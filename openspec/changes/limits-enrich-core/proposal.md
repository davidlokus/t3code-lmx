# Proposal: Enrich Core Provider Usage Limits (PR 2a)

## Why

Wave 1 (`feat/usage-limits-intelligence`, PR #20) shipped the optional rich quota contract (`usedAmount`, `limitAmount`, `remainingAmount`, `unit`, `category`, `scopeLabel`, `planTier`, `balances`, `subscriptionExpiresAt`) and four-lens `/usage` intelligence engine. However, the core backend probes (Claude, Codex, Grok, and CLIProxyAPI hub) still only populate percentages and reset timestamps, leaving dollar/credit amounts, categories, model scopes, credit balances, and subscription renewal dates empty even when the upstream payloads already carry them.

## What Changes

Populate the existing Wave 1 optional metadata fields in the four core provider probes without adding extra HTTP requests or breaking backwards compatibility with minimal/legacy payloads:

1. **Claude (`apps/server/src/provider/claudeUsageLimits.ts`)**:
   - Tag `five_hour` and `seven_day` windows with `category: "plan"` (in both full probes and `claudeRateLimitEventToUpdate` stream events so sparse merges stay unit/category-compatible).
   - Tag `model_scoped` windows with `category: "plan"` and `scopeLabel: displayName` (in both full probes and `claudeRateLimitEventToUpdate`).
   - Tag `monthly_spend` with `category: "overage"` and attach exact `usedAmount`, `limitAmount`, `remainingAmount`, and `unit`:
     - From `spend` (`enabled: true`, matching non-empty currency & exponent, `limit.amount_minor > 0`): scale `amount_minor / 10 ** exponent`, `unit: currency.trim().toUpperCase()`.
     - From `extra_usage` fallback (`is_enabled: true`, finite `used_credits >= 0`, `monthly_limit > 0`): if optional `currency` (trimmed non-empty) and `decimal_places` (natural int) are present, scale by `10 ** decimal_places` with `unit: currency.trim().toUpperCase()`; otherwise emit raw `used_credits`/`monthly_limit` with `unit: "credits"`.
     - Utilization-only fallback (`used_credits` or `monthly_limit` absent): emit percentage + `category: "overage"` only (never fabricate amounts or unit).
2. **Codex (`apps/server/src/provider/codexUsageLimits.ts`)**:
   - Tag `primary` and `secondary` windows with `category: "plan"`.
   - Extend optional `CodexRateLimitSnapshot.individualLimit` with `used?: string | null` and `limit?: string | null` (already emitted by `effect-codex-app-server` `V2GetAccountRateLimitsResponse__SpendControlLimitSnapshot`); tag `individual` with `category: "balance"` and attach parsed finite `usedAmount`/`limitAmount`/`remainingAmount` + `unit: "credits"` when `used >= 0` and `limit > 0`.
   - Extend optional `CodexRateLimitSnapshot` with `credits?: { hasCredits: boolean; unlimited: boolean; balance?: string | null } | null` (already on `V2GetAccountRateLimitsResponse__RateLimitSnapshot`) and `subscriptionActiveUntil?: string | number | null`:
     - Emit `balances: [{ id: "codex-credits", label: "Credits", remaining, unit: "credits", kind: "credits" }]` when `credits.hasCredits && !credits.unlimited` and `balance` parses to a finite number (`Math.max(0, parsed)`). Emit `balances: []` when `credits` is explicitly present with `hasCredits: false` (so explicit clears propagate cleanly); omit `balances` when `credits` is undefined.
     - Emit `subscriptionExpiresAt` when `subscriptionActiveUntil` parses to a valid ISO datetime or positive epoch seconds.
   - Emit `planTier` from non-empty, non-`"unknown"` `planType` (clean human tier name: `Plus`, `Pro`, `Pro 100`, `Pro 500`, `Free`, `Go`, `Business`, `Business Premium`, `Enterprise`, or trimmed raw fallback).
   - Update `mergeCodexRateLimits` to preserve/merge `credits` and `subscriptionActiveUntil`; keep `codexRateLimitsToUpdate` diffing accurately without emitting spurious empty-window updates.
3. **Grok (`packages/provider-grok/src/server/usageLimits.ts`)**:
   - Tag the `subscription` window with `category: "plan"`.
   - Optionally decode `subscription_tier_display` on `GrokUsageResponse` and populate `planTier` when non-empty.
4. **CLIProxyAPI (`apps/server/src/usage/cliproxyApi.ts`)**:
   - Extend `CodexUsage` with optional `credits` (`has_credits`, `unlimited`, `balance`) and `subscription_active_until`, and `AuthFile.id_token` with optional `chatgpt_subscription_active_until`; forward to `codexRateLimitsToLimits`.
   - Extend `ClaudeUsage.extra_usage` with optional `currency` and `decimal_places` so hub Claude spend accounts preserve exact currency amounts.

## Provider Payload Truth Table

| Probe                                        | Upstream field(s)                                                           | Contract mapping                                                                                      | Guard / fallback when absent                                                                         |
| -------------------------------------------- | --------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| Claude `five_hour`/`seven_day`               | `utilization`, `resets_at`                                                  | `category: "plan"`                                                                                    | Identical on probe + stream update                                                                   |
| Claude `model_scoped`                        | `display_name`, `utilization`, `resets_at`                                  | `category: "plan"`, `scopeLabel: display_name`                                                        | Skipped when `utilization` not numeric                                                               |
| Claude `spend`                               | `used/limit.{amount_minor, currency, exponent}`                             | `category: "overage"`, `usedAmount`, `limitAmount`, `remainingAmount`, `unit: currency.toUpperCase()` | Requires matching currency & exponent and `limit > 0`                                                |
| Claude `extra_usage`                         | `used_credits`, `monthly_limit`, optional `currency`, `decimal_places`      | `category: "overage"`, scaled currency or raw `"credits"`                                             | Utilization-only omits amounts & `unit`                                                              |
| Codex `primary`/`secondary`                  | `usedPercent`, `resetsAt`, `windowDurationMins`                             | `category: "plan"`                                                                                    | Same fallback durations as before                                                                    |
| Codex `individualLimit`                      | `remainingPercent`, `resetsAt`, optional `used`, `limit`                    | `category: "balance"`, optional `usedAmount`/`limitAmount`/`remainingAmount`, `unit: "credits"`       | Non-numeric or `limit <= 0` omits amounts                                                            |
| Codex `credits`                              | `hasCredits`, `unlimited`, `balance`                                        | `balances: [{ id: "codex-credits", label: "Credits", remaining, unit: "credits", kind: "credits" }]`  | `undefined` omits `balances`; `hasCredits: false` emits `[]`; `unlimited: true` omits finite balance |
| Codex `planType` / `subscriptionActiveUntil` | `planType`, `subscriptionActiveUntil` / `chatgpt_subscription_active_until` | `planTier`, `subscriptionExpiresAt`                                                                   | `"unknown"` / blank omitted; invalid date omitted                                                    |
| Grok                                         | `config.currentPeriod`, optional `subscription_tier_display`                | `category: "plan"`, optional `planTier`                                                               | Minimal payloads remain valid                                                                        |

## 4-Quadrant Defense Matrix

- **Bad / malformed payloads**: Non-numeric strings (`"NaN"`, `""`), negative limits, mismatched currencies/exponents, invalid dates, or `unlimited: true` never fabricate amounts, units, or expiries.
- **Mixed-fleet / streaming merge**: Streamed Claude and Codex updates emit identical `category`/`scopeLabel` so `applyUsageLimitsUpdate` (Wave 1) preserves probed metadata without unit/category conflicts.
- **Backward compatibility**: Every newly decoded upstream field is `Schema.optional` / optional property; existing minimal fixtures continue decoding cleanly.
- **Exclusive file fence**: Only touches the 4 core probe files and their unit tests (zero UI, i18n, contract, shared, or `FORK.md`/`LESSONS.md` edits).

## Impact

- Exclusive files:
  - `apps/server/src/provider/claudeUsageLimits.ts`, `apps/server/src/provider/claudeUsageLimits.test.ts`
  - `apps/server/src/provider/codexUsageLimits.ts`, `apps/server/src/provider/codexUsageLimits.test.ts`
  - `packages/provider-grok/src/server/usageLimits.ts`, `packages/provider-grok/src/server/usageLimits.test.ts`
  - `apps/server/src/usage/cliproxyApi.ts`, `apps/server/src/usage/cliproxyApi.test.ts`
- Non-goals: No new network requests, no UI/i18n edits, no changes to IDE probes (owned by PR 2b) or new limit sources (owned by PR 3a).
