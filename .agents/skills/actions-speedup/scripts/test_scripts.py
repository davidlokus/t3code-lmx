#!/usr/bin/env python3
"""Offline tests for ci_profile.py and test_times.py. Run: python3 test_scripts.py"""
import contextlib
import importlib.util
import io
import os
import re
import sys
import tempfile
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent


def load(name):
    spec = importlib.util.spec_from_file_location(name, HERE / f"{name}.py")
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def t(sec):
    return f"2026-01-01T00:{sec // 60:02d}:{sec % 60:02d}Z"


def job(name, start, end, conclusion="success", steps=None):
    return {"name": name, "created_at": t(start), "started_at": t(start), "completed_at": t(end),
            "conclusion": conclusion,
            "steps": steps if steps is not None else
            [{"name": "Run tests", "started_at": t(start), "completed_at": t(end),
              "conclusion": conclusion}]}


def run(rid, jobs, event="pull_request", conclusion="success", attempt=1, branch="feature"):
    return {"id": rid, "name": "CI", "path": ".github/workflows/ci.yml", "workflow_id": 1,
            "event": event, "conclusion": conclusion, "status": "completed",
            "run_attempt": attempt, "head_branch": branch, "head_sha": f"{rid:040d}",
            "created_at": t(0), "run_started_at": t(0), "_fake_jobs": jobs}


class FakeGitHub:
    def __init__(self, runs, page_size=100):
        self.runs, self.page_size = runs, page_size

    def __call__(self, path):
        if re.match(r"repos/[^/]+/[^/?]+$", path):
            return {"default_branch": "main"}
        if "/commits?" in path:
            return []
        m = re.search(r"/runs/(\d+)/jobs\?per_page=\d+&page=(\d+)", path)
        if m:
            jobs = next(r["_fake_jobs"] for r in self.runs if r["id"] == int(m[1]))
            page = int(m[2])
            return {"total_count": len(jobs),
                    "jobs": jobs[(page - 1) * self.page_size: page * self.page_size]}
        if "/runs?" in path:
            page = int(re.search(r"[?&]page=(\d+)", path)[1])
            return {"workflow_runs": self.runs if page == 1 else []}
        raise AssertionError(path)


def profile(runs, page_size=100):
    mod = load("ci_profile")
    mod.gh = FakeGitHub(runs, page_size)
    out = io.StringIO()
    argv = sys.argv
    sys.argv = ["ci_profile.py", "--repo", "o/r", "--limit", "50"]
    try:
        with contextlib.redirect_stdout(out):
            mod.main()
    finally:
        sys.argv = argv
    return out.getvalue()


class ProfileTests(unittest.TestCase):
    def test_jobs_beyond_first_page_are_counted(self):
        jobs = [job(f"j{i}", 0, 1) for i in range(100)] + [job("slow", 0, 900)]
        out = profile([run(1, jobs)], page_size=100)
        self.assertIn("created to done: median 15m00s", out)
        self.assertIn("`slow` 1/1", out)

    def test_skipped_job_is_not_the_long_pole(self):
        jobs = [job("test", 0, 30), job("notify", 40, 40, conclusion="skipped")]
        out = profile([run(1, jobs)])
        self.assertIn("`test` 1/1", out)
        self.assertNotIn("`notify`", out.split("last-finishing job")[1].splitlines()[0])

    def test_failures_and_reruns_stay_out_of_timing(self):
        runs = [run(1, [job("test", 0, 600)]),
                run(2, [job("test", 0, 5, "failure")], conclusion="failure"),
                run(3, [job("test", 0, 30)], attempt=2)]
        out = profile(runs)
        self.assertIn("(n=1, too few", out)
        self.assertIn("median 10m00s", out)
        self.assertIn("1 re-run, excluded from timing", out)

    def test_shards_fold_into_one_group(self):
        jobs = [job("Linux (1/3)", 0, 100), job("Linux (2/3)", 0, 300), job("Linux (3/3)", 0, 200)]
        out = profile([run(1, jobs)])
        row = next(l for l in out.splitlines() if l.startswith("| Linux (N/3)"))
        cells = [c.strip() for c in row.strip("|").split("|")]
        self.assertEqual(cells[2], "3")          # shards
        self.assertEqual(cells[7], "5m00s")      # slowest shard
        self.assertEqual(cells[9], "10m00s")     # sum of shards

    def test_matrix_names_are_not_folded(self):
        jobs = [job("test (ubuntu, 1)", 0, 60), job("test (ubuntu, 2)", 0, 60)]
        out = profile([run(1, jobs)])
        self.assertIn("| test (ubuntu, 1) |", out)

    def test_cancelled_run_without_jobs_is_a_signal(self):
        runs = [run(1, [job("test", 0, 60)]),
                run(2, [], event="push", conclusion="cancelled", branch="main")]
        out = profile(runs)
        self.assertIn("cancelled with no recorded jobs", out)

    def test_nearest_rank_p90(self):
        mod = load("ci_profile")
        self.assertEqual(mod.p90([1, 2, 3, 4, 5, 6]), 6)
        self.assertEqual(mod.p90([5]), 5)
        self.assertIsNone(mod.p90([]))


LOG = """test\tRun npm test\t2026-01-01T00:00:00.0000000Z > root@1.0.0 test
test\tRun npm test\t2026-01-01T00:00:00.1000000Z > npm test --workspaces --if-present
test\tRun npm test\t2026-01-01T00:00:01.0000000Z > @a/api@1.0.0 test
test\tRun npm test\t2026-01-01T00:00:01.1000000Z > node --test
test\tRun npm test\t2026-01-01T00:00:02.0000000Z ✔ api does a thing ({ms}ms)
test\tRun npm test\t2026-01-01T00:00:03.0000000Z > test
test\tRun npm test\t2026-01-01T00:00:03.1000000Z > tsx run.ts
test\tRun npm test\t2026-01-01T00:00:04.0000000Z ✔ web renders (500ms)
go\tRun go test\t2026-01-01T00:00:05.0000000Z --- PASS: TestSettle (2.50s)
py\tRun pytest\t2026-01-01T00:00:06.0000000Z 1.25s call     tests/test_x.py::test_wait
"""


class TestTimesTests(unittest.TestCase):
    def test_groups_by_workspace_and_parses_each_runner(self):
        mod = load("test_times")
        with tempfile.TemporaryDirectory() as d:
            paths = []
            for i, ms in enumerate((1000, 1000, 1000)):
                p = os.path.join(d, f"{i}.log")
                Path(p).write_text(LOG.replace("{ms}", str(ms)), encoding="utf-8")
                paths.append(p)
            rows = mod.parse(paths[0])
            groups = {(job, group) for job, group, _, _ in rows}
            self.assertIn(("test", "test #1 @a/api"), groups)
            self.assertTrue(any(g.startswith("test #2") for _, g in groups))
            names = {name for _, _, name, _ in rows}
            self.assertEqual(names, {"api does a thing", "web renders", "TestSettle",
                                     "tests/test_x.py::test_wait"})
            out = io.StringIO()
            argv = sys.argv
            sys.argv = ["test_times.py", *paths, "--top", "3"]
            try:
                with contextlib.redirect_stdout(out):
                    mod.main()
            finally:
                sys.argv = argv
            self.assertIn("steady", out.getvalue())


class DiagnoseTests(unittest.TestCase):
    def test_pauses_and_signals(self):
        mod = load("ci_diagnose")
        log = (
            "build\tStep\t2026-01-01T00:00:00.0000000Z \x1b[1mInstalling collected packages: a, b\x1b[0m\n"
            "build\tStep\t2026-01-01T00:00:50.0000000Z Successfully installed a b\n"
            "build\tStep\t2026-01-01T00:00:51.0000000Z Cache hit occurred on the primary key lint-abc, not saving cache\n"
            "build\tStep\t2026-01-01T00:00:52.0000000Z Cache hit occurred on the primary key setup-python-Linux-pip-x, not saving cache\n"
            "build\tStep\t2026-01-01T00:00:53.0000000Z libpq-dev is already the newest version (16.1).\n"
            "build\tStep\t2026-01-01T00:00:54.0000000Z created: 2/2 workers\n"
        )
        with tempfile.TemporaryDirectory() as d:
            p = Path(d) / "1.log"
            p.write_text(log, encoding="utf-8")
            rows = mod.read_log(p)
            self.assertEqual(rows[0][3], "Installing collected packages: a, b")
            gaps = mod.pauses(rows)
            self.assertEqual(len(gaps), 1)
            self.assertEqual(gaps[0][0], 50)
            hits = {k for k, rx, _ in mod.SIGNALS for r in rows if rx.search(r[3])}
            self.assertTrue({"frozen-cache", "already-installed", "workers"} <= hits)
            frozen = [rx for k, rx, _ in mod.SIGNALS if k == "frozen-cache"][0]
            keys = [frozen.search(r[3])[1] for r in rows if frozen.search(r[3])]
            self.assertEqual([k for k in keys if not mod.DEPENDENCY_CACHE.match(k)], ["lint-abc"])


class WorkflowScanTests(unittest.TestCase):
    def test_hygiene_findings(self):
        mod = load("workflow_scan")
        wf = """name: CI
on:
  push:
  pull_request:
jobs:
  test:
    runs-on: ubuntu-latest
    strategy:
      matrix:
        python: ["3.11", "3.12"]
    steps:
      - uses: actions/checkout@v5
        with:
          fetch-depth: 0
      - uses: actions/setup-python@v6
        with:
          python-version: ${{ matrix.python }}
      - run: pip install -e .[test]
      - run: pytest --cov
      - run: python -m doctest docs/a.md
      - run: python -m doctest docs/a.md
      - uses: actions/cache@v4
        with:
          path: ~/.thing
          key: thing-cache
      - uses: codecov/codecov-action@v5
        if: matrix.python == '3.11'
  lint:
    runs-on: macos-latest
    timeout-minutes: 5
    steps:
      - run: go install example.com/tool@latest
"""
        with tempfile.TemporaryDirectory() as d:
            p = Path(d) / ".github" / "workflows"
            p.mkdir(parents=True)
            (p / "ci.yml").write_text(wf, encoding="utf-8")
            keys = {k for _, _, k, _ in mod.scan(d)}
        for k in ["no-cancel", "double-run", "full-history", "repeated-step", "pip-no-cache",
                  "coverage-every-leg", "static-cache-key", "lint-on-costly-os", "compiled-tool",
                  "no-timeout"]:
            self.assertIn(k, keys)
        # setup-python is not flagged here because an actions/cache step exists in the job.
        self.assertNotIn("setup-no-cache", keys)


if __name__ == "__main__":
    unittest.main(verbosity=1)
