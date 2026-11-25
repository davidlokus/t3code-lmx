# Tasks

## 1. Group 1 — Contracts, Capability Negotiation & 4 External Quota Sources (`omp` Worker)

- [ ] 1.1 扩展契约与四级双向能力协商：`packages/contracts/src/providerUsageLimits.ts`（`UsageLimitSourceKind` 增加 `openrouter | copilot | ollama | openaiApi`）、`packages/contracts/src/environment.ts`（`EXTERNAL_USAGE_LIMIT_SOURCES_CAPABILITY`、`externalUsageLimitSources`）、`packages/client-runtime/src/connection/compatibility.ts`、`apps/server/src/environment/ServerEnvironment.ts`、`apps/server/src/ws.ts`、`apps/server/src/serverSettings.ts`；补齐四级降级与能力协商单测。
  - Verify: `vp test run packages/client-runtime/src/connection/compatibility.test.ts apps/server/src/serverSettings.test.ts apps/server/src/environment/ServerEnvironment.test.ts apps/server/src/ws.test.ts`
- [ ] 1.2 实现 `apps/server/src/usage/sources/openrouter.ts` 及 `openrouter.test.ts`：覆盖 `/credits` + `/key`、管理密钥 `/keys` 有界分页（≤50 页）、`/credits` 403 降级、Pay-as-you-go 周期花费余额、Credits/Limit/Budget/Free Requests 窗口、401/403 清洗错误。
  - Verify: `vp test run apps/server/src/usage/sources/openrouter.test.ts`
- [ ] 1.3 实现 `apps/server/src/usage/sources/copilot.ts` 及 `copilot.test.ts`：覆盖 `Authorization: token` 请求头、`quota_snapshots`（含跳过 unlimited/-1/0）、overage 余额、bare `YYYY-MM-DD` 重置日期保留、legacy `limited_user_quotas` 兜底、org-managed `token_based_billing` 有界 org billing 查询（≤5 org，零伪造 0% 条）。
  - Verify: `vp test run apps/server/src/usage/sources/copilot.test.ts`
- [ ] 1.4 实现 `apps/server/src/usage/sources/ollama.ts` 及 `ollama.test.ts`：纯 `node:crypto` 严格解析未加密 OpenSSH Ed25519 私钥（校验 magic/cipher/kdf/keyCount/内外公钥匹配派生公钥；拒绝加密或损坏密钥），实现 `<METHOD>,<uri>?ts=...` 签名，支持新版 USD 月度额度、旧版 Session/Weekly（仅在有 `resets_at` 时给时长）、Purchased Credits 与 `POST /api/me` 套餐名；导出 `resolveOllamaKeyPath`、`readOllamaKeyIdentity`、`readOllamaUsage`。
  - Verify: `vp test run apps/server/src/usage/sources/ollama.test.ts`
- [ ] 1.5 实现 `apps/server/src/usage/sources/openaiApi.ts` 及 `openaiApi.test.ts`：覆盖显式 Admin Key Bearer 鉴权（严禁读 `OPENAI_API_KEY` 或 Codex OAuth）、`/v1/organization/costs` 有界分页（≤10 页 + 游标环检测）、严格 USD 币种校验、UTC 日桶聚合 Today/Yesterday/This Month/30-Day Spend 余额、全 $0 合法响应（`windows: []`，无伪造百分比）。
  - Verify: `vp test run apps/server/src/usage/sources/openaiApi.test.ts`
- [ ] 1.6 将 4 个新源接入 `apps/server/src/usage/UsageLimitSources.ts`（扩展 `ReadQuotaJson` 支持可选 `method?: "GET" | "POST"`，保持 `hasValidHttpHeaderValues` + `Effect.withTracerEnabled(false)`；`ollama` 缓存目标键包含公钥 SHA-256 指纹以隔离换号），并补充 `UsageLimitSources.test.ts`（覆盖 4 新源拉取、失败保旧、换行密钥不泄漏 trace、ollama 换钥不串号）。
  - Verify: `vp test run apps/server/src/usage/UsageLimitSources.test.ts && vp run --filter @t3tools/contracts --filter @t3tools/client-runtime --filter t3 typecheck`

## 2. Group 2 — Settings UI, Matrix Badges, 10-Locale i18n & Visual QA (`agy` Coordinator)

- [ ] 2.1 更新 `apps/web/src/components/settings/AddUsageLimitSourceDialog.logic.ts`、`AddUsageLimitSourceDialog.tsx`、`UsageProviderSettings.tsx`、`ProviderSettingsPanel.tsx`：按 `externalUsageLimitSources` 门控新源选项，为 `openrouter`/`copilot`/`openaiApi` 分配 UUID 后缀 ID，为 `ollama` 提供 `ollama://default` 默认路径（无需密钥输入）；补充逻辑与浏览器单测。
  - Verify: `vp test run apps/web/src/components/settings/AddUsageLimitSourceDialog.logic.test.ts apps/web/src/components/settings/AddUsageLimitSourceDialog.browser.tsx`
- [ ] 2.2 更新 `apps/web/src/fork/usage/UsageLimitsMatrixView.tsx`：展示 `openrouter` / `copilot` / `ollama` / `openaiApi` 来源徽章与品牌图标；补充测试覆盖余额卡与新源渲染。
  - Verify: `vp test run apps/web/src/fork/usage/UsageLimitsMatrixView.browser.tsx`
- [ ] 2.3 运行 `vp run i18n:generate` 并补全全部 10 语种翻译，执行 `vp run i18n:check`；完成隔离实例 Dark + Light `ego-browser` 视觉验收。
  - Verify: `vp run i18n:check && vp run --filter @t3tools/web typecheck`

## 3. Group 3 — Cross-Model Review, Falsification & Fork Closeout

- [ ] 3.1 通过 Pre-Review Gate（`vp fmt --check`、`vp lint`、受影响包 typecheck 与单测）后，销毁写入 worker，拉起全新只读跨模型 Reviewer（`omp-rev-w3-ext`）审查 `git diff <plan-sha>` 直至 `VERDICT: PASS`。
  - Verify: Reviewer 返回 `VERDICT: PASS`（0 CRITICAL / 0 WARNING）且已 `hc kill` 清理子 worker
- [ ] 3.2 执行 `Broken by hand` 证伪验证（至少破坏一项能力降级过滤与一项私钥/签名校验并确认单测变红，再恢复变绿）。
  - Verify: 记录完整 RED → GREEN 证伪输出
- [ ] 3.3 归档 OpenSpec（`openspec archive usage-sources-ext --skip-specs --yes`），运行全套 Fork 门禁并提交开 PR 合并至 `origin/lmx-lab`。
  - Verify: `vp run check:changed origin/lmx-lab && vp test run packages/shared/src/forkIdentity.guard.test.ts && vp run i18n:check`
