# Design: Usage Limits Intelligence & Four-Lens Dashboard (Wave 1 / PR 1)

## 1. Provider Payload Truth Table (`LESSONS.md #5`)

实盘核对仓库现有 8 个额度数据生产路径（含 PR #15 上游新增 `http` 配额源）与本地运行环境结构后，确认字段真值如下（PR 1 不修改探测端，仅基于真实产出设计契约与降级行为）：

| Provider / Source                    | 源码与载荷来源                                                                                                          | 实测观测字段与类型（脱敏）                                                                                                                                                                                                                                                                 | Empty / `0` / 未开始 / `429` / 过期行为                                                                                                                                                     | 轮询 / 刷新节奏                              |
| ------------------------------------ | ----------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------- |
| **Claude Code**                      | `apps/server/src/provider/claudeUsageLimits.ts` (`SDKControlGetUsageResponse` + `SDKRateLimitInfo`)                     | `five_hour` (`session`, 300m) / `seven_day` (`weekly`, 10080m) / `model_scoped[]` (`seven_day_*`) / `spend` (`amount_minor`, `currency`, `exponent`) / `extra_usage` (`used_credits`, `monthly_limit`, `utilization`)；**`get_usage` 为 0–100，流式事件 `utilization` 为 0–1**             | `rate_limits_available: false` → `unavailable.unsupported`；`extra_usage.monthly_limit === 0` → `zeroSpendCap: true`（无 window）；流式缺 `resetsAt` 时靠 `applyUsageLimitsUpdate` 继承旧值 | 手动/打开 Limits 页刷新 + 会话中实时流式更新 |
| **Codex**                            | `apps/server/src/provider/codexUsageLimits.ts` (JSON-RPC `CodexRateLimitSnapshot` + `CodexResetCreditsSummary`)         | `primary` (300m 或 Free/Go 43200m) / `secondary` (10080m) / `individualLimit` (`remainingPercent`, `resetsAt` epoch sec，无 `windowDurationMins`) / `resetCredits` (`availableCount`, `credits[].expiresAt`)                                                                               | `limitId !== "codex"` 被过滤；token tick 重复旧快照需去重；失败返回 `probeFailed` 并由 `resolveUsageLimitsAfterProbe` 保留上次成功读数                                                      | 后台周期刷新 + 会话 token tick 增量          |
| **Antigravity**                      | `apps/server/src/provider/antigravityUsageLimits.ts` (`retrieveUserQuotaSummary` / `fetchAvailableModels` + `userinfo`) | `groups[].buckets[]`: `bucketId` (`gemini-*`, `gemini-argon-*`, `gemini-carbon-*`, `3p-*`), `window` (`"5h"` / `"weekly"`), `remainingFraction` (0–1), `resetTime` ISO；回退 `models[].quotaInfo` 无 `windowDurationMins`；身份用 `credentialFingerprint` (sha256 Google ID)，**无 email** | `remainingFraction === 1` 且 `resetTime` 等于满窗口滚动时间时 `resetsAt` 刻意省略（未开始窗口）；token 过期返回 `probeFailed`                                                               | 后台周期刷新（10s 单请求 / 30s 总超时）      |
| **Cursor**                           | `packages/provider-cursor/src/server/usageLimits.ts` (`DashboardService/GetCurrentPeriodUsage`)                         | `billingCycleStart` / `billingCycleEnd` (ms string/number), `planUsage.{totalPercentUsed,autoPercentUsed,apiPercentUsed}` (`monthly`, `windowDurationMins` 由周期起止计算)                                                                                                                 | 无 token → `unsupported`；仅 `autoPercentUsed` 且等于 `totalPercentUsed` 时 `displayLimitWindows` 去重隐藏 `total`                                                                          | 后台周期刷新（10s 超时）                     |
| **Grok**                             | `packages/provider-grok/src/server/usageLimits.ts` (`GET /v1/billing?format=credits`)                                   | `config.creditUsagePercent`, `config.currentPeriod.{type,start,end}` (`weekly` / `monthly` / `other`)                                                                                                                                                                                      | 0% 时服务端省略 `creditUsagePercent` 但保留 `currentPeriod`，需还原为 `0`；403 `WKE=privacy-mode` 返回 `probeFailed` 提示                                                                   | 后台周期刷新（10s 超时）                     |
| **OpenCode Go**                      | `packages/provider-opencode/src/server/usageLimits.ts` (`GET /zen/go/v1/usage`)                                         | `usage.{rolling(300m),weekly(10080m),monthly(无duration)}.{percent,resetsAt}` + `credentialFingerprint`                                                                                                                                                                                    | 403（仅有 Zen 无 Go 订阅）→ `unsupported`；无 `email`，靠 `credentialFingerprint` 跨环境去重                                                                                                | 后台周期刷新（5s 超时）                      |
| **Muse**                             | `packages/provider-muse/src/server/usageLimits.ts` (`MuseSubscriptionUsage`)                                            | `tier` (authLabel), `window` (`session`, `windowDurationMins`, `resetsAtMs`), `weekly` (10080m)                                                                                                                                                                                            | 429 拒绝文本可能含 `resets at <ISO>`                                                                                                                                                        | 会话事件驱动                                 |
| **CLIProxyAPI & HTTP Quota Sources** | `apps/server/src/usage/{UsageLimitSources,cliproxyApi}.ts`                                                              | `kind: "cliproxy"` 输出 `accounts[]`（Codex/Claude/Grok/Antigravity，含 `resetCredits.nextCreditId` 与 `models`）；PR #15 新增 `kind: "http"` 输出 `quotaAccounts[]`（`id, label, providerInstanceId?, windows[{id,kind,label,usedPercent,resetsAt?}]`，**无 `windowDurationMins`**）      | `keepLastGoodReadings` 按同 hub + email/workspaceId 保留上次成功读数；`http` 源无 `accounts` 时 `quotaAccounts` 单独渲染；失败写入 `source.error`                                           | `providerHealthRefreshInterval`（默认 60s）  |
| **omp（本地验证）**                  | `~/.omp/agent/`（存在 `agent.db`、`config.yml`、`sessions/`）                                                           | 当前无内置 `usageLimits` 探测（留待 Wave 2 PR 3a 接入）；会话 JSONL 已由 `/usage` Overview 扫描                                                                                                                                                                                            | 缺 `usageLimits` 时在 Limits 页自然跳过，不报假错                                                                                                                                           | N/A（Wave 2 PR 3a）                          |

## 2. 4-Quadrant Defense Matrix (`LESSONS.md #9`)

| 象限                               | 设计约束与自动化测试断言                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| ---------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **1. 旧服缺可选字段（混合舰队）**  | `ServerProviderUsageWindow` / `ServerProviderUsageLimits` 所有新增字段全部 `Schema.optional(...)`；旧服返回基础字段时，Matrix / Resets / Alerts / Expiries 正常渲染，缺 `usedAmount`/`limitAmount` 不显示伪 `$0`，缺 `windowDurationMins`（如 Antigravity 回退、Codex `individual`、`http` `quotaAccounts`）时 `computeWindowBurnPace` 返回 `null` 而不臆测窗口长度。                                                                                                                                           |
| **2. 探测/异步失败保留旧值防震荡** | `applyUsageLimitsUpdate` 收到稀疏更新时不覆盖已探测的 `usedAmount`/`limitAmount`/`remainingAmount`/`unit`/`category`/`scopeLabel` 与账号级 `subscriptionExpiresAt`/`planTier`/`balances`/`serviceNotice`；`UsageLimitsEnhanced` 沿用隔离分钟时钟 `useNowMinute()`，切换视角或刷新失败时不重置已展示数据、不触发循环重查。                                                                                                                                                                                       |
| **3. 多账号/多实例隔离防双计**     | 情报引擎在未过滤全量舰队（`identityPresentations`）上执行与上游一致的 `email` / `workspaceId` / `credentialFingerprint` 规范身份消歧，并采用 JSON 元组命名空间键（`["identity", ...]` / `["native", ...]` / `["cliproxy", ...]` / `["http", ...]`）消除跨环境筛选丢键、换号串号与冒号碰撞；混合新旧服归并保留最新读数与显式清空（如 `balances: []`），仅对缺省字段做单位/容量兼容继承；同步复用 Cursor `totalPercentUsed`/`autoPercentUsed` 别名抑制；账号回退 `unsupported` 时保留既有手动续费以便查看与清除。 |
| **4. 缓存/存储版本与失效清理**     | 沿用 `USAGE_UI_OPTIONS_STORAGE_KEY = "t3lab:usage-ui:v1"`，所有新增 UI 字段在 `parseUsageUiOptions` 做类型守卫与非法值回退（含损坏 JSON、越界 `alertThresholdPercent`、畸形 `manualSubscriptionOverrides` 条目），老用户已存偏好 100% 平滑保留且无冗余旧键残留。                                                                                                                                                                                                                                                |

## 3. Public vs Internal Export Boundary (`knip:check:exports`)

为保证 `vp run check:changed` 中的 `knip 2/2` 一次全绿，所有导出严格受生产代码消费约束：

- **`packages/contracts/src/providerUsageLimits.ts`**（公开契约导出）：
  - 新增导出：`ServerProviderUsageBalance`（schema + type）、`ServerProviderUsageWindowCategory`（仅在生产消费时导出，否则内联字面量）。
- **`packages/shared/src/usageLimitsIntelligence.ts`**（子路径 `@t3tools/shared/usageLimitsIntelligence`）：
  - **公开导出**（均被 `apps/web/src/fork/usage/*` 消费）：
    - Types: `ManualSubscriptionOverride`, `WindowBurnPaceStatus`, `WindowBurnPace`, `NormalizedLimitWindow`, `NormalizedLimitAccount`, `ResetTimelineGroup`, `ResetTimelineEntry`, `LimitAlertSeverity`, `LimitAlertKind`, `LimitAlertEntry`, `ExpiryItemKind`, `ExpiryItem`, `LimitsIntelligenceSnapshot`
    - Functions: `computeWindowBurnPace`, `collectLimitsIntelligence`
  - **模块内部 unexported helper**：所有日期解析、货币聚合、去重键拼接、告警文案 code 推导等内部函数均不 `export`。
- **`apps/web/src/fork/usage/usageDashboard.logic.ts`**：
  - 新增公开导出：`UsageStreakSnapshot`（type）、`computeUsageStreak`（由 `UsageDashboard.tsx` / `UsageKpiCards.tsx` 消费）。
- **`apps/web/src/fork/usage/usageOptionsStore.ts`**：
  - 新增公开导出：`UsageLimitsLens`, `UsageLimitsLayout`, `UsageQuotaDisplayMode`, `UsageResetTimeMode`（均由 `UsageLimitsEnhanced` / `UsageTopbar` / `UsageQuotaStrip` 消费）。
- **Hermes 兼容要求**：`packages/shared/src/usageLimitsIntelligence.ts` 位于 `packages/shared/src/**`，受 `t3code/no-hermes-unsupported-apis` 约束，禁止使用 `.toSorted()` 等 Hermes 缺失 API，统一用 `[...items].sort(...)`。

## 4. Burn-Rate & Intelligence 算法规范

### 4.1 `computeWindowBurnPace(window, now)`

- 输入：`Pick<ServerProviderUsageWindow, "usedPercent" | "resetsAt" | "windowDurationMins">`、`now: number`
- 无效守卫：`windowDurationMins === undefined || windowDurationMins <= 0 || !resetsAt || !Number.isFinite(Date.parse(resetsAt)) || Date.parse(resetsAt) <= now` → 返回 `null`。
- 计算：
  - `lengthMs = windowDurationMins * 60_000`
  - `remainingMs = resetsAtMs - now`
  - `elapsedMs = Math.max(0, Math.min(lengthMs, lengthMs - remainingMs))`
  - `elapsedShare = elapsedMs / lengthMs`
  - `expectedUsedPercent = elapsedShare * 100`
  - `usedPercent = clamp(window.usedPercent, 0, 100)`
  - `headroomPercent = Math.round(expectedUsedPercent - usedPercent)`（正数表示比均匀节奏宽裕，负数表示超前消耗）
- 状态判定：
  1. `usedPercent >= 100` → `status: "exhausted"`, `paceRatio: elapsedShare > 0 ? round2(usedPercent / expectedUsedPercent) : null`, `projectedUsedAtResetPercent: 100`, `projectedExhaustionMs: now`。
  2. `usedPercent <= 0 || (elapsedShare < 0.05 && elapsedMs < 5 * 60_000)` → `status: "insufficient-data"`, `paceRatio: null`, `projectedUsedAtResetPercent: null`, `projectedExhaustionMs: null`。
  3. 否则：
     - `paceRatio = Number((usedPercent / expectedUsedPercent).toFixed(2))`
     - `projectedUsedAtResetPercent = Math.min(999, Math.round(usedPercent / elapsedShare))`
     - `projectedExhaustionMs`: 若 `projectedUsedAtResetPercent > 100`，`Math.round(now + ((100 - usedPercent) / (usedPercent / elapsedMs)))`（且仅在 `< resetsAtMs` 时返回），否则 `null`。
     - `status`:
       - `projectedExhaustionMs !== null` → `"will-exhaust"`
       - `usedPercent - expectedUsedPercent > 5` → `"ahead"`
       - `usedPercent - expectedUsedPercent < -5` → `"under-pace"`
       - 其余 → `"on-pace"`

### 4.2 `collectLimitsIntelligence(input)`

- 输入：
  ```ts
  {
    readonly presentations: LimitPresentations;
    readonly identityPresentations?: LimitPresentations; // unfiltered fleet for stable canonical keys across environment filters
    readonly now: number;
    readonly alertThresholdPercent?: number; // default 80 (clamped 50..95)
    readonly manualOverrides?: Readonly<Record<string, ManualSubscriptionOverride>>;
  }
  ```
- 数据源统一（与上游 Pool 视图保持一致的去重与别名语义，同时保留扩展元数据与稳定覆写键）：
  1. 原生 Provider + CLIProxyAPI accounts：基于 `identityPresentations ?? presentations` 生成规范身份键 `JSON.stringify(["identity", "email"|"credential", driver, id, workspaceId|null])`（缺失身份时回退到无碰撞命名空间元组 `["native", envId, instanceId]` / `["cliproxy", hubKey, accountId, workspaceId|null]`），按新鲜度优先保留最新读数与显式清空值（含 `balances: []`），仅对省略字段继承其他可读路由（含纯元数据路由）及单位/容量/范围兼容窗口的富字段；同时应用 Cursor `totalPercentUsed` / `autoPercentUsed` 别名抑制，并在账号报告 `unsupported` 时保留已有手动续费记录（不使其额度变为可读）。
  2. 上游 `http` 配额源：提取每个 `quotaAccount`（`sourceKind: "http"`，`driver: null`，`key: JSON.stringify(["http", envId, sourceId, accountId])`）；Provider 过滤器会先按环境内 `providerInstanceId` 解析绑定驱动再过滤，未绑定 HTTP 源保持独立可见。
  3. 不可读的 Provider / Hub 错误（`probeFailed` / `source.error` / `serviceNotice`）进入 `alerts`（`kind: "probe-failed" | "service-notice"`）。
- `resets` 分组：
  - `resetsAt === undefined` 或无效 → `group: "unscheduled"`
  - `resetsInMs <= 24h` → `group: "next24h"`
  - `resetsInMs <= 7d` → `group: "next7d"`
  - 其余 → `group: "later"`
  - 仅包含未来或即将重置的窗口（过去已过期的重置仍展示并标 `resetsInMs: 0`，方便用户识别待刷新窗口）。
- `alerts` 严重度顺序：`critical` (0) → `warning` (1) → `info` (2)，同级按剩余比例升序 / 到期时间升序稳定排序：
  - 窗口已耗尽 (`usedPercent >= 100` 且未过期) → `critical` (`kind: "window-exhausted"`)
  - 窗口达到或超过阈值：`remainingPercent <= 10` → `critical`，否则 `usedPercent >= alertThresholdPercent` → `warning` (`kind: "window-low"`)
  - 预计提前耗尽 (`pace.status === "will-exhaust"` 且未触发 `window-exhausted`) → 若 `remainingPercent <= 15` 升级为 `critical`，否则 `warning` (`kind: "burn-exhaustion"`)；与 `window-low` 同窗口合并去重（同一 `accountKey + windowId` 保留最高优先级告警并携带 `pace` 详情，避免同窗口刷屏两张卡片！）
  - 重置券 7 天内过期（`<= 48h` → `critical`，`<= 7d` → `warning`，`kind: "credit-expiring"`）
  - 订阅 7 天内到期或已过期（`<= 48h` 或已过期 → `critical`，`<= 7d` → `warning`，`kind: "subscription-expiring"`）
  - 余额 7 天内过期（`<= 48h` → `critical`，`<= 7d` → `warning`，`kind: "balance-expiring"`）
  - 探测失败 / `serviceNotice` → `warning` / `critical` / `info`（`kind: "probe-failed" | "service-notice"`）
- `expiries`：汇总 `subscription`（provider 优先于 manual override）、`reset-credit`、`balance` 三类到期项，按 `expiresAtMs` 升序排列；同时返回 `accountsWithoutExpiry`（方便 Expiries 视图提供「Set renewal date」入口）与 `monthlySpendByCurrency`（仅聚合手动覆写中填写了正数 `monthlyCost` 的订阅）。

### 4.3 `computeUsageStreak(daily, todayDay, windowStartDay)`

- 过滤 `totalTokens > 0 || costUsd > 0` 的活跃日期 `Set<string>`。
- 从 `todayDay` 起向过去回溯；若 `todayDay` 不在集合中，则检查 `yesterdayDay` 作为当前连续起点（宽容当天尚未开始写代码的情况）。
- 计算 `currentDays`、`longestDays`（窗口内最长连续活跃天数）、`activeDays` 与 `reachesWindowStart`（当前连续起点触及 `windowStartDay` 时为 `true`）。

## 5. UI 架构与最小上游钩子

- **上游最小 `// fork:` 钩子**：
  - `apps/web/src/components/usage/UsageLimitsPooled.tsx` & `UsageLimits.tsx`：仅新增两个可选 props `quotaDisplayMode?: "remaining" | "used"`（默认 `"remaining"`）与 `resetTimeMode?: "countdown" | "exact"`（默认 `"countdown"`），并在 `PoolWindowCard` / `SegmentTriggers` / `LegendRow` / `SegmentPopover` / `http quotaSources` 中切换显示百分比与重置时间文案。不传时行为与上游 100% 一致。
- **Fork 独立 UI 模块（`apps/web/src/fork/usage/`）**：
  - `UsageLimitsEnhanced.tsx`：顶部摘要栏 + 4-Lens 分段切换（`Pools` / `Resets` / `Alerts` / `Expiries` 含红/黄徽章计数）+ 全局快速切换（`Pool|Matrix`、`Left|Used`、`Countdown|Exact`）+ 路由到各 Lens 子视图 + `Manage limit hubs` 链接。
  - `UsageLimitsMatrixView.tsx`：Account × Window 紧凑矩阵视图，支持脱敏邮箱点击显隐（`RedactedSensitiveText`）、烧毁率标签（`1.4× · ~1h 20m`）、余额条、重置券计数与一键编辑订阅覆写按钮。
  - `UsageLimitsResetsView.tsx`：按 `Next 24h` / `Next 7 days` / `Later` / `No schedule` 分组的重置时间线，展示每条窗口的重置时间/倒计时、当前进度、预测是否会提前耗尽与预计回血幅度。
  - `UsageLimitsAlertsView.tsx`：按严重度分组的告警列表 + 顶部内联阈值切换（`70%` / `80%` / `90%`）+ 跳转调整/管理链接。
  - `UsageLimitsExpiriesView.tsx`：统一到期时间线 + 按币种汇总的月订阅成本 + 未设到期日期账号列表与一键打开 `UsageSubscriptionOverrideDialog` 弹窗。
  - `UsageSubscriptionOverrideDialog.tsx`：基于 `~/components/ui/dialog`（严禁嵌套 Popover，遵循 `LESSONS.md #7`），编辑/清空单账号的续费日期、月费、币种、方案名与备注。
  - `UsageQuotaStrip.tsx`：读取 `quotaDisplayMode` / `resetTimeMode`，并在预计耗尽窗口上展示简洁风险提示。
  - `UsageTopbar.tsx`：在 `UsageDisplayOptionsMenu` 中同步暴露 `Quota display`、`Reset time format`、`Alert threshold` 分组，与 Limits 工具栏共享同一个 Zustand store。
  - `UsageKpiCards.tsx`：日粒度下在 `Avg per active day` 卡底行以克制语义样式展示 `Streak`（含 `Tooltip` 显示窗口内最长连续天数）。
- **语义色彩纪律（`shadcn/no-raw-colors`）**：仅使用 `apps/web/src/index.css` 声明的语义 token（`bg-error/15`、`text-error-foreground`、`bg-warning/15`、`text-warning-foreground`、`bg-success/12`、`text-success-foreground`、`bg-info/12`、`text-info-foreground`、`bg-card/65`、`bg-muted`），绝不使用原始 Tailwind 色板或原生 `title` 属性。
