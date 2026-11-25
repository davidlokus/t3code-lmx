# Tasks: usage-sources-omp-cn (PR 3a)

## 1. Contracts & Shared Projections (Group 1 — Backend/Shared)

- [ ] 1.1 Extend `packages/contracts/src/settings.ts` and `packages/contracts/src/providerUsageLimits.ts` with `UsageLimitSourceKind` (`"cliproxy" | "http" | "omp" | "kimi" | "zai"`), `UsageLimitSourceRegion` (`"cn" | "global"`), optional `region` on `UsageLimitSourceConfig` (keeping `Schema.Struct`), and optional rich window/account metadata on `HttpQuotaAccount`.
- [ ] 1.2 Update `packages/shared/src/usageLimits.ts`, `packages/shared/src/usageLimitsCopy.ts`, `packages/shared/src/usageLimitsIntelligence.ts`, and `apps/web/src/components/chat/ThreadDetailsUsage.logic.ts` so all source kinds with `quotaAccounts` project cleanly into Pools, Matrix, Resets, Alerts, Expiries, notices, and thread details while restricting `redeem` strictly to `source.kind === "cliproxy"`; add regression tests in `packages/shared/src/usageLimitsIntelligence.test.ts` (and `usageLimits.test.ts` if needed).

## 2. Independent Server Sources (`omp`, `kimi`, `zai`) (Group 1 — Backend/Shared)

- [ ] 2.1 Implement `apps/server/src/usage/sources/omp.ts` and `apps/server/src/usage/sources/omp.test.ts`: strict read-only `node:sqlite` reader for `usage_cache:report:*` (never `auth_credentials`, never `PI_CODING_AGENT_*`), mapping native T3 drivers to `accounts[]` for anti-double-count deduplication and non-native providers to rich `quotaAccounts[]`.
- [ ] 2.2 Implement `apps/server/src/usage/sources/kimi.ts` and `apps/server/src/usage/sources/kimi.test.ts`: direct `x-api-key` reader for `cn` (`api.kimi.com`) and `global` (`api.kimi.ai`) with modern ratio + legacy counter fallback (stale-zero guard), `booster_wallet` USD balance, `membership.level` `planTier`, timeout/size-cap, and credential-free error handling.
- [ ] 2.3 Implement `apps/server/src/usage/sources/zai.ts` and `apps/server/src/usage/sources/zai.test.ts`: direct Bearer reader for `global` (`api.z.ai`) and `cn` (`open.bigmodel.cn`), parsing `/api/monitor/usage/quota/limit` (`CREDIT_LIMIT`/`TOKENS_LIMIT` + `TIME_LIMIT`) and best-effort `/api/biz/subscription/list` (`planTier` + date-only `subscriptionExpiresAt`), plus HTTP 200 error envelope detection.
- [ ] 2.4 Wire `omp`, `kimi`, and `zai` into `apps/server/src/usage/UsageLimitSources.ts` (including `sourceLabel`, `keepLastGoodReadings` preservation for `quotaAccounts`, and `cliproxy`-only `consumeResetCredit`) and add full integration tests in `apps/server/src/usage/UsageLimitSources.test.ts`.

## 3. Settings UI, i18n & Visual QA (Group 2 — Frontend)

- [ ] 3.1 Update `apps/web/src/components/settings/AddUsageLimitSourceDialog.logic.ts`, `apps/web/src/components/settings/AddUsageLimitSourceDialog.tsx`, and `apps/web/src/components/settings/UsageProviderSettings.tsx` to support adding, displaying, and removing `cliproxy`, `http`, `omp`, `kimi`, and `zai` sources (region picker for Kimi/Z.ai, optional DB path for OMP, `SecretSourceInput` for keys/tokens, clean labels/descriptions).
- [ ] 3.2 Run `vp run i18n:generate` and translate all new UI copy across `apps/web/src/i18n/translations/*.json`, then verify `vp run i18n:check`.
- [ ] 3.3 Add browser tests covering the new Settings UI flows (adding/validating/rendering `omp`, `kimi`, `zai` sources) and perform real-app Dark + Light visual QA via isolated `vp run dev` + `ego-browser`.

## 4. Verification, Cross-Model Review & Delivery

- [ ] 4.1 Run Pre-Review Gate (`vp fmt --check`, `vp lint`, `vp run knip:check`, typecheck, unit + browser tests, `i18n:check`), complete fresh read-only cross-model review until `VERDICT: PASS`, run `Broken by hand` falsification, archive OpenSpec, and pass `vp run check:changed origin/lmx-lab` + `forkIdentity.guard.test.ts`.
