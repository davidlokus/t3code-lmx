# usage-sources-omp-cn Specification

## Purpose

TBD - created by archiving change usage-sources-omp-cn. Update Purpose after archive.

## Requirements

### Requirement: Extended Usage Limit Source Contracts and Secret Compatibility

`UsageLimitSourceConfig` and `UsageLimitSourceSnapshot` SHALL support `kind` values `"cliproxy" | "http" | "omp" | "kimi" | "zai"`, optional `region?: "cn" | "global"` on `UsageLimitSourceConfig`, and optional rich window/account metadata on `HttpQuotaAccount`, while keeping `UsageLimitSourceConfig` a `Schema.Struct` compatible with server secret redaction and secret-provider references.

#### Scenario: Existing cliproxy and http configs decode identically

- **WHEN** an existing settings file contains `cliproxy` or `http` entries without `region`
- **THEN** `UsageLimitSourceConfig` decodes them without migration and `secretSettingsFields(UsageLimitSourceConfig)` continues protecting `managementKey`

#### Scenario: Legacy HTTP v1 quota endpoint remains valid

- **WHEN** an external HTTP quota endpoint returns `{ version: 1, accounts: [{ id, label, windows: [{ id, kind, label, usedPercent }] }] }` without any new optional fields
- **THEN** `HttpQuotaResponse` decodes it cleanly and omits all unset optional fields

### Requirement: Read-Only OMP Usage Cache Source with Anti-Double-Count Identity

An enabled `omp` usage limit source SHALL open the configured SQLite database (`$OMP_CODING_AGENT_DIR/agent.db`, `~/.omp/agent/agent.db`, or explicit path) strictly read-only (`readOnly: true`, `PRAGMA busy_timeout = 100`), SHALL NEVER inherit `PI_CODING_AGENT_*` environment variables, SHALL NEVER read `auth_credentials` or OAuth/API tokens, and SHALL route cached reports to prevent double-counting with native or CLIProxyAPI accounts.

#### Scenario: Native-driver cached rows deduplicate against native and CLIProxyAPI routes

- **WHEN** `agent.db` contains `usage_cache:report:*` rows for providers T3 Lab natively supports (`openai-codex`, `cursor`, `xai-oauth`, `muse-code`, `opencode-go`, `google-antigravity`, `anthropic`)
- **THEN** rows with a verified `email` are emitted in `snapshot.accounts[]` with the mapped T3 `driver` and reported `email`/`workspaceId` so `collectLimitsIntelligence` and `collectLimitAccounts` merge them by canonical identity without attaching CLIProxyAPI reset-credit redemption, while email-less rows (e.g. `api_key|secret:*` or workspace-only entries) stay explicitly separated in `snapshot.quotaAccounts[]` so they never create unverified duplicate native rows

#### Scenario: Non-native cached providers surface as rich quota accounts

- **WHEN** `agent.db` contains `usage_cache:report:*` rows for providers without a native T3 driver (e.g. `kimi-code`, `zai`, `commandcode`)
- **THEN** the `omp` source emits them in `snapshot.quotaAccounts[]` with normalized windows (`usedPercent`, `resetsAt`, `windowDurationMins`, `usedAmount`, `limitAmount`, `remainingAmount`, `unit`, `category`) and `planTier`

#### Scenario: Missing database or corrupt cache rows degrade safely

- **WHEN** the target `agent.db` file does not exist or one `usage_cache:report:*` row holds malformed JSON
- **THEN** a missing file returns a clean error snapshot without throwing, and a corrupt single row is skipped while healthy rows still publish

### Requirement: Direct Kimi Code API-Key Usage Source

An enabled `kimi` usage limit source SHALL query `https://api.kimi.com/coding/v1/usages` (`region: "cn"`, default) or `https://api.kimi.ai/coding/v1/usages` (`region: "global"`) using the resolved secret in the `x-api-key` header with `redirect: "error"`, a 10-second timeout, and a 1 MiB body limit.

#### Scenario: Modern ratio response with booster wallet and membership level

- **WHEN** Kimi returns `usages.{limit_5h, limit_7d, limit_month_total, limit_month_code}`, `booster_wallet.balance.amountLeft`, and `user.membership.level`
- **THEN** the source emits normalized quota windows with percentages and reset timestamps, converts `amountLeft` from millionths of a cent to USD in `balances[]`, and formats `LEVEL_*` into `planTier`

#### Scenario: Legacy counter fallback protects against stale zero summary ratios

- **WHEN** Kimi returns legacy `usage` / `limits[]` counters (numeric or numeric-string `used`/`limit`) alongside a stale `used_ratio: 0`
- **THEN** the non-zero legacy counter reading wins so active usage is never reset to 0%

#### Scenario: Credential-free error handling

- **WHEN** Kimi returns HTTP 401/403, times out, or fails to connect
- **THEN** the source returns a credential-free error message that never includes the API key or raw response body

### Requirement: Direct Z.ai / BigModel Coding Plan Usage Source

An enabled `zai` usage limit source SHALL query `https://api.z.ai` (`region: "global"`, default) or `https://open.bigmodel.cn` (`region: "cn"`) using `Authorization: Bearer <apiKey>` with `redirect: "error"`, a 10-second timeout, and a 1 MiB body limit, reading `/api/monitor/usage/quota/limit` (required) and `/api/biz/subscription/list` (best-effort).

#### Scenario: Quota meters and subscription metadata publish together

- **WHEN** `/api/monitor/usage/quota/limit` returns `CREDIT_LIMIT`/`TOKENS_LIMIT` windows and `TIME_LIMIT` web searches, and `/api/biz/subscription/list` returns a `VALID` subscription
- **THEN** the source emits session/weekly/monthly quota windows (with optional `usedAmount`/`limitAmount`/`remainingAmount` in `"credits"` or `"searches"` and epoch-ms `resetsAt`), sets `planTier` from `productName`, and sets `subscriptionExpiresAt` from `nextRenewTime` (preserving date-only `YYYY-MM-DD` strings verbatim)

#### Scenario: Subscription list failure does not discard quota meters

- **WHEN** `/api/monitor/usage/quota/limit` succeeds but `/api/biz/subscription/list` fails or times out
- **THEN** the source still publishes all valid quota windows without failing the snapshot

#### Scenario: HTTP 200 business error envelopes fail explicitly

- **WHEN** Z.ai answers HTTP 200 with `{"success":false,"code":401}` or `{"success":false,"code":500,"msg":"...coding plan"}`
- **THEN** the source returns an explicit rejected-key or no-coding-plan error rather than publishing empty zero-usage meters

### Requirement: Last-Good Quota Preservation and Intelligence Projection

`UsageLimitSources` SHALL retain the previous valid `quotaAccounts` when a transient refresh returns an error for the same configured source identity, and shared projections SHALL surface all `quotaAccounts` across `/usage` Pools, Matrix, Resets, Alerts, Expiries, and notices, while thread details SHALL surface `quotaAccounts` from any source kind only when explicitly bound via `providerInstanceId` (never attaching unbound independent sources to unrelated threads).

#### Scenario: Transient Kimi or Z.ai outage keeps last good quota readings

- **WHEN** a `kimi`, `zai`, `omp`, or `http` source previously published valid `quotaAccounts` and a subsequent poll returns an error
- **THEN** the published snapshot preserves the last good `quotaAccounts` alongside the `error` notice so dashboard meters do not flicker empty

#### Scenario: Shared projections handle rich quota accounts and multi-bucket sources

- **WHEN** a source publishes `quotaAccounts` with `planTier`, `subscriptionExpiresAt`, `balances`, and rich window fields
- **THEN** `collectLimitsIntelligence` surfaces those windows in Pools/Matrix/Resets/Alerts and surfaces `subscriptionExpiresAt` and `balances` in Expiries, while `collectLimitNotices` reports "No accounts reported" only when both `accounts` and `quotaAccounts` are empty

### Requirement: Settings UI Management for Independent Sources

The Usage Sources settings section and Add Usage Limit Source dialog SHALL allow adding, inspecting, and removing `cliproxy`, `http`, `omp`, `kimi`, and `zai` sources with tailored region, path, and secret controls, and all user-facing strings SHALL be localized across the web translation catalogs.

#### Scenario: Adding an OMP, Kimi, or Z.ai source in Settings

- **WHEN** a user opens the Add Usage Limit Source dialog and selects `OMP Local Cache`, `Kimi Code`, or `Z.ai / BigModel`
- **THEN** the dialog presents only the relevant fields for that kind (optional DB path for OMP without a secret field; region selector + `SecretSourceInput` API key for Kimi and Z.ai), validates input, saves the config under a collision-free source ID, and displays the configured source with a Remove action
