# Tasks: composer-telemetry-popover

## Group 1: Contracts, Shared Pricing, Provider Passthrough & Pure Telemetry Logic

- [x] 1.1 Extend contracts & client projection preservation:
  - Add `OrchestrationV2SubagentUsage` and optional `usage` on `OrchestrationV2Subagent` in `packages/contracts/src/orchestrationV2.ts`.
  - Add optional `requestCount` and `costUsd` to `TurnTokenUsage` in `packages/contracts/src/providerRuntime.ts`.
  - Preserve last-known `subagent.usage` in `apps/server/src/orchestration-v2/ProjectionStore.ts` and `packages/client-runtime/src/state/orchestrationV2Projection.ts` (plus map in `packages/client-runtime/src/state/subagentRuntime.ts`) when later updates omit `usage`.
  - Add contract & projection preservation tests.

- [x] 1.2 Add curated model reference pricing in `packages/shared`:
  - Create `packages/shared/src/modelReferencePricing.ts` + `packages/shared/src/modelReferencePricing.test.ts` and register `./modelReferencePricing` in `packages/shared/package.json`.
  - Support cycle-safe `usageModelAliases`, `usagePriceOverrides`, normalized model slug matching, non-double-counted cache token billing, and honest `null` for unknown models.

- [x] 1.3 Wire provider usage passthrough (OMP, Pi, Claude):
  - `packages/provider-omp/src/server/orchestration.ts`: extract & monotonically preserve `usage` (`totalTokens`, `contextTokens`, `contextWindow`, `requests`, `toolUses`, `durationMs`, `costUsd`) and `resolvedModel` across `subagent_progress`, `task` `details.results[]`, and `wait`/`async-result` `details.jobs[]`.
  - `packages/provider-pi/src/server/adapter.ts`: forward validated `subagent.usage` onto `OrchestrationV2Subagent`; accumulate per-turn `turnTokenUsage` (`inputTokens`, `cachedInputTokens`, `cacheCreationTokens`, `outputTokens`, `reasoningTokens`, `requestCount`, `costUsd`, `models`, `hasSubagents`) across assistant `message_end` frames without double-counting whole-session `tokenUsage.cost`.
  - `apps/server/src/provider/ClaudeTurnTokenUsage.ts` & `apps/server/src/orchestration-v2/Adapters/ClaudeAdapterV2.ts`: map `num_turns` -> `TurnTokenUsage.requestCount`, positive `total_cost_usd` -> `TurnTokenUsage.costUsd`, and `task_progress`/`task_notification` `usage.{total_tokens, tool_uses, duration_ms}` -> `OrchestrationV2Subagent.usage`.
  - Add targeted unit tests across `provider-omp`, `provider-pi`, and `apps/server` (`TurnTokenUsage.test.ts` / `ClaudeAdapterV2.test.ts`).

- [x] 1.4 Extend shared telemetry derivation & HUD options store:
  - Extend `apps/web/src/fork/hud/hudOptionsStore.ts` with `showComposerRing` (default `true`, backward-compatible persistence + `isDefaultHudUiOptions` + reset).
  - Extend `apps/web/src/fork/hud/hudMetrics.logic.ts` with `deriveComposerContextBreakdown` (6 honest estimated buckets: `messages`, `systemBase`, `tools`, `mcpTools`, `subagents`, `remaining`, plus current-step cache reuse vs new input split) and `deriveSessionTelemetryMetrics` (turns/steps, cumulative token totals, avg/peak/latest/live tok/s, cache hit rate & state, request/error/tool counts, interval-merged tool vs model duration, TTFT, non-double-counted billed/reference cost, and deduplicated subagent rollup).
  - Add thorough unit tests in `apps/web/src/fork/hud/hudMetrics.logic.test.ts`.

## Group 2: Composer Ring UI, Dual Popover, Toggles, i18n & Browser Tests

- [x] 2.1 Build `apps/web/src/fork/telemetry/ComposerTelemetryControl.tsx`:
  - Compact footer SVG progress ring + percentage button (zero continuous animations, semantic color tokens, closes cleanly on `composerMenusClosed`).
  - Lazy-mounted Base UI `<PopoverPopup>` with dual tabs (`Context window` | `Session stats`), expandable `More stats`, clickable subagent list opening native subagent inspector or child thread tab, optional Compact button, and quick Hide action; zero middle-dot `·` separators.
- [x] 2.2 Wire minimal `// fork:` hooks & visibility toggles:
  - `apps/web/src/components/chat/ChatComposer.tsx` & `apps/web/src/components/ChatView.tsx`: mount `<ComposerTelemetryControl>` in the composer footer next to the model selector.
  - `apps/web/src/fork/hud/ThreadHudSections.tsx`: add `Composer telemetry ring` switch in HUD options menu.
  - `apps/web/src/components/settings/AppearanceSettingsPanel.tsx` & `apps/web/src/components/settings/settingsSearch.ts`: add searchable `composer-telemetry-ring` switch synced with `useHudOptionsStore`.
- [x] 2.3 Localize across all 10 locales (`vp run i18n:generate` + translations + `vp run i18n:check`) and add Chromium browser tests in `apps/web/src/fork/telemetry/ComposerTelemetryControl.browser.test.tsx` (covering ring rendering, toggle hide/restore across Settings/HUD/popover, both tabs, expandable stats, clickable native/child subagents, and zero middle dots).
- [x] 2.4 Pass Pre-Review Gate (`vp fmt --check`, `vp lint`, affected `typecheck` across contracts/shared/client-runtime/provider-pi/provider-omp/server/web/mobile, `vp run knip:check:exports`, `vp run i18n:check`, and targeted unit + Chromium tests).

## Group 3: Cross-Model Review, Falsification, Dogfood, Archive & Ship

- [x] 3.1 Run fresh read-only cross-model review (`devin/swe-2-1`) against plan baseline commit and fix any CRITICAL/WARNING findings until `VERDICT: PASS`.
- [x] 3.2 Execute 3 `Broken by hand` RED -> GREEN falsifications (subagent usage preservation / cache non-double-count pricing / interval-merged tool duration or composer ring visibility toggle).
- [x] 3.3 Run `vp run check:changed origin/lmx-lab`, `vp test run packages/shared/src/forkIdentity.guard.test.ts`, `vp run i18n:check`, build & overwrite-install local macOS Dogfood `0.1.12-lab.6-dogfood.7` for live verification, then archive OpenSpec, update `FORK.md` / `LESSONS.md`, open PR to `origin/lmx-lab`, verify Fork CI green, squash-merge, and close worktree.
