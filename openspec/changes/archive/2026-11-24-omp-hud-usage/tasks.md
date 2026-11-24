# Tasks

## 1. Contracts, Client Runtime & OMP/Pi Cost + Usage Backend

- [x] 1.1 Add optional `cost` to `OrchestrationV2ProviderTurnTokenUsage`, add `"omp"` to `UsageProviderKind`, and forward `liveUsage.cost ?? null` in `deriveLatestContextWindowSnapshot` (`vp test run packages/client-runtime/src/state/contextWindow.test.ts`).
- [x] 1.2 Propagate `reasoningTokens` and positive session/message USD `cost` in `packages/provider-pi/src/server/adapter.ts` without emitting `cost` when absent or `0` (`vp test run packages/provider-pi/src/server/adapter.test.ts packages/provider-omp/src/server/adapter.test.ts`).
- [x] 1.3 Implement `packages/provider-omp/src/server/usage.ts` (`ompUsageFormat`, `ompUsageReader`) + unit tests in `packages/provider-omp/src/server/usage.test.ts`, wire `OmpDriver.usage`, `BUILT_IN_USAGE_DRIVERS`, and Web/Mobile `UsageProviderKind` maps (`vp test run packages/provider-omp/src/server/usage.test.ts`).

## 2. Web Thread HUD Improvements & i18n

- [x] 2.1 Update `apps/web/src/fork/hud/hudMetrics.logic.ts`, `HudSessionCard.tsx`, `HudActivityCard.tsx`, and `ThreadHudSections.tsx` for `thinking` string effort (`omp`/`pi`), live running-turn speed leaf, TTFT derivation from first output/tool item, and localized built-in tool labels; expand `hudMetrics.logic.test.ts` and `hudUi.browser.test.tsx` (`vp test run apps/web/src/fork/hud/hudMetrics.logic.test.ts apps/web/src/fork/hud/hudUi.browser.test.tsx`).
- [x] 2.2 Run `i18n:generate`, translate all new HUD tool labels across all 10 catalogs in `apps/web/src/i18n/translations/*.json`, and verify `vp run i18n:check`.

## 3. Verification, Falsification & Local Desktop Install

- [x] 3.1 Run `vp run check:changed origin/lmx-lab`, `vp test run packages/shared/src/forkIdentity.guard.test.ts`, and `vp run i18n:check`.
- [x] 3.2 Run `Broken by hand` falsification on HUD/OMP cost or thinking logic and verify unit test catches the regression before restoring cleanly.
- [x] 3.3 Build local `T3-Lab-Extend-0.1.12-lab.3-arm64.dmg`, pass `verify-mac-dmg.sh`, overwrite-install `/Applications/T3 Lab (Extend).app`, pass `smoke-desktop-app.ts`, launch app, and report `Verified` / `Broken by hand` / `Not tried`.
