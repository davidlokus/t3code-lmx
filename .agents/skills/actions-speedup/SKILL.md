---
name: actions-speedup
description: Find out why GitHub Actions CI is slow and shorten the wait, with run data and a before/after comparison that shows nothing was tested less. Use when CI is too slow, PRs wait too long for checks, tests take forever on Actions, CI minutes are too high, or agents open more PRs than CI can keep up with. 中文：CI 太慢、Actions 提速、PR 等太久、缩短 CI 时间、测试跑太久、CI 跟不上 agent。Not for setting up CI from scratch, non-GitHub-Actions CI, security-only audits, or debugging one failed run.
---

# Actions speedup

Two passes, because each catches what the other misses. A **breadth pass** goes through a 16-item checklist of common CI waste, every item with a verdict. A **depth pass** starts from a script that reads the run history and the logs and lists leads. You then follow the slowest steps inside, to the test helper, build script, cache rule or unused switch where the time actually goes. Finally you show the speedup did not come from testing less. In evaluation, a checklist alone missed causes inside tests and build scripts, and depth alone missed cheap waste off the slowest chain.

Status: trial; see `evals/results.md` for how it was tested and where it falls short.

## Two modes

- **Inspect** (default): read repository files and existing CI runs and logs, and run this skill's scripts. Do not execute the repository's code and do not edit its files. The scripts save logs to a temp folder outside the repository.
- **Experiment** (after the user agrees): run tests locally or on a branch, edit files, within the scope the user agreed to. Do not ask again for what the user has already authorised.

Every write on GitHub (push, open a PR, re-run, comment, change settings) needs its own confirmation.

## Workflow

The scripts are in this skill's `scripts/` folder; call them by absolute path. They need an authenticated `gh` and Python 3.9+, standard library only.

### 1. Set the contract

Write down three things; ask for whatever is missing in one message.

- **Goal**: shorter wait (run created to all jobs done) or fewer runner minutes. They often pull in opposite directions. If the user does not say, optimise the wait.
- **Invariants**: the list of tests (names, not just a count), the OS and version matrix, and the names of required checks. Read required checks with `gh api repos/{owner}/{repo}/rules/branches/{branch}` and the branch-protection endpoint. An empty answer means none are configured; 403 or 404 means you cannot see them. In that case write "unknown, ask the user to check settings" and do not claim which check gates merging.
- **Scope**: which workflows. Treat PR checks, release pipelines and scheduled jobs separately.

### 2. Diagnose

```bash
python3 <skill>/scripts/ci_diagnose.py --repo owner/name --root <local checkout> --limit 60
```

It prints four parts:

1. **The profile**: per workflow and event, from first-attempt successful runs only. It covers created-to-done time with a newer-vs-older trend, the wait before the first job, the last job to finish, each job split into queue / setup / work / unaccounted, the slowest steps, observed runner minutes and signals.
2. **Log reading for the two slowest workflows**: the longest silent pauses in their logs, recurring signals (frozen caches, cache misses, redundant installs, slow downloads, worker counts, configure times, retries, out-of-memory, tools compiled on the spot, submodule clones) and per-test times.
3. **A hygiene scan of the workflow files**: superseded PR runs left running, setup actions without their cache, `pip` without a cache, the same command twice in a job, coverage traced on every matrix leg but uploaded from one, full-history checkouts and submodules, tools compiled on every run, static cache keys, Docker builds without a layer cache, OS-independent checks on macOS or Windows, and missing timeouts.
4. **A numbered list of leads** from all of the above.

Read it with three caveats. Setup versus work is guessed from step names. The last job to finish is not necessarily the one that gates merging. A sample marked `too few` is a lead, not a conclusion.

### 3. Check what is broken before what is slow

Each signal at the end of the profile comes before any tuning. Confirm it, then report it separately from speed findings.

- **The default branch keeps failing**: read the failure and separate real failures from flaky ones. A job that keeps failing may never save the cache it owns, so its timings are not representative.
- **Runs cancelled with no jobs**: check whether that commit was tested by another run. The usual cause is a `concurrency` group. By default a group keeps one pending run, and a newer one replaces it; `cancel-in-progress: false` does not protect pending runs. To run every commit on the default branch, give each run its own group and include the workflow's own name, because groups are repository-wide:
  ```yaml
  concurrency:
    group: <workflow-name>-${{ github.event_name == 'pull_request' && github.ref || github.run_id }}
    cancel-in-progress: ${{ github.event_name == 'pull_request' }}
  ```
  Check GitHub's current concurrency documentation before recommending it; queueing options have changed.
- **Many commits on the default branch with no run**: the gate may no longer be on the path changes take (for example it triggers only on PRs while commits are pushed directly). The timings then describe older code.

### 4. Breadth pass

Go through `references/checklist.md` and give every item a verdict: fixed, proposed, not applicable, or left to the user, each with its evidence or reason. "Not on the slowest chain" is not a reason.

When an item applies and its fix is equivalent (it runs the same checks with the same outcome), fix it at the root rather than working around it. If an install pulls packages nobody needs, stop pulling them; do not just retry the download. If something is downloaded every run, cache it. Leave to the user only what lowers assurance or changes product behaviour.

### 5. Depth pass: account for every lead, then follow the slowest step to its cause

Go through the leads one by one. Open the log around each one, or the code it points at, and mark it **confirmed** (with the cause) or **dismissed** (with the reason). A long pause is a real sleep, a slow download, a step doing heavy silent work, or normal progress; say which. The report lists every lead with its verdict, so none can be skipped.

Then work from the slowest step of the slowest job, and do the same for the next-slowest chain: once the first is fixed, it sets the wait.

- **A test or build step is slow** → read `references/code-layer.md`. Establish three things: whether the time sits in a few tests or is spread over many; whether tests run in parallel or one after another; and whether the same work (code generation, a build, a type check, a configure step) runs several times. Then read the slowest test files, their shared helpers (what is built per test or per request) and any build or configure script that grows with the project, and say what they wait on or compute. If the logs carry no per-test times, say so and use the summary lines they do have.
- **A setup step is slow** → see whether caches actually hit, and check the key, scope and save condition of the action version in use (most save only when the job succeeds). A cache whose key never changes is frozen. That is fine for dependencies keyed on a lockfile, but wrong for build output or tool state, which change while the key does not. Look separately at dependency install, tools compiled on the spot, image pulls, service containers and artifact transfers.
- **Jobs wait before they start** → look at concurrency limits (standard macOS runners on free accounts allow only a few at once, shared across the account), a concurrency group running things in series, and `needs` edges that pass nothing.

Without evidence, do not stop at "the test step is slow, shard it". Sharding spreads the time over more machines; it does not say why the time is spent.

### 6. List candidates, ranked by the contract

One line per candidate: evidence (run ID, log line, code location) → wait saved → runner-minute change → effect on invariants → risk. Mark measured and estimated numbers apart, and leave out anything without evidence. Rank in this order:

1. what saves time without more machines (repeated work, needless waits, broken caches). Within this group, reuse a result before making its computation faster: caching a generated directory or a built wheel is a smaller change than rewriting the code that produces it. Changes to the product's own code come after changes to CI configuration and test code;
2. switching to a faster tool for the same check (see the table in `references/code-layer.md`);
3. parallelism and sharding;
4. bigger runners.

Prefer the smallest change: a setting over a new script, the tool's own option over a reimplementation. A new script that replaces what a tool already does (its executor, its scheduler, its cache) is a maintainer decision, not a default.

Before proposing any of these, check every item in its row:

| Change                                                           | Check                                                                                                                                                                                                                                                                                                                                                                                       |
| ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `paths` filters                                                  | Whether tests, fixtures or generation steps read the ignored paths (grep is a hint, not proof). A workflow-level filter leaves required checks pending forever. A safer pattern: always trigger the workflow, and add a gate job that runs after the others (`if: always()`) and fails on any failure, cancellation or unexpected skip. Handle `merge_group` if the repo uses a merge queue |
| Sharding                                                         | The union of shards runs exactly the original list of tests (compare names, not counts). Check names may change; update required checks or use a gate job. Each shard repeats setup, so runner minutes usually rise; measure them. Choose the shard count from the slowest job's work time over its setup time, and stay within concurrency limits                                          |
| Changing waits, isolation or setup lifetime                      | Same test names and results are necessary, not sufficient: fewer waits can stop a test from observing behaviour that arrives late. Write down the readiness condition that replaces the wait, and repeat runs on the target OS. Do not tune a number until the tests happen to pass; leave such changes to the maintainers by default                                                       |
| Saving a cache when the job fails                                | Keep the condition narrow: the step producing the cache succeeded, the exact key missed, and the run was not cancelled, e.g. `if: ${{ !cancelled() && steps.build.outcome == 'success' && steps.restore.outputs.cache-hit != 'true' }}`. Do not run it next to the action's own save                                                                                                        |
| Swapping a tool                                                  | The new tool must run the same checks with the same outcome on the current code: compare rule coverage and results before and after. Linter and formatter swaps are a team decision. A different cache action, a prebuilt installer for the same tool version, or a test runner that runs the same tests (e.g. nextest for `cargo test`, plus doc tests separately) is not a team decision  |
| Running only affected tests, or moving the full suite to nightly | This lowers pre-merge assurance and is not "invariants unchanged". Hand it to the user as a separate decision                                                                                                                                                                                                                                                                               |
| Bigger or self-hosted runners                                    | Have CPU or memory evidence first. For self-hosted runners the line is trust: untrusted code must not reach credentials, internal networks or reusable writable state. A private repo or a disposable machine does not replace that rule                                                                                                                                                    |

### 7. Change (with the user's agreement)

Once the user has asked for changes, make every candidate that keeps the invariants unchanged, not only the top one. That includes moving OS-independent checks to Linux, running a check once instead of on every leg that gives the same answer, removing a build the tests do not use, turning off a cache that restores slower than a fresh install, replacing a frozen cache, installing a prebuilt tool, cancelling superseded runs and splitting the longest suite.

Not being able to measure a change here is not a reason to leave it unmade: make it, mark its saving as estimated, and list what to confirm on the first real run. A change stays **proposed** only when it lowers assurance (fewer tests, OS legs or feature combinations on PRs), changes product behaviour or code outside CI and tests, or changes what a test can observe (waits, isolation, setup lifetime). Say which of the three applies. A report whose changes do not shorten the wait at all, while it lists equivalent candidates that would, is unfinished.

When committing, make one commit per change; when only drafting, list the changes one by one. After editing a workflow file, check that:

- no new `pull_request_target` or `workflow_run` checks out and runs PR code;
- no `${{ github.event.* }}` or `github.head_ref` is pasted into `run:` (pass it through `env:`, quote it, never `eval` it);
- `permissions` are not widened;
- new third-party actions are pinned to a full commit SHA;
- `actionlint` passes, if it is available.

### 8. Verify on real runs

Push to a branch and compare like with like:

```bash
python3 <skill>/scripts/ci_profile.py --repo owner/name --branch <change-branch> --workflow ci.yml
python3 <skill>/scripts/ci_profile.py --repo owner/name --branch <base-branch> --workflow ci.yml
```

Three runs support "first observation" only. A stable claim needs enough runs after caches warm up, of the same event type and matrix, with cold or warm caches and every failure and retry recorded. If you cannot run CI, start the report with "Not verified on real runs".

### 9. Shorten the agent loop (when agents write the code)

When coding agents push many changes, every red check costs a full CI round trip. Offer, as a separate change:

- a fast local check of the changed files: format, lint and type check in seconds, not the full suite;
- enforcing it with a pre-push git hook instead of an instruction in `AGENTS.md` or `CLAUDE.md`: agents skip written steps, a hook always runs;
- formatting on edit, so agents do not spend a turn on it;
- when many agents share one machine, a cap on concurrent heavy checks (type checks, full test runs) so they do not starve each other.

Measure the local check's time on a typical change and report it.

### 10. Report

```
## Result
Wait from X to Y (measured over n runs / first observation / estimate); runner minutes from A to B.

## Before and after
| Measure | Before | After | Note |
| Created to done (median, event, n) |
| Observed runner minutes per run |
| List of tests | | | must match |
| OS / matrix | | | must match |
| Required checks | | | same, updated, or "unknown" |

## Checklist
all 16 items: fixed / proposed / not applicable / left to the user, each with evidence or reason

## Leads
every lead from ci_diagnose.py: confirmed (cause) or dismissed (reason)

## Where the time went
slowest job → slowest step → cause, each with evidence; then the next-slowest chain

## What changed / what to change
ranked by the contract's goal; each marked measured or estimated

## Broken rather than slow
## Not done, not verified, uncertain
```

## Hard rules

- **No speedup by testing less.** Deleting tests, shrinking the matrix, loosening assertions, skipping checks, or moving pre-merge checks to nightly is a separate decision for the user and never counts as a speedup.
- **Every number has a source and a sample size**: script output, a log, or a measurement. Without runs after the change, do not write "N times faster".
- **Compare like with like**: the same event type, matrix and outcome. Do not set estimates next to measurements as if they were the same thing.
- **State causes so they can be checked.** "Tests are slow" is not a cause; "`fails()` runs `check()` twice per call, 281 calls in the file" is.

## Gotchas

From real repositories. They are leads, not laws.

| What happened                                                                                                                                                                                                                                                                                                                                                          | Hint                                                                                     |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| A Go desktop app's CI took 9.5 minutes, 8 of them in the Windows test step. Two agents using generic methods proposed only sharding (estimated 4.5 minutes). The author's actual change cut a test helper from drawing 31 frames per settle call to 3, fixed a cache, and sharded: about 3 minutes measured.                                                           | When the work step dominates, read the shared test helpers.                              |
| Same repo: the Go cache was saved only by passing jobs, the default branch had been red for days, and every run built from scratch.                                                                                                                                                                                                                                    | A job that keeps failing may never save its cache.                                       |
| Same repo: `concurrency` grouped by `github.ref`; pending runs on the default branch were replaced and some commits never ran.                                                                                                                                                                                                                                         | Investigate runs cancelled with no jobs.                                                 |
| Same repo: "skip CI for docs-only changes" would have skipped a test that reads `docs/SETTINGS.md` and checks it against the code.                                                                                                                                                                                                                                     | Before a paths filter, find who reads those paths.                                       |
| A repository waited over 20 minutes per PR, almost all of it in one test command; setup took seconds. Its workspaces ran one after another, an assertion helper recomputed the check to build its error message, and a loop regenerated output that did not depend on the loop variable.                                                                               | Look for repeated work before adding parallelism.                                        |
| A CI gate triggered only on PRs while changes were pushed straight to the default branch, so recent commits had never run.                                                                                                                                                                                                                                             | Confirm the gate is still on the path changes take.                                      |
| A Python library's slowest job rebuilt an ontology-derived cache in every run. An agent following the slow test rewrote 60 lines of product code to make the build 2.6× faster. The maintainers instead kept the cache directory between runs. The same agent dismissed cancelling superseded PR runs as "minutes only", and a generic checklist beat it on that repo. | Cache the result before optimising the computation, and do the hygiene pass.             |
| A C firmware repo's test job spent 60–110 s in CMake configure. A generic method logged the number as setup. Following it into the build script found a linear lookup in a ~22k-entry list on every call, quadratic overall.                                                                                                                                           | A configure or generate step that grows with the project is code, not setup. Read it.    |
| An e2e suite's setup ran `playwright install --with-deps`, which apt-installed fonts the runner did not need and stalled for ten minutes when the mirror failed. The agent with this skill confirmed the lead and proposed adding a retry. The maintainers dropped `--with-deps` and cached the browser.                                                               | Remove the cause; do not retry around it.                                                |
| A Python repo's slowest workflow was the docs build, so agents with and without this skill ignored the test workflow. The maintainers' own speedup was removing needless sleeps and probe timeouts from the tests there. Even when told to scan the next chain, an agent skipped it.                                                                                   | Next-slowest chains get the same treatment, and every lead gets a verdict in the report. |
