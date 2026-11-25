# Cross-Agent Handoff & Review Protocol (`OpenSpec + hc + agy × omp`)

Battle-tested playbook for splitting L1/L2 Fork work and multi-PR parallel Waves across **`agy`** and **`omp`** via **Herdr Core (`hc`)**, **`fork/scripts/worktree-task.mjs`**, and **OpenSpec**.

## 1. Role split & ownership boundary

| Phase                                                 | Default Owner                                            | Responsibility                                                                                                                                                                                                                                                                                                                                                                                                               | Allowed Writes                                                  |
| ----------------------------------------------------- | -------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| **Phase 1: Ground-Truth & Plan**                      | Coordinator (`agy`)                                      | Open worktree via `node fork/scripts/worktree-task.mjs open <topic>`. When consuming provider runtime data, **sample real payloads** (`omp` + ≥1 upstream provider) first and record the **Payload Truth Table** + **4-Quadrant Defense Matrix**. Write OpenSpec artifacts (`proposal.md`, `specs/`, `design.md`, `tasks.md`), run `openspec validate <change> --strict`, and **commit the plan baseline** before delegating | `openspec/changes/<change>/**`                                  |
| **Phase 2: Group 1 (Data / Store / Pure Logic)**      | Worker (`omp`)                                           | Implement pure logic, stores, backend/contract modules, and unit tests strictly matching `design.md` / `proposal.md` contracts; check off Group 1 in `tasks.md`                                                                                                                                                                                                                                                              | Explicitly assigned files only + `tasks.md` checkboxes          |
| **Phase 3: Group 2 (UI / Wiring / i18n / Visual QA)** | Coordinator (`agy`)                                      | Verify Group 1 tests independently, build UI in `apps/web/src/fork/<area>/`, wire minimal `// fork:` hooks in upstream files, run `i18n:generate` + translate all 10 locales, pass the **Pre-Review Gate** (`fmt`, `lint`, affected `typecheck` & tests), and run isolated real-app visual QA (`vp run dev --no-seed` + `ego-browser`)                                                                                       | Group 2 files + translations + `tasks.md`                       |
| **Phase 4: Group 3 (Cross-Model Review & Closeout)**  | Fresh Reviewer (Author ≠ Reviewer) → Coordinator (`agy`) | Spawn a **fresh read-only** reviewer session on the opposite model (`omp-review-<topic>` for full-stack/UI PRs; `agy` read-only review when `omp` wrote a pure-backend PR), run `openspec-verify-change <change>` against `git diff <plan-sha>`, classify findings (`CRITICAL`/`WARNING`/`SUGGESTION`); Coordinator fixes real findings, kills `hc` children, runs `Broken by hand` + Fork gates + archive + PR              | Reviewer: **none** (read-only); Coordinator: fixes, archive, PR |

### Hard rules

- **Heterogeneous Author ≠ Reviewer**: the review model MUST differ from the primary write model. For pure-backend / adapter PRs where `omp` authors the code, `agy` runs the read-only review (or vice versa)—never self-review with the same model.
- **Fresh read-only Reviewer session**: Group 3 Reviewer MUST run in a **fresh read-only** session (e.g. a new `omp-review-<topic>` worker after killing the Group 1 writer) rather than reusing the Group 1 author session, preventing author blind spots from leaking into verification.
- **Sample real Provider payloads before designing**: whenever a feature reads provider usage, cost, model options, tool items, or transcripts, inspect real payloads (`~/.omp/agent/sessions/*.jsonl`, `omp --mode rpc`, or real adapter output) for `omp` plus at least one upstream provider before locking `design.md` or L1+ `proposal.md`. Never guess fixture shapes.
- **Commit the OpenSpec plan before delegating Group 1** so `git diff <plan-sha>` cleanly isolates implementation during cross-review.
- **Pre-Review Gate before Group 3**: Coordinator MUST pass `vp fmt --check`, `vp lint`, `vp run --filter <affected> typecheck`, and `vp test run <affected>` **before** invoking the Reviewer—never waste a cross-model review round catching compiler or lint errors. Aim for **1–2 review rounds** by completing the Pre-Code Matrices up front.
- **One active writer per worktree**: run Group 1 → verify → Group 2 sequentially in a single worktree; use separate worktrees when running parallel PRs in a Wave.
- **Workers never commit, push, merge, or archive** unless explicitly instructed.
- **Never touch live `~/.t3/userdata`**; linked worktrees automatically isolate dev state under `<worktree>/.t3/userdata` (`vp run dev --no-seed`).

## 2. Multi-PR & Parallel Wave Orchestration (Epic Mode)

For large features split into ≥ 2 PRs across sequential/parallel Waves:

1. **Epic Charter (`openspec/epics/<epic>.md`)**: keep a single-page charter (see `openspec/epics/README.md`) locking shared contract fields, Wave DAG, **File Ownership Fence** (disjoint writable paths per PR), and PR/SHA status.
2. **Worktree lifecycle via script**: manage all Wave worktrees with `node fork/scripts/worktree-task.mjs`:
   - `open <topic> [--prefix feat|chore|fix] [--base origin/lmx-lab]` (validates slug & fork origin, respects `.t3/setup-running` live PID, runs `vp i`);
   - `status [--fetch] [--json]` (audits branch, dirty count, ahead/behind, deps, active OpenSpec changes across all worktrees);
   - `close <topic> [--force] [--keep-branch]` (refuses main repo, protected branches, cwd-inside-target, and dirty trees).
3. **Parallel Wave cap**: run at most **2–3 concurrent worktrees** per Wave, with one dedicated `hc` worker (`omp-<topic>`) per worktree and zero overlap across their File Ownership Fences.
4. **Low-conflict merge discipline**:
   - **Single i18n writer per Wave**: at most **1 PR per Wave** edits `apps/web/src/i18n/translations/*.json`.
   - **Defer shared ledgers**: defer `FORK.md`「分叉改动台账」and `LESSONS.md` edits until final pre-merge rebase or the Wave closeout PR so parallel PRs never collide on root markdown tails.
   - **Wave-level Dogfood**: run local macOS DMG overwrite install (`bash fork/scripts/install-local-mac.sh <ver>`) at **Wave closeout** rather than per pure-backend intermediate PR.

## 3. `hc` orchestration runbook

Confirm `HC_TERMINAL_ID` (your parent terminal ID, e.g. `t84`), open the worktree with `node fork/scripts/worktree-task.mjs open <topic>`, then launch `omp` in the background inside the feature worktree:

```bash
hc run --bg --name omp-<topic> --cwd "$WORKTREE" -- \
  omp --provider openai-codex --model gpt-6.2-sol --thinking max --service-tier priority
hc wait omp-<topic> --timeout 60
```

Send Group 1 assignment and wait reactively:

```bash
hc send omp-<topic> "<Group 1 brief>"
hc wait --children all --timeout 300
```

When Group 1 finishes and passes verification, kill the writer (`hc kill omp-<topic>`) and spawn a **fresh read-only** reviewer (`hc run --bg --name omp-review-<topic> ...`) for Group 3 (or let `agy` perform read-only review when `omp` authored a pure-backend PR).

### Operational guardrails

- **Initial `hc send` idle quirk**: if `hc send` reports `idle; it did not start working`, run `hc read --lines 40 omp-<topic>` before resending—the message is often already queued and starts executing a few seconds later.
- **Long-task timeout**: if `hc wait --timeout 300` returns before completion, inspect `hc get omp-<topic>` and `hc read --lines 30 omp-<topic>`, then re-wait instead of spawning a duplicate worker.
- **Mandatory cleanup**: terminate every `hc` child cleanly (`hc kill omp-<topic>` / `hc kill omp-review-<topic>`) before closing out or removing the worktree.

## 4. Pre-code matrices & anti-rework checklist

Fill both pre-code tables in `design.md` (L2) or `proposal.md` (L1+) before writing code so subtle protocol, cache, and fleet bugs are caught before Round 1 Review:

### Provider Payload Truth Table (`LESSONS.md #5`)

| Provider | Endpoint / File | Redacted observed fields & types | Empty / `0` / unstarted / `429` / expired behavior | Poll / rate-limit cadence |
| -------- | --------------- | -------------------------------- | -------------------------------------------------- | ------------------------- |

### 4-Quadrant Defense Matrix (`LESSONS.md #9`)

| Quadrant                                         | Mandatory design & test assertion                                                                                                              |
| ------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| **1. Legacy server missing optional fields**     | Gate UI/logic on server-echoed fields & `contributingEnvironments`; never fabricate `$0` or silently ignore active filters on mixed fleets     |
| **2. Probe / async failure retains last-good**   | Preserve `previousSuccess` safely on error; pin query keys/anchors so failure states never oscillate or overwrite downgrade flags              |
| **3. Multi-account / multi-instance isolation**  | Isolate per-instance runtime dirs/env (never inherit another provider's env, `LESSONS.md #6`); use canonical dedupe keys to avoid double-count |
| **4. Cache / storage versioning & invalidation** | Bump schema/cache filename version atomically, globally grep all old version references & upgrade tests, and handle corrupt/stale entries      |

### Contract & UI anti-rework checklist

1. **Export discipline (`knip:check:exports`)**: in `design.md`, separate **public consumer exports** from **module-internal helpers**. Do not `export` constants or helpers consumed only inside the same file or only in `*.test.ts`—`vp run check:changed` (`knip 2/2`) fails on unused production exports.
2. **Semantic color tokens (`shadcn/no-raw-colors`)**: in `apps/web`, never use raw Tailwind palettes (`bg-indigo-*`, `text-violet-*`, `text-teal-*`) or undeclared surface names (`bg-info-surface`). Use declared tokens from `apps/web/src/index.css` (`bg-info/12`, `bg-warning/15`, `bg-error/15`, `bg-guest-surface`, `bg-update/15`, `text-update-foreground`, `text-success-foreground`). Never use native HTML `title` attributes as tooltips (`t3code/no-native-title-tooltip`).
3. **Single-source-of-truth projections**: filters, scopes, and groupings must transform the upstream list projection (not only JSX render conditionals) so keyboard jumps, Shift-range selection, drag/sweep actions, and empty states cannot target hidden rows.
4. **Minimal upstream hooks & entry-point parity**: place new logic and shared UI slots under `apps/web/src/fork/<area>/` (or `fork/`) so upstream files keep small `// fork:` hooks. Check Settings panels, command palette, mobile exhaustive maps, and search rows so no existing toggle or union becomes stale.
5. **Base UI overlay stacking**: never nest a second Base UI `<Popover>` inside an existing popover container (such as `ThreadDetailsCard`)—it paints behind the parent popover or triggers parent focus-out dimming. Use native `<Menu>` + `<MenuCheckboxItem variant="switch" closeOnClick={false}>` and exempt its container attribute in the parent's `onOpenChange` guard.
6. **Visual QA & motion clones**: verify both light and dark themes in `ego-browser`, check popover anchoring so controls do not cover the content being previewed, and scope browser test assertions to live `data-testid` rows (`Sidebar.motion.ts` exit clones strip `data-testid` while retaining `data-slot`).

## 5. Prompt templates

### Group 1 worker brief (`omp`)

```text
Work strictly inside <WORKTREE> on branch <BRANCH> (OpenSpec change: <CHANGE>).
Read openspec/changes/<CHANGE>/{proposal.md,specs/**,design.md,tasks.md} (and Epic Charter if referenced) first.

Your scope is ONLY Group 1 (tasks 1.1–1.x):
- Allowed files (File Ownership Fence): <exact file list> + checking off 1.1–1.x in openspec/changes/<CHANGE>/tasks.md.
- Satisfy all rows of the Payload Truth Table and 4-Quadrant Defense Matrix in design.md / proposal.md.
- Export ONLY public consumer symbols listed in the plan (keep internal-only helpers unexported so knip:check:exports stays green).
- Do NOT edit any upstream component files, and do NOT commit, push, or archive.

Verify before replying:
1. vp test run <group1-test-files>
2. vp lint <group1-files>
3. vp fmt --check <group1-files>
4. vp run --filter <pkg> typecheck

When done, report concise results to parent terminal <PARENT_ID> via:
hc send <PARENT_ID> "<status + files + verification counts>"
```

### Group 3 fresh read-only cross-review brief (Author ≠ Reviewer)

```text
Task 3.1 Cross-Review (FRESH READ-ONLY SESSION — do NOT edit any files, do NOT commit/push/archive):

Follow .agents/skills/openspec-verify-change/SKILL.md for change '<CHANGE>' in <WORKTREE>:
1. Read openspec/changes/<CHANGE>/{proposal.md,specs/**,design.md,tasks.md} (and Epic Charter if referenced).
2. Inspect git status and git diff <PLAN_SHA> plus all new files added by this change.
3. Audit four universal dimensions (checking both Group 1 and Group 2 edge cases from scratch):
   - Real provider & data boundaries: Payload Truth Table fidelity, model/account switches, unpriced/zero/unstarted/429/expired fields, and non-fabrication invariants.
   - 4-Quadrant Defense Matrix: legacy server missing optional fields, probe/async failure retaining last-good without oscillation, multi-account/instance isolation & anti-double-count, cache versioning & invalidation.
   - Cross-surface & UX parity: Settings/palette/search/Web/Mobile exhaustive types, accessibility/focus restoration, React Compiler & render isolation, `shadcn/no-restyle`, and 10-locale i18n.
   - Minimal `// fork:` upstream footprint, File Ownership Fence compliance, and zero unused exports.
4. Classify findings as CRITICAL / WARNING / SUGGESTION with exact file:line citations (or VERDICT: PASS).
5. Reply to parent terminal <PARENT_ID> via:
hc send <PARENT_ID> "<verdict + findings>"
```
