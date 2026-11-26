# Proposal: omp-subagent-inspector-polish

## Why

Live dogfooding of a real multi-subagent `omp v19.2.1` task (`多视角解读项目架构`, 4 parallel `scout` subagents + `todo` checklist) in `T3 Lab (Extend) 0.1.12-lab.6-dogfood.5` uncovered two real async-task bugs and two clear UX gaps:

1. **Stuck `Waiting - task` banner after turn completion (Real Bug)**:
   - `omp v19.2.1` runs multi-agent `task` calls asynchronously (`async: true`): `tool_execution_end(toolName: "task")` fires immediately (1ms, `"Spawned 4 background agents"`), while `omp` continues emitting delayed `tool_execution_update(toolName: "task")` frames for the same `toolCallId` over the next several minutes as background agents run.
   - `PiAdapterV2`'s `emitToolItem` currently lacks a monotonic terminal guard for completed `toolCallId`s, so a late `tool_execution_update` overwrites the completed `task` tool item/node back to `status: "running"` (`completedAt: null`) forever. Even after the turn completes, `derivePendingBackgroundWork` keeps showing `Waiting - task` permanently.
2. **Empty `result` on async background `omp` subagents (Real Bug)**:
   - Because `async: true` `task` calls return `results: []` immediately, the 4 subagents' actual Markdown reports arrive later through TWO other `omp` RPC channels (verified directly from the live session JSONL & binary):
     - `tool_execution_end(toolName: "wait")`: `result.details.jobs[]` entries with `type: "task"` and `resultText` wrapped in `<task-result id="..." ...><output>...</output></task-result>`.
     - `message_end` with `message.role === "custom"` and `message.customType === "async-result"`: `message.details.jobs[]` (`jobId`/`agentId`/`status`) paired with `<task-result id="..." ...><output>...</output></task-result>` blocks inside `message.content`.
3. **Subagent title & progress polish**:
   - Parallel same-type subagents (`ProviderView`, `ClientView`, `RuntimeView`, `ExecutionView` all using `scout`) all render with the identical title `"scout"`, making them indistinguishable in the timeline and Thread HUD Activity card.
   - `subagentProgress` tail-slices `recentOutput` with `text.slice(-200)`, producing mid-word / mid-markdown-link fragments (e.g. `p/src/backend/...`, `4`](pnpm-workspace.yaml...)`).
4. **Native Subagent Right-Panel Inspector & Refined Frontend Presentation**:
   - Clicking a `provider_native` subagent (`childThreadId === null`, covering `omp`, Pi, Claude, Cursor, etc.) currently does nothing (`<div>` instead of `<button>`) in both the timeline (`V2LifecycleRow.tsx`) and the Thread HUD Activity card (`HudActivityCard.tsx`).
   - Users want to click any native subagent to inspect its full Markdown report, assigned task prompt, model, live progress, and timing side-by-side in T3's right panel (`RightPanelTabs`), with multiple subagents openable as peer tabs without disrupting the main chat stream.

## What Changes

### 1. Backend Bugfixes & Async Subagent Enrichment (`provider-omp` + minimal `provider-pi` guard)

- **Monotonic tool completion guard**:
  - In `packages/provider-pi/src/server/adapter.ts` (`// fork:`): track `endedToolCalls: Set<string>` on `ActivePiTurn`; ignore any `tool_execution_update` (`phase === "update"`) for a `toolCallId` that has already received `phase === "end"`.
  - In `packages/provider-omp/src/server/protocol.ts`: also drop late `tool_execution_update` frames for already-ended `toolCallId`s (reset on turn settle/start), preventing async `task` updates from ever regressing `task` back to `running`.
- **Async background subagent result extraction (`packages/provider-omp/src/server/orchestration.ts` & `protocol.ts`)**:
  - Add `OmpSubagentTracker.fromWaitResult(frame)` for `tool_execution_end(toolName === "wait")` (`result.details.jobs[]` with `type === "task"` and `resultText` / `error`).
  - Add `OmpSubagentTracker.fromAsyncResultMessage(frame)` for `message_end` (`message.role === "custom"` & `message.customType === "async-result"`, parsing `<task-result id="...">...<output>...</output></task-result>` / `<error>...</error>` blocks and `details.jobs[]`).
  - Unwrap `<task-result>`/`<output>`/`<error>` cleanly into plain Markdown, raise the safe result cap from `10_000` to `50_000` characters so full architecture reports are preserved, and preserve monotonic terminal status while enriching `result`.
- **Distinguishable subagent titles & clean progress**:
  - Format title cleanly when `description` (short, trimmed) or `taskKey` differs from `agent`: e.g. `ProviderView (scout)` (falling back to `agent` if identical or absent). Pass optional `title` (or formatted display name) cleanly through `t3.subagent_update` → `emitSubagent`.
  - Replace tail-slicing `text.slice(-200)` on `recentOutput` with clean head truncation (`<= 200` chars with `…`), preferring clean prose/heading lines over mid-link markdown fragments.

### 2. Frontend Right-Panel Native Subagent Inspector & Timeline/HUD Refinement (`apps/web`)

- **First-class Right-Panel `subagent` Surface**:
  - `apps/web/src/rightPanelStore.ts`: add `"subagent"` to `RIGHT_PANEL_KINDS`, define `SubagentSurface = { id: \`subagent:\${NodeId}\`; kind: "subagent"; subagentId: NodeId; title: string }`, add `decodeSubagentSurface`, and add `openSubagent(ref, subagentId, title)`.
  - Wire exhaustively in `apps/web/src/closedViewStore.ts`, `apps/web/src/reopenClosedView.ts`, `apps/web/src/components/RightPanelTabs.tsx` (status-aware icon + live title), and `apps/web/src/components/chat/RightPanelSurfaceContent.tsx`.
- **Refined `apps/web/src/fork/subagent/NativeSubagentInspectorPane.tsx` (new)**:
  - Subscribes live to `environmentThreadDetails.threadAtom(parentRef)` for the matching `subagentId` (updates live while running and transitions seamlessly when `result` arrives!).
  - Refined header: `EnvironmentSubagentAvatar` with live status dot, bold title, semantic status pill (`Running` / `Completed` / `Failed` / `Stopped`), model badge (if present), live/final elapsed timer (`SubagentElapsed`), and a **Copy output** button with feedback.
  - Collapsible **Task prompt** section (collapsed to a sleek 2-line preview when `result` is available, expanded while running/empty, one-click expand/collapse).
  - Live **Progress** banner while running (no continuously repainting GPU animations) and full **`<ChatMarkdown>`** rendering of `subagent.result` (with workspace file-link resolution, code blocks, tables, and diagrams).
  - Honest empty/unavailable states if a subagent has no output yet or was removed.
- **Hit Both Entry Points + Refined Subagent Card**:
  - `apps/web/src/components/chat/V2LifecycleRow.tsx`: make `provider_native` subagents (`childThreadId === null && remote === undefined`) interactive `<button>` rows opening the right-panel `subagent` surface via `useRightPanelStore.getState().openSubagent(...)`, showing hover highlight, subtle model badge pill alongside title when available, and the right chevron `>`.
  - `apps/web/src/fork/hud/HudActivityCard.tsx`: make native subagent rows in the Thread HUD Activity panel clickable to open the same right-panel `subagent` surface (`interactive` chevron `>`).
- **Translations (`i18n`)**:
  - Wrap all new user-facing copy in `gt-react` (`<T>` / `useGT` / `msg`), run `vp run i18n:generate`, translate across all 10 locales in `apps/web/src/i18n/translations/*.json`, and pass `vp run i18n:check`.

## Four-Quadrant Defense Matrix

| Quadrant                    | Threat / Edge Case                                                                                                                                                                                                                   | Defense                                                                                                                                                                                                                                                                   |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Input Validation**        | Malformed `<task-result>` XML tags, nested `<output>` tags, non-task `wait` jobs (e.g. bash jobs), oversized async result payloads, invalid persisted `subagent` surface in `localStorage`                                           | Filter `wait`/`async-result` strictly to `type === "task"` or known tracked `subagentId`s; safe non-backtracking tag extraction (no ReDoS); cap `result` at 50,000 chars; strict `decodeSubagentSurface` validation drops corrupted persisted tabs cleanly                |
| **State Consistency**       | Late `tool_execution_update` after `tool_execution_end` reverting `task` to `running`; `wait`/`async-result` arriving after `subagent_lifecycle(completed)` regressing status; deleting/changing thread while `subagent` tab is open | Monotonic `endedToolCalls` guard in both `OmpTranslator` and `PiAdapterV2`; `OmpSubagentTracker` keeps terminal status locked while enriching `result`; `NativeSubagentInspectorPane` renders clean fallback state if `subagent` is absent                                |
| **Concurrency & Lifecycle** | Multiple background subagents completing across both `wait` and `async-result` messages; opening multiple subagent tabs side-by-side; closing & reopening closed subagent tabs (`reopenClosedView`)                                  | Each subagent gets a distinct `subagent:${subagentId}` tab id; deduplication prevents redundant emissions when `wait` and `async-result` report the same job; `closedViewStore` + `reopenClosedView` support undo-close seamlessly                                        |
| **Cross-Surface Isolation** | Breaking `childThreadId !== null` (`delegate_task`) or `remoteChild` subagent navigation; breaking Pi/Claude/Cursor native subagents; violating `shadcn/no-restyle` or GPU animation rules                                           | Existing `childThreadId` and `remote` paths remain primary; native inspector activates ONLY when `childThreadId === null && remote === undefined`; uses existing T3 UI primitives (`Button`, `ScrollArea`, `ChatMarkdown`, `Collapsible`) with zero continuous animations |

## Surface Matrix

| Surface                      | Applies? | Decision                                                                                                                                                               |
| ---------------------------- | -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Entry points                 | Yes      | Timeline `V2LifecycleRow` AND Thread HUD `HudActivityCard` both open the right-panel Subagent Inspector                                                                |
| Clients (Web/Desktop/Mobile) | Yes      | Web & Desktop share `apps/web` right panel; Mobile has no right panel (mobile timeline unchanged, automatically benefits from richer titles/results/bugfix)            |
| Providers                    | Yes      | Bugfix in `provider-omp` + generic monotonic guard in `provider-pi`; Right-Panel Inspector works for ALL `provider_native` subagents (`omp`, Pi, Claude, Cursor, etc.) |
| Contracts                    | No       | Uses existing `OrchestrationV2Subagent` fields                                                                                                                         |
| Reverse states               | Yes      | Right-panel subagent tabs can be opened, switched, closed, and reopened via closed-view history                                                                        |
| Connection modes             | Yes      | Reads existing synced `environmentThreadDetails` projection; works identically on local, remote, and relay connections                                                 |
| Languages (i18n)             | Yes      | All new UI strings in `gt-react`, translated across all 10 locales, verified via `vp run i18n:check`                                                                   |
| Docs                         | No       | Internal UX polish & bugfix; existing `docs/user/providers-omp.md` remains accurate                                                                                    |
