# Spec Delta

## Purpose

Defines Wave 2a of the native `omp` (oh-my-pi) integration in T3 Lab (Extend): session cost and run-time guardrails with RPC notice/cost-cap surfacing, unified profile-aware read-only `agent.db` quota discovery without double-counting, and active-model sub-backend quota mapping in the Thread HUD.

## ADDED Requirements

### Requirement: First-Class OMP Session Cost and Time Guardrails

An `omp` provider instance SHALL support optional `warnCostUsd`, `maxCostUsd`, and `maxTime` settings with strict validation matching `omp v19.2.1` CLI rules, conflict detection against manual `launchArgs`, session-only CLI forwarding, and exclusion from short-lived ephemeral text generation runs.

#### Scenario: Valid cost and time guardrails forward on session startup

- **WHEN** an `omp` instance configures `warnCostUsd: "2.50"`, `maxCostUsd: "10"`, and `maxTime: "30m"`
- **THEN** normal RPC session launch arguments include `--warn-cost 2.50`, `--max-cost 10`, and `--max-time 30m`

#### Scenario: Invalid guardrail values or launchArgs conflicts fail fast before spawn

- **WHEN** an `omp` instance configures `warnCostUsd: "0"`, `maxCostUsd: "-1"`, `maxTime: "2d"`, or repeats `--max-cost` in `launchArgs` while `maxCostUsd` is set
- **THEN** launch validation fails with a clear actionable error before spawning `omp`

#### Scenario: Ephemeral text generation strips session cost and time guardrails

- **WHEN** T3 runs a short-lived ephemeral text generation request on an `omp` instance that configures `warnCostUsd`, `maxCostUsd`, and `maxTime`
- **THEN** the spawned ephemeral `omp` command omits `--warn-cost`, `--max-cost`, and `--max-time`

### Requirement: RPC Notice and Cost-Cap Refusal Surfacing

The `omp` RPC protocol translator SHALL surface `omp` `notice` frames and `prompt_result` `cost_cap` refusals as user-visible notification events without duplicating an identical notice already emitted for the same refusal.

#### Scenario: Cost warning notice translates into warning notification

- **WHEN** `omp --mode rpc` emits `{ type: "notice", level: "warning", message: "Cost warning: ...", source: "cost_gate" }`
- **THEN** the translator emits an `extension_ui_request` `notify` frame with `notifyType: "warning"` and the exact message text

#### Scenario: Cost cap refusal emits one error notification even across notice and prompt_result

- **WHEN** `omp --mode rpc` emits a `notice` with `level: "error"` followed by a `prompt_result` with `status: "error"` and `error.code === "cost_cap"` carrying the same message
- **THEN** the translator surfaces the error notification once without duplicate notifications, and still surfaces it if only the `prompt_result` `cost_cap` frame is received

### Requirement: Unified Profile-Aware Read-Only OMP Quota Discovery

The server SHALL resolve `omp` `agent.db` paths with the same profile and agent-directory precedence as `packages/provider-omp` (never inheriting ambient `PI_CODING_AGENT_*`), auto-read `agent.db` for enabled `omp` instances read-only without creating SQLite sidecars or reading `auth_credentials`, and deduplicate by resolved `dbPath` against manual `kind: "omp"` sources.

#### Scenario: Named omp profile resolves to profile agent.db across manual and auto sources

- **WHEN** a user enables an `omp` instance with `profile: "work"` or configures a manual `omp` source with `url: "omp://profile/work"`
- **THEN** the server reads `~/.omp/profiles/work/agent/agent.db` read-only without creating `-wal` or `-shm` sidecar files and never reads `~/.omp/agent/agent.db` or `PI_CODING_AGENT_DIR`

#### Scenario: Duplicate dbPath between auto-discovered instance and manual omp source reads once

- **WHEN** an enabled `omp` instance and a manual `kind: "omp"` source in `usageLimitSources` resolve to the same `agent.db` path
- **THEN** `UsageLimitSources` preserves the manual source and suppresses the redundant auto-discovered snapshot so accounts are not double-read or double-listed

#### Scenario: Disabling an omp instance immediately prunes its auto-discovered quota snapshot

- **WHEN** an enabled `omp` instance is disabled in server settings (including mid-refresh)
- **THEN** `UsageLimitSources` stops reading its `agent.db` and removes its auto-discovered snapshot on commit

### Requirement: Active-Model Sub-Backend Quota Mapping in Thread HUD

When a thread runs on an `omp` provider instance, the Thread HUD Quota card SHALL resolve quota windows matching ONLY the thread's active model's sub-backend prefix (`<subprovider>/<model>`) from the `omp` instance's quota snapshot (falling back to an unambiguous matching native provider when present), and SHALL auto-hide honestly when the active sub-backend has no usable quota data.

#### Scenario: OMP thread running a Codex or Anthropic model shows matching sub-backend quota

- **WHEN** an `omp` thread's active model is `openai-codex/gpt-6.2-sol` and the `omp` instance's `agent.db` snapshot contains both `openai-codex` (`codex`) and `anthropic` (`claudeAgent`) quota accounts
- **THEN** the Thread HUD Quota card displays ONLY the `codex` quota windows and never mixes in `claudeAgent` windows

#### Scenario: OMP thread running an unquoted or API-key sub-backend hides the quota card

- **WHEN** an `omp` thread's active model is `devin/swe-2-1` (no matching quota entry) or the unprefixed `"default"` sentinel
- **THEN** the Thread HUD Quota resolver returns `null` and the Quota card stays hidden without fabricating usage or borrowing another sub-backend's quota

### Requirement: Settings Localization and Documentation Parity

The new `Cost warning (USD)`, `Max cost (USD)`, and `Max run time` setting labels, descriptions, and placeholders SHALL be localized across all 10 Web translation catalogs and documented accurately in `docs/user/providers-omp.md`.

#### Scenario: All 10 translation catalogs pass i18n check with new guardrail copy

- **WHEN** `vp run i18n:check` runs after updating `ProviderSettingsForm.tsx` and all 10 `apps/web/src/i18n/translations/*.json` files
- **THEN** all catalogs match source keys with zero missing or untranslated entries
