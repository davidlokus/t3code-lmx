# Tasks: omp-subagent-inspector-polish

## Group 1: Backend Bugfixes & Subagent Enrichment

- [ ] 1.1 Add monotonic `endedToolCalls` guard against late `tool_execution_update` after `tool_execution_end`:
  - Guard in `packages/provider-pi/src/server/adapter.ts` (`// fork:`) on `ActivePiTurn` so completed tools never revert to `running` on late updates.
  - Guard in `packages/provider-omp/src/server/protocol.ts` so late `tool_execution_update` frames for ended calls are dropped before reaching the adapter.
  - Pin with regression tests in `packages/provider-pi/src/server/adapter.test.ts`, `packages/provider-omp/src/server/protocol.test.ts`, and `packages/provider-omp/src/server/adapter.test.ts` reproducing the exact async `task` scenario (`tool_execution_end` followed by late `tool_execution_update`).

- [ ] 1.2 Enrich `packages/provider-omp/src/server/orchestration.ts` & `protocol.ts`:
  - Add `OmpSubagentTracker.fromWaitResult(frame)` (`tool_execution_end` for `wait`, extracting `result.details.jobs[]` task results and unwrapping `<task-result>`/`<output>`/`<error>`).
  - Add `OmpSubagentTracker.fromAsyncResultMessage(frame)` (`message_end` with `message.role === "custom"` & `message.customType === "async-result"`, parsing `<task-result id="...">` blocks + `details.jobs[]`).
  - Raise safe `result` cap to `50_000` chars and format distinguishable subagent titles (`ProviderView (scout)` when distinct from `agent`, while keeping clean fallback).
  - Replace tail-slicing `text.slice(-200)` on `recentOutput` with clean head truncation (`<= 200` chars) so live progress never shows broken mid-word/mid-link fragments.
  - Add comprehensive unit & adapter tests in `orchestration.test.ts`, `protocol.test.ts`, and `packages/provider-omp/src/server/adapter.test.ts`.

## Group 2: Frontend Right-Panel Native Subagent Inspector & Card Refinement

- [ ] 2.1 Add `"subagent"` right-panel surface (`RightPanelSurface`) and wire exhaustive handlers:
  - `apps/web/src/rightPanelStore.ts` (`RIGHT_PANEL_KINDS`, `SubagentSurface`, `decodeSubagentSurface`, `openSubagent`).
  - `apps/web/src/closedViewStore.ts`, `apps/web/src/reopenClosedView.ts`, `apps/web/src/components/RightPanelTabs.tsx`, `apps/web/src/components/chat/RightPanelSurfaceContent.tsx`.

- [ ] 2.2 Create `apps/web/src/fork/subagent/NativeSubagentInspectorPane.tsx`:
  - Render live-updating native subagent details: avatar + status dot, title, status badge, model badge, live/final elapsed timer, copy output button, collapsible task prompt card, live progress bar (no continuous animations), full `<ChatMarkdown>` report body, and honest empty/missing states.

- [ ] 2.3 Wire both entry points & polish timeline subagent row:
  - `apps/web/src/components/chat/V2LifecycleRow.tsx`: make `provider_native` subagent rows clickable buttons opening the right-panel `subagent` inspector, with hover state, subtle model pill, and right chevron `>`.
  - `apps/web/src/fork/hud/HudActivityCard.tsx`: make native subagent rows clickable to open the right-panel `subagent` inspector.

- [ ] 2.4 Update i18n catalogs across all 10 locales (`vp run i18n:generate` + translations + `vp run i18n:check`) and add targeted unit/browser tests (rightPanelStore + inspector/HUD/timeline behavior).

- [ ] 2.5 Run scoped verification (`vp test run`, `typecheck` for `provider-pi`/`provider-omp`/`web`, scoped `vp lint`, `vp fmt --check`, `vp run knip:check:exports`, `vp run i18n:check`).

## Group 3: Cross-Model Review, Falsification, Archive & Ship

- [ ] 3.1 Run fresh read-only cross-model review (`devin/swe-2-1`) against plan baseline and resolve any CRITICAL/WARNING findings until `VERDICT: PASS`.
- [ ] 3.2 Execute 2+ `Broken by hand` RED → GREEN falsifications (late `tool_execution_update` regression guard + `async-result`/`wait` result backfill or right-panel subagent open guard).
- [ ] 3.3 Run `vp run check:changed origin/lmx-lab`, `vp test run packages/shared/src/forkIdentity.guard.test.ts`, `vp run i18n:check`, archive OpenSpec, update `FORK.md`, ship PR to `origin/lmx-lab`, verify Fork CI green, squash-merge, and build/install local `0.1.12-lab.6-dogfood.6`.
