# Proposal: Usage Limits Intelligence & Four-Lens Dashboard (Wave 1 / PR 1)

- **Epic Charter**：[openspec/epics/usage-subscriptions.md](../../epics/usage-subscriptions.md)
- **文件归属围栏**：`packages/contracts/src/providerUsageLimits.ts`、`packages/provider-core/src/server/usageLimits*`、`packages/shared/{package.json,src/usageLimitsIntelligence*}`、`apps/web/src/fork/usage/*`、`apps/web/src/components/usage/UsageLimitsPooled.tsx`（最小 `// fork:` 显示模式钩子）、`apps/web/src/i18n/translations/*.json`

## Why

当前 `/usage` 的 Limits 视图只展示按 Provider 分组的静态进度条（`UsageLimitsPooled`），缺少跨账号全局视角的**即将重置时间线**、**烧毁率与提前耗尽预测**、**风险告警聚合**、**订阅/重置券/余额到期追踪**，也无法切换 `Left ↔ Used` 与 `Countdown ↔ Exact Time` 或为无到期 API 的订阅（Claude / Codex / Cursor 等）记录手动续费日期。同时，后续 Wave 2/3 要接入更丰富的金额/余额/到期元数据，需要先在 Wave 1 冻结向后兼容的可选契约字段与共享情报计算引擎。

## What Changes

1. **向后兼容的可选契约扩展（`packages/contracts/src/providerUsageLimits.ts`）**：
   - `ServerProviderUsageWindow` 新增可选字段：`usedAmount`、`limitAmount`、`remainingAmount`、`unit`、`category`（`"plan" | "balance" | "overage" | "bonus"`）、`scopeLabel`。
   - 新增 `ServerProviderUsageBalance` schema，并在 `ServerProviderUsageLimits` 上新增可选字段：`subscriptionExpiresAt`、`planTier`、`balances`、`serviceNotice`。
2. **流式局部更新保真（`packages/provider-core/src/server/usageLimits.ts`）**：
   - 升级 `applyUsageLimitsUpdate` 与 `usageWindowEquals`，确保中段流式刷新（如 Claude/Codex 仅携带 `usedPercent` 与 `resetsAt` 的增量更新）不会抹除窗口级与账号级已探测的富元数据。
3. **共享纯计算情报引擎（`@t3tools/shared/usageLimitsIntelligence`，Hermes 兼容）**：
   - `computeWindowBurnPace`：基于已过窗口比例计算真实烧毁倍率（`paceRatio`）、周期末预测占用、预计耗尽时间（`projectedExhaustionMs`），在缺少窗口时长或过早样本期（`< 5%` 且 `< 5m` 或 `usedPercent === 0`）诚实返回 `insufficient-data` / `null`，绝不编造。
   - `collectLimitsIntelligence`：统一归一化原生 Provider 账号、CLIProxyAPI Hub 账号及上游 PR #15 新增的 `http` `quotaAccounts`，叠加本地手动订阅覆写，输出 `accounts`、`resets`（按即将重置分组排序）、`alerts`（按严重度分级）、`expiries`（订阅到期 + 重置券到期 + 余额到期 + 未设置到期账号）与汇总指标。
4. **Overview 活跃连续天数（Streak）**：
   - 在 `apps/web/src/fork/usage/usageDashboard.logic.ts` 新增纯函数 `computeUsageStreak`，在 `UsageKpiCards` 的日粒度活跃均值卡片展示诚实窗口内连续活跃天数（含提示当前连续与窗口最长连续，触及窗口首日时明确标注边界）。
5. **Limits 四视角 UI 与全局显示控制（`apps/web/src/fork/usage/*`）**：
   - 持久化 UI 选项扩展（`t3lab:usage-ui:v1` 向后兼容可选字段）：`limitsLens`（`pools` | `resets` | `alerts` | `expiries`）、`limitsLayout`（`pool` | `matrix`）、`quotaDisplayMode`（`remaining` | `used`）、`resetTimeMode`（`countdown` | `exact`）、`alertThresholdPercent`（默认 80，即剩余 ≤ 20% 触发告警）、`manualSubscriptionOverrides`。
   - `UsageLimitsEnhanced` 升级为四视角容器：`Pools`（支持 `Pool ↔ Matrix` 切换，保留完整重置券兑换能力并兼容 `UsageLimitsPooled`）、`Resets`、`Alerts`、`Expiries`（含一键新增/编辑/清除手动订阅覆写弹窗 `UsageSubscriptionOverrideDialog`）。
   - `UsageQuotaStrip`、`UsageLimitsPooled`（仅最小 `// fork:` props）与 `UsageTopbar` 选项菜单同步响应 `Left ↔ Used`、`Countdown ↔ Exact` 与告警阈值配置。
   - 补齐全部 10 种语言翻译（`vp run i18n:generate` + `vp run i18n:check`）。

## Assumptions

- 现有 `t3lab:usage-ui:v1` `localStorage` 键保持不变，新增字段均带默认值与严格解析清洗，确保已存用户的总览偏好和预算配置零丢失。
- 手动订阅覆写（`manualSubscriptionOverrides`）在 PR 1 阶段按客户端本地持久化，避免改动服务端 `ServerSettings` 契约（把服务端 settings 扩展留给 Wave 2 的 PR 3a 统一处理）。
- `Pools` 视图默认保持 `pool` 布局、`remaining`（Left）与 `countdown` 模式，确保既有浏览器测试与用户习惯零破坏。
- Mobile 端在 PR 1 不新增四视角屏幕，但 `@t3tools/shared/usageLimitsIntelligence` 严格满足 Hermes 规则，后续可直接复用。

## Out of Scope

- 不改动任何现有服务端 Provider 探测逻辑（Claude/Codex/Grok/CLIProxyAPI/Cursor/Antigravity/OpenCode/Muse 的富字段填充由 Wave 2 PR 2a / 2b 负责）。
- 不新增外部订阅/余额数据源（`omp` / `kimi` / `zai` / `openrouter` / `copilot` / `ollama` / `openaiApi` 由 PR 3a / 3b 负责）。
- 不新增本地第三方会话/代理日志扫描（Kimi CLI / ZCode / Magpie / `claude-swap` 由 PR 4 负责）。
- 不改动移动端 UI、桌面端打包入口或服务端持久化数据库 schema。

## 上游同步冲突面

- **新增独立文件**：
  - `openspec/epics/usage-subscriptions.md`
  - `packages/shared/src/usageLimitsIntelligence.ts`
  - `packages/shared/src/usageLimitsIntelligence.test.ts`
  - `apps/web/src/fork/usage/UsageLimitsMatrixView.tsx`
  - `apps/web/src/fork/usage/UsageLimitsResetsView.tsx`
  - `apps/web/src/fork/usage/UsageLimitsAlertsView.tsx`
  - `apps/web/src/fork/usage/UsageLimitsExpiriesView.tsx`
  - `apps/web/src/fork/usage/UsageSubscriptionOverrideDialog.tsx`
  - `apps/web/src/fork/usage/usageLimitsIntelligence.browser.test.tsx`
- **改动 Fork 自有文件（0 上游冲突）**：
  - `apps/web/src/fork/usage/{UsageDashboard,UsageLimitsEnhanced,UsageQuotaStrip,UsageKpiCards,UsageTopbar,usageOptionsStore,usageDashboard.logic,usageDashboard.logic.test,usageDashboard.browser.test}.*`
- **上游文件最小 `// fork:` 钩子**：
  - `packages/contracts/src/providerUsageLimits.ts`（追加可选字段与 `ServerProviderUsageBalance`）
  - `packages/provider-core/src/server/usageLimits.ts`（在 `applyUsageLimitsUpdate` / `usageWindowEquals` 保留新增可选字段）
  - `packages/shared/package.json`（新增 `./usageLimitsIntelligence` 子路径导出）
  - `apps/web/src/components/usage/UsageLimitsPooled.tsx`（可选 `quotaDisplayMode` / `resetTimeMode` props，默认行为与上游完全一致）
  - `apps/web/src/components/usage/UsageLimits.tsx`（透传可选 `quotaDisplayMode` / `resetTimeMode` 到 `UsageLimitsPooled`）
  - `apps/web/src/i18n/translations/*.json`（新增文案 10 语言翻译）

## Surface Matrix

| Surface   | Status  | Notes                                                                                                        |
| --------- | ------- | ------------------------------------------------------------------------------------------------------------ |
| Web       | Changed | `/usage` Limits 四视角、Pool↔Matrix、Left↔Used、Countdown↔Exact、手动订阅覆写、QuotaStrip 与 Overview Streak |
| Desktop   | Inherit | 复用 Web 渲染包；无 Electron 主进程或打包入口改动                                                            |
| Mobile    | Compat  | 可选契约字段天然向后兼容；新增共享引擎遵守 Hermes 限制；Mobile UI 四视角留待后续                             |
| Server    | Compat  | 仅 `provider-core` 局部更新保真兼容新可选字段；不改现有 Provider 探测行为                                    |
| Contracts | Changed | 向后兼容扩展 `ServerProviderUsageWindow` / `ServerProviderUsageLimits` 与 `ServerProviderUsageBalance`       |
| Providers | N/A     | 本 PR 冻结契约与引擎，各 Provider 富字段填充由 Wave 2 PR 2a / 2b 分别实施                                    |
| i18n      | Changed | 新增 Limits 情报视图与选项文案，需跑 `vp run i18n:generate`、补齐 10 语言并通过 `vp run i18n:check`          |
