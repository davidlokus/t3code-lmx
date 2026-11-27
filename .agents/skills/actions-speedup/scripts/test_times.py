#!/usr/bin/env python3
"""Per-test durations out of GitHub Actions logs that already print them.

    gh run view <id> --repo owner/name --log > run.log     # writes a local file
    test_times.py run.log [more.log ...] [--top 20]

Reads Go (`--- PASS: TestX (1.23s)`), node:test (`✔ name (12.3ms)`), pytest
(`1.23s call path::test`) and Jest/Vitest verbose (`✓ name (123 ms)`) lines. Groups by the
job and step that printed them, and by npm workspace in the order npm ran them. Give it several runs: one run mixes a fast or slow machine with the code.

A sum of test times close to the step's wall time suggests the tests ran one at a time; it
does not prove it, since parent tests include their children and setup is not timed.
"""
import argparse
import re
import statistics
from collections import defaultdict

LINE = re.compile(r"^(?P<job>[^\t]*)\t(?P<step>[^\t]*)\t(?P<ts>\S+Z) (?P<txt>.*)$")
PATTERNS = [
    (re.compile(r"^\s*--- (?:PASS|FAIL): (\S+) \(([\d.]+)s\)"), 1.0),
    (re.compile(r"^\s*[✔✖] (.+) \(([\d.]+)ms\)"), 0.001),
    (re.compile(r"^\s*[✓√×] (.+?) \(?([\d.]+) ?ms\)?$"), 0.001),
    (re.compile(r"^([\d.]+)s (?:call|setup|teardown)\s+(\S+)"), None),  # pytest: time first
]
WORKSPACE = re.compile(r"^> (?:(@?[\w./-]+)@\S+ )?([\w:.-]+)$")


def parse(path):
    """Rows of (job, group, test, seconds). An npm script run with `--workspaces` repeats its
    header (`> test`, `> pkg@1.0 test`) once per workspace, in the order of `workspaces` in
    package.json, with no name for a package that has none; each repeat starts a group."""
    rows, outer, seg, label, pending = [], None, 0, "", None
    with open(path, encoding="utf-8", errors="replace") as f:
        lines = f.read().splitlines()
    for raw in lines:
        m = LINE.match(raw)
        if not m:
            continue
        txt = m["txt"]
        w = WORKSPACE.match(txt)
        if w:
            pending = (w[1] or "", w[2])
            continue
        if pending and txt.startswith("> "):
            pkg, script = pending
            pending = None
            if "--workspaces" in txt or " -ws" in txt:
                outer, seg, label = script, 0, ""
            elif script == outer:
                seg += 1
                label = pkg or txt[2:50]
            continue
        for pat, scale in PATTERNS:
            t = pat.match(txt)
            if not t:
                continue
            if scale is None:
                name, d = t[2], float(t[1])
            else:
                name, d = t[1], float(t[2]) * scale
            group = f"{outer} #{seg} {label}".strip() if outer and seg else m["step"]
            rows.append((m["job"], group, name, d))
            break
    return rows


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawTextHelpFormatter)
    ap.add_argument("logs", nargs="+")
    ap.add_argument("--top", type=int, default=20)
    a = ap.parse_args()

    per_test = defaultdict(list)       # (job, group, test) -> one duration per log
    per_group = defaultdict(lambda: defaultdict(float))
    for i, path in enumerate(a.logs):
        for job, group, name, d in parse(path):
            per_test[(job, group, name)].append(d)
            per_group[(job, group)][i] += d
    if not per_test:
        raise SystemExit("no per-test timing lines recognised; the test runner may need a "
                         "verbose or durations flag in CI")

    print(f"{len(a.logs)} log(s), {len(per_test)} distinct tests\n")
    print("| job | group | tests | sum of test time per run (median) | min | max |")
    print("|---|---|---|---|---|---|")
    for (job, group), by_log in sorted(per_group.items(),
                                       key=lambda kv: -statistics.median(kv[1].values())):
        v = list(by_log.values())
        n = sum(1 for k in per_test if k[:2] == (job, group))
        print(f"| {job} | {group} | {n} | {statistics.median(v):.0f}s | {min(v):.0f}s | "
              f"{max(v):.0f}s |")

    meds = {k: statistics.median(v) for k, v in per_test.items()}
    total = sum(meds.values())
    ranked = sorted(meds.items(), key=lambda kv: -kv[1])
    top = sum(d for _, d in ranked[:a.top])
    buckets = defaultdict(int)
    for d in meds.values():
        buckets["<1s" if d < 1 else "1-5s" if d < 5 else "5-20s" if d < 20 else ">20s"] += 1
    print(f"\nSum of medians {total:.0f}s; slowest {a.top} are {top:.0f}s "
          f"({100 * top / total:.0f}%); distribution {dict(buckets)}\n")
    print(f"Slowest {a.top} (median, [min-max] across logs):")
    for (job, group, name), d in ranked[:a.top]:
        v = per_test[(job, group, name)]
        steady = " steady" if len(v) > 2 and d > 1 and (max(v) - min(v)) / d < 0.1 else ""
        print(f"- {d:7.1f}s [{min(v):.1f}-{max(v):.1f}]{steady}  {group} | {name[:110]}")
    print("\n`steady`: nearly the same on every run whatever the machine. Look for a real "
          "sleep, timeout or retry backoff.")


if __name__ == "__main__":
    main()
