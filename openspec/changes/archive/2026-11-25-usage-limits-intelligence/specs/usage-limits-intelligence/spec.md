## Purpose

Define Fork-owned wire contract extensions, burn-rate intelligence calculations, manual subscription override persistence, four-lens `/usage` Limits views, and Overview activity streak semantics for T3 Lab (Extend) while remaining strictly backward-compatible with older servers and upstream pooled limits.

## ADDED Requirements

### Requirement: Backward-compatible rich usage-limit wire contracts

The system SHALL extend `ServerProviderUsageWindow` and `ServerProviderUsageLimits` in `packages/contracts/src/providerUsageLimits.ts` exclusively with optional fields (`usedAmount`, `limitAmount`, `remainingAmount`, `unit`, `category`, `scopeLabel`, `subscriptionExpiresAt`, `planTier`, `balances`, `serviceNotice`) and preserve those fields across sparse streaming updates in `applyUsageLimitsUpdate`.

#### Scenario: Legacy server payload without new optional fields

- **WHEN** a client receives `ServerProviderUsageLimits` from an older server omitting all new optional fields
- **THEN** schema decoding succeeds without error and the intelligence engine derives pools, resets, alerts, and expiries solely from `usedPercent`, `resetsAt`, `windowDurationMins`, `resetCredits`, and `unavailable` without fabricating amounts or expiries

#### Scenario: Sparse mid-turn window update arrives after a full probe

- **WHEN** `applyUsageLimitsUpdate` receives a window update carrying only `id`, `kind`, `label`, `usedPercent`, and `resetsAt`
- **THEN** previously probed `usedAmount`, `limitAmount`, `remainingAmount`, `unit`, `category`, and `scopeLabel` on matching windows, as well as account-level `subscriptionExpiresAt`, `planTier`, `balances`, and `serviceNotice`, are preserved unless explicitly replaced by the update

### Requirement: Honest burn-rate pacing and exhaustion projection

The shared pure engine (`@t3tools/shared/usageLimitsIntelligence`) SHALL compute window burn pace (`paceRatio`, `projectedUsedAtResetPercent`, `projectedExhaustionMs`, and status `"exhausted" | "will-exhaust" | "ahead" | "on-pace" | "under-pace" | "insufficient-data"`) without fabricating projections from missing or noisy data.

#### Scenario: Window lacks duration or reset timestamp

- **WHEN** a window omits `windowDurationMins`, has `windowDurationMins <= 0`, omits `resetsAt`, or has `resetsAt <= now`
- **THEN** `computeWindowBurnPace` returns `null`

#### Scenario: Early window sample prevents false spike alerts

- **WHEN** elapsed time in the window is under 5% of total duration and under 5 minutes (or `usedPercent === 0`)
- **THEN** `computeWindowBurnPace` returns status `"insufficient-data"` with `paceRatio: null` and `projectedExhaustionMs: null`

#### Scenario: Fast burn projected to exhaust before reset

- **WHEN** a 5-hour window is 50% elapsed with `usedPercent === 75`
- **THEN** `computeWindowBurnPace` returns status `"will-exhaust"`, `paceRatio` of `1.5`, `projectedUsedAtResetPercent` of `150`, and `projectedExhaustionMs` strictly earlier than `resetsAt`

### Requirement: Unified multi-source limits intelligence and alerts

`collectLimitsIntelligence` SHALL aggregate native providers, CLIProxyAPI hub accounts, and HTTP quota sources with manual subscription overrides into deterministic `resets`, `alerts`, and `expiries` using canonical fleet identity keys and metadata-preserving mixed-fleet deduplication.

#### Scenario: Mixed-fleet deduplication and filtered workspace-less routes preserve identity and metadata

- **WHEN** a native provider with `email` and `workspaceId` and a workspace-less hub route for the same email report overlapping snapshots, or the user filters to only the hub route while passing the unfiltered fleet via `identityPresentations`
- **THEN** both views resolve the same canonical `account.key` so saved manual renewals remain attached, fresher explicit values (including `balances: []`) win while omitted optional metadata and unit-compatible window fields inherit from other readable routes, and conflicting units never cross-inherit amounts

#### Scenario: Alert severity ranking respects user threshold

- **WHEN** `alertThresholdPercent` is configured to `80` (20% remaining) and accounts contain an exhausted window (`100%` used), a window at `85%` used (`15%` remaining), and a healthy window at `30%` used
- **THEN** `alerts` includes a `critical` alert for the exhausted window, a `warning` alert for the `85%` window, and no quota-threshold alert for the `30%` window, ordered `critical` before `warning` before `info`

#### Scenario: HTTP quota source windows appear in resets and alerts

- **WHEN** a connected environment reports an `http` `UsageLimitSourceSnapshot` with `quotaAccounts` containing windows with `resetsAt` and high `usedPercent`
- **THEN** `collectLimitsIntelligence` includes those windows in `resets` and evaluates them in `alerts` alongside native and CLIProxyAPI accounts

#### Scenario: Expiries unify provider expiries, reset credits, balances, and manual overrides

- **WHEN** an account has a manual override `expiresAt` (and no provider `subscriptionExpiresAt`), another account has an expiring reset credit, and another has an expiring prepaid balance
- **THEN** `expiries` includes all three sorted soonest-first with accurate `source` (`"provider" | "manual"`) and `kind` (`"subscription" | "reset-credit" | "balance"`), while a provider-reported `subscriptionExpiresAt` takes precedence over a manual expiry override

### Requirement: Four-lens `/usage` Limits UI and global display modes

The `/usage` Limits view (`UsageLimitsEnhanced`) SHALL provide four switchable lenses (`Pools`, `Resets`, `Alerts`, `Expiries`), a `Pool ↔ Matrix` layout toggle inside `Pools`, global `Left ↔ Used` (`quotaDisplayMode`) and `Countdown ↔ Exact` (`resetTimeMode`) toggles, and a dialog to create, edit, and clear local manual subscription overrides.

#### Scenario: Switching lenses and Pool-to-Matrix view preserves environment and provider filters

- **WHEN** the user switches between `Pools` (`Pool` and `Matrix` layouts), `Resets`, `Alerts`, and `Expiries` while filtering providers or environments
- **THEN** only matching visible environments and providers are shown in every lens and persisted preferences survive reload without resetting other usage options

#### Scenario: Global Left/Used and Countdown/Exact toggles update Pool, Matrix, and Quota Strip

- **WHEN** the user switches `quotaDisplayMode` to `"used"` or `resetTimeMode` to `"exact"`
- **THEN** percentage headlines and labels switch from remaining (`X% left`) to consumed (`Y% used`), and reset indicators switch between relative countdowns and formatted clock timestamps across `UsageLimitsPooled`, `UsageLimitsMatrixView`, and `UsageQuotaStrip`

#### Scenario: Manual subscription override round-trip

- **WHEN** the user saves a manual renewal date, monthly cost, and plan label for an account in `UsageSubscriptionOverrideDialog` and later clears it
- **THEN** the Expiries lens immediately reflects the saved expiry and tracked monthly total (persisted in `localStorage`), and clearing removes the override cleanly without leaving stale state

### Requirement: Honest Overview activity streak

The Overview `UsageKpiCards` SHALL display the current consecutive active-day streak computed from loaded daily buckets when viewing day resolution and `currentDays > 0`, without claiming history beyond the queried window.

#### Scenario: Consecutive active days including yesterday-only grace

- **WHEN** daily usage has activity on the 3 consecutive days ending yesterday (and zero today so far) within a 30-day window
- **THEN** `computeUsageStreak` reports `currentDays: 3`, `longestDays: 3`, and `reachesWindowStart: false`; if all 7 days of a 7-day window are active, `reachesWindowStart` is `true` so the UI displays `7+d` instead of overclaiming an exact all-time streak
