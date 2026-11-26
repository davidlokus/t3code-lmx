# Proposal: omp-orchestration-rich

## Why

Wave 1 (`bfdbcfba6a`) and Wave 2 (`53dfaf9b05`, `807a4bcb3c`) brought `omp` (oh-my-pi) to first-class profile/path parity, model roles, text generation, usage/quota visibility, budget guardrails, and session import with concurrency leases. However, three native `omp` orchestration capabilities remain opaque inside T3 Lab (Extend) threads:

1. Native `omp` `task` subagents currently appear only as raw `dynamic_tool` blobs instead of live `subagent.updated` / `turn_item.updated(type: "subagent")` cards that also light up the Thread HUD B6 Activity panel.
2. Native `omp` `todo_write` updates remain buried in raw tool output instead of projecting into T3's structured `plan.updated(kind: "todo_list")` and `turn_item.updated(type: "todo_list")` checklist.
3. Native `omp` interactive Q&A — both extension `AskUiRequest` (`method: "ask"`) and the built-in `ask` tool's `FormUiRequest` (`method: "form"`, HTML `<form>`) — are currently ignored by `PiAdapterV2`, causing interactive `omp` questions to stall or fail instead of rendering in T3's existing multi-question `user_input_request` composer flow.

Meanwhile, probing real `/Users/liamx/.local/bin/omp` (`v19.2.1`) confirmed two critical protocol facts:

- All three capabilities work over plain `--mode rpc` without switching to `--mode rpc-ui`, preserving T3's host MCP tools (`set_host_tools` / `host_tool_call`) 100%.
- `omp v19.2.1` RPC has **no** native `set_plan_mode` command or `PlanMode` toggle (`--plan` is a model role and `--plan-yolo` is a startup flag), so `showInteractionModeToggle` MUST remain `false` (honest capability boundary).

## What Changes

- **RPC subscription bootstrap (`packages/provider-omp/src/server/connection.ts`)**: Upon `ready` on plain `--mode rpc`, send best-effort `set_subagent_subscription({ level: "progress" })` and `set_ask_dialog({ enabled: true })` before the first `prompt` (with bounded timeout and warn-only degradation on older runtimes; zero delay when a mock/legacy runtime never emits `ready`).
- **Pure orchestration translator (`packages/provider-omp/src/server/orchestration.ts`)**:
  - Project `subagent_lifecycle`, `subagent_progress`, and fallback `tool_execution_end(toolName: "task")` (`result.details.results`) into generic `t3.subagent_update` frames with monotonic terminal-state protection, progress extraction, and deduplication.
  - Project non-error, non-`view` `tool_execution_end(toolName: "todo_write")` (`result.details.phases`) into generic `t3.todo_list_update` frames (filtering `"abandoned"` tasks, mapping `in_progress` → `running`, preserving phase context when multiple named phases exist).
  - Translate `extension_ui_request(method: "ask")` and supported `extension_ui_request(method: "form")` HTML subsets into generic multi-question `extension_ui_request(method: "ask", questions: OrchestrationV2UserInputQuestion[])` frames, and translate user replies back into strictly validated `AnswersUiResponse` (`answers`) or `DataUiResponse` (`data`), failing closed with `cancelled: true` + error notice for malformed requests or unsupported form controls (`type="file"`, conflicting/empty forms, etc.).
- **Minimal generic `PiAdapterV2` hooks (`packages/provider-pi/src/server/adapter.ts`)**: Add three thin, dialect-agnostic `// fork:` handlers (`t3.subagent_update`, `t3.todo_list_update`, and `extension_ui_request(method: "ask")` multi-question prompt/reply forwarding) without embedding any `omp`-specific parsing or policy in `provider-pi`.
- **User documentation (`docs/user/providers-omp.md`)**: Document live subagent streaming, native `todo_write` task checklists, interactive `ask`/`form` Q&A, and the honest Plan Mode boundary (`omp` uses **Plan model** rather than an RPC Plan toggle).

## Capabilities

### New Capabilities

- `omp-orchestration-rich`: Live native `omp` subagent streaming (`subagent_lifecycle`/`subagent_progress`/`task` fallback), `todo_write` task list projection, and interactive `ask`/`form` Q&A over plain `--mode rpc` with honest Plan Mode capability reporting.

### Modified Capabilities

- None to `omp-provider-core` or `omp-limits-budget` contracts (additive internal translation only; `OmpSettings` unchanged; zero Web/Mobile UI or i18n edits required because existing T3 clients already render `subagent`, `todo_list`, and multi-question `user_input_request` artifacts).

## Impact

- **Exclusive File Fence** (zero overlap with parallel Wave 3b `feat/omp-auth-controller`):
  - `packages/provider-omp/src/server/orchestration.ts` (new)
  - `packages/provider-omp/src/server/orchestration.test.ts` (new)
  - `packages/provider-omp/src/server/protocol.ts`
  - `packages/provider-omp/src/server/protocol.test.ts`
  - `packages/provider-omp/src/server/connection.ts`
  - `packages/provider-omp/src/server/connection.test.ts`
  - `packages/provider-omp/src/server/adapter.test.ts`
  - `packages/provider-pi/src/server/adapter.ts` (minimal generic `// fork:` hooks only)
  - `packages/provider-pi/src/server/adapter.test.ts`
  - `docs/user/providers-omp.md`
  - `openspec/changes/omp-orchestration-rich/**`
- **Explicitly untouched**: `driver.ts`, `status.ts`, `auth.ts` (owned by Wave 3b), `packages/contracts`, `apps/web`, `apps/mobile`, `apps/web/src/i18n/translations/*.json`.

## Surface Matrix

| Surface                      | Applies?        | Decision                                                                                                                                                            |
| ---------------------------- | --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Entry points                 | Yes             | Thread timeline, Thread HUD Activity panel, Composer pending user input panel (all receive standard orchestration-v2 events automatically)                          |
| Clients (Web/Desktop/Mobile) | Yes (automatic) | Zero client edits needed; `subagent.updated`, `plan.updated(kind: "todo_list")`, and multi-question `user_input_request` already render on Web, Desktop, and Mobile |
| Providers                    | Yes             | `omp` implements translation in `provider-omp`; `provider-pi` gains 3 generic dialect-agnostic hooks; Pi default behavior unchanged                                 |
| Contracts                    | No              | Uses existing `OrchestrationV2Subagent`, `OrchestrationV2PlanArtifact(kind: "todo_list")`, and `OrchestrationV2UserInputQuestion`                                   |
| Reverse states               | Yes             | Subagents settle cleanly to `completed`/`failed`/`interrupted`; `ask`/`form` support cancel/dismiss/timeout and upstream `method: "cancel"` cleanup                 |
| Connection modes             | Yes             | Standard server-emitted orchestration events work identically over local, remote, and relay/tunnel sessions                                                         |
| Languages (i18n)             | No              | Zero new UI copy keys in `apps/web` or `apps/mobile`                                                                                                                |
| Docs                         | Yes             | Update `docs/user/providers-omp.md`                                                                                                                                 |
