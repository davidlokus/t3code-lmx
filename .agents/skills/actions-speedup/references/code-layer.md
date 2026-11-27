# Code layer: following a slow test or build step

Read this when the slowest step is the tests or the build itself. The question to answer: is the time in a few tests, spread over code every test shares, or outside the tests altogether.

## 1. Get per-test times

Use existing CI logs first (`scripts/test_times.py` reads Go, node:test, pytest and Jest/Vitest verbose output). Only if the logs have no per-test times, run locally in experiment mode. Keep the repository's own invocation and configuration and only add the flag that prints durations; do not swap the test runner or change test selection.

| Stack         | Flag to add                        | Note                                                                                       |
| ------------- | ---------------------------------- | ------------------------------------------------------------------------------------------ |
| Go            | `-json` or `-v`                    | Add `-count=1` or you read cached results; keep the tags, `-race` and package list CI uses |
| node:test     | `--test-reporter=spec`             |                                                                                            |
| Vitest / Jest | `--reporter=verbose` / `--verbose` |                                                                                            |
| pytest        | `--durations=20`                   |                                                                                            |
| Rust          | nextest JUnit output               |                                                                                            |

Take three or more runs. One run mixes a fast or slow machine with the code.

## 2. Read the distribution

- **A few tests take most of the time**: read each and say what it does. Common: real subprocesses, full database migrations, generating every artifact and checking each. Some are inherent and can only be spread by parallelism; some can share one expensive setup.
- **Spread over many tests**: look at shared helpers (next section).
- **Sum of test times close to the step's wall time**: suggests tests ran one after another, but does not prove it (parent tests include children; setup is not timed). Confirm the actual parallelism:
  - Go: `-p` is across packages, `-parallel` and `t.Parallel()` within a package;
  - node:test: default concurrency is available cores minus one, which is one on small runners;
  - `npm test --workspaces` dispatches workspaces one after another in `workspaces` order;
  - check runner cores and memory first: CPU-bound tests in parallel on two cores can make tests with timeouts flaky.
- **Sum far below wall time**: the time is outside the tests: compiling, generating code, starting databases or containers, rebuilding each package. Or some test times are missing from the log.
- **Some tests take nearly the same time on every run regardless of machine speed** (`test_times.py` marks them `steady`): usually a real sleep, timeout or retry backoff.

## 3. Shared helpers and repeated work

In test helpers and the slowest tests, look for:

- loops that wait a fixed number of times for "settled" or "idle";
- fixed delays: `time.Sleep`, `setTimeout`, `sleep`, polling far slower than the condition needs;
- expensive setup redone per test: starting services, creating databases, migrations, loading the whole app;
- a fake clock still advanced frame by frame or tick by tick;
- an assertion helper that calls the function under test again to build its failure message (template strings and format arguments are evaluated even when the assertion passes);
- a loop that recomputes something not depending on the loop variable;
- the same generation or build step run once per package.

Multiplying one call's cost by the number of calls gives total work; when work runs in parallel, the critical path gains less.

Equivalent changes: hoisting loop invariants, removing a repeated pure call, generating once per run. They do not change what a test observes.

Not equivalent: fewer wait rounds, shorter timeouts, sharing state that each test had to itself. These can stop a test from observing late behaviour or let state leak; treat them by the table in SKILL.md step 6.

## 4. Capabilities already written but unused

Read the test script CI calls (`scripts/test.sh`, `Makefile`, `package.json` scripts), its comments and options: sharding supported but not passed by the workflow, ordering by last run's times without CI keeping the times file, parallelism designed in but ineffective at CI's core count. Enabling them still goes through the table in SKILL.md step 6; existing does not mean safe.

## 5. Local versus CI

Local hardware and OS differ from runners. Use local data to confirm mechanisms (which code is expensive, whether results stay the same after a change), not to predict absolute CI numbers. OS-specific slowness (process creation, file system, antivirus scanning on Windows) has to be read on the same OS or in CI's per-step timings; these are candidates needing log evidence, and turning off security software is not a default recommendation.

## 6. Other causes, by symptom

| Symptom                                                              | Possible cause                                                                                                                              | Look at                                                                                                                                                                       |
| -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Long dependency install                                              | downloads, extraction, native builds, install scripts                                                                                       | which is cached: the download cache or the installed result                                                                                                                   |
| Long `docker build`                                                  | layer cache misses                                                                                                                          | instruction order (copy the manifest, install, then copy source), build context size, cache import/export                                                                     |
| Long service container start                                         | image pulls, health checks, migrations                                                                                                      | whether every job starts them again                                                                                                                                           |
| Long artifact upload/download                                        | size, compression, transfers nobody needs                                                                                                   | bytes, whether downstream uses them                                                                                                                                           |
| Green eventually, but slowly                                         | flaky tests retried, jobs re-run                                                                                                            | retry counts, re-run history                                                                                                                                                  |
| Steps killed or erratic                                              | out of memory, workers above core count                                                                                                     | exit signals, runner size, parallelism settings                                                                                                                               |
| Every test file slow to start                                        | isolation reloading the app per file                                                                                                        | isolation settings; turning isolation off lets tests affect each other, not equivalent                                                                                        |
| Fewer workers than cores                                             | the runner's auto-detection (e.g. `created: 2/2 workers` with psutil counting physical cores)                                               | the worker count the log reports versus the runner's vCPUs                                                                                                                    |
| Tests much slower with coverage on                                   | coverage tracer overhead                                                                                                                    | whether a cheaper tracer is available for the language version (e.g. Python 3.12+ `COVERAGE_CORE=sysmon` when branch coverage is off); compare covered lines before and after |
| Browser e2e tests slower per test than the app's own response time   | traces, videos or screenshots recorded for every test, not only on failure                                                                  | the runner's config (`trace`, `video`, `screenshot`); `retain-on-failure` or `on-first-retry` keep the evidence for failures                                                  |
| A web test suite slow on every request                               | middleware or static-file handling scanning the asset tree per request in test mode (e.g. WhiteNoise autorefresh, dev-server file watching) | test settings for static files; whether tests need assets served at all                                                                                                       |
| Tests that start tools slow, even trivial ones                       | tool lookup walking every directory on `PATH`, or a subprocess spawned per test to discover a tool                                          | cache the lookup once per run; pass the tool path in                                                                                                                          |
| `install-deps` / apt steps with a long tail                          | the Ubuntu mirror stalling                                                                                                                  | the job's container image with the dependencies preinstalled, or dropping packages nobody uses                                                                                |
| apt installs slow even from a fast mirror                            | the man-db trigger rebuilding the manual index after every install                                                                          | `sudo rm -f /var/lib/man-db/auto-update` before installing; one `apt-get update` per job                                                                                      |
| Job start waits on a service container                               | the job blocks until the service image is pulled and healthy                                                                                | start it with `docker run -d` early and wait for readiness just before the tests need it                                                                                      |
| Restoring a dependency cache takes longer than installing            | a multi-GB store (pnpm, Gradle) unpacked on a slow disk, often macOS                                                                        | compare restore time with a cache-miss install on the same OS; turn the cache off there if the install is faster                                                              |
| Browser tests uneven or slower in some shards                        | several browsers per runner competing for its CPUs                                                                                          | the same spec file's time in different shards; one browser process per job and more jobs                                                                                      |
| Sanitized or instrumented tests slow when they start child processes | `LD_PRELOAD` / `DYLD_INSERT_LIBRARIES` or coverage variables inherited by every child                                                       | the child's environment; strip what the child does not need                                                                                                                   |
| The same tests run in two jobs or scripts                            | overlapping globs or a suite also run under another name                                                                                    | the union of test files per job; each file runs in exactly one place                                                                                                          |
| Monorepo runs everything                                             | no selection by dependency graph                                                                                                            | correctness of selection; global config and lockfile changes must run everything                                                                                              |

## 7. Faster tools for the same check

Swaps that teams reported large gains from in 2026. Each changes a tool, so confirm the same checks run with the same outcome (step 6's table), and treat linter or formatter swaps as a team decision.

| Slow                      | Faster                                                                             | Watch out for                                                                     |
| ------------------------- | ---------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| ESLint                    | Oxlint                                                                             | rule coverage differs; type-aware rules may still need ESLint, perhaps only in CI |
| Prettier                  | oxfmt, Biome                                                                       | a one-off formatting diff                                                         |
| `tsc --noEmit`            | TypeScript 7 native (`tsgo`) or the runtime's own checker                          | version support for the repo's TS features; compare the error lists               |
| `pip install`             | `uv pip install` / `uv sync`                                                       | resolution and build-isolation differences; keep the lockfile semantics           |
| serial pytest             | `pytest-xdist`; on Python 3.12+ `COVERAGE_CORE=sysmon` when branch coverage is off | tests sharing files or ports; compare covered lines                               |
| `cargo test`              | `cargo nextest`; `Swatinem/rust-cache`; `sccache`                                  | doctests are not run by nextest                                                   |
| C/C++ rebuilds            | `ccache` / `sccache` with a size cap                                               | cache size; save from the default branch only                                     |
| `docker build`            | Buildx with `cache-from/cache-to: type=gha`                                        | cache size and scope                                                              |
| GitHub's standard runners | larger or third-party runners                                                      | money; get CPU or queue evidence first                                            |
| Vitest isolation per file | `isolate: false`                                                                   | tests leaking state; needs a reset hook. This is not an equivalent change         |
