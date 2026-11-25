# Tasks: limits-enrich-ide (PR 2b)

## 1. Cursor Enrichment

- [x] 1.1 Update `packages/provider-cursor/src/server/usageLimits.ts` to decode optional `membershipType`, `planUsage` cent amounts, and `spendLimitUsage`, emit `category: "plan"` + `scopeLabel` + optional USD amounts on plan windows, append `on_demand` overage window when a positive spend limit exists, emit `subscriptionExpiresAt` for monthly billing cycles, and emit `planTier`.
- [x] 1.2 Update `packages/provider-cursor/src/server/usageLimits.test.ts` covering rich `planUsage` USD conversion, individual & pooled `spendLimitUsage`, disabled/zero spend limits, monthly vs weekly `subscriptionExpiresAt` gating, `planTier`, and backward compatibility with minimal payloads.

## 2. Antigravity, OpenCode Go, and Muse Enrichment

- [x] 2.1 Update `apps/server/src/provider/antigravityUsageLimits.ts` and `apps/server/src/provider/antigravityUsageLimits.test.ts` to emit `category: "plan"` and `scopeLabel: family` across both summary and fallback model windows without altering `antigravitySummaryWindows` signature.
- [x] 2.2 Update `packages/provider-opencode/src/server/usageLimits.ts` and `packages/provider-opencode/src/server/usageLimits.test.ts` to emit `category: "plan"`, `scopeLabel: "OpenCode Go"`, and `planTier: "OpenCode Go"`.
- [x] 2.3 Update `packages/provider-muse/src/server/usageLimits.ts` and `packages/provider-muse/src/server/usageLimits.test.ts` to emit `category: "plan"` on both windows and `planTier: tier` when `tier` is non-empty.

## 3. Verification & Review

- [x] 3.1 Run targeted tests, typecheck, format/lint/knip, `vp run check:changed origin/lmx-lab`, and `packages/shared/src/forkIdentity.guard.test.ts`, plus cross-model review and `Broken by hand` falsification.
