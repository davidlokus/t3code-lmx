# Proposal: T3 Lab `/usage` 用量仪表盘全面重构（`usage-dashboard`）

## Why

侧边栏左下角「用量」按钮打开的 `/usage` 弹窗目前仍沿用上游的基础三 Tab（`Cost` / `Tokens` / `Limits`）设计，存在五类显著体验短板：

1. **首屏割裂且易扑空**：默认落在 `Limits` Tab，主力使用 `omp` / Pi / API Key 的用户打开即见空态；有订阅额度的用户也无法在同一屏内同时看到配额余量与近期消耗；`Cost` 与 `Tokens` 两个 Tab 布局高度重复。
2. **已有数据未充分释放**：服务端已经采集并合并了 `reasoningTokens`、全局 `cacheHitRate`、`cacheCreationTokens`、`costQuality`（实报/估算/未定价）与 `speedCost`，Web 端却缺失展示；同时上游 `Day/Hour` 明细表在 `Tokens` 模式下硬编码输出 `formatUsd`，存在指标错位 Bug。
3. **缺少关键归因与对比维度**：无法按**项目（Project/CWD，自动归并同一 Git 仓库的 worktree）**或**高消耗会话（Top Sessions，支持直达 T3 线程）**定位开销来源，也缺少与**上一周期的环比涨跌**和**今日 / 本月(MTD)** 高频自然周期。
4. **图表与交互偏弱**：非堆叠半透明面积曲线在多 Provider 叠加时可读性差；结构占比条全为灰阶；点击 Provider / 日期 / 项目无法联动过滤；「模型价格」隐藏在环境筛选菜单底部极难发现；缺少明细导出与本地软预算提醒。
5. **额度视图落后于 HUD 体验**：`Limits` 页缺乏与右侧 `HudQuotaCard` 对齐的红/黄/绿风险分级，重置时间点与套餐藏在 Hover 浮层，且缺少每分钟静默更新与直达 Hub 设置入口。

在完成侧边栏（`fork-sidebar-navigation`）与右侧实时 HUD（`fork-thread-hud-panel`）升级后，重构 `/usage` 成为补齐 T3 Lab 完整可观测性闭环的下一步关键能力。

## What Changes

### 1. 信息架构与顶栏控制升级（Web / Desktop）

- **双顶层视角**：将原 `Cost` / `Tokens` 合并为默认首屏 **「总览（Overview）」**（内嵌 `费用 | Token` 指标切换，完全兼容现有快捷键 `usage.cost` / `usage.tokens` / `usage.limits`），保留独立 **「额度（Limits）」** 视角用于多账号池、Hub 与 Reset Credit 兑换。
- **自适应顶部「配额摘要条（Quota Strip）」**：总览顶部在存在订阅额度时自动显示紧凑配额胶囊（统一绿 / 黄 `≤20%` / 红 `≤10%` 风险色 + 倒计时），点击直达「额度」视角；无订阅额度时自动隐藏。
- **高频自然时间预设**：扩展为 `今日（小时）` / `24h` / `7天` / `本月(MTD)` / `30天` / `90天`。
- **显式操作与偏好记忆**：
  - 将 **「模型价格」** 从环境菜单提升为顶栏显式入口；新增 **「导出（CSV / JSON）」** 与 **`🎛` 显示选项与软预算配置**（持久化于 `localStorage["t3lab:usage-ui:v1"]`，可开关配额条、占比条、环比徽章、软预算条，并支持在软预算中切换「全量费用」或「仅实报 / 非订阅费用」口径）。
  - 放宽 `/usage` 弹窗内部内容区至充分利用 `AppRouteModal` 全宽（1280px），同时保留 `Esc` 秒回当前会话的弹窗模式。

### 2. 总览分析区与 4 视角明细升级（Web / Desktop）

- **4 卡 KPI 带**：① 总费用 / 总 Token（含上周期环比徽章、实报/估算/未定价诚实来源标、未定价一键设价、以及匹配今日/本月窗口时的内联软预算进度条）② 燃速与均价（日均/时均、`$/1M`、活跃周期与总会话数）③ 缓存效率（全局缓存命中率 %、节省金额与倍率、Cache Read/Write 明细）④ 输出与思考（总 Output、`Reasoning` 思考 Token 与占比、Fast/Ultrafast 加速溢价）。
- **Provider 排行与交互式趋势图**：左侧 Provider 列表支持点击快速独显/联动过滤全页；右侧趋势图默认改为 **堆叠柱状图（Stacked Bar）** 并提供一键切换 **折线对比**，点击单根柱子可锁定该日/小时联动高亮下方明细；结构占比条全面替换为 `apps/web/src/index.css` 声明的语义主题色。
- **4 视角明细表（`模型` | `项目` | `Top 会话` | `按日/时`）**：
  - **模型表**：新增 `缓存命中率 %`、`$/1M` 列，支持列头排序、关键词搜索与未定价行内快捷设价；升级模型详情弹窗展示 Reasoning 与项目分布。
  - **项目表**：展示归并 worktree 后的规范项目名（优先匹配 T3 项目名，缺失 `cwd` 诚实归入「未归属」）；点击项目行通过 `projectFilter` 联动重算整个总览。
  - **Top 会话表（Top 50）**：展示标题（优先 T3 线程名，其次日志标题，兜底短 ID）、项目标签、主模型、费用、Token、缓存命中率与最近活跃时间；关联到 T3 线程的点击关闭弹窗并直达该会话，外部 CLI 会话弹出只读详情卡。
  - **按日/时表**：修复上游在 `Tokens` 模式下硬编码输出美元金额的 Bug，严格跟随当前指标切换并支持点击高亮趋势柱。

### 3. 额度（Limits）视图升级（Web / Desktop）

- 统一对齐 `HudQuotaCard` 风险色阶（`>20%` 正常、`≤20%` 警告、`≤10%` 危险）。
- 卡片直接呈现套餐（Plan）、具体重置时间点、每分钟静默更新的独立倒计时叶节点与 Pace 速率标线，保留多账号池与 Reset Credit 兑换，顶部新增「管理配额源（Hub）」跳转 `/settings/providers#usage-providers`。

### 4. 后端、Provider 解析与向后兼容契约扩展（Server / Contracts / Providers）

- **向后兼容契约扩展**（[packages/contracts/src/usage.ts](packages/contracts/src/usage.ts)）：`UsageSummaryInput` 新增可选 `projectFilter`；`UsageSummary` 新增可选 `projects`（项目聚合数组）与 `topSessions`（服务端按窗口截断 Top 50）；保持 `USAGE_MERGE_COMPATIBLE_SINCE = 4`，不破坏连接旧版/上游远程环境。
- **Provider 日志 `cwd` 与标题抽取**：补齐 `Claude`、`Codex`、`omp`、`Pi`、`OpenCode` 的真实 `cwd` 与会话标题提取，平滑升级服务端扫描缓存以保留已删历史。
- **项目归并与 T3 线程关联**：新增独立可选服务 `UsageMetadataIndex`（基于 `Context.Reference`，默认空实现不影响现有单测），从 `ProjectStoreV2` + OrchestrationV2 SQLite 表匹配 T3 项目名、worktree 归属与 `threadId`（覆盖 UUID 型 `nativeId` 与 Pi/`omp` 路径型 `nativeId`），对非 T3 外部仓库采用有超时保护的 Git common-dir 归并（避开 macOS TCC 阻塞）。

## Capabilities

### New Capabilities

- `fork-usage-dashboard`: T3 Lab `/usage` 用量仪表盘，涵盖向后兼容的项目/Top 会话后端归因契约、双视角总览与配额摘要条、交互式堆叠柱/折线趋势图、4 视角可联动明细表、软预算与持久化显示选项、明细导出以及风险分级额度视图。

### Modified Capabilities

- （无：不修改 `fork-sidebar-navigation` 或 `fork-thread-hud-panel` 既有需求契约；左侧栏入口与 HUD Quota 跳转 `/usage` 保持原行为无缝衔接。）

## Impact

### 多面影响矩阵（Hit Every Surface）

| 影响面        | 影响说明                                                                                                                                                                                                                                                                                                                                                                                                                           |
| ------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Web**       | 在 `apps/web/src/fork/usage/*` 新增完整仪表盘 UI、Store、逻辑与导出模块；在 [UsagePage.tsx](apps/web/src/components/usage/UsagePage.tsx)、[UsageLimitsPooled.tsx](apps/web/src/components/usage/UsageLimitsPooled.tsx)、[UsageModelDialog.tsx](apps/web/src/components/usage/UsageModelDialog.tsx) 等处做最小 `// fork:` 钩子接入。                                                                                                |
| **Desktop**   | 直接复用 Web 前端与本地 Server，无需改动 Electron 打包入口（`boot.ts` / `preload.ts` / `compileCache.ts` 不受影响），完成后执行本地 macOS 真机试装验收。                                                                                                                                                                                                                                                                           |
| **Mobile**    | **N/A（本次不改 UI）**：`UsageSummary` 新增字段均为可选字段且 `USAGE_CONTRACT_VERSION` 保持向后兼容，确保 Mobile 现有 `UsageRouteScreen` 零回归。                                                                                                                                                                                                                                                                                  |
| **Server**    | 扩展 [UsageService.ts](apps/server/src/usage/UsageService.ts)、[usageAggregation.ts](apps/server/src/usage/usageAggregation.ts)、[usageScanCache.ts](apps/server/src/usage/usageScanCache.ts)，新增独立模块 `apps/server/src/usage/UsageMetadataIndex.ts` 与 `usageProjectResolution.ts`，在 [server.ts](apps/server/src/server.ts) 注入可选元数据层。                                                                             |
| **Contracts** | [packages/contracts/src/usage.ts](packages/contracts/src/usage.ts) 新增可选 `UsageProjectFilter`、`UsageProjectSummary`、`UsageSessionSummary` 类型与字段；[packages/shared/src/usageMerge.ts](packages/shared/src/usageMerge.ts) 扩展多环境合并逻辑（合并项目与 Top 50 会话、过滤隐藏 Provider、保留实报/估算分项费用）。                                                                                                         |
| **Providers** | 补齐 `claudeUsage.ts`、`codexUsage.ts`、`packages/provider-omp/src/server/usage.ts`、`packages/provider-pi/src/server/usage.ts`、`packages/provider-opencode/src/server/usage.ts` 的 `cwd`/标题提取，并更新 `packages/provider-core/src/server/usage.ts` 的 `UsageRecord` 可选字段；`Grok` / `Muse` / `Antigravity` / `Cursor` 不含日志 `cwd` 时优先通过 T3 `UsageMetadataIndex` 按 `sessionId` 反查，未命中则诚实归入「未归属」。 |
| **i18n**      | 所有新增 Web UI 文案使用 `gt-react`（`<T>` / `useGT` / `msg`），运行 `vp run i18n:generate` 并补全 10 语言目录，通过 `vp run i18n:check`。                                                                                                                                                                                                                                                                                         |

### Out of Scope

- 不改造 Mobile（React Native）的 `UsageRouteScreen` 界面。
- 不新增自定义起止日期选择器（Date Range Picker）与多币种汇率换算（保留 USD）。
- 不新增服务端持久化预算配置或强制阻断用户发消息的硬限额（软预算仅本地 `localStorage` 提醒）。
- 不重做 `UsagePriceOverrides` 表格内部交互，仅将其入口提升到顶栏并支持行内快捷唤起。
- 不修改现有 `t3code:usage-page-preferences:v1` 中仍被上游/快捷键依赖的旧键破坏性结构，Fork 新增 UI/预算选项独立持久化在 `t3lab:usage-ui:v1`。

### Assumptions

1. **旧版远程环境降级**：若连接的远程服务端未返回 `projects` / `topSessions`（如上游版本服务器），前端自动在「项目」「Top 会话」Tab 显示诚实提示（说明需要更新该环境服务端），总览/趋势图/模型表/时间表仍完全正常。
2. **环比请求节流**：开启环比（默认开启，可在 `🎛` 关闭）时，前端复用既有 `usageSummary` RPC 请求对齐的上一周期（命中服务端内存 `fileCache`）；若用户在 `🎛` 关闭环比或处于 `Limits` 视角，则完全不发上一周期查询。
3. **软预算周期匹配**：日预算仅在 `今日` 窗口渲染进度条，月预算仅在 `本月(MTD)` 窗口渲染进度条；其余滚动窗口（`24h` / `7天` / `30天` / `90天`）不强行换算以免误导。
4. **Top 会话截断与跨环境合并**：每个服务端按窗口返回最多 50 条高消耗会话（按费用降序并补足高 Token 未定价会话），前端多环境合并去重后同样截断展示 Top 50，严格控制 WebSocket 体积。
5. **键盘快捷键向后兼容**：`usage.cost` / `usage.tokens` 切换到「总览」并分别激活 `费用` / `Token` 指标，`usage.limits` 切换到「额度」；`usage.period.day/week/month/quarter` 分别映射 `24h` / `7天` / `30天` / `90天`。

### 上游同步冲突面

| 类别                               | 文件路径                                                                                                                                                                                                                                                                                                                                              | 冲突风险与控制策略                                                                                       |
| ---------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| **新增独立文件（零上游冲突）**     | `apps/server/src/usage/UsageMetadataIndex.ts`、`apps/server/src/usage/usageProjectResolution.ts`、对应 `*.test.ts`；`apps/web/src/fork/usage/*`（store、逻辑、KPI/配额条/趋势图/明细表/详情卡/导出/额度升级组件与测试）                                                                                                                               | **无冲突**：完全独立于上游目录。                                                                         |
| **最小 `// fork:` 钩子（低冲突）** | `apps/server/src/server.ts`（注入 `UsageMetadataIndex.layer`）、`apps/web/src/components/usage/UsagePage.tsx`（薄壳路由分派至 `fork/usage/UsageDashboard`）、`apps/web/src/components/usage/UsageModelDialog.tsx`（追加 Reasoning 与项目分布槽位）、`packages/provider-omp/src/server/usage.ts`（Fork 自有包）                                        | **极低冲突**：仅 1–15 行清晰标注 `// fork:` 的接入点。                                                   |
| **契约与扫描核心（可控中冲突）**   | `packages/contracts/src/usage.ts`、`packages/provider-core/src/server/usage.ts`、`packages/shared/src/usageMerge.ts`、`apps/server/src/usage/{UsageService,usageAggregation,usageScanCache}.ts`、`apps/server/src/provider/Drivers/{claudeUsage,codexUsage}.ts`、`packages/provider-{pi,opencode}/src/server/usage.ts`、`apps/web/src/state/usage.ts` | **可控**：所有扩展字段均为可选字段、保持独立辅助函数并带 `// fork:` 注释与单测守卫，不重构无关上游逻辑。 |
