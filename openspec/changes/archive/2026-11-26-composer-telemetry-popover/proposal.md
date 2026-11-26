# Proposal: Composer Telemetry Ring, Dual Context/Session Popover, and Subagent Usage Passthrough

**Tier:** L2 Full Spec (`spec-driven`) — spans `packages/contracts`, `packages/shared`, `packages/client-runtime`, `packages/provider-pi`, `packages/provider-omp`, `apps/server` (Claude adapter), and `apps/web` (composer footer, dual telemetry popover, Thread HUD, Settings, and 10-locale i18n).

## Why

1. **No at-a-glance context or session telemetry in the composer**: Users currently have to open the Thread Details / HUD drawer to check context usage, cache health, speed, or cost, whereas a compact progress ring right next to the composer model picker (`○ 35.3%`) surfaces context pressure continuously while writing prompts and opens rich telemetry on demand.
2. **Missing cumulative session statistics & reference API cost**: Existing HUD cards only display single-turn output speed and the latest turn breakdown. They do not aggregate session-wide totals (cumulative tokens across turns, input/cache-read/cache-write/output/reasoning breakdown, average/peak/latest tok/s, model vs tool time, request count, error count) or compute reference API cost when a subscription provider omits direct cost reporting.
3. **Provider-native subagent usage is dropped at the adapter boundary**: Both `omp` (`SubagentProgress` carrying `tokens`, `contextTokens`, `contextWindow`, `requests`, `toolCount`, `cost`, `durationMs`, `resolvedModel`) and Claude Code (`task_progress`/`task_notification` carrying `usage.{total_tokens, tool_uses, duration_ms}` and `SDKResultMessage.num_turns`) already emit rich usage data that is currently discarded instead of flowing onto `OrchestrationV2Subagent` and `TurnTokenUsage`.
4. **Pi/OMP multi-step turns lack per-turn cumulative `turnTokenUsage`**: `provider-pi` currently emits only the last message's `tokenUsage` snapshot (and whole-session `cost`), omitting per-turn cumulative tokens and API request counts across multi-step tool-calling turns.
5. **User control**: Users want a toggleable composer telemetry ring (enabled by default, hideable and restorable from Settings, Thread HUD options, and the popover itself).

## What Changes

1. **Backward-compatible wire contracts (`packages/contracts`)**:
   - Add optional `OrchestrationV2SubagentUsage` (`usage?`) to `OrchestrationV2Subagent` (stored inside existing SQLite `payload_json`, zero migration).
   - Add optional `requestCount?` and per-turn `costUsd?` to `TurnTokenUsage`.
   - Preserve monotonic/last-known subagent `usage` across `subagent.updated` merges in server & client projections when later updates omit `usage`.
2. **Curated reference API pricing (`packages/shared/src/modelReferencePricing.ts`)**:
   - Add a zero-dependency model reference rate estimator overlaid with `serverConfig.settings.usageModelAliases` and `usagePriceOverrides` so subscription/unpriced turns can display honest API reference cost without extra WebSocket payloads or server roundtrips.
3. **Provider passthrough (`provider-omp`, `provider-pi`, `apps/server` ClaudeAdapterV2)**:
   - `provider-omp`: extract `usage` (`totalTokens`, `contextTokens`, `contextWindow`, `requests`, `toolUses`, `durationMs`, `costUsd`) and `resolvedModel` from `subagent_progress`, `task` `details.results[]`, and `wait`/`async-result` `details.jobs[]`.
   - `provider-pi`: forward validated `subagent.usage` onto `OrchestrationV2Subagent`; accumulate per-turn `turnTokenUsage` (`inputTokens`, `cachedInputTokens`, `cacheCreationTokens`, `outputTokens`, `reasoningTokens`, `requestCount`, `costUsd`, `models`, `hasSubagents`) across every `message_end(role === "assistant")` in a turn.
   - `ClaudeAdapterV2` / `ClaudeTurnTokenUsage`: forward `num_turns` to `TurnTokenUsage.requestCount` and positive `total_cost_usd` to `TurnTokenUsage.costUsd`; forward `task_progress`/`task_notification` `usage.{total_tokens, tool_uses, duration_ms}` onto `OrchestrationV2Subagent.usage`.
4. **Shared telemetry engine + Composer Ring & Dual Popover + Toggles (`apps/web`)**:
   - Add `deriveComposerTelemetry` & `deriveSessionTelemetryMetrics` in `apps/web/src/fork/hud/hudMetrics.logic.ts` (reusing shared pure logic across composer popover and HUD).
   - Add `showComposerRing` (default `true`) in `apps/web/src/fork/hud/hudOptionsStore.ts` with switches in both Thread HUD options (`ThreadHudSections.tsx`) and Settings -> Appearance (`AppearanceSettingsPanel.tsx` + `settingsSearch.ts`).
   - Add `apps/web/src/fork/telemetry/ComposerTelemetryControl.tsx`: compact ring trigger in `ChatComposer` footer next to the model picker, opening a lazy-mounted dual-tab Base UI `<Popover>` (`Context window` | `Session stats`) with honest estimated breakdown buckets, cache reuse vs new input split, per-subagent cards (app-owned child threads + provider-native subagents, clickable to inspect), cumulative stats, speed stats, interval-merged tool vs model duration, and subagent rollup.
   - Translate all new UI strings across all 10 locales in `apps/web/src/i18n/translations/*.json`.

## Non-Goals

- Fabricating exact 9-bucket prompt composition (`system prompt`, `rules`, `skills`, `plugins`, `MCP schemas`) that external CLIs do not report; estimated context buckets are explicitly labeled with `≈` and grouped into honestly observable categories (`Messages`, `System base` / `Compaction base`, `Tools`, `MCP tools`, `Subagents`, `Remaining`).
- Modifying React Native mobile UI layouts (mobile retains full contract compatibility and typecheck green).
- Adding continuous repainting animations or polling loops.
