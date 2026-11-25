# Proposal

- **Epic Charter**: [openspec/epics/usage-subscriptions.md](../../epics/usage-subscriptions.md)（Wave 3 / PR 3b：`feat/usage-sources-ext`）
- **Tier**: L1+ Light Spec（沿 Wave 1 冻结契约与 Wave 2 PR #23 `UsageLimitSources` 架构增量扩展 4 个独立远端/API 配额源 + Settings UI + Matrix 徽章 + Wave 3 唯一 10 语种 i18n）
- **Exclusive File Ownership Fence（与并行 PR 4 `feat/usage-local-history-sources` 零重叠）**：
  - `packages/contracts/src/providerUsageLimits.ts`
  - `packages/contracts/src/environment.ts`
  - `packages/client-runtime/src/connection/compatibility.ts` (+ test)
  - `apps/server/src/environment/ServerEnvironment.ts` (+ test)
  - `apps/server/src/serverSettings.ts` (+ test)
  - `apps/server/src/ws.ts` (+ test)
  - `apps/server/src/usage/UsageLimitSources.ts` (+ test)
  - `apps/server/src/usage/sources/{openrouter,copilot,ollama,openaiApi}.ts` (+ tests)
  - `apps/web/src/components/settings/{AddUsageLimitSourceDialog*,UsageProviderSettings,ProviderSettingsPanel}.tsx` (+ tests)
  - `apps/web/src/fork/usage/{UsageLimitsMatrixView,UsageLimitsResetsView}.tsx` (+ tests)
  - `packages/secret-provider-core/src/server/SecretResolver.ts`（`revisionSync` 零让出同步版本查询）
  - `packages/shared/src/{usageLimits,usageLimitsIntelligence}.ts`（`parseUsageLimitTimestampMs` 统一日历校验）
  - `apps/web/src/components/usage/UsageLimitsPooled.tsx`、`apps/web/src/timestampFormat.ts` (+ tests)
  - `apps/web/src/i18n/translations/*.json`（Wave 3 单写者）

## Why

Wave 2（PR #23）已将 `UsageLimitSources` 扩展至 `omp`、`kimi`、`zai` 并验证了统一配额通道、密钥隔离与双向能力协商机制。本 PR 补齐其余 4 个高频独立远端/API 配额与账单源（OpenRouter、GitHub Copilot、Ollama Cloud、OpenAI API Admin Key），使用户在 `/usage` 额度总览中即可一站式查看所有外部订阅、免费额度、余额与 API 花费。

## What Changes

- **Contracts & 4-Tier 双向能力协商**：
  - `packages/contracts/src/providerUsageLimits.ts`：`UsageLimitSourceKind` 扩展为 `cliproxy | http | omp | kimi | zai | openrouter | copilot | ollama | openaiApi`。
  - `packages/contracts/src/environment.ts`：新增客户端能力常量 `EXTERNAL_USAGE_LIMIT_SOURCES_CAPABILITY = "externalUsageLimitSources"` 与服务端能力字段 `ExecutionEnvironmentCapabilities.externalUsageLimitSources`。
  - `packages/client-runtime/src/connection/compatibility.ts`、`apps/server/src/ws.ts`、`apps/server/src/environment/ServerEnvironment.ts`、`apps/server/src/serverSettings.ts`：实现四级降级过滤（旧客户端仅 `cliproxy` → `httpUsageLimitSources` 2 种 → `extendedUsageLimitSources` 5 种 → `externalUsageLimitSources` 9 种），保证连接老版服务端或老版客户端均零解码报错。
- **Server 独立数据源实现（`apps/server/src/usage/sources/`）**：
  - `openrouter.ts`：`GET /api/v1/credits` + `GET /api/v1/key`（管理密钥时有界分页 `GET /api/v1/keys`，上限 50 页）；宽容 `/credits` 403；映射 Credits / Key Limit / Budget / Free Requests 窗口、Balance 与 Pay-as-you-go 周期花费余额。
  - `copilot.ts`：`GET https://api.github.com/copilot_internal/user`（`Authorization: token <key>` + Copilot 必需请求头）；映射 `quota_snapshots`（跳过 `unlimited` / `-1` / `0`）、`overage` 余额、旧版 `limited_user_quotas` 兜底、以及仅当席位响应明确给出单一组织时查询官方 `GET /organizations/{org}/settings/billing/usage/summary`（带组织名标注 `Org Credits (Org)` / `Org Spend (Org)`，绝不通过 `/user/orgs` 盲猜，也不编造 0% 进度条）。
  - `ollama.ts`：纯 `node:crypto` 严格解析未加密 OpenSSH Ed25519 私钥（默认 `~/.ollama/id_ed25519`，对应 `ollama://default` 或自定义路径，无需粘贴密钥），校验内外公钥与 32 字节 seed 派生结果一致；签名请求 `GET https://ollama.com/api/balance?ts=...` + 尽力 `POST https://ollama.com/api/me?ts=...`；支持新版 USD 月度额度与旧版 Session/Weekly 窗口 + Purchased Credits 余额；将公钥 SHA-256 指纹纳入缓存目标键以隔离换号。
  - `openaiApi.ts`：`GET https://api.openai.com/v1/organization/costs`（显式 Admin API Key，严禁读取 `OPENAI_API_KEY` 环境变量或 Codex OAuth）；有界游标分页（上限 10 页 + 循环游标检测）；严格校验 USD 币种；按 UTC 日桶汇总 Today / Yesterday / This Month / 30-Day Spend 为 `balances[]`（`windows: []`，绝不编造百分比进度条）。
- **`UsageLimitSources.ts` 接线**：
  - `ReadQuotaJson` 增加可选 `method?: "GET" | "POST"` 参数（默认 `"GET"`），复用现有 `hasValidHttpHeaderValues` + `Effect.withTracerEnabled(false)` + 1 MiB 响应上限 + `redirect: "error"` + 10s 超时防泄漏链路。
  - 接线 4 个新源的 `sourceLabel`、`resolveSourceEndpoint`、`resolveCacheTarget`、`readSource`、`keepLastGoodReadings`。
- **Settings UI、Matrix 徽章与 10 语种 i18n**：
  - `AddUsageLimitSourceDialog.logic.ts`、`AddUsageLimitSourceDialog.tsx`、`UsageProviderSettings.tsx`、`ProviderSettingsPanel.tsx`：受 `externalUsageLimitSources` 能力门控；`openrouter` / `copilot` / `openaiApi` 分配不可复用 UUID 后缀 ID（支持同端点多账号独立配置与续费覆写）；`ollama` 默认 `ollama://default`（可选自定义私钥路径，无密钥输入框）。
  - `UsageLimitsMatrixView.tsx`：为 4 种新源展示清晰来源徽章与对应图标（复用 `OpenRouterIcon` / `OllamaIcon` / `OpenAI` 等既有图标组件）。
  - 运行 `vp run i18n:generate` 并补全全部 10 语种翻译，通过 `vp run i18n:check`。

## Assumptions

- **Copilot 鉴权方式**：统一通过用户显式配置的 `managementKey`（明文或 SecretReference）传入 GitHub Token，不在服务端静默读取 macOS Keychain 或外部 CLI 凭据文件，确保远端/headless/多环境行为一致且零权限弹窗。
- **OpenAI API 范围**：仅通过显式配置的组织 Admin Key 查询 `/v1/organization/costs`（USD 账单花费），不读取 `OPENAI_API_KEY` 环境变量，也不触碰 Codex OAuth。
- **Ollama 私钥路径**：支持 `ollama://default`（解析为 `~/.ollama/id_ed25519`）或显式文件路径；拒绝加密私钥与损坏/不匹配公钥并给出清洗后的可读错误，不暴露私钥字节。
- **OpenRouter 管理密钥分页上限**：`/api/v1/keys` 分页严格限制最多 50 页，避免异常大工作区或坏服务端导致无限请求。

## Out of Scope

- 不实现本地历史/缓存数据源（`kimiCli` / `zcode` / `magpie` / `claudeSwap`，归并行 PR 4 `feat/usage-local-history-sources`）。
- 不修改 `packages/contracts/src/settings.ts`、`packages/contracts/src/usage.ts` 或 `apps/server/src/usage/UsageService.ts`。
- 不实现自动 OAuth 登录流程或 macOS Keychain 静默读取。
- 不在本 PR 中修改 `FORK.md` / `LESSONS.md` 共享台账（推迟至 Wave 3 收尾统一更新）。

## 上游同步冲突面

- **新增独立文件**：
  - `apps/server/src/usage/sources/openrouter.ts` & `openrouter.test.ts`
  - `apps/server/src/usage/sources/copilot.ts` & `copilot.test.ts`
  - `apps/server/src/usage/sources/ollama.ts` & `ollama.test.ts`
  - `apps/server/src/usage/sources/openaiApi.ts` & `openaiApi.test.ts`
- **上游文件最小 `// fork:` 钩子**：
  - `packages/contracts/src/{providerUsageLimits,environment}.ts`
  - `packages/client-runtime/src/connection/compatibility.ts`
  - `apps/server/src/{environment/ServerEnvironment,serverSettings,ws,usage/UsageLimitSources}.ts`
  - `apps/web/src/components/settings/{AddUsageLimitSourceDialog*,UsageProviderSettings,ProviderSettingsPanel}.tsx`
  - `apps/web/src/components/usage/UsageLimitsPooled.tsx`、`apps/web/src/timestampFormat.ts`（bare `YYYY-MM-DD` UTC 日期安全格式化钩子）
  - `apps/web/src/fork/usage/{UsageLimitsMatrixView,UsageLimitsResetsView}.tsx`（Fork 自有目录）
  - `apps/web/src/i18n/translations/*.json`

## Payload Truth Table & 4-Quadrant Defense Matrix

### 1. Provider 真实载荷真值表（来源：OpenUsage 对应客户端与映射源码核实）

| Provider     | Endpoint / File                                                                                                                                                    | Redacted observed fields & types                                                                                                                                                                                                                                                                                                                                                                                                                                                          | Empty / `0` / unstarted / `429` / expired behavior                                                                                                                                                                                                                                                                                                                                               | Poll / rate-limit cadence                                              |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------- |
| `openrouter` | `GET https://openrouter.ai/api/v1/credits` + `GET /api/v1/key` (+ `GET /api/v1/keys?include_disabled=true&include_expired=true&offset=N` when `is_management_key`) | `credits.data.{total_credits,total_usage}: number`; `key.data.{usage,usage_daily,usage_weekly,usage_monthly,limit,limit_remaining,limit_reset,is_free_tier,is_management_key,effective_budget:{limit_usd,spend_usd,reset_interval},free_model_daily_requests:{limit,used\|count}}`                                                                                                                                                                                                        | `/credits` 返回 403（管理密钥）时静默省略不失败；`total_credits <= 0` 不输出百分比窗口，输出周期花费余额；双端点 401/403 报清洗后鉴权错误                                                                                                                                                                                                                                                        | 跟随 `providerHealthRefreshInterval`（默认 5m）；分页上限 50 页        |
| `copilot`    | `GET https://api.github.com/copilot_internal/user` (+ 单一组织席位时 `GET /organizations/{org}/settings/billing/usage/summary`)                                    | `copilot_plan: string`, `quota_reset_date?: ISO`, `limited_user_reset_date?: YYYY-MM-DD`, `organization_login_list?: string[]`, `organization?: string\|{login}`, `quota_snapshots.{premium_interactions,chat,completions}.{entitlement,remaining,percent_remaining,unlimited,overage_permitted,overage_count}`, `limited_user_quotas`, `monthly_quotas`, `token_based_billing?: boolean`, `credits_used?: number`; org billing `usageItems[].{product,unitType,grossQuantity,netAmount}` | 跳过 `unlimited===true \| entitlement===-1 \| remaining===-1 \| entitlement===0`；bare `YYYY-MM-DD` 保留原日期串；仅当 `quota_snapshots` 为空时走 `limited_user_quotas` 兜底；`token_based_billing` 且无窗口时仅针对席位明确声明的单一组织查 `/organizations/{org}/settings/billing/usage/summary`（`403`/`404` 静默省略，瞬时失败按组织作用域保底上次成功余额，绝不跨组织借用或伪造 0% 进度条） | 跟随 `providerHealthRefreshInterval`；单组织按需最多 1 次 org 账单查询 |
| `ollama`     | 本地 `~/.ollama/id_ed25519` 签名 → `GET https://ollama.com/api/balance?ts=<unix>` + `POST https://ollama.com/api/me?ts=<unix>`                                     | `balance.{included:{allowance_usd,balance_usd,period:{from,until}} \| {session:{remaining_percent,resets_at?},weekly:{remaining_percent,resets_at?}}, purchased?:{balance_usd}}`; `me.{Plan\|plan}`                                                                                                                                                                                                                                                                                       | 缺 `included` 视为畸形响应报错；旧版 `session`/`weekly` 仅在存在 `resets_at` 时附带 5h/7d 周期时长；加密/截断/公钥不匹配私钥拒绝加载并报清洗错误；`/me` 失败降级无 `planTier`                                                                                                                                                                                                                    | 跟随 `providerHealthRefreshInterval`；每次请求用当前 unix 秒签名       |
| `openaiApi`  | `GET https://api.openai.com/v1/organization/costs?start_time=...&end_time=...&bucket_width=1d&limit=180&group_by=project_id&group_by=api_key_id`                   | `data[].{object:"bucket",start_time,end_time,results:[{object:"organization.costs.result",amount:{value,currency},project_id?,api_key_id?}]}`, `has_more`, `next_page`                                                                                                                                                                                                                                                                                                                    | 合法全 $0 响应返回 `windows: []` + `$0` 余额项（非错误）；非 `"usd"` 币种返回清洗错误；游标循环或超过 10 页有界中止；401/403 提示需组织 Admin Key                                                                                                                                                                                                                                                | 跟随 `providerHealthRefreshInterval`；分页上限 10 页                   |

### 2. 四象限防御检查（`LESSONS.md #9` / `#14`）

| Quadrant                                                              | Mandatory design & test assertion                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| --------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **1. Legacy server / client missing optional fields & kinds**         | 四级能力协商：`externalUsageLimitSources` 缺失时服务端过滤掉新 4 种源（向后兼容 5 种/2 种/1 种旧客户端），前端按 `capabilities.externalUsageLimitSources` 门控下拉选项，零解码异常                                                                                                                                                                                                                                                                                                       |
| **2. Probe / async failure retains last-good without secret leakage** | 全部 HTTP 请求经 `requestQuotaJson`（Fetch 前 `hasValidHttpHeaderValues` 校验 + `Effect.withTracerEnabled(false)` + 1 MiB 限流 + `redirect: "error"`）；`withSettingsSnapshot` 原子围栏防旧凭据回写；`ollama` 缓存键包含公钥 SHA-256 摘要，换私钥后失败不借用旧账号读数                                                                                                                                                                                                                  |
| **3. Multi-account / multi-instance isolation**                       | `openrouter` / `copilot` / `openaiApi` 使用 UUID 后缀 ID 防并发覆写与续费覆写串号；`openaiApi` 绝不读 `OPENAI_API_KEY` 或 Codex OAuth；`copilot` 绝不静默读 Keychain                                                                                                                                                                                                                                                                                                                     |
| **4. Cache / storage versioning & export discipline**                 | 无扫描缓存结构变更；`UsageLimitSourceSnapshots` 复用 `ForwardCompatibleArray`；各新源模块仅导出被生产代码消费的符号（`openrouter.ts`: `OPENROUTER_USAGE_ORIGIN`, `readOpenRouterUsage`; `copilot.ts`: `COPILOT_USAGE_ENDPOINT`, `readCopilotUsage`; `ollama.ts`: `resolveOllamaKeyPath`, `readOllamaKeyGenerationSync`, `readOllamaKeyIdentity`, `readOllamaUsage`; `openaiApi.ts`: `OPENAI_API_COSTS_ENDPOINT`, `readOpenAiApiUsage`），内部辅助函数保持私有以通过 `knip:check:exports` |

## Surface Matrix

| Surface   | Status   | Notes                                                                                                                                           |
| --------- | -------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| Web       | Affected | `AddUsageLimitSourceDialog*`、`UsageProviderSettings`、`ProviderSettingsPanel` 能力门控、`UsageLimitsMatrixView` 新源徽章与图标                 |
| Desktop   | Affected | 复用 Web 界面与内置 Server（无需 Electron IPC 改动）                                                                                            |
| Mobile    | Affected | `packages/client-runtime/src/connection/compatibility.ts` 广播新能力；现有 `UsageLimitsPooled` 已原生支持余额卡与任意 `quotaAccounts`           |
| Server    | Affected | `sources/{openrouter,copilot,ollama,openaiApi}.ts`、`UsageLimitSources.ts`、`serverSettings.ts`、`ws.ts`、`ServerEnvironment.ts`                |
| Contracts | Affected | `providerUsageLimits.ts`（`UsageLimitSourceKind`）、`environment.ts`（`EXTERNAL_USAGE_LIMIT_SOURCES_CAPABILITY` & `externalUsageLimitSources`） |
| Providers | N/A      | 独立配额源，不修改编码 Agent Provider Driver                                                                                                    |
| i18n      | Affected | Wave 3 唯一 i18n 写者：`vp run i18n:generate` + 10 语种翻译 + `vp run i18n:check`                                                               |
