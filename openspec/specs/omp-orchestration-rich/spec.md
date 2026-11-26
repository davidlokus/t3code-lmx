# omp-orchestration-rich Specification

## Purpose

Defines live native `omp` orchestration streaming (`task` subagents, `todo`/`todo_write` checklists, interactive `ask`/`form` Q&A) over plain `--mode rpc` without losing T3 host MCP tools, alongside the honest Plan Mode capability boundary.

## Requirements

### Requirement: Plain RPC orchestration feature opt-in

Upon receiving `ready` from `omp` over plain `--mode rpc`, the connection MUST send best-effort `set_subagent_subscription` (`level: "progress"`) and `set_ask_dialog` (`enabled: true`) before forwarding the first `prompt`, while keeping host MCP tool registration intact and degrading to a logged warning if rejected or timed out.

#### Scenario: Startup subscribes before first prompt

- **WHEN** `omp` emits `ready` over `--mode rpc` and the adapter sends a `prompt`
- **THEN** `set_subagent_subscription` (`level: "progress"`) and `set_ask_dialog` (`enabled: true`) are requested before `prompt` is sent, and `set_host_tools` continues to run normally

#### Scenario: Legacy runtime rejection does not fail startup

- **WHEN** `omp` returns `success: false` for `set_subagent_subscription` or `set_ask_dialog`
- **THEN** the connection logs a warning and proceeds with the `prompt` without failing the session

#### Scenario: Runtime without ready frame does not stall prompts

- **WHEN** a mock or legacy process never emits a `ready` frame and `mcpSession` is absent
- **THEN** `prompt` is forwarded immediately with zero artificial timeout delay

### Requirement: Native subagent lifecycle and progress projection

The `omp` protocol layer MUST project `subagent_lifecycle`, `subagent_progress`, and fallback `tool_execution_end` for tool `task` into `subagent.updated` and `turn_item.updated` (`type: "subagent"`) events without regressing terminal statuses or duplicating unchanged snapshots.

#### Scenario: Live subagent lifecycle and progress streaming

- **WHEN** `omp` emits `subagent_lifecycle` (`status: "started"`), then `subagent_progress` with `lastIntent` or `currentTool`, then `subagent_lifecycle` (`status: "completed"`)
- **THEN** T3 emits `subagent.updated` and `turn_item.updated` (`type: "subagent"`) transitioning `running` (with progress text) to `completed` using a stable `subagentId`

#### Scenario: Late progress does not regress a terminal subagent

- **WHEN** a stale `subagent_progress` (`status: "running"`) arrives after `subagent_lifecycle` (`status: "failed"` or `"aborted"` or `"completed"`) for the same subagent id
- **THEN** the translator ignores the stale progress update and preserves the terminal status (`failed`, `interrupted`, or `completed`)

#### Scenario: Task tool end populates final result and serves as fallback

- **WHEN** `tool_execution_end` for `task` arrives with `result.details.results` entries
- **THEN** each entry is projected with its terminal status (`completed`, `failed`, or `interrupted`) and output/error result text, even if subscription frames were absent

### Requirement: Native todo_write plan projection

The `omp` protocol layer MUST project non-error, non-`view` `tool_execution_end` frames for `todo` or `todo_write` containing valid `result.details.phases` into `node.updated`, `plan.updated` (`kind: "todo_list"`), and `turn_item.updated` (`type: "todo_list"`), excluding `abandoned` tasks.

#### Scenario: Valid todo mutation projects ordered steps

- **WHEN** `tool_execution_end` for `todo` or `todo_write` arrives with `isError: false`, `op: "start"`, and phases containing `pending`, `in_progress`, `completed`, and `abandoned` tasks
- **THEN** T3 emits a `todo_list` plan mapping `pending -> pending`, `in_progress -> running`, `completed -> completed`, dropping `abandoned` tasks, and reusing the turn's `planId` on subsequent updates

#### Scenario: View or errored todo is ignored

- **WHEN** `tool_execution_end` for `todo` or `todo_write` has `isError: true` or `details.op === "view"` or invalid `phases`
- **THEN** no `todo_list` plan update is emitted

### Requirement: Interactive ask dialog translation

The `omp` protocol layer MUST translate valid `extension_ui_request` (`method: "ask"`) frames into multi-question `user_input_request` items and encode replies into `omp`-valid `AnswersUiResponse` payloads, cancelling closed on malformed requests.

#### Scenario: Multi-question single and multi-select ask roundtrip

- **WHEN** `omp` sends `extension_ui_request` (`method: "ask"`) with a single-select question and a multi-select question and the user submits answers (including custom text)
- **THEN** T3 sends `{ type: "extension_ui_response", id, answers }` in exact question order where single-select carries either one exact option label or `customInput` (never both) and multi-select splits exact option labels into `selectedOptions` and freeform text into `customInput`

#### Scenario: Malformed ask request fails closed

- **WHEN** `omp` sends `method: "ask"` with an empty, duplicate, or invalid `questions` list
- **THEN** the translator replies immediately with `{ type: "extension_ui_response", id, cancelled: true }` and emits an error notice without creating a pending prompt

### Requirement: Built-in ask tool HTML form dialog translation

The `omp` protocol layer MUST parse supported `extension_ui_request` (`method: "form"`) HTML controls into multi-question `user_input_request` items, encode replies into `omp`-valid `DataUiResponse` payloads matching `omp` cardinality rules, and fail closed with cancellation plus a notice for unsupported forms.

#### Scenario: Supported radio, checkbox, select, and text form roundtrip

- **WHEN** `omp` sends `method: "form"` HTML with `<fieldset><legend>` and radio, multi-option checkbox, single checkbox, `<select>`, and `<textarea>`/`<input type="text">` controls and the user responds
- **THEN** T3 encodes `data` with `string[]` only for multi-option checkboxes or `<select multiple>`, a single `string` for radios, single `<select>`, single checkboxes, and text inputs, never sends unknown field names or disabled options, and preserves hidden fields

#### Scenario: Unsupported form controls fail closed without hanging the turn

- **WHEN** `omp` sends `method: "form"` HTML containing `<input type="file">` or zero named supported controls or conflicting duplicate field names
- **THEN** the translator replies immediately with `{ type: "extension_ui_response", id, cancelled: true }` and emits an error notice so the turn does not stall

#### Scenario: Upstream cancel clears pending ask or form state

- **WHEN** `omp` sends `extension_ui_request` (`method: "cancel"`, `targetId`) for a pending `ask` or `form` request
- **THEN** both the translator and `PiAdapterV2` clear the pending prompt entry cleanly

### Requirement: Honest Plan Mode capability boundary

Because `omp v19.2.1` RPC exposes no native Plan Mode toggle command, `omp` MUST keep `showInteractionModeToggle: false` and document **Plan model** (`--plan`) rather than fabricating an unsupported Plan Mode toggle.

#### Scenario: Provider snapshot keeps interaction mode toggle disabled

- **WHEN** T3 builds an `omp` provider snapshot
- **THEN** `showInteractionModeToggle` remains `false`
