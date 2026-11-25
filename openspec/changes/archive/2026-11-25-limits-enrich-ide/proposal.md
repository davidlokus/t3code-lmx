# Proposal: Enrich IDE & Subscription Provider Usage Limits (PR 2b)

## Why

Following Wave 1 (`feat/usage-limits-intelligence`, PR #20), the four IDE/subscription probes (Cursor, Antigravity, OpenCode Go, and Muse) still emit bare percentage windows without categories, scopes, USD spend amounts, on-demand overage windows, billing-cycle subscription expiries, or plan tiers—even when their existing API responses already carry that data.

## What Changes

Populate the existing Wave 1 optional metadata fields across the four IDE/subscription probes using data already returned on their current endpoints (zero extra network requests, zero UI/i18n edits, 100% backward-compatible with minimal payloads):

1. **Cursor (`packages/provider-cursor/src/server/usageLimits.ts`)**:
   - Extend `CursorUsageResponse` with optional fields already returned by `GetCurrentPeriodUsage`:
     - `membershipType?: string`
     - `planUsage.{limit, totalSpend, remaining, autoSpend, apiSpend, bonusSpend}` (all optional numbers, unit: USD cents)
     - `spendLimitUsage.{enabled, limitType, individualLimit, individualUsed, individualRemaining, pooledLimit, pooledUsed, pooledRemaining}` (optional object, unit: USD cents)
   - Tag `CURSOR_USAGE_WINDOWS` (`totalPercentUsed`, `autoPercentUsed`, `apiPercentUsed`) with `category: "plan"`, and attach `scopeLabel` (`"Cursor Models"` for `autoPercentUsed`, `"Other Models"` for `apiPercentUsed`).
   - On `totalPercentUsed`: keep `usedPercent` strictly from `planUsage.totalPercentUsed` (dashboard percentage includes bonus usage); when `planUsage.limit` is finite `> 0` and either `planUsage.totalSpend` or `planUsage.remaining` is finite, attach `usedAmount`, `limitAmount`, `remainingAmount` (converted from cents to USD via `/ 100`), and `unit: "USD"`.
   - When `spendLimitUsage` is present (and `enabled !== false`) with a positive `individualLimit` or `pooledLimit`, append an `on_demand` overage window (`id: "on_demand"`, `kind: "monthly"`, `label: individualLimit > 0 ? "On-demand" : "Team spend"`, `category: "overage"`, `usedPercent`, `usedAmount`, `limitAmount`, `remainingAmount`, `unit: "USD"`, plus `resetsAt`/`windowDurationMins` when present).
   - Emit `subscriptionExpiresAt: resetsAt` when `resetsAt` is present and the cycle is monthly (`windowDurationMins === 0 || windowDurationMins >= 28 * 24 * 60`) so weekly unified-billing cycles are never mislabeled as subscription renewals.
   - Emit `planTier` from `membershipType` when non-empty (clean formatted tier, e.g. `pro -> Pro`, `pro_plus -> Pro+`, `ultra -> Ultra`, `team -> Team`, `enterprise -> Enterprise`, fallback trimmed raw).
2. **Antigravity (`apps/server/src/provider/antigravityUsageLimits.ts`)**:
   - Tag all `summaryWindows` and `modelWindows` with `category: "plan"` and `scopeLabel: family` (`"Gemini"`, `"Gemini Argon"`, `"Gemini Carbon"`, `"Claude & GPT (shared)"`, `"Claude"`, `"GPT"`, etc.).
   - Keep `antigravitySummaryWindows` signature/return type (`Effect<ServerProviderUsageWindow[], ...>`) unchanged so `cliproxyApi.ts` (owned by PR 2a) stays completely untouched.
3. **OpenCode Go (`packages/provider-opencode/src/server/usageLimits.ts`)**:
   - Tag `go_rolling`, `go_weekly`, and `go_monthly` windows with `category: "plan"` and `scopeLabel: "OpenCode Go"`.
   - Populate `planTier: "OpenCode Go"` on successful usage limits snapshots.
4. **Muse (`packages/provider-muse/src/server/usageLimits.ts`)**:
   - Tag `session` and `weekly` windows with `category: "plan"`.
   - Populate `planTier: tier` alongside `authLabel: tier` when `tier` is non-empty.

## Provider Payload Truth Table

| Probe                     | Upstream field(s)                                                                                          | Contract mapping                                                                             | Guard / fallback when absent                               |
| ------------------------- | ---------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- | ---------------------------------------------------------- |
| Cursor `planUsage`        | `totalPercentUsed`, `autoPercentUsed`, `apiPercentUsed`, optional `limit`/`totalSpend`/`remaining` (cents) | `category: "plan"`, `scopeLabel` on scoped pools, optional USD amounts on `totalPercentUsed` | Minimal percentage-only payloads omit amounts & `unit`     |
| Cursor `spendLimitUsage`  | optional `enabled`, `individualLimit`/`Used`/`Remaining`, `pooledLimit`/`Used`/`Remaining` (cents)         | `id: "on_demand"`, `category: "overage"`, USD amounts + percent                              | Omitted when `enabled === false` or limit `<= 0`           |
| Cursor cycle / membership | `billingCycleStart`, `billingCycleEnd`, optional `membershipType`                                          | `subscriptionExpiresAt` (monthly cycles only), `planTier`                                    | Short/weekly cycles (`< 28d`) omit `subscriptionExpiresAt` |
| Antigravity               | `retrieveUserQuotaSummary` / `fetchAvailableModels`                                                        | `category: "plan"`, `scopeLabel: family`                                                     | Disabled/missing buckets still skipped                     |
| OpenCode Go               | `/zen/go/v1/usage`                                                                                         | `category: "plan"`, `scopeLabel: "OpenCode Go"`, `planTier: "OpenCode Go"`                   | Unsupported/403 behavior unchanged                         |
| Muse                      | `MuseSubscriptionUsage`                                                                                    | `category: "plan"`, `planTier: tier`                                                         | Blank `tier` omits both `authLabel` and `planTier`         |

## 4-Quadrant Defense Matrix

- **Bad / malformed payloads**: Non-finite/negative cents, `limit <= 0`, `enabled: false`, or zero-spend placeholders never emit NaN or fabricated USD amounts.
- **Weekly vs monthly Cursor billing cycles**: `subscriptionExpiresAt` is only set when cycle duration is absent or `>= 28` days, avoiding false subscription expiry dates on weekly unified-billing pools.
- **Backward compatibility**: All added schema fields are `Schema.optional`; existing minimal payloads continue to produce valid limits without breaking callers.
- **Exclusive file fence**: Only touches the 4 IDE/subscription probe files and their tests (zero UI, i18n, contract, shared, `cliproxyApi.ts`, or `FORK.md`/`LESSONS.md` edits).

## Impact

- Exclusive files:
  - `packages/provider-cursor/src/server/usageLimits.ts`, `packages/provider-cursor/src/server/usageLimits.test.ts`
  - `apps/server/src/provider/antigravityUsageLimits.ts`, `apps/server/src/provider/antigravityUsageLimits.test.ts`
  - `packages/provider-opencode/src/server/usageLimits.ts`, `packages/provider-opencode/src/server/usageLimits.test.ts`
  - `packages/provider-muse/src/server/usageLimits.ts`, `packages/provider-muse/src/server/usageLimits.test.ts`
- Non-goals: No extra HTTP endpoints (e.g. `GetPlanInfo` or Stripe balance), no UI/i18n edits, no changes to PR 2a or PR 3a owned files.
