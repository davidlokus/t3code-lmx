#!/usr/bin/env python3
"""One command: profile a repository's GitHub Actions, then read the logs of its two slowest
workflows and list leads to confirm or dismiss.

    ci_diagnose.py --repo owner/name [--limit 60] [--created-before ISO] [--logs 3]
                   [--out DIR]

Read-only against GitHub; writes logs only to --out (default: a temp folder). Needs an
authenticated `gh` and Python 3.9+, standard library only.

Prints three parts:
1. the profile from ci_profile.py;
2. for the two slowest workflows (median created-to-done of first-attempt successful runs),
   the longest pauses in their logs, recurring signals and per-test timings;
3. a numbered list of leads. Each lead is a place to look, not a conclusion.
"""
import argparse
import contextlib
import io
import os
import re
import statistics
import subprocess
import sys
import tempfile
from collections import defaultdict
from datetime import datetime
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import ci_profile  # noqa: E402
import test_times  # noqa: E402
import workflow_scan  # noqa: E402

LINE = re.compile(r"^(?P<job>[^\t]*)\t(?P<step>[^\t]*)\t(?P<ts>\d{4}-\d\d-\d\dT[\d:.]+Z) ?(?P<txt>.*)$")

# Generic CI signals. Each: (key, regex, what it may mean).
SIGNALS = [
    ("frozen-cache", r"Cache hit occurred on the primary key (\S+), not saving cache",
     "the same cache key hits on every run, so the cache never updates; a tool's incremental "
     "cache inside it goes stale"),
    ("cache-miss", r"Cache not found for input keys|cache miss\b|No cache found",
     "a cache that misses; check its key, scope and when it is saved"),
    ("already-installed", r"is already the newest version|is already installed",
     "an install step installing what the runner already has"),
    ("slow-download", r"Fetched [\d.,]+ ?[kMG]?B in (?:\d+min|[1-9]\d+s)",
     "a package download that took tens of seconds or minutes (slow mirror?)"),
    ("workers", r"created: (\d+)/(\d+) workers|[Rr]unning (?:with )?(\d+) (?:workers|processes|threads)",
     "the parallelism the test runner actually used; compare with the runner's cores"),
    ("configure", r"Configuring done \(([\d.]+)s\)|Generating done \(([\d.]+)s\)",
     "a build configure/generate step; if it takes long, read the build scripts"),
    ("retry", r"\bRERUN\b|\bRetrying\b|retry attempt|\bflaky\b|Re-running failed",
     "retries: tests or downloads that only pass on a second try"),
    ("resource", r"exit code 137|\bKilled\b|out of memory|heap out of memory|No space left on device",
     "memory or disk exhaustion"),
    ("compiled-tool", r"\bgo install \S|\bcargo install \S|\bnpm (?:i|install) -g\b",
     "a tool compiled or installed on every run instead of downloaded prebuilt"),
    ("submodule", r"Submodule path '[^']+': checked out|Cloning into '[^']*'",
     "submodule clones; check depth and whether they run in parallel"),
]
SIGNALS = [(k, re.compile(p), why) for k, p, why in SIGNALS]
NUMS = re.compile(r"\d+(?:\.\d+)?")
ANSI = re.compile(r"\x1b\[[0-9;]*m|\[\d+(?:;\d+)*m")
# Exact hits on these are normal: dependency caches keyed on a lockfile.
DEPENDENCY_CACHE = re.compile(r"^(setup-(python|node|go|java|ruby)|node-cache|npm|yarn|pnpm|pip|uv|"
                              r"poetry|bundler|gems?|go-mod|gomod|cargo-registry|gradle|maven|composer)", re.I)


def ts(s):
    return datetime.fromisoformat(s[:26].rstrip("Z") + "+00:00")


def read_log(path):
    rows = []
    with open(path, encoding="utf-8", errors="replace") as f:
        for raw in f.read().splitlines():
            m = LINE.match(raw)
            if m:
                rows.append((m["job"], m["step"], ts(m["ts"]), ANSI.sub("", m["txt"]).strip()))
    return rows


def pauses(rows, floor=15.0):
    """Gaps between consecutive lines of one job longer than `floor` seconds."""
    out, last = [], {}
    for job, step, t, txt in rows:
        if job in last:
            pt, ptxt, pstep = last[job]
            gap = (t - pt).total_seconds()
            if gap >= floor:
                out.append((gap, job, pstep, ptxt, txt))
        last[job] = (t, txt, step)
    return out


def shape(text):
    """A line with its numbers removed, so the same pause matches across runs."""
    return NUMS.sub("#", text)[:120]


MAX_LOG_BYTES = 40 * 1024 * 1024
BARE = re.compile(r"^\ufeff?(\d{4}-\d\d-\d\dT[\d:.]+Z) ?(.*)$")


def gh_log(repo, run_id, dest, jobs_per_run=4):
    """Logs of the run's slowest jobs only, in `job<TAB>step<TAB>time text` form.

    Whole-run logs can be gigabytes; the slowest jobs are where the time is."""
    if dest.exists() and dest.stat().st_size:
        return True
    jobs, _ = ci_profile.fetch_jobs(repo, run_id)
    ran = sorted((j for j in jobs if ci_profile.ran(j)),
                 key=lambda j: -(ci_profile.secs(j["started_at"], j["completed_at"]) or 0))
    written = 0
    with open(dest, "w", encoding="utf-8") as out:
        for j in ran[:jobs_per_run]:
            res = subprocess.run(["gh", "api", f"repos/{repo}/actions/jobs/{j['id']}/logs"],
                                 capture_output=True, text=True, errors="replace")
            if res.returncode != 0 or not res.stdout:
                continue
            text = res.stdout
            if len(text) > MAX_LOG_BYTES:  # keep the end, where slow steps finish
                text = text[-MAX_LOG_BYTES:]
            name = j["name"].replace("\t", " ")
            for line in text.splitlines():
                m = BARE.match(line)
                if m:
                    out.write(f"{name}\t-\t{m[1]} {m[2]}\n")
            written += 1
    return written > 0


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawTextHelpFormatter)
    ap.add_argument("--repo", required=True)
    ap.add_argument("--limit", type=int, default=60)
    ap.add_argument("--created-before")
    ap.add_argument("--logs", type=int, default=3, help="successful runs to read per workflow")
    ap.add_argument("--jobs-per-run", type=int, default=4,
                    help="slowest jobs per run whose logs are read")
    ap.add_argument("--out", help="folder for downloaded logs (default: a temp folder)")
    ap.add_argument("--root", default=".", help="local checkout to scan the workflow files of")
    a = ap.parse_args()
    out_dir = Path(a.out or tempfile.mkdtemp(prefix="ci-diagnose-"))
    out_dir.mkdir(parents=True, exist_ok=True)

    # 1. The profile, and the runs it was built from.
    argv = ["ci_profile.py", "--repo", a.repo, "--limit", str(a.limit)]
    if a.created_before:
        argv += ["--created-before", a.created_before]
    sys.argv, saved = argv, sys.argv
    buf = io.StringIO()
    try:
        with contextlib.redirect_stdout(buf):
            ci_profile.main()
    finally:
        sys.argv = saved
    print(buf.getvalue())

    # 2. The two slowest workflows by median created-to-done of clean runs.
    runs = ci_profile.fetch_runs(a.repo, a.limit, a.created_before, None)
    by_wf = defaultdict(list)
    for r in runs:
        if r.get("path", "").startswith("dynamic/"):
            continue
        if r["conclusion"] == "success" and r.get("run_attempt", 1) == 1:
            by_wf[r.get("path") or r["name"]].append(r)
    timed = []
    for path, rs in by_wf.items():
        walls = []
        for r in rs:
            jobs, _ = ci_profile.fetch_jobs(a.repo, r["id"])
            ends = [j["completed_at"] for j in jobs if ci_profile.ran(j)]
            if ends:
                walls.append(ci_profile.secs(r["created_at"], max(ends)))
        if walls:
            timed.append((statistics.median(walls), path, rs))
    timed.sort(key=lambda x: -x[0])
    chains = timed[:2]
    if not chains:
        print("No successful runs to read logs from.")
        return

    print("# Log reading\n")
    print(f"Logs saved in `{out_dir}`.\n")
    leads = []
    for wall, path, rs in chains:
        name = rs[0]["name"]
        print(f"## {name} (`{path}`), median created to done {ci_profile.fmt(wall)}\n")
        logs = []
        for r in rs[:a.logs]:
            dest = out_dir / f"{r['id']}.log"
            if gh_log(a.repo, r["id"], dest, a.jobs_per_run):
                logs.append(dest)
        if not logs:
            print("Could not download any log.\n")
            continue
        print("Runs read: " + ", ".join(p.stem for p in logs) + "\n")
        all_rows = {p: read_log(p) for p in logs}

        # Longest pauses, grouped by the line before them across runs.
        groups = defaultdict(list)
        for p, rows in all_rows.items():
            for gap, job, step, before, after in pauses(rows):
                groups[(job, shape(before))].append((gap, p.stem, step, before, after))
        ranked = sorted(groups.items(), key=lambda kv: -statistics.median(g[0] for g in kv[1]))
        print("### Longest pauses in the log (no output for this long)\n")
        if not ranked:
            print("none over 15 s\n")
        pause_leads = 0
        for (job, _), hits in ranked[:8]:
            gap = statistics.median(h[0] for h in hits)
            runs_hit = len({h[1] for h in hits})
            _, _, step, before, after = max(hits)
            print(f"- {ci_profile.fmt(gap)} median, in {runs_hit}/{len(logs)} runs, `{job}` / "
                  f"`{step}`: after `{before[:100]}` → before `{after[:80]}`")
            if gap >= 30 and pause_leads < 3 and (runs_hit > 1 or gap >= 60):
                pause_leads += 1
                leads.append(f"{name}: `{job}` goes silent for {ci_profile.fmt(gap)} after "
                             f"`{before[:80]}` ({runs_hit}/{len(logs)} runs). What is it waiting on?")
        print()

        # Signals.
        print("### Signals\n")
        found = False
        for key, rx, why in SIGNALS:
            per_log, sample = {}, None
            for p, rows in all_rows.items():
                for job, step, t, txt in rows:
                    m = rx.search(txt)
                    if not m or (key == "frozen-cache" and DEPENDENCY_CACHE.match(m[1])):
                        continue
                    per_log[p.stem] = per_log.get(p.stem, 0) + 1
                    sample = sample or (job, step, txt)
            if not per_log:
                continue
            found = True
            total = sum(per_log.values())
            print(f"- **{key}**: {total} lines in {len(per_log)}/{len(logs)} runs, e.g. "
                  f"`{sample[0]}` / `{sample[1]}`: `{sample[2][:140]}`. {why}")
            if key != "submodule" or total >= 5:
                leads.append(f"{name}: {key} ({total} lines in {len(per_log)}/{len(logs)} runs): "
                             f"{why}")
        if not found:
            print("none\n")
        print()

        # Per-test times.
        print("### Per-test times\n")
        sys.argv, saved = ["test_times.py", *map(str, logs), "--top", "15"], sys.argv
        buf = io.StringIO()
        try:
            with contextlib.redirect_stdout(buf):
                test_times.main()
        except SystemExit as e:
            buf.write(f"{e}\n")
        finally:
            sys.argv = saved
        text = buf.getvalue()
        print(text)
        if "durations" in text or "slowest" in text:
            print("(Runners that print only their N slowest tests, such as pytest `--durations=N`, "
                  "show only those; the rest of the suite is not in these numbers.)\n")
        steady = [l for l in text.splitlines() if " steady " in l]
        if steady:
            leads.append(f"{name}: {len(steady)} of the slowest tests take the same time on every "
                         "run (steady): likely real sleeps, timeouts or retries. Read them.")
        top = re.search(r"slowest \d+ are \d+s \((\d+)%\)", text)
        if top and int(top[1]) >= 40:
            leads.append(f"{name}: the slowest tests hold {top[1]}% of all test time. Read them.")

    # 3. Static hygiene: cheap waste worth fixing whether or not it is on the slowest chain.
    hygiene = workflow_scan.scan(a.root)
    print("# Workflow hygiene scan\n")
    if not (Path(a.root) / ".github" / "workflows").is_dir():
        print(f"no `.github/workflows` under `{a.root}`; pass --root <checkout>\n")
    for wf, job, key, why in hygiene:
        print(f"- **{key}** `{wf}`" + (f" / `{job}`" if job != "-" else "") + f": {why}")
        if key != "no-timeout":
            leads.append(f"hygiene `{wf}`" + (f" / `{job}`" if job != "-" else "") + f": {key}: {why}")
    print()

    print("# Leads to confirm or dismiss\n")
    print("Each is a place to look, found mechanically. In the report, mark every lead "
          "confirmed (with the cause) or dismissed (with the reason).\n")
    for i, lead in enumerate(leads or ["none found mechanically; follow the slowest step by hand"], 1):
        print(f"{i}. {lead}")


if __name__ == "__main__":
    main()
