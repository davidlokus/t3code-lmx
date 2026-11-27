#!/usr/bin/env python3
"""Static hygiene scan of GitHub Actions workflow files: cheap, common waste that is worth
fixing whether or not it sits on the slowest chain.

    workflow_scan.py [repo-root]

Line-based (no YAML library), so each finding is a lead to check, not a verdict.
"""
import re
import sys
from pathlib import Path

SETUP_CACHE = {
    "setup-node": "cache: npm|yarn|pnpm",
    "setup-python": "cache: pip|pipenv|poetry (or use uv with its cache)",
    "setup-java": "cache: maven|gradle|sbt",
    "setup-go": "cache is on by default from v4; check it is not disabled",
    "setup-dotnet": "cache: true",
    "setup-ruby": "bundler-cache: true",
}
COVERAGE = re.compile(r"--cov\b|coverage run|-coverprofile|--coverage\b|cargo (?:llvm-cov|tarpaulin)|nyc ")
COMPILE_TOOL = re.compile(r"\bgo install \S|\bcargo install \S|\bnpm (?:i|install) -g\b|\bpip install --no-binary")
LINT_NAME = re.compile(r"lint|format|fmt|style|typecheck|type-check|audit", re.I)


def jobs_of(text):
    """Split a workflow into (job_id, job_text) by the two-space job keys under `jobs:`."""
    m = re.search(r"^jobs:\s*$", text, re.M)
    if not m:
        return []
    body = text[m.end():]
    starts = [(mm.start(), mm[1]) for mm in re.finditer(r"^  ([A-Za-z0-9_-]+):\s*$", body, re.M)]
    out = []
    for i, (pos, name) in enumerate(starts):
        end = starts[i + 1][0] if i + 1 < len(starts) else len(body)
        out.append((name, body[pos:end]))
    return out


def steps_of(job):
    """Each `- ` step under `steps:` as its own text block."""
    m = re.search(r"^(\s*)steps:\s*$", job, re.M)
    if not m:
        return []
    lines = job[m.end():].splitlines()
    steps, cur, indent = [], None, None
    for line in lines:
        mm = re.match(r"^(\s*)- ", line)
        if mm and (indent is None or len(mm[1]) == indent):
            indent = len(mm[1])
            if cur is not None:
                steps.append("\n".join(cur))
            cur = [line]
        elif cur is not None:
            cur.append(line)
    if cur is not None:
        steps.append("\n".join(cur))
    return steps


def run_lines(job):
    """The commands in `run:` steps, one string per step."""
    cmds, lines = [], job.splitlines()
    i = 0
    while i < len(lines):
        m = re.match(r"^(\s*)(?:- )?run:\s*(.*)$", lines[i])
        if not m:
            i += 1
            continue
        indent, first = len(m[1]), m[2].strip()
        if first in ("|", ">", "|-", ">-", ""):
            block = []
            i += 1
            while i < len(lines) and (not lines[i].strip() or len(lines[i]) - len(lines[i].lstrip()) > indent):
                block.append(lines[i].strip())
                i += 1
            cmds.append("\n".join(b for b in block if b))
        else:
            cmds.append(first)
            i += 1
    return cmds


def scan(root):
    wf_dir = Path(root) / ".github" / "workflows"
    findings = []
    if not wf_dir.is_dir():
        return findings
    for wf in sorted(list(wf_dir.glob("*.yml")) + list(wf_dir.glob("*.yaml"))):
        text = wf.read_text(encoding="utf-8", errors="replace")
        name = wf.name
        on_block = text.split("\njobs:")[0]
        has_pr = re.search(r"^\s*pull_request\b(?!_target)", on_block, re.M)
        has_push = re.search(r"^\s*push\s*:", on_block, re.M) or re.search(r"^on:\s*\[?[^\n]*\bpush\b", on_block, re.M)

        if has_pr and "cancel-in-progress" not in text:
            findings.append((name, "-", "no-cancel",
                             "runs on pull_request without `concurrency` + `cancel-in-progress`: a "
                             "new push leaves the superseded run running and holding runners"))
        if has_pr and has_push:
            push_part = re.search(r"^\s*push\s*:(.*?)(?=^\s*pull_request|\Z)", on_block, re.M | re.S)
            if push_part and "branches" not in push_part[1] and "tags" not in push_part[1]:
                findings.append((name, "-", "double-run",
                                 "runs on push to every branch and on pull_request: a PR branch "
                                 "runs twice per push"))

        no_timeout = []
        for job_id, job in jobs_of(text):
            matrix = "matrix:" in job
            runs_on = re.search(r"runs-on:\s*(.+)", job)
            os_label = runs_on[1].strip() if runs_on else ""
            if "timeout-minutes" not in job and not re.search(r"^\s{4}uses:", job, re.M):
                no_timeout.append(job_id)
            uses_cache_action = re.search(r"actions/cache|setup-uv|\buv (?:sync|pip)", job)
            steps = steps_of(job)
            for step in steps:
                um = re.search(r"uses:\s*actions/(setup-[a-z]+)@", step)
                if um and um[1] in SETUP_CACHE:
                    action = um[1]
                    disabled = re.search(r"cache:\s*false", step)
                    has = re.search(r"\bcache(?:-dependency-path)?:|bundler-cache:", step)
                    if action == "setup-go":
                        if disabled and not uses_cache_action:
                            findings.append((name, job_id, "setup-no-cache",
                                             f"`{action}` with `cache: false` and no other cache step"))
                    elif not has and not uses_cache_action:
                        findings.append((name, job_id, "setup-no-cache",
                                         f"`{action}` without its built-in cache "
                                         f"({SETUP_CACHE[action]}) and no `actions/cache` step"))
                if re.search(r"uses:\s*actions/checkout@", step) and re.search(r"fetch-depth:\s*0\b", step):
                    findings.append((name, job_id, "full-history",
                                     "checkout with `fetch-depth: 0` downloads the whole history; check "
                                     "something needs it (versioning, diffs) or use `filter: blob:none`"))
            if re.search(r"submodules:\s*(?:true|recursive)", job):
                findings.append((name, job_id, "submodules",
                                 "submodules cloned by checkout: full history, one at a time; "
                                 "`git submodule update --init --depth 1 --jobs 8` is often faster"))
            cmds = run_lines(job)
            seen = {}
            for c in cmds:
                key = re.sub(r"\s+", " ", c).strip()
                if len(key) > 8:
                    seen[key] = seen.get(key, 0) + 1
            for c, n in seen.items():
                if n > 1:
                    findings.append((name, job_id, "repeated-step",
                                     f"the same command runs {n} times in this job: `{c[:80]}`"))
            for c in cmds:
                if COMPILE_TOOL.search(c):
                    findings.append((name, job_id, "compiled-tool",
                                     f"installs or compiles a tool on every run: `{c.splitlines()[0][:80]}`; "
                                     "download a prebuilt binary or cache it"))
                pip_cached = re.search(r"cache: ?pip|\buv\b|setup-uv", job) or any(
                    "actions/cache" in st and re.search(r"pip", st) for st in steps)
                if re.search(r"\bpip install\b", c) and not pip_cached:
                    findings.append((name, job_id, "pip-no-cache",
                                     "`pip install` with no pip cache; `cache: pip` or uv with its "
                                     "cache avoid re-downloading (and re-building wheels)"))
                    break
            if matrix and any(COVERAGE.search(c) for c in cmds):
                uploads = [st for st in steps if re.search(r"codecov|coveralls|upload-coverage", st, re.I)]
                if uploads and all(re.search(r"^\s*if:", st, re.M) for st in uploads):
                    findings.append((name, job_id, "coverage-every-leg",
                                     "coverage is measured on every matrix leg but uploaded from one "
                                     "(conditional upload); tracing slows the other legs for nothing"))
            if re.search(r"macos|windows", os_label, re.I) and LINT_NAME.search(job_id) and not matrix:
                findings.append((name, job_id, "lint-on-costly-os",
                                 f"`{job_id}` runs on `{os_label}`; OS-independent checks are cheaper "
                                 "and less contended on Linux"))
            if re.search(r"apt-get install", job) and not re.search(r"cache-apt|awalsh128|apt-cache", job):
                findings.append((name, job_id, "apt-every-run",
                                 "installs system packages on every run; check the runner image "
                                 "already has them, and how long the step takes"))
            for k in re.finditer(r"^\s*key:\s*(.+)$", job, re.M):
                key = k[1]
                if "hashFiles" not in key and "github.sha" not in key and "run_id" not in key \
                        and "steps." not in key and "inputs." not in key:
                    findings.append((name, job_id, "static-cache-key",
                                     f"cache key `{key.strip()[:70]}` never changes: the first save is "
                                     "kept forever and later content is never stored"))
            if re.search(r"docker build|docker/build-push-action", job) and "cache-from" not in job:
                findings.append((name, job_id, "docker-no-cache",
                                 "Docker build without `cache-from`: every run rebuilds every layer"))
        if no_timeout:
            findings.append((name, "-", "no-timeout",
                             f"{len(no_timeout)} job(s) without `timeout-minutes` ({', '.join(no_timeout[:6])}); "
                             "a hung job runs, and bills, up to 6 hours. Minor"))
    return findings


def main():
    root = sys.argv[1] if len(sys.argv) > 1 else "."
    findings = scan(root)
    print("# Workflow hygiene scan\n")
    if not findings:
        print("nothing found")
        return
    for wf, job, key, why in findings:
        print(f"- **{key}** `{wf}`" + (f" / `{job}`" if job != "-" else "") + f": {why}")


if __name__ == "__main__":
    main()
