# Proposal: Independent Usage Limit Sources — OMP Cache, Kimi Code & Z.ai (PR 3a)

## Why

Wave 1 (`feat/usage-limits-intelligence`, PR #20) delivered the four-lens `/usage` subscription intelligence dashboard, and Wave 2 PRs 2a/2b enrich built-in provider probes. However, users who rely on subscriptions outside T3 Lab's native provider adapters—specifically **Kimi Code** (`cn`/`global`), **Z.ai / BigModel GLM Coding Plan** (`global`/`cn`), or multi-provider quotas already cached locally by **oh-my-pi (`omp`)** in `~/.omp/agent/agent.db`—still cannot see those quotas, balances, or renewal dates inside `/usage` without running an external menu-bar app.

## What Changes

Extend T3 Lab's `UsageLimitSources` architecture with three first-class independent sources (`omp`, `kimi`, `zai`), rich quota-account metadata pass-through, and Settings UI + i18n support:

1. **Contract & Shared Projection Extensions**:
   - Extend `UsageLimitSourceKind` to `"cliproxy" | "http" | "omp" | "kimi" | "zai"` on both `UsageLimitSourceConfig` and `UsageLimitSourceSnapshot` (keeping `UsageLimitSourceConfig` a `Schema.Struct` so `settingsSecrets.ts` and `SecretsSettings.logic.ts` secret redaction & secret-provider references continue working automatically).
   - Add optional `region?: "cn" | "global"` to `UsageLimitSourceConfig` for `kimi` and `zai`.
   - Extend `HttpQuotaAccount` (backward-compatibly with `Schema.optional(...)`) to carry optional rich window fields (`windowDurationMins`, `usedAmount`, `limitAmount`, `remainingAmount`, `unit`, `category`, `scopeLabel`) and optional account metadata (`planTier`, `subscriptionExpiresAt`, `balances`, `serviceNotice`).
   - Generalize shared projections (`collectHttpQuotaSources`, `collectLimitNotices`, `collectLimitsIntelligence`, `resolveThreadHttpQuotas`) to consume `quotaAccounts` from any source kind (`http`, `omp`, `kimi`, `zai`), while ensuring `cliproxy` reset-credit redemption (`redeem`) is ONLY attached to `source.kind === "cliproxy"` accounts.
2. **Server Source Implementations (`apps/server/src/usage/sources/`)**:
   - **`omp.ts` (`kind: "omp"`)**: Strictly read-only `node:sqlite` reader (`{ readOnly: true }`, `PRAGMA busy_timeout = 100`) for `$OMP_CODING_AGENT_DIR/agent.db` / `~/.omp/agent/agent.db` (or explicit custom path, never inheriting `PI_CODING_AGENT_*` and never querying `auth_credentials` or OAuth tokens). Maps native-driver rows (`openai-codex`, `cursor`, `xai-oauth`, `muse-code`, `opencode-go`, `google-antigravity`, `anthropic`) into `accounts[]` for automatic canonical-identity deduplication against native/CLIProxyAPI routes, and non-native providers (`kimi-code`, `zai`, `commandcode`, etc.) into rich `quotaAccounts[]`.
   - **`kimi.ts` (`kind: "kimi"`)**: Direct API-key reader (`x-api-key`) against `https://api.kimi.com/coding/v1/usages` (`cn`) or `https://api.kimi.ai/coding/v1/usages` (`global`), parsing modern ratio summaries + legacy counter fallback (with stale-zero protection), `booster_wallet` USD balance, and `user.membership.level` plan tier.
   - **`zai.ts` (`kind: "zai"`)**: Direct API-key reader (`Authorization: Bearer`) against `https://api.z.ai` (`global`) or `https://open.bigmodel.cn` (`cn`), fetching `/api/monitor/usage/quota/limit` (`CREDIT_LIMIT`/`TOKENS_LIMIT` session & weekly meters with credit amounts + `TIME_LIMIT` web-search meter) plus best-effort `/api/biz/subscription/list` (`planTier` + `subscriptionExpiresAt`), handling HTTP 200 business error envelopes (`code: 401`, no-coding-plan `code: 500`).
   - **`UsageLimitSources.ts`**: Dispatch `"omp"`, `"kimi"`, `"zai"` alongside `"cliproxy"` and `"http"`; extend `keepLastGoodReadings` to preserve last good `quotaAccounts` when a transient refresh returns an error for the same configured source.
3. **Settings UI & i18n (Wave 2 Single i18n Writer)**:
   - Update `UsageProviderSettings.tsx`, `AddUsageLimitSourceDialog.tsx`, and `AddUsageLimitSourceDialog.logic.ts` to add, display, and remove `cliproxy`, `http`, `omp`, `kimi`, and `zai` sources using `SecretSourceInput` for API keys/tokens and clear region/path controls.
   - Update all locale catalogs via `vp run i18n:generate` and verify `vp run i18n:check`.

## Capabilities

### New Capabilities

- `usage-sources-omp-cn`: Independent usage limit sources for local `omp` SQLite usage cache (read-only, anti-double-count), direct Kimi Code API-key quotas (`cn`/`global`), and direct Z.ai / BigModel GLM Coding Plan API-key quotas (`global`/`cn`), with Settings UI management and full `/usage` four-lens intelligence integration.

### Modified Capabilities

- `usage-limits-intelligence`: Generalize quota-account ingestion and rich metadata pass-through across all non-CLIProxyAPI source kinds (`http`, `omp`, `kimi`, `zai`) while restricting reset-credit redemption strictly to `cliproxy` sources.

## Impact

- Exclusive files:
  - `packages/contracts/src/settings.ts`, `packages/contracts/src/providerUsageLimits.ts`
  - `packages/shared/src/usageLimits.ts`, `packages/shared/src/usageLimitsCopy.ts`, `packages/shared/src/usageLimitsIntelligence.ts` (+ unit tests)
  - `apps/server/src/usage/UsageLimitSources.ts`, `apps/server/src/usage/UsageLimitSources.test.ts`
  - `apps/server/src/usage/sources/{omp,kimi,zai}.{ts,test.ts}`
  - `apps/web/src/components/chat/ThreadDetailsUsage.logic.ts`
  - `apps/web/src/components/settings/{UsageProviderSettings,AddUsageLimitSourceDialog,AddUsageLimitSourceDialog.logic}*` (+ browser test)
  - `apps/web/src/i18n/translations/*.json`
- Zero overlap with Wave 2 PR 2a (`claude/codex/grok/cliproxyApi`) or PR 2b (`cursor/antigravity/opencode/muse`).
- Mobile compatibility: Because `HttpQuotaAccount` extensions are strictly optional and `collectHttpQuotaSources` emits `quotaAccounts`, `apps/mobile/src/features/usage/UsageLimitsPooled.tsx` displays `omp`/`kimi`/`zai` quota accounts without requiring mobile code changes.
