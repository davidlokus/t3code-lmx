# Design: Independent Usage Limit Sources (`omp`, `kimi`, `zai`)

## Architecture Overview

PR 3a extends T3 Lab's existing `UsageLimitSources` Effect service (`apps/server/src/usage/UsageLimitSources.ts`) rather than introducing a second polling daemon or parallel settings map. All five source kinds (`cliproxy`, `http`, `omp`, `kimi`, `zai`) share:

- One `ServerSettings.usageLimitSources` record with `UsageLimitSourceConfig` kept as a `Schema.Struct` so `settingsSecrets.ts` (`secretSettingsFields(UsageLimitSourceConfig)`) and `SecretsSettings.logic.ts` protect `managementKey` (literal redaction + 1Password/env `SecretReference` resolution) with zero extra plumbing.
- One serialized `Semaphore(1)` refresh loop and `PubSub` stream (`usageLimitSourcesUpdated`).
- One `UsageLimitSourceSnapshot` wire format (`accounts[]` for T3-native-driver accounts that join canonical identity deduplication; `quotaAccounts[]` for non-native/direct quota accounts that render in Web Pools, the 4-lens intelligence engine, AND Mobile `UsageLimitsPooled`).

## Source Payload Truth Table

### 1. `omp` (`apps/server/src/usage/sources/omp.ts`)

Verified against live `~/.omp/agent/agent.db`:

- **Database open**: `new NodeSqlite.DatabaseSync(dbPath, { readOnly: true })` + `PRAGMA busy_timeout = 100`, always closed in `finally`.
- **Path resolution**:
  - Sentinel `"omp://default"` -> `env.OMP_CODING_AGENT_DIR` (if non-empty, expanded via `expandHomePath`) + `agent.db`, else `path.join(home, ".omp", "agent", "agent.db")`.
  - **Invariant (`LESSONS.md #6`)**: NEVER inspect `PI_CODING_AGENT_DIR` or `PI_CODING_AGENT_SESSION_DIR`.
  - Any other `config.url` -> `path.resolve(expandHomePath(config.url, home))`.
- **SQL query**: `SELECT key, value, expires_at FROM cache WHERE key LIKE 'usage_cache:report:%'`. NEVER queries `auth_credentials`.
- **Observed `UsageReport` JSON shape**:
  - `provider`: string (`"openai-codex"`, `"cursor"`, `"xai-oauth"`, `"muse-code"`, `"opencode-go"`, `"google-antigravity"`, `"anthropic"`, `"kimi-code"`, `"zai"`, `"commandcode"`, ...)
  - `fetchedAt`: epoch ms or ISO string
  - `metadata`: `{ planType?, email?, accountId?, organizationId? }`
  - `limits[]`: `{ id, label, window?: { durationMs?, resetsAt? }, amount?: { used?, limit?, remaining?, usedFraction?, unit? }, status? }`
- **Routing / anti-double-count**:
  - Native drivers (`openai-codex -> codex`, `cursor -> cursor`, `xai-oauth -> grok`, `muse-code -> muse`, `opencode-go -> opencode`, `google-antigravity -> antigravity`, `anthropic | claude -> claudeAgent`) emit into `accounts[]` (`UsageLimitSourceAccount`) with `driver`, `email`, `workspaceId: organizationId ?? accountId`, `plan`/`planTier`, and `usageLimits`. Canonical identity in `usageLimits.ts` and `usageLimitsIntelligence.ts` automatically deduplicates them against native probes & CLIProxyAPI.
  - Non-native providers emit into `quotaAccounts[]` (`HttpQuotaAccount`) with rich window fields and `planTier`.
  - Window `usedPercent`: derived from `amount.usedFraction * 100` (when finite in `[0, 1]` or clamped `[0, 100]`), else `(amount.used / amount.limit) * 100` when `limit > 0`, else skip invalid limit row.

### 2. `kimi` (`apps/server/src/usage/sources/kimi.ts`)

Verified against OpenUsage `KimiUsageClient.swift` & `KimiUsageMapper.swift`:

- **Endpoints**: `cn` (default) = `https://api.kimi.com/coding/v1/usages`; `global` = `https://api.kimi.ai/coding/v1/usages`.
- **Headers**: `x-api-key: <resolvedKey>`, `Accept: application/json`.
- **Response envelope**: `envelope.data?.quota ?? envelope`.
- **Windows**:
  - `usages.limit_5h ?? usages.limit5h` -> `id: "session"`, `kind: "session"`, `label: "Session"`, `windowDurationMins: 300`, fallback to `limits[]` 300-minute entry.
  - `usages.limit_7d ?? usages.limit7d` -> `id: "weekly"`, `kind: "weekly"`, `label: "Weekly"`, `windowDurationMins: 10080`, fallback to `usage` block.
  - `usages.limit_month_total` -> `id: "monthly_total"`, `kind: "monthly"`, `label: "Monthly Total"`.
  - `usages.limit_month_code` -> `id: "monthly_coding"`, `kind: "monthly"`, `label: "Monthly Coding"`.
  - Stale-zero guard: if `used_ratio === 0` and legacy counter reports `usedPercent > 0`, retain legacy reading.
  - Numeric strings (e.g. `"100"`, `"12"`) accepted for legacy `used`/`limit`/`duration`.
- **Balances & Plan**:
  - `booster_wallet.balance.amountLeft` (or `boosterWallet`): millionths of a cent -> `remaining = amountLeft / 1e8`, `unit: "USD"`, `id: "kimi-booster"`, `label: "Booster"`, `kind: "balance"`.
  - `user.membership.level`: strip `LEVEL_` prefix and title-case (e.g. `LEVEL_ADVANCED` -> `"Advanced"`).

### 3. `zai` (`apps/server/src/usage/sources/zai.ts`)

Verified against OpenUsage `ZAIPlatform.swift`, `ZAIUsageClient.swift`, `ZAIUsageMapper.swift`:

- **Endpoints**: `global` (default) = `https://api.z.ai`, `cn` = `https://open.bigmodel.cn`.
  - Required: `GET <base>/api/monitor/usage/quota/limit`
  - Best-effort: `GET <base>/api/biz/subscription/list`
- **Headers**: `Authorization: Bearer <resolvedKey>`, `Accept: application/json`.
- **HTTP 200 business errors**:
  - `success === false && code === 401` -> rejected API key error.
  - `success === false && /coding plan/i.test(msg)` -> no active GLM Coding Plan error.
- **Limits mapping** (`root.data?.limits ?? root.limits`):
  - `type`/`name` in `["CREDIT_LIMIT", "TOKENS_LIMIT"]`:
    - `unit: 3` -> hours, `4` -> days, `6` -> weeks, `5` -> months (`periodMs = unitMs * number`).
    - Sub-daily (`< 24h`) -> `id: "session"`, `kind: "session"`, `label: "Session"`; multi-day -> `id: "weekly"` (or `"monthly"` if `>= 28d`), `kind: period >= 28d ? "monthly" : "weekly"`, `label`.
    - `usedPercent = clampPercent(percentage)`, `resetsAt = iso(nextResetTime)` (epoch ms), `windowDurationMins = Math.round(periodMs / 60_000)`, `category: "plan"`, plus optional `usedAmount: currentValue`, `limitAmount: usage`, `remainingAmount: Math.max(0, usage - currentValue)`, `unit: "credits"` when both finite and `usage > 0`.
  - `type`/`name === "TIME_LIMIT"`:
    - `id: "web_searches"`, `kind: "monthly"`, `label: "Web Searches"`, `usedPercent = usage > 0 ? clampPercent((currentValue / usage) * 100) : 0`, `usedAmount: currentValue`, `limitAmount: usage`, `remainingAmount: Math.max(0, usage - currentValue)`, `unit: "searches"`, `category: "plan"`, `resetsAt = iso(nextResetTime)`, `windowDurationMins: 30 * 24 * 60`.
- **Subscription mapping** (`root.data` array):
  - Pick first `status?.toUpperCase() === "VALID"` with `inCurrentPeriod === true`, else first `VALID`.
  - `planTier`: trimmed `productName`.
  - `subscriptionExpiresAt`: trimmed `nextRenewTime` — if bare `YYYY-MM-DD`, preserve verbatim so Wave 1 UTC date-only rendering shows the exact calendar date (`LESSONS.md #13`); if `YYYY-MM-DD HH:mm:ss`, extract the calendar date `YYYY-MM-DD` (since Z.ai omits timezone offset).

## 4-Quadrant Defense Matrix

| Threat / Failure Mode                       | Defense                                                                                                                                                                                                                                                                                                                                   |
| ------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Credential / Token Leak**                 | `omp` never queries `auth_credentials`; `kimi`/`zai` store keys in `UsageLimitSourceConfig.managementKey` (`secretSetting` -> server secret store + `SECRET_REDACTED` wire redaction); error messages emit only status codes / sanitized reasons, never keys or raw bodies; `redirect: "error"` prevents bearer/API-key redirect leakage. |
| **Double-Counting / Wrong Redemption**      | `omp` maps native drivers to `accounts[]` with matching `driver` + `email`/`workspaceId` so canonical identity merges with native/CLIProxyAPI; `usageLimitsIntelligence.ts` attaches `redeem` ONLY when `source.kind === "cliproxy"` and `UsageLimitSources.consumeResetCredit` rejects non-`cliproxy` kinds.                             |
| **Transient Outage Flicker & Slow Network** | 10s timeout + 1 MiB response cap on `kimi`/`zai`; `zai` subscription fetch is best-effort; `keepLastGoodReadings` preserves prior valid `quotaAccounts` (alongside `error`) when a transient refresh fails for the same source identity (`id`, `kind`, `endpoint`/`url`).                                                                 |
| **Cross-Runtime & Hermes Safety**           | `packages/shared/**` remains pure JS without `.toSorted()` or Node APIs; `omp.ts` uses `node:sqlite` strictly inside `apps/server` with `readOnly: true` and `finally { db.close() }`; never reads `PI_CODING_AGENT_*`.                                                                                                                   |

## Public Export Boundary

- `@t3tools/contracts`:
  - `UsageLimitSourceKind` (`"cliproxy" | "http" | "omp" | "kimi" | "zai"`), `UsageLimitSourceRegion` (`"cn" | "global"`).
  - `UsageLimitSourceConfig` (extended `Schema.Struct` with `kind: UsageLimitSourceKind`, optional `region: UsageLimitSourceRegion`).
  - `HttpQuotaAccount` (extended with optional rich window fields + `planTier`/`subscriptionExpiresAt`/`balances`/`serviceNotice`).
  - `UsageLimitSourceSnapshot` (`kind: UsageLimitSourceKind`).
- `@t3tools/shared/usageLimits` & `@t3tools/shared/usageLimitsIntelligence`:
  - Existing exports preserved; `NormalizedLimitAccount["sourceKind"]` extended to `"native" | "cliproxy" | "http" | "omp" | "kimi" | "zai"`.
- `apps/server/src/usage/sources/{omp,kimi,zai}.ts`: internal server modules (no new package exports; keep knip clean).
