# Design: omp-orchestration-rich

## 1. Real Binary Ground-Truth Table (`omp v19.2.1`, `/Users/liamx/.local/bin/omp`)

All wire contracts below were verified directly against `/Users/liamx/.local/bin/omp` (`v19.2.1`) bundled runtime code and live isolated `--mode rpc` execution (in a throwaway `HOME`, never touching live `~/.omp` or `~/.t3/userdata`).

### 1.1 RPC Startup & Feature Opt-In (Plain `--mode rpc`)

- Live test (`omp --mode rpc --no-session --no-extensions`):
  - `{"id":"2","type":"set_ask_dialog","enabled":true}` → `{"id":"2","type":"response","command":"set_ask_dialog","success":true,"data":{"enabled":true}}`
  - `{"id":"3","type":"set_subagent_subscription","level":"progress"}` → `{"id":"3","type":"response","command":"set_subagent_subscription","success":true,"data":{"level":"progress"}}`
- **No switch to `--mode rpc-ui`**: Keeping plain `--mode rpc` preserves `set_host_tools`, `host_tool_call`, `host_tool_cancel`, and `host_tool_result` without losing T3 MCP tools.
- **No Plan Mode toggle in RPC**: `omp v19.2.1` RPC command set has no `set_plan_mode` command or `PlanMode` session state (`--plan` is a model role, `--plan-yolo` is a startup flag). `OMP_PRESENTATION.showInteractionModeToggle` remains `false`.

### 1.2 Subagent Streaming (`subagent_lifecycle`, `subagent_progress`, `task` fallback)

Verified from `omp` RPC schema bundle & `SubagentTracker` (`handleLifecycle` / `handleProgress`):

- `subagent_lifecycle`:
  ```json
  {
    "type": "subagent_lifecycle",
    "payload": {
      "id": "sub-1",
      "index": 0,
      "agent": "explore",
      "agentSource": "bundled",
      "description": "Search codebase",
      "status": "started | completed | failed | aborted",
      "sessionFile": "/.../sub.jsonl",
      "parentToolCallId": "call_123",
      "detached": false
    }
  }
  ```
- `subagent_progress`:
  ```json
  {
    "type": "subagent_progress",
    "payload": {
      "index": 0,
      "agent": "explore",
      "agentSource": "bundled",
      "task": "Find all auth hooks",
      "assignment": "...",
      "parentToolCallId": "call_123",
      "sessionFile": "/.../sub.jsonl",
      "detached": false,
      "progress": {
        "id": "sub-1",
        "status": "pending | running | completed | failed | aborted",
        "description": "Search codebase",
        "currentTool": "grep",
        "currentToolArgs": "pattern",
        "lastIntent": "Inspecting auth routes",
        "recentOutput": ["..."],
        "model": "openai-codex/gpt-5.4-mini"
      }
    }
  }
  ```
- `tool_execution_end` (`toolName === "task"`):
  - `result.details.results[]`: `{ id, index, agent, agentSource, task, assignment, description, exitCode, output, stderr, error, aborted, modelOverride }`.
- Status mapping:
  - `"pending"` → `"pending"`
  - `"started"` | `"running"` → `"running"`
  - `"completed"` → `"completed"`
  - `"failed"` → `"failed"`
  - `"aborted"` → `"interrupted"`
  - Fallback from `task` `SingleResult`: `aborted === true` → `"interrupted"`, else `(exitCode ?? 0) !== 0 || Boolean(error)` → `"failed"`, else `"completed"`.

### 1.3 Native `todo_write` Tool (`H9` validator in `omp`)

Verified from `omp` `todo_write` handler:

- `tool_execution_end` with `toolName === "todo_write"`:
  ```json
  {
    "type": "tool_execution_end",
    "toolCallId": "call_todo_1",
    "toolName": "todo_write",
    "isError": false,
    "result": {
      "details": {
        "op": "init | start | done | rm | drop | append | view",
        "phases": [
          {
            "name": "Phase 1",
            "tasks": [
              {
                "content": "Inspect schema",
                "status": "pending | in_progress | completed | abandoned"
              }
            ]
          }
        ]
      }
    }
  }
  ```
- Ignore when `isError === true`, `op === "view"`, or `phases` fails structural validation.
- Drop tasks with `status === "abandoned"`. Map `pending -> pending`, `in_progress -> running`, `completed -> completed`.
- When multiple phases contain visible tasks and have non-empty names, format step text as `[<phase.name>] <task.content>`; when only a single phase has visible tasks (or phase name is blank), use `<task.content>` verbatim.

### 1.4 `AskUiRequest` (`method: "ask"`) & `gt()` Validator

Verified from `omp` `rpc-mode.ts` `gt()`:

- Request:
  ```json
  {
    "type": "extension_ui_request",
    "id": "ui-1",
    "method": "ask",
    "timeout": 60000,
    "questions": [
      {
        "id": "q1",
        "question": "Which runtime?",
        "header": "Runtime",
        "multi": false,
        "recommended": 0,
        "options": [{ "label": "Node", "description": "Node 22", "preview": "..." }]
      }
    ]
  }
  ```
- Response (`AnswersUiResponse`):
  ```json
  {
    "type": "extension_ui_response",
    "id": "ui-1",
    "answers": [
      { "id": "q1", "selectedOptions": ["Node"] },
      { "id": "q2", "selectedOptions": [], "customInput": "custom answer" }
    ]
  }
  ```
- Strict `omp` `gt()` constraints enforced by `OmpTranslator.toOmp`:
  1. `answers.length === questions.length` and `answers[i].id === questions[i].id`.
  2. Every element of `selectedOptions` MUST be an exact option `label` from `questions[i].options`, with NO duplicates.
  3. If `!question.multi` (single-select): `selectedOptions.length <= 1` AND NEVER set both non-empty `selectedOptions` and `customInput`.
  4. `customInput` MUST be a non-empty trimmed string if present (omit when empty).

### 1.5 `FormUiRequest` (`method: "form"`) & `Ty()`/`ht()`/`Y$()` Validators

Verified from `omp` `tools/html-form/data.ts` (`Y$`, `Cp`, `_f`) and `rpc-mode.ts` (`yt`, `ht`, `H`, `mt`, `Me`):

- Request: `{ type: "extension_ui_request", id: "ui-2", method: "form", html: "<form>...</form>", timeout?: number }`.
- Critical `omp` `Y$(field)` cardinality rule:
  - `isMultiArray(field) = field.multi && field.options.length > 1`.
  - Multi-option `<input type="checkbox">` (2+ options with same `name`) and `<select multiple>` with 2+ options MUST be sent as `string[]` in `DataUiResponse.data[name]`.
  - `<input type="radio">`, single `<select>`, **single-option checkbox (`options.length === 1`)**, `<select multiple>` with 1 option, and text/textarea/number inputs MUST be sent as a single `string` (NOT an array!) or omitted when empty/unchecked!
- Critical `omp` `other` (custom answer) rule from `Ty()`:
  - `field.other = field.kind === "choice" && !field.select && field.options.length >= 2 && !field.options.some(o => /^\s*other\b/i.test(o.label))`.
  - Only choice fields where `field.other === true` may receive a freeform custom string; `<select>` and single checkboxes set `allowCustomAnswer: false`!
- Default values from `Ty()`:
  - Radio/checkbox `value`: `attr("value") ?? "on"`.
  - `<option>` `value`: `attr("value") ?? normalizedInnerText`.
  - Disabled options (`disabled` attribute) MUST be excluded from selectable options (`ht()` throws `"carries disabled option"`).
  - Hidden inputs (`<input type="hidden" name="..." value="...">`): allowed in `data` (and `omp` pre-populates them from `o.hidden`, so we keep hidden field names out of user questions).
  - Button inputs (`submit`, `reset`, `button`, `image`): ignored just like `omp`'s `x[o]`.
  - Unsupported controls (`<input type="file">`, `<input type="color">`, `<input type="date">`, `<input type="datetime-local">`, `<input type="month">`, `<input type="week">`, `<input type="time">`, or forms with zero named supported fields, or conflicting duplicate field names of mixed kinds, or HTML > 256 KiB): fail closed immediately with `{ type: "extension_ui_response", id, cancelled: true }` + error `notify` frame.

## 2. Architecture & Component Boundaries

### 2.1 `packages/provider-omp/src/server/orchestration.ts` (New Pure Module)

Holds 100% of `omp`-specific parsing, state tracking, and response encoding:

- `OmpSubagentTracker`: tracks known subagents per connection, handles `subagent_lifecycle`, `subagent_progress`, and `tool_execution_end(toolName: "task")`, enforces monotonic terminal states and change-deduplication, returns `t3.subagent_update` frames.
- `projectOmpTodoWrite(frame)`: validates `tool_execution_end(toolName: "todo_write")` and returns `t3.todo_list_update` frame (or `undefined`).
- `parseOmpAskRequest(frame)` & `encodeOmpAskResponse(descriptor, reply)`: validates `AskUiRequest`, produces `OrchestrationV2UserInputQuestion[]`, and encodes `AnswersUiResponse` honoring every `gt()` rule.
- `parseOmpFormRequest(frame)` & `encodeOmpFormResponse(descriptor, reply)`: parses HTML form subset (pure deterministic tag/entity parser, zero DOM/external dependencies), produces `OrchestrationV2UserInputQuestion[]`, and encodes `DataUiResponse` honoring every `Ty()`/`Y$()`/`ht()` rule.

### 2.2 `packages/provider-omp/src/server/protocol.ts`

Integrates `orchestration.ts` inside `makeOmpTranslator()`:

- `fromOmp`:
  - `subagent_lifecycle`, `subagent_progress` → `t3.subagent_update` frames (swallowing raw frames).
  - `tool_execution_end`: forwards original `tool_execution_end` frame PLUS any `t3.subagent_update` (for `task`) or `t3.todo_list_update` (for `todo_write`).
  - `extension_ui_request`:
    - `method === "ask"` → translates via `parseOmpAskRequest` (or fail-closed cancel + error notify).
    - `method === "form"` → translates via `parseOmpFormRequest` (or fail-closed cancel + error notify).
    - `method === "cancel"` → deletes `targetId` from pending `approvals`, `askRequests`, and `formRequests` maps, then forwards the cancel frame to `PiAdapterV2`.
    - existing approval detection (`approvalAsConfirm`) unchanged.
- `toOmp`:
  - `extension_ui_response`: checks `askRequests` and `formRequests` maps (alongside existing `approvals`), deletes the entry, and encodes `AnswersUiResponse` / `DataUiResponse` / `CancelUiResponse` (pushing a warning notice if reply was malformed and had to cancel).

### 2.3 `packages/provider-omp/src/server/connection.ts`

- On `ready`:
  - Track `readyReceived = true`.
  - Fork `initializeSessionFeatures()` (in parallel with `registerHostTools()` when `mcp` is present, or standalone when `mcp` is absent), sending best-effort:
    - `raw.request({ type: "set_subagent_subscription", level: "progress" })`
    - `raw.request({ type: "set_ask_dialog", enabled: true })`
      each guarded with timeout + `Effect.catch` warn-only logging, then completing `sessionFeaturesReady`.
- Before sending `prompt`:
  - Keep existing `afterHostTools` when `mcp !== undefined`.
  - Also await `sessionFeaturesReady` (bounded timeout, e.g. 5s) ONLY when `readyReceived === true` so real `omp` sessions never race feature opt-in against the first prompt, while mock/legacy tests that never send `ready` pay 0ms!

### 2.4 `packages/provider-pi/src/server/adapter.ts` (Minimal Generic `// fork:` Hooks)

Keep upstream merge conflict surface strictly minimal (~60 lines total, 100% dialect-agnostic):

1. `case "t3.subagent_update":` in main event switch — when `turn !== null`, delegates directly to existing `emitSubagent(turn, toolCallId, taskKey, task)`.
2. `case "t3.todo_list_update":` in main event switch — when `turn !== null`, allocates/reuses `turn.todoPlanId` via `idAllocator.allocate.plan`, and emits `node.updated(kind: "todo_list")`, `plan.updated(kind: "todo_list")`, and `turn_item.updated(type: "todo_list")` (matching `provider-muse` / `provider-cursor` exact semantics, including `status: steps.every(s => s.status === "completed") ? "completed" : "active"`).
3. `method === "ask"` in `handleExtensionUiRequest` / `PendingPiPrompt` / `piUiResponse`:
   - Accepts `method === "ask"` carrying a non-empty `questions` array of `OrchestrationV2UserInputQuestion`.
   - Emits `runtime_request.updated`, `node.updated(kind: "user_input_request")`, and `turn_item.updated(type: "user_input_request", questions)`.
   - In `piUiResponse`, for `pending.method === "ask"`, returns `answers !== undefined ? { answers } : { cancelled: true }`.

## 3. Four-Quadrant Defense Matrix

| Quadrant                    | Threat / Edge Case                                                                                                                                                                                                                                         | Defense                                                                                                                                                                                                                                                                                         |
| --------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Input Validation**        | Malformed HTML forms, XSS/script tags, HTML entities, `<input type="file">`, duplicate/conflicting field names, >256 KiB HTML, empty `ask.questions`, duplicate request IDs                                                                                | Pure parser strips `<script>`/`<style>`/`<noscript>` comments, decodes safe HTML entities (`&amp;`, `&lt;`, `&gt;`, `&quot;`, `&#39;`, numeric entities), rejects unsupported inputs/empty forms/oversized HTML, fails closed immediately with `cancelled: true` + error notice                 |
| **State Consistency**       | Late `subagent_progress` regressing terminal subagent; `task` tool end racing `subagent_lifecycle`; multiple `todo_write` calls creating duplicate plan cards; upstream `cancel` leaking translator maps; `omp` `gt()`/`ht()` throwing on bad answer shape | Monotonic terminal lock per subagent id; stable `subagentId` (`${toolCallId}:subagent:${subagentId}`); single `turn.todoPlanId` per turn; `method: "cancel"` cleans all translator maps; strict `AnswersUiResponse`/`DataUiResponse` validators mirror `omp`'s `gt()`/`ht()`/`Y$()` exact rules |
| **Concurrency & Lifecycle** | First `prompt` racing `set_subagent_subscription`/`set_ask_dialog`; older `omp` rejecting new RPC commands; mock tests without `ready` hanging on startup gate                                                                                             | `readyReceived`-gated `sessionFeaturesReady` deferred with bounded timeout and warn-only fallback; 0ms overhead when no `ready` frame is emitted; host MCP tool registration unaffected                                                                                                         |
| **Cross-Surface Isolation** | Polluting `provider-pi` with `omp`-specific HTML parsing or business logic; breaking Pi native `select`/`confirm`/`input`/`editor` or `rpiv-ask-user-question`; colliding with Wave 3b (`driver.ts`/`status.ts`/`auth.ts`)                                 | 95%+ logic isolated in `packages/provider-omp/src/server/orchestration.ts`; `provider-pi` gets only 3 generic `// fork:` hooks; disjoint file fence from Wave 3b; zero Web/Mobile/i18n edits                                                                                                    |
