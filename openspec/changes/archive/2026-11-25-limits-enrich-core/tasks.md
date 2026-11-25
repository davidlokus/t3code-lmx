# Tasks: limits-enrich-core (PR 2a)

## 1. Claude & CLIProxyAPI Claude Enrichment

- [x] 1.1 Update `apps/server/src/provider/claudeUsageLimits.ts` to populate `category: "plan"` on `five_hour`/`seven_day`, `category: "plan"` + `scopeLabel` on `model_scoped` (probe and stream update), and `category: "overage"` + exact `usedAmount`/`limitAmount`/`remainingAmount`/`unit` on `monthly_spend` (`spend` and `extra_usage` paths, never fabricating amounts on utilization-only payloads).
- [x] 1.2 Update `apps/server/src/provider/claudeUsageLimits.test.ts` to assert exact amounts/units/categories/scopeLabels across `spend`, `extra_usage` (currency + raw credits + utilization-only), `model_scoped`, and streamed rate-limit events.

## 2. Codex & CLIProxyAPI Codex Enrichment

- [x] 2.1 Update `apps/server/src/provider/codexUsageLimits.ts` to emit `category: "plan"` on `primary`/`secondary`, `category: "balance"` + optional parsed `usedAmount`/`limitAmount`/`remainingAmount`/`unit: "credits"` on `individual`, `planTier` from `planType`, `balances` from `credits`, and `subscriptionExpiresAt` from `subscriptionActiveUntil`, plus merge/update consistency in `mergeCodexRateLimits` and `codexRateLimitsToUpdate`.
- [x] 2.2 Update `apps/server/src/usage/cliproxyApi.ts` to optionally decode Codex `credits`, `subscription_active_until`, `id_token.chatgpt_subscription_active_until`, and Claude `extra_usage.{currency, decimal_places}` and forward them cleanly.
- [x] 2.3 Update `apps/server/src/provider/codexUsageLimits.test.ts` and `apps/server/src/usage/cliproxyApi.test.ts` covering rich Codex credits/individual amounts/planTier/expiry, explicit empty credits clear, unlimited credits, minimal legacy payloads, and CLIProxyAPI forwarding.

## 3. Grok Enrichment & Verification

- [x] 3.1 Update `packages/provider-grok/src/server/usageLimits.ts` and `packages/provider-grok/src/server/usageLimits.test.ts` to emit `category: "plan"` and optional `planTier` from `subscription_tier_display` while keeping minimal payloads backward-compatible.
- [x] 3.2 Run targeted tests, typecheck, format/lint/knip, `vp run check:changed origin/lmx-lab`, and `packages/shared/src/forkIdentity.guard.test.ts`, plus cross-model review and `Broken by hand` falsification.
