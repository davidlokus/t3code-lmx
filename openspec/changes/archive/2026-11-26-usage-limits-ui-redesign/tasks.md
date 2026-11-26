# Tasks: usage-limits-ui-redesign

## Group 1: Shared Presentation Logic, Store Default & Core Dual-View Redesign

- [x] 1.1 Create `apps/web/src/fork/usage/usageLimitsPresentation.ts` and `apps/web/src/fork/usage/usageLimitsPresentation.test.ts`:
  - Restrained tone helpers (`restrainedBarClass`, `restrainedTextClass`, `effectiveWindowTone` elevating `exhausted` / `will-exhaust` / `ahead`).
  - Metadata deduplication (`formatAccountMeta`, `dedupeWindowScopeLabel`, `shouldShowPlanBadge`).
  - Risk scoring & sorting (`accountRiskTier`, `sortAccountsByRisk`) and unified platform pool grouping (`groupAccountsByPlatformPool`, handling native, OMP, HTTP, OpenRouter, Copilot, Ollama, OpenAI API, Kimi, Z.ai, claude-swap).
- [x] 1.2 Update `apps/web/src/fork/usage/usageOptionsStore.ts` (`DEFAULT_OPTIONS.limitsLayout: "matrix"`, preserving backward-compatible parsing of `"pool"` and `"matrix"`).
- [x] 1.3 Redesign `apps/web/src/fork/usage/UsageLimitsEnhanced.tsx`:
  - Borderless editorial header with inline counters (zero `·`), clickable alert jump pill, subtle `Manage limit hubs` link.
  - Clean underline tab bar (`Pools`, `Resets`, `Alerts`, `Expiries`), right-aligned `Cards` / `Table` view toggle, compact `Left/Used` & `Countdown/Exact` switches, and optional `At risk` focus filter when risk accounts exist.
  - Route `pool` layout to `UsageLimitsPoolTableView` and `matrix` layout to `UsageLimitsMatrixView`.
- [x] 1.4 Redesign `apps/web/src/fork/usage/UsageLimitsMatrixView.tsx` into a multi-column Bento Card Wall (`md:grid-cols-2 xl:grid-cols-3`):
  - Flat borderless hairline window rows (`divide-y`), zero nested window sub-cards, 3px restrained progress bars + pace needle, risk-first sorting, deduplicated source/plan/scope metadata, compact icon-only renewal action button with tooltip, inline balances strip, and zero `·` separators.
- [x] 1.5 Build `apps/web/src/fork/usage/UsageLimitsPoolTableView.tsx`:
  - Compact platform-grouped expandable summary table unifying all provider & HTTP/external quota sources.
  - Platform summary rows with inline window mini-bars, aggregate `%`, fast-burn indicator, soonest reset/refill info, and expandable per-account sub-rows with redacted email, burn pace, balances, renewal editing, and reset-credit redemption (`useResetCredit` / `ResetCreditDialog`), plus external links & notices footer.

## Group 2: Unified Restrained Polish on Resets, Alerts, Expiries, Quota Strip & i18n

- [x] 2.1 Refine `apps/web/src/fork/usage/UsageQuotaStrip.tsx`, `UsageLimitsResetsView.tsx`, `UsageLimitsAlertsView.tsx`, and `UsageLimitsExpiriesView.tsx`:
  - Apply restrained neutral-healthy / amber-warning / red-error palette, 3px–4px tracks, cleaner spacing/hierarchy, deduplicated labels, and remove `·` middle-dot separators.
- [x] 2.2 Generate and translate all new/updated i18n keys across all 10 locales (`vp run --filter @t3tools/web i18n:generate` + `vp run i18n:check`).
- [x] 2.3 Update and expand tests (`usageLimitsPresentation.test.ts`, `usageDashboard.logic.test.ts`, `usageLimitsIntelligence.browser.test.tsx`, `usageDashboard.browser.test.tsx`) covering Bento grid, risk sorting, metadata deduplication, platform table expand/collapse, external sources, zero `·` assertions, and React Compiler coverage.

## Group 3: Cross-Model Review, Falsification, Gates, Archive & Local Dogfood

- [x] 3.1 Run fresh read-only cross-model review (`devin/swe-2-1`) against plan baseline commit and resolve any CRITICAL/WARNING findings until `VERDICT: PASS`.
- [x] 3.2 Execute 3 `Broken by hand` RED -> GREEN falsifications (metadata dedup / risk-first ordering / platform pool table expand or display mode sync).
- [x] 3.3 Run `vp run check:changed origin/lmx-lab`, `vp test run packages/shared/src/forkIdentity.guard.test.ts`, `vp run i18n:check`, archive OpenSpec, update `FORK.md`, open Fork PR, confirm Fork CI green, squash-merge, close worktree, and install local macOS Dogfood `0.1.12-lab.6-dogfood.8`.
