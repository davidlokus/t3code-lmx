# Proposal

## Why

Real-world `omp` testing against the T3 Lab right-side Thread HUD revealed two gaps: (1) HUD session/activity logic missed `omp`/`pi` string `thinking` effort values (`{ id: "thinking", value: "high" }`), left Speed/TTFT blank during an active first turn, and left common `omp` tool names (`read`, `grep`, `find`, `write`, `edit`, `todo`, `task`) untranslated; (2) the shared Pi/omp adapter dropped `usage.cost.total`, `get_session_stats.cost`, and `reasoningTokens`, and `OmpDriver` did not register a transcript usage reader for `~/.omp/agent/sessions`, leaving `/usage` blind to `omp`.

## What Changes

- **Contracts & Client Runtime**:
  - Add optional `cost` (`{ amount, currency }`) to `OrchestrationV2ProviderTurnTokenUsage` in `packages/contracts/src/orchestrationV2.ts` and forward `liveUsage.cost ?? null` in `packages/client-runtime/src/state/contextWindow.ts`.
  - Add `"omp"` to `UsageProviderKind` in `packages/contracts/src/usage.ts`.
- **Pi / OMP Adapter & Usage Reader**:
  - Extract `reasoningTokens`/`reasoning` and positive USD `cost.total` / `get_session_stats.cost` in `packages/provider-pi/src/server/adapter.ts` (omitting `cost` when `0` or absent so unpriced models stay honest and existing fixtures stay unchanged).
  - Add `packages/provider-omp/src/server/usage.ts` (`ompUsageFormat`, `ompUsageReader`, `resolveOmpSessionsDir`) parsing `~/.omp/agent/sessions/**/*.jsonl` (`session`, `message`, `model_usage`, `usage`, `compaction`, `branch_summary`, `reasoningTokens`, `cost.total`, `--session-dir`, `OMP_CODING_AGENT_*` / `PI_CODING_AGENT_*`), register it on `OmpDriver` and `BUILT_IN_USAGE_DRIVERS`, and add `"omp"` presentation entries for Web & Mobile `/usage`.
- **Web Thread HUD (`apps/web/src/fork/hud/`)**:
  - Parse string values on `option.id === "thinking"` (ignoring `"off"`) in `readThinkingEffort()`.
  - Expose live running-turn output throughput (`liveTurnOutputTokens`, `liveTurnStartedAtMs`) with an isolated `HudLiveSpeed` second-clock leaf and compute real TTFT from `turn.startedAt` to the earliest model output/tool item `startedAt`.
  - Localize common built-in tool names (`read`, `write`, `edit`, `grep`, `find`/`glob`, `bash`, `fetch`, `todo`, `task`) across all 10 translation catalogs while keeping unknown/MCP tool names verbatim.

## Assumptions

- When `omp` reports `cost.total === 0` (unpriced models such as `zai/glm-5.4`), live HUD omits `cost` (displaying `–` rather than misleading `$0.00`), while `/usage` transcript scanning passes `reportedCostUsd: null` so LiteLLM model pricing can apply when known.
- `omp` `model_usage` JSONL records represent separate auxiliary/sub-model invocations with distinct entry IDs and do not duplicate `message` (`role: "assistant"`) records.
- `omp` remains without `usageLimits` (multi-backend CLI has no single account quota window API), so the HUD Quota card continues to auto-hide for `omp`.

## Out of Scope

- Scraping terminal ANSI `setWidget` output (e.g. third-party `omp-hud` extension widgets) into T3 Code state.
- Adding custom per-model local pricing tables for unlisted models like `zai/glm-5.4`.
- Native mobile UI layout changes beyond adding `"omp"` to the exhaustive `UsageProviderKind` maps.

## 上游同步冲突面

- **新增独立文件**：
  - `packages/provider-omp/src/server/usage.ts`
  - `packages/provider-omp/src/server/usage.test.ts`
  - `openspec/changes/omp-hud-usage/{proposal.md,tasks.md}`
- **上游文件最小 `// fork:` 钩子**：
  - `packages/contracts/src/orchestrationV2.ts`（`OrchestrationV2ProviderTurnTokenUsage` 增加可选 `cost`）
  - `packages/contracts/src/usage.ts`（`UsageProviderKind` 增加 `"omp"`）
  - `packages/client-runtime/src/state/contextWindow.ts`（`deriveLatestContextWindowSnapshot` 透传 `liveUsage.cost ?? null`）
  - `packages/provider-pi/src/server/adapter.ts`（提取 `reasoningTokens` 与正数 USD `cost` 并在切换会话时清零基线）
  - `apps/server/src/provider/builtInDrivers.ts`（`BUILT_IN_USAGE_DRIVERS` 注册 `OmpDriver`）
  - `apps/web/src/components/usage/usageProviders.ts`、`apps/mobile/src/features/usage/{usageProviders.ts,providerColors.ts}`（补齐 `omp` 配色与标签）

## Surface Matrix

| Surface   | Status  | Notes                                                                    |
| --------- | ------- | ------------------------------------------------------------------------ |
| Web       | Changed | HUD thinking/speed/TTFT/tool labels + `/usage` `omp` provider color      |
| Desktop   | Changed | Bundles updated Web + Server into local `T3 Lab (Extend).app` test build |
| Mobile    | Changed | Exhaustive `UsageProviderKind` maps updated with `"omp"`                 |
| Server    | Changed | `BUILT_IN_USAGE_DRIVERS` registers `OmpDriver` usage reader              |
| Contracts | Changed | Optional `cost` on `OrchestrationV2ProviderTurnTokenUsage`; `"omp"` kind |
| Providers | Changed | `provider-omp` usage reader + `provider-pi` live/stats cost & reasoning  |
| i18n      | Changed | New HUD tool labels translated across all 10 web locale catalogs         |
