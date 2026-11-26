# Tasks: omp-orchestration-rich

## Group 1: Implementation & Unit/Integration Tests

- [x] 1.1 Create `packages/provider-omp/src/server/orchestration.ts` and `packages/provider-omp/src/server/orchestration.test.ts`:
  - Implement `OmpSubagentTracker` (`subagent_lifecycle`, `subagent_progress`, `tool_execution_end(toolName: "task")` fallback, monotonic terminal state lock, progress extraction, deduplication).
  - Implement `projectOmpTodoWrite` (`tool_execution_end(toolName: "todo_write")` filtering `!isError`, `op !== "view"`, dropping `"abandoned"`, mapping `in_progress` → `running`, phase-prefixing multi-phase lists).
  - Implement `parseOmpAskRequest` / `encodeOmpAskResponse` matching `omp v19.2.1` `gt()` rules verbatim (exact question order/ids, deduplicated exact option labels, single-select mutual exclusion of `selectedOptions` vs `customInput`, fail-closed on malformed requests).
  - Implement pure `parseOmpFormRequest` / `encodeOmpFormResponse` matching `omp v19.2.1` `Ty()`/`Y$()`/`ht()` rules verbatim (radio, multi-checkbox, single-checkbox, select/select-multiple, text/textarea/number, hidden fields, disabled option exclusion, entity decoding, fail-closed on unsupported controls like `type="file"`, conflicting names, empty forms, or oversized HTML).
  - Write comprehensive unit tests in `orchestration.test.ts` covering happy paths, edge cases, and fail-closed guards.

- [x] 1.2 Wire orchestration translation into `packages/provider-omp/src/server/protocol.ts` and `packages/provider-omp/src/server/connection.ts` (plus `protocol.test.ts` and `connection.test.ts`):
  - Route `subagent_lifecycle`, `subagent_progress`, `tool_execution_end` (`task` & `todo_write`), `extension_ui_request` (`ask`, `form`, `cancel`), and `extension_ui_response` (`ask` & `form` reply encoding + map cleanup) inside `makeOmpTranslator()`.
  - On `ready` in `makeOmpRpcConnection`, send best-effort `set_subagent_subscription({ level: "progress" })` and `set_ask_dialog({ enabled: true })` with warn-only degradation and `readyReceived`-gated pre-prompt await (0ms delay when no `ready` frame arrives).
  - Add thorough unit tests in `protocol.test.ts` and `connection.test.ts`.

- [x] 1.3 Add minimal generic `// fork:` hooks to `packages/provider-pi/src/server/adapter.ts` and end-to-end adapter tests in `packages/provider-pi/src/server/adapter.test.ts` and `packages/provider-omp/src/server/adapter.test.ts`:
  - Handle `t3.subagent_update` (delegating to existing `emitSubagent`).
  - Handle `t3.todo_list_update` (allocating/reusing `turn.todoPlanId` and emitting `node.updated` + `plan.updated` + `turn_item.updated` of kind/type `todo_list`).
  - Extend `handleExtensionUiRequest`, `PendingPiPrompt`, and `piUiResponse` to support `method: "ask"` with pre-structured multi-question `questions` and raw `answers` forwarding (preserving existing Pi `select`/`confirm`/`input`/`editor` & `rpiv` behavior 100%).
  - Prove full adapter round-trips in `packages/provider-pi/src/server/adapter.test.ts` and `packages/provider-omp/src/server/adapter.test.ts` (including subagent progress → completion, `todo_write` multi-update plan reuse, `ask` & `form` reply roundtrip, fail-closed unsupported form, and upstream `cancel`).

- [x] 1.4 Update `docs/user/providers-omp.md`:
  - Update the `task` / orchestration section to reflect live subagent progress, `todo_write` task list projection, interactive `ask`/`form` prompts, and the honest Plan Mode boundary (`showInteractionModeToggle` stays off; configure **Plan model**).

- [x] 1.5 Run scoped verification (`vp test run`, `vp run --filter @t3tools/provider-pi typecheck`, `vp run --filter @t3tools/provider-omp typecheck`, scoped `vp lint`, `vp fmt --check`, `vp run knip:check:exports`, and verify zero files outside the exclusive fence).

## Group 2: Cross-Model Review (Author ≠ Reviewer)

- [x] 2.1 Run read-only cross-model review (`devin/swe-2-1`) against plan baseline diff and fix any CRITICAL/WARNING findings until `VERDICT: PASS`.

## Group 3: Falsification, Archive & Ship

- [x] 3.1 Execute 2+ `Broken by hand` RED → GREEN falsifications (e.g. HTML form cardinality/fail-closed guard and subagent terminal-state monotonicity or `ask` single-select exclusivity guard).
- [x] 3.2 Run `vp run check:changed origin/lmx-lab`, `vp test run packages/shared/src/forkIdentity.guard.test.ts`, and `vp run i18n:check`.
- [x] 3.3 Sync `openspec/specs/omp-orchestration-rich/spec.md`, archive change, update `openspec/epics/omp-ecosystem.md` and `FORK.md`, open PR to `davidlokus/t3code-lmx` (`--base lmx-lab`), verify Fork CI green, and squash-merge.
