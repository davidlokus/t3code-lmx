# Composer Telemetry Popover Specification

## ADDED Requirements

### Requirement: Optional subagent usage and per-turn request/cost contracts

The wire contracts SHALL carry optional native subagent usage (`OrchestrationV2Subagent.usage`) and optional per-turn request count and cost (`TurnTokenUsage.requestCount`, `TurnTokenUsage.costUsd`) while remaining strictly backward-compatible with legacy servers and persisted snapshots.

#### Scenario: Legacy snapshot omits new optional fields

- **WHEN** a persisted thread projection or legacy server omits `subagent.usage`, `turnTokenUsage.requestCount`, and `turnTokenUsage.costUsd`
- **THEN** schema decoding succeeds without migration errors and client telemetry falls back cleanly without fabricating zeros

#### Scenario: Subsequent subagent update omits usage

- **WHEN** a provider or async backfill emits `subagent.updated` without `usage` for a subagent that previously recorded `usage`
- **THEN** both server and client projections preserve the last-known `usage` fields instead of wiping them

### Requirement: Provider usage passthrough for OMP, Pi, and Claude

OMP, Pi, and Claude adapters SHALL forward observed per-turn request counts, per-turn costs, and native subagent usage metrics into orchestration events without double-counting whole-session totals.

#### Scenario: OMP subagent progress and completion usage

- **WHEN** `omp` emits `subagent_progress` with `tokens`, `contextTokens`, `contextWindow`, `requests`, `toolCount`, `cost`, `durationMs`, and `resolvedModel`
- **THEN** `OmpSubagentTracker` and `provider-pi` project those fields onto `OrchestrationV2Subagent.usage` and `model`, preserving monotonic high-water metrics if a later `async-result` omits usage

#### Scenario: Pi and OMP multi-step turn cumulative token usage

- **WHEN** a Pi or OMP turn executes multiple assistant messages (`message_end` with `role === "assistant"`)
- **THEN** `provider-pi` accumulates `inputTokens` (inclusive of cache reads and writes), `cachedInputTokens`, `cacheCreationTokens`, `outputTokens`, `reasoningTokens`, `requestCount`, and per-turn `costUsd` into `providerTurn.turnTokenUsage`, while keeping `tokenUsage.cost` monotonic for the whole session

#### Scenario: Claude native subagent usage and turn request count

- **WHEN** Claude emits `task_progress` or `task_notification` with `usage.{total_tokens, tool_uses, duration_ms}` and a turn result with `num_turns` and `total_cost_usd`
- **THEN** `ClaudeAdapterV2` and `ClaudeTurnTokenUsage` project `subagent.usage` and `turnTokenUsage.{requestCount, costUsd}` across single or steered turn segments

### Requirement: Reference API pricing without double-counting cache tokens

The shared reference pricing helper SHALL compute USD reference estimates from model IDs and token counts using `usageModelAliases`, `usagePriceOverrides`, and built-in model rates, returning `null` for unknown models.

#### Scenario: Input tokens inclusive of cache reads and writes

- **WHEN** `estimateModelReferenceCost` receives `inputTokens: 100_000`, `cachedInputTokens: 90_000`, `cacheCreationTokens: 5_000`, and `outputTokens: 2_000` for a known model
- **THEN** it bills `5_000` uncached input tokens, `90_000` cache-read tokens, `5_000` cache-write tokens, and `2_000` output tokens without double-charging cached tokens

#### Scenario: User override and alias precedence

- **WHEN** `usageModelAliases` maps a custom model alias to a target model or `usagePriceOverrides` defines explicit rates
- **THEN** alias resolution (cycle-safe) and user overrides take precedence over built-in reference rates

### Requirement: Cumulative session telemetry and interval-merged tool timing

The shared telemetry derivation SHALL aggregate session-wide token totals, speed metrics, cache hit rates, tool/error/request counts, interval-merged tool vs model duration, and deduplicated subagent rollups across turns.

#### Scenario: Parallel tool calls do not exceed active execution time

- **WHEN** three tool items run concurrently with overlapping `[startedAt, completedAt]` intervals inside a 10-second run
- **THEN** `toolDurationMs` equals the merged union of tool intervals (never exceeding the 10-second active duration) and `modelDurationMs` equals `max(0, activeDurationMs - toolDurationMs)`

#### Scenario: Session cost avoids double-counting whole-session Pi/OMP cost

- **WHEN** multiple turns carry cumulative whole-session `tokenUsage.cost` without per-turn `turnTokenUsage.costUsd`
- **THEN** session cost uses the latest whole-session `tokenUsage.cost` rather than summing whole-session snapshots across turns

### Requirement: Toggleable composer telemetry ring and dual-view popover

The composer footer SHALL display a compact, toggleable context progress ring next to the model selector that opens a dual-view popover (`Context window` and `Session stats`) and can be hidden and restored cleanly.

#### Scenario: Composer ring visibility and toggle round-trip

- **WHEN** `showComposerRing` is enabled (default) on a server thread with context or turn telemetry
- **THEN** the composer footer renders a compact progress ring trigger next to the model picker; toggling `showComposerRing` off in Settings -> Appearance, Thread HUD options, or the popover hides it immediately and persists across reloads, and toggling it back on restores it

#### Scenario: Dual-view popover renders context breakdown, session stats, and clickable subagents

- **WHEN** the user clicks the composer telemetry ring trigger
- **THEN** a Base UI popover opens showing the `Context window` view (stacked semantic color bar, honestly labeled `≈` estimated breakdown rows, remaining space, cache reuse vs new input split, clickable subagent rows that open the right-panel inspector or child thread, and optional Compact action) and switches cleanly to the `Session stats` view (turns/steps, cumulative tokens, API cost/reference cost, average/peak/latest tok/s, cache hit rate, expandable token/request/error/tool details, model/tool/TTFT durations, and subagent rollup), without using middle dot (`·`) separators and localized across all 10 locales
