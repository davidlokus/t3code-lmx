# Tasks: `thread-hud-panel` (PR 2 — Right-Side T3 Lab HUD)

## Group 1: HUD Options Store & Pure Metrics Logic `[Owner: omp]`

- [x] 1.1 Implement `apps/web/src/fork/hud/hudOptionsStore.ts` per `design.md` §2.1 (`t3lab:hud-ui:v1` persistence, resilient parsing, default collapsed System card, strictly public-only exports).
- [x] 1.2 Implement `apps/web/src/fork/hud/hudMetrics.logic.ts` per `design.md` §2.2 (`deriveHudHeaderSummary`, `deriveHudContextMetrics`, `derivePromptCacheCountdown`, `deriveHudSessionMetrics`, `deriveHudActivityMetrics`, `deriveHudSystemMetrics`, `formatHudCompactDuration` — strict non-fabrication, single-model cache isolation, post-compaction 4-bucket estimation summing to `usedTokens`).
- [x] 1.3 Implement comprehensive unit tests in `apps/web/src/fork/hud/hudMetrics.logic.test.ts` covering persistence/corruption fallback, 4-bucket post-compaction math, single-model cache isolation across model switches, warm/cold countdown transitions, non-fabrication `null` guards (`tok/s`, `TTFT`, cost, host RAM), subagent/tool failure aggregation, and system telemetry process bucketing.

## Group 2: HUD UI Components, Upstream Wiring, i18n & Visual QA `[Owner: agy]`

- [x] 2.1 Implement HUD components in `apps/web/src/fork/hud/`:
  - `ThreadHudSections.tsx` (B1 status header + `🎛` options popover + B3–B7 card orchestrator using `useQuietThreadProjection`)
  - `HudContextCard.tsx` (B3 Context Lens + isolated self-ticking `HudPromptCacheCountdown` leaf + `/compact` action)
  - `HudSessionCard.tsx` (B4 2×2 KPIs with honest `—` fallbacks & model delta)
  - `HudQuotaCard.tsx` (B5 read-only `resolveThreadDetailsLimits` windows with directly visible reset countdowns & auto-hide)
  - `HudActivityCard.tsx` (B6 clickable subagents + top 8 tool pills with failure badges & auto-hide)
  - `HudSystemCard.tsx` (B7 collapsed-by-default card + visibility-gated `useResourceTelemetry` subscription + local ports + `Σ totalProcessedTokens`)
- [x] 2.2 Add minimal `// fork:` wiring in `apps/web/src/components/chat/ThreadDetailsCard.tsx`, `apps/web/src/components/chat/ThreadDetailsPanel.tsx`, and `apps/web/src/components/ChatView.tsx`, deduplicating legacy Usage/Context when HUD cards are active without breaking existing tests.
- [x] 2.3 Run `i18n:generate`, translate all new HUD copy across all 10 catalogs in `apps/web/src/i18n/translations/*.json`, and verify `vp run i18n:check`.
- [x] 2.4 Write `apps/web/src/fork/hud/hudUi.browser.test.tsx`, pass all targeted unit/browser/React Compiler tests, and complete isolated live visual QA (light + dark modes via `vp run dev --no-seed` + `Replay (dev)` in `ego-browser`).

## Group 3: Cross-Review, Falsification, Gates & Archive `[Owner: omp + agy]`

- [x] 3.1 `[Owner: omp]` Run strictly read-only `openspec-verify-change thread-hud-panel` cross-review against `specs/fork-thread-hud-panel/spec.md` and `design.md`; `[Owner: agy]` resolve all CRITICAL and actionable WARNING findings and terminate `omp` terminal.
- [x] 3.2 `[Owner: agy]` Run `Broken by hand` falsification on HUD logic, confirm unit test catches regression, and restore cleanly.
- [x] 3.3 `[Owner: agy]` Archive change (`openspec archive thread-hud-panel --yes`), update `FORK.md` ledger, pass `vp run check:changed origin/lmx-lab`, `vp test run packages/shared/src/forkIdentity.guard.test.ts`, and `vp run i18n:check`, then push, open fork PR, wait for Fork CI green, squash-merge, and clean up worktree.
