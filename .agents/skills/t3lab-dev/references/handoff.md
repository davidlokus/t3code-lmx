# Cross-Agent Handoff & Review Protocol (`OpenSpec + hc + agy × omp`)

Battle-tested playbook for splitting L1/L2 Fork work across **Coordinator/UI (`agy`)** and **Data/Logic + Independent Reviewer (`omp`)** inside one feature worktree via **Herdr Core (`hc`)** and **OpenSpec**.

## 1. Role split & ownership boundary

| Phase                                                 | Default Owner                                     | Responsibility                                                                                                                                                                                                                                                                                           | Allowed Writes                                                  |
| ----------------------------------------------------- | ------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| **Phase 1: Plan & Contract**                          | Coordinator (`agy`)                               | Cut feature branch + adjacent worktree (`../t3code-lmx-<topic>`), write OpenSpec artifacts (`proposal.md`, `specs/`, `design.md`, `tasks.md`), run `openspec validate <change> --strict`, and **commit the plan baseline** before delegating                                                             | `openspec/changes/<change>/**`                                  |
| **Phase 2: Group 1 (Data / Store / Pure Logic)**      | Worker (`omp`)                                    | Implement pure logic, stores, backend/contract modules, and unit tests strictly matching `design.md` contracts; check off Group 1 in `tasks.md`                                                                                                                                                          | Explicitly assigned files only + `tasks.md` checkboxes          |
| **Phase 3: Group 2 (UI / Wiring / i18n / Visual QA)** | Coordinator (`agy`)                               | Verify Group 1 tests independently, build UI in `apps/web/src/fork/<area>/`, wire minimal `// fork:` hooks in upstream files, run `i18n:generate` + translate all 10 locales, run browser tests + isolated real-app visual QA (`vp run dev --no-seed` + `ego-browser`)                                   | Group 2 files + translations + `tasks.md`                       |
| **Phase 4: Group 3 (Cross-Model Review & Closeout)**  | Reviewer (`omp`, read-only) → Coordinator (`agy`) | `omp` runs `openspec-verify-change <change>` strictly read-only against `git diff <plan-sha>`, classifies findings (`CRITICAL`/`WARNING`/`SUGGESTION`); `agy` fixes real findings, kills `omp` child, executes `Broken by hand` + mandatory Fork gates + `openspec archive` + `FORK.md` ledger + Fork PR | Reviewer: **none** (read-only); Coordinator: fixes, archive, PR |

### Hard rules

- **Commit the OpenSpec plan before delegating Group 1** so `git diff <plan-sha>` cleanly isolates implementation during cross-review.
- **One active writer per worktree**: run Group 1 → verify → Group 2 sequentially in the shared feature worktree (or use separate worktrees if two agents must edit concurrently).
- **Workers never commit, push, merge, or archive** unless explicitly instructed.
- **Never touch live `~/.t3/userdata`**; linked worktrees automatically isolate dev state under `<worktree>/.t3/userdata` (`vp run dev --no-seed`).

## 2. `hc` orchestration runbook

Confirm `HC_TERMINAL_ID` (your parent terminal ID, e.g. `t84`), then spawn `omp` inside the feature worktree:

```bash
hc spawn --name omp-<topic> --cwd "$WORKTREE" -- \
  omp --provider openai-codex --model gpt-6.2-sol --thinking max --service-tier priority
hc wait omp-<topic> --timeout 60
```

Send Group 1 assignment and wait reactively:

```bash
hc send omp-<topic> "<Group 1 brief>"
hc wait --children all --timeout 300
```

### Operational guardrails

- **Initial `hc send` idle quirk**: if `hc send` reports `idle; it did not start working`, run `hc read --lines 40 omp-<topic>` before resending—the message is often already queued and starts executing a few seconds later.
- **Long-task timeout**: if `hc wait --timeout 300` returns before completion, inspect `hc get omp-<topic>` and `hc read --lines 30 omp-<topic>`, then re-wait instead of spawning a duplicate worker.
- **Reuse the live worker for cross-review**: keep `omp-<topic>` alive after Group 1 so it already has full contract/domain context for Group 3 read-only review.
- **Mandatory cleanup**: once review rounds finish, terminate the child cleanly with `hc kill omp-<topic>` before closing out the worktree.

## 3. Contract & anti-rework checklist

Apply these checks when authoring `design.md` and implementing Group 1 / Group 2 to avoid repeated CI and review rework:

1. **Export discipline (`knip:check:exports`)**: in `design.md`, separate **public consumer exports** from **module-internal helpers**. Do not `export` constants or helpers consumed only inside the same file or only in `*.test.ts`—`vp run check:changed` (`knip 2/2`) fails on unused production exports.
2. **Semantic color tokens (`shadcn/no-raw-colors`)**: in `apps/web`, never use raw Tailwind palettes (`bg-indigo-*`, `text-violet-*`, `text-teal-*`) or undeclared surface names (`bg-info-surface`). Use declared tokens from `apps/web/src/index.css` (`bg-info/12`, `bg-warning/15`, `bg-error/15`, `bg-guest-surface`, `bg-update/15`, `text-update-foreground`, `text-success-foreground`). Never use native HTML `title` attributes as tooltips (`t3code/no-native-title-tooltip`).
3. **Single-source-of-truth projections**: filters, scopes, and groupings must transform the upstream list projection (not only JSX render conditionals) so keyboard jumps, Shift-range selection, drag/sweep actions, and empty states cannot target hidden rows.
4. **Minimal upstream hooks & entry-point parity**: place new logic and shared UI slots under `apps/web/src/fork/<area>/` (or `fork/`) so upstream files keep small `// fork:` hooks. Check Settings panels, command palette, and search rows so no existing toggle becomes a dead no-op.
5. **Visual QA & motion clones**: verify both light and dark themes in `ego-browser`, check popover anchoring so controls do not cover the content being previewed, and scope browser test assertions to live `data-testid` rows (`Sidebar.motion.ts` exit clones strip `data-testid` while retaining `data-slot`).

## 4. Prompt templates

### Group 1 worker brief (`omp`)

```text
Work strictly inside <WORKTREE> on branch <BRANCH> (OpenSpec change: <CHANGE>).
Read openspec/changes/<CHANGE>/{proposal.md,specs/**,design.md,tasks.md} first.

Your scope is ONLY Group 1 (tasks 1.1–1.x):
- Allowed files: <exact file list> + checking off 1.1–1.x in openspec/changes/<CHANGE>/tasks.md.
- Export ONLY public consumer symbols listed in design.md (keep internal-only helpers unexported so knip:check:exports stays green).
- Do NOT edit any upstream component files, and do NOT commit, push, or archive.

Verify before replying:
1. vp test run <group1-test-files>
2. vp lint <group1-files>
3. vp fmt --check <group1-files>
4. vp run --filter <pkg> typecheck

When done, report concise results to parent terminal <PARENT_ID> via:
hc send <PARENT_ID> "<status + files + verification counts>"
```

### Group 3 read-only cross-review brief (`omp`)

```text
Task 3.1 Cross-Review (STRICTLY READ-ONLY — do NOT edit any files, do NOT commit/push/archive):

Follow .agents/skills/openspec-verify-change/SKILL.md for change '<CHANGE>' in <WORKTREE>:
1. Read openspec/changes/<CHANGE>/{proposal.md,specs/**,design.md,tasks.md}.
2. Inspect git status and git diff <PLAN_SHA> plus all new files in apps/web/src/fork/<area>/.
3. Audit:
   - Every Requirement/Scenario in specs/ and contract in design.md.
   - Hidden-row interactions (shortcuts, selection ranges, sweeps, search, empty states) and entry-point parity (Settings, command palette).
   - Edge cases, accessibility/focus restoration, memo/render isolation, React Compiler, shadcn/no-restyle, i18n, and minimal // fork: upstream footprint.
4. Classify findings as CRITICAL / WARNING / SUGGESTION with exact file:line citations (or VERDICT: PASS).
5. Reply to parent terminal <PARENT_ID> via:
hc send <PARENT_ID> "<verdict + findings>"
```
