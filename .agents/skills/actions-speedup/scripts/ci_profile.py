#!/usr/bin/env python3
"""Profile a repository's GitHub Actions history: where the wait goes, and what looks broken.

Read-only against GitHub. Needs an authenticated `gh` CLI; standard library only.

    ci_profile.py --repo owner/name [--limit 60] [--created-before ISO] [--workflow file.yml]

Prints a Markdown profile to stdout. Timing statistics use only first-attempt runs that
completed successfully, split by event, so a fast failure or a partial re-run never passes
for a fast run. Everything else is counted and reported separately.

What the numbers are, and are not:
- "created to done" is run creation to the last job's completion. It is the closest the API
  gives to a developer's wait, and is not push-to-green across several workflows.
- "last-finishing job" is the job that ended last in that workflow. Whether it gates a merge
  depends on required checks, which this script does not read.
- setup/work is a heuristic split on step names. Confirm it against the workflow file.
- "observed runner minutes" are sums of job durations, not a bill.
"""
import argparse
import json
import math
import re
import statistics
import subprocess
import sys
import time
from collections import Counter, defaultdict
from concurrent.futures import ThreadPoolExecutor
from threading import Lock
from datetime import datetime
from urllib.parse import quote

SETUP_STEP = re.compile(
    r"^(set up job|complete job|post |pre |initialize containers|stop containers|"
    r"(run )?actions/(checkout|setup-[\w.-]+|cache)\b|"
    r"(run )?[\w.-]+/(setup-[\w.-]+|[\w.-]*cache[\w.-]*)@|"
    r"set ?up \w+|install (dependencies|deps)|restore .*cache|save .*cache|cache \w+)",
    re.I,
)
# "Linux (ubuntu-24.04, 3/5)" and "... 1/5)" are shards of one job. Only the i/m form folds.
SHARD = re.compile(r"\b\d+\s*/\s*(\d+)\b")


CALLS = 0
MAX_CALLS = 1500
CALLS_LOCK = Lock()


_CACHE = {}


def gh(path):
    """GET through `gh api`, retrying rate limits and server errors with backoff."""
    if path in _CACHE:
        return _CACHE[path]
    _CACHE[path] = result = _gh(path)
    return result


def _gh(path):
    global CALLS
    for attempt in range(5):
        with CALLS_LOCK:
            CALLS += 1
            over = CALLS > MAX_CALLS
        if over:
            sys.exit(f"stopped after {MAX_CALLS} API calls; lower --limit or pass --workflow")
        out = subprocess.run(["gh", "api", "-X", "GET", path], capture_output=True, text=True)
        if out.returncode == 0:
            return json.loads(out.stdout)
        err = out.stderr.strip()
        if attempt < 4 and re.search(r"rate limit|HTTP 429|HTTP 5\d\d|timed out|EOF", err, re.I):
            time.sleep(min(60, 5 * 2 ** attempt))
            continue
        sys.exit(f"gh api {path} failed: {err}")


def ts(s):
    if not s or s.startswith("0001"):
        return None
    return datetime.fromisoformat(s.replace("Z", "+00:00"))


def secs(a, b):
    a, b = ts(a), ts(b)
    return (b - a).total_seconds() if a and b else None


def med(xs):
    xs = [x for x in xs if x is not None]
    return statistics.median(xs) if xs else None


def p90(xs):
    """Nearest-rank 90th percentile."""
    xs = sorted(x for x in xs if x is not None)
    return xs[max(0, math.ceil(0.9 * len(xs)) - 1)] if xs else None


def fmt(x):
    if x is None:
        return "-"
    x = int(round(x))
    return f"{x}s" if x < 90 else f"{x // 60}m{x % 60:02d}s"


def fetch_runs(repo, limit, before, workflow, branch=None):
    base = f"repos/{repo}/actions" + (f"/workflows/{quote(workflow, safe='')}" if workflow else "")
    runs, seen, page = [], set(), 1
    while len(runs) < limit and page <= 10:  # the API stops at 1,000 results per query
        q = f"{base}/runs?per_page=100&page={page}"
        if before:
            q += "&created=" + quote(f"<{before}", safe="")
        if branch:
            q += "&branch=" + quote(branch, safe="")
        batch = gh(q).get("workflow_runs", [])
        if not batch:
            break
        for r in batch:
            if r["id"] not in seen:
                seen.add(r["id"])
                runs.append(r)
        page += 1
    return runs[:limit]


def fetch_jobs(repo, run_id):
    jobs, page, total = [], 1, None
    while True:
        d = gh(f"repos/{repo}/actions/runs/{run_id}/jobs?per_page=100&page={page}")
        total = d.get("total_count", 0)
        jobs += d.get("jobs", [])
        if len(jobs) >= total or not d.get("jobs"):
            break
        page += 1
    return jobs, len(jobs) >= (total or 0)


def ran(j):
    return (j.get("conclusion") != "skipped" and ts(j.get("started_at"))
            and ts(j.get("completed_at")))


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawTextHelpFormatter)
    ap.add_argument("--repo", required=True)
    ap.add_argument("--limit", type=int, default=60)
    ap.add_argument("--created-before", help="UTC ISO time ending in Z; note a run created "
                    "before it may have been re-run after it (re-runs are excluded from timing)")
    ap.add_argument("--workflow", help="workflow file name, e.g. ci.yml")
    ap.add_argument("--branch", help="only runs of this branch: profile a change's branch, then "
                    "the base, to compare before and after")
    a = ap.parse_args()
    if a.limit <= 0:
        sys.exit("--limit must be positive")

    runs = fetch_runs(a.repo, a.limit, a.created_before, a.workflow, a.branch)
    if not runs:
        sys.exit("no runs found")
    repo_info = gh(f"repos/{a.repo}")
    default_branch = repo_info.get("default_branch", "main")

    by_wf = defaultdict(list)
    signals, incomplete = [], 0
    own = [r for r in runs if not r.get("path", "").startswith("dynamic/")]
    managed = len(runs) - len(own)  # Dependabot, Pages: GitHub's own
    with ThreadPoolExecutor(max_workers=8) as pool:
        fetched = list(pool.map(lambda r: fetch_jobs(a.repo, r["id"]), own))
    for r, (jobs, complete) in zip(own, fetched):
        r["_jobs"] = jobs
        if not complete:
            incomplete += 1
            continue
        by_wf[(r["workflow_id"], r.get("path") or r["name"])].append(r)
        if r["conclusion"] == "cancelled" and not r["_jobs"]:
            signals.append(
                f"run {r['id']} (`{r['event']}` on `{r['head_branch']}`, {r['created_at']}) was "
                f"cancelled with no recorded jobs. Check whether commit {r['head_sha'][:8]} was "
                "tested by another run; a concurrency group that replaces pending runs does this")
        if r["conclusion"] == "action_required":
            signals.append(f"run {r['id']} is waiting for approval (action_required)")

    print(f"# CI profile: {a.repo}\n")
    print(f"{len(runs)} runs fetched, {runs[-1]['created_at']} to {runs[0]['created_at']}"
          + (f" (created before {a.created_before})" if a.created_before else "")
          + (f", branch `{a.branch}`" if a.branch else ""))
    if managed:
        print(f"- {managed} GitHub-managed runs (Dependabot, Pages) left out")
    if incomplete:
        print(f"- {incomplete} runs left out: their job list could not be fetched in full")
    print("- timing below: first-attempt successful runs only, per event\n")

    for (_, path), rs in sorted(by_wf.items(), key=lambda kv: -len(kv[1])):
        name = rs[0]["name"]
        concl = Counter(r["conclusion"] or r["status"] for r in rs)
        events = Counter(r["event"] for r in rs)
        reruns = sum(1 for r in rs if r.get("run_attempt", 1) > 1)
        observed_min = sum(secs(j["started_at"], j["completed_at"]) or 0
                           for r in rs for j in r["_jobs"] if ran(j)) / 60

        print(f"## {name} (`{path}`)\n")
        print(f"- runs: {len(rs)}, by event {dict(events)}, by conclusion {dict(concl)}"
              + (f"; {reruns} re-run, excluded from timing" if reruns else ""))
        print(f"- observed runner minutes, every run and conclusion: {observed_min:.0f}")

        clean = [r for r in rs if r["conclusion"] == "success" and r.get("run_attempt", 1) == 1]
        for ev in sorted({r["event"] for r in clean}):
            sample = []
            for r in clean:
                if r["event"] != ev:
                    continue
                js = [j for j in r["_jobs"] if ran(j)]
                if js:
                    sample.append((r, js))
            if not sample:
                continue
            walls, pre, mins, last = [], [], [], Counter()
            jobstat = defaultdict(lambda: defaultdict(list))
            stepstat = defaultdict(list)
            for r, js in sample:
                end = max(j["completed_at"] for j in js)
                walls.append(secs(r["created_at"], end))
                pre.append(secs(r["created_at"], min(j["started_at"] for j in js)))
                mins.append(sum(secs(j["started_at"], j["completed_at"]) for j in js) / 60)
                last[SHARD.sub(r"N/\1", max(js, key=lambda j: j["completed_at"])["name"])] += 1
                # Shards of one job: the group ends with its slowest shard and costs their sum.
                groups = defaultdict(list)
                for j in js:
                    groups[SHARD.sub(r"N/\1", j["name"])].append(j)
                for g, members in groups.items():
                    setup = work = other = 0.0
                    for j in members:
                        total = secs(j["started_at"], j["completed_at"])
                        stepped = 0.0
                        for s in j.get("steps", []):
                            d = secs(s.get("started_at"), s.get("completed_at"))
                            if d is None or s.get("conclusion") == "skipped":
                                continue
                            stepped += d
                            if SETUP_STEP.match(s["name"]):
                                setup += d
                            else:
                                work += d
                            stepstat[(g, s["name"])].append(d)
                        other += max(0.0, total - stepped)
                    n = len(members)
                    st = jobstat[g]
                    st["shards"].append(n)
                    # `created_at` on a job is present in practice though undocumented.
                    st["queue"].append(med([secs(j.get("created_at"), j["started_at"])
                                            for j in members]))
                    st["setup"].append(setup / n)
                    st["work"].append(work / n)
                    st["other"].append(other / n)
                    st["slowest"].append(max(secs(j["started_at"], j["completed_at"])
                                             for j in members))
                    st["sum"].append(sum(secs(j["started_at"], j["completed_at"])
                                         for j in members))

            n = len(sample)
            print(f"\n### on `{ev}` (n={n}" + (", too few to conclude from" if n < 10 else "") + ")\n")
            print(f"- created to done: median {fmt(med(walls))}, p90 {fmt(p90(walls))}")
            if n >= 6:
                half = n // 2  # sample is newest first
                print(f"- trend: newer half median {fmt(med(walls[:half]))}, "
                      f"older half {fmt(med(walls[half:]))}")
            print(f"- before the first job starts: median {fmt(med(pre))}, max {fmt(max(pre))}")
            print(f"- observed runner minutes per run: median {med(mins):.1f}")
            print("- newest run IDs, for `gh run view <id> --log`: "
                  + ", ".join(str(r["id"]) for r, _ in sample[:5]))
            print("- last-finishing job: "
                  + ", ".join(f"`{k}` {v}/{n}" for k, v in last.most_common(3)))
            print("\n| job | n | shards | queue | setup | work | unaccounted | slowest shard "
                  "(median) | p90 | sum of shards |")
            print("|---|---|---|---|---|---|---|---|---|---|")
            for g, st in sorted(jobstat.items(), key=lambda kv: -(med(kv[1]["slowest"]) or 0)):
                print(f"| {g} | {len(st['slowest'])} | {int(med(st['shards']))} | "
                      f"{fmt(med(st['queue']))} | {fmt(med(st['setup']))} | "
                      f"{fmt(med(st['work']))} | {fmt(med(st['other']))} | "
                      f"{fmt(med(st['slowest']))} | {fmt(p90(st['slowest']))} | "
                      f"{fmt(med(st['sum']))} |")
            print("\nSlowest steps (median per occurrence; setup/work split is by step name):")
            for (g, step), ds in sorted(stepstat.items(), key=lambda kv: -(med(kv[1]) or 0))[:8]:
                kind = "setup" if SETUP_STEP.match(step) else "work"
                print(f"- {fmt(med(ds))} (p90 {fmt(p90(ds))}, n={len(ds)}, {kind}): "
                      f"`{g}` / `{step}`")
        if not clean:
            print("\nNo first-attempt successful run in the window: no timing sample.")

        # Signals worth a look before any tuning.
        head = [r for r in rs if r["head_branch"] == default_branch and r["event"] == "push"
                and r["conclusion"] in ("success", "failure")]
        streak = 0
        for r in head:
            if r["conclusion"] != "failure":
                break
            streak += 1
        if streak >= 2:
            signals.append(
                f"`{name}`: the last {streak} pushes to `{default_branch}` failed. Read the "
                "failure first; a job that keeps failing may also never save a cache it owns")
        print()

    # A gate nobody runs is not slow, it is absent.
    gate = [r["created_at"] for r in runs
            if r["event"] in ("push", "pull_request", "pull_request_target", "merge_group")]
    newest = max(gate) if gate else None
    later = [] if not newest or a.created_before else gh(
        f"repos/{a.repo}/commits?sha={quote(default_branch, safe='')}"
        f"&since={quote(newest, safe='')}&per_page=100")
    if len(later) > 5:
        signals.append(
            f"{len(later)}{'+' if len(later) == 100 else ''} commits reached `{default_branch}` "
            f"since the newest push or pull-request run here ({newest}). Check that the workflows still trigger on "
            "the way changes land; timings above describe older code")

    failed = [r for rs in by_wf.values() for r in rs if r["conclusion"] == "failure"]
    if failed:
        print("Newest failed run IDs: " + ", ".join(str(r["id"]) for r in failed[:5]) + "\n")
    print("## Signals to investigate (not conclusions)\n")
    for x in signals or ["none found by this script"]:
        print(f"- {x}")


if __name__ == "__main__":
    main()
