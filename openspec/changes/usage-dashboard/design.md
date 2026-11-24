# 技术设计：T3 Lab `/usage` 用量仪表盘重构（`usage-dashboard`）

> 变更动机与范围边界见 [proposal.md](./proposal.md)；行为契约与验收场景见 [specs/fork-usage-dashboard/spec.md](./specs/fork-usage-dashboard/spec.md)。

---

## 1. Context 与真实 Provider 载荷真值矩阵

严格遵循 `LESSONS.md` 第 5 条，在锁定任何契约和夹具前，已于 2026-11-24 在本机以**只读方式**抽样核对真实 `~/.omp/agent/sessions`、`~/.pi/agent/sessions`、`~/.claude/projects`、`~/.codex/sessions`、`~/.local/share/opencode/opencode.db` 与 `~/.grok/sessions`（全程零触碰 `~/.t3/userdata`），同时核对 `packages/provider-pi/src/server/adapter.ts` 与 `apps/server/src/orchestration-v2/Adapters/*` 的 `nativeThreadRef` 写入逻辑。

### 1.1 真实载荷字段真值矩阵

| Provider | 磁盘存储位置 | `cwd` 真值字段 | 原生标题真值字段 | `sessionId` 真值字段 | T3 `nativeThreadRef.nativeId` 形态 | `reportedCostUsd` / `reasoningTokens` |
| --- | --- | --- | --- | --- | --- | --- |
| **`omp`** | `~/.omp/agent/sessions/**/*.jsonl` | 第 2 行 `type:"session"` → `cwd: string` | **第 1 行** `type:"title"` → `title: string`（先于 `session` 出现！） | `type:"session"` → `id: string` | **绝对文件路径**（`..._<uuid>.jsonl`） | `usage.cost.total` / `usage.reasoningTokens ?? usage.reasoning` |
| **`pi`** | `~/.pi/agent/sessions/**/*.jsonl` | 第 1 行 `type:"session"` → `cwd: string` | 后续 `type:"session_info"` → `name: string` | `type:"session"` → `id: string` | **绝对文件路径**（`..._<uuid>.jsonl`） | `usage.cost.total` / `usage.reasoning` |
| **`claude`** | `~/.claude/projects/**/*.jsonl` | `type:"assistant"` 行顶层 **`cwd: string`** | 后续 `type:"ai-title"` → `aiTitle` / `type:"custom-title"` → `customTitle`（后于消息出现！） | `sessionId: string` | **会话 UUID**（与 `sessionId` 相同） | `costUSD` / `0`（Anthropic 未拆出思考） |
| **`codex`** | `~/.codex/sessions/**/*.jsonl` | `type:"session_meta"` → **`payload.cwd: string`** | 无内置标题（优先取 T3 线程标题，兜底短 ID） | `payload.id ?? payload.session_id` | **会话 UUID**（与 `payload.id` 相同） | `null`（走表定价）/ `reasoning_output_tokens` |
| **`opencode`** | `~/.local/share/opencode/opencode.db` + `storage/message/` | SQLite `session.directory` / `session_v2.directory`（遗留 JSON `path.cwd`） | SQLite `session.title` / `session_v2.title` | `session_id` / `sessionID` | **会话 ID** | `cost`（非零实报）/ `tokens.reasoning` |
| **`grok`** | `~/.grok/sessions/*/updates.jsonl` | 日志中无 `cwd`（依赖 T3 `UsageMetadataIndex` 反查，否则未归属） | 同左 | `params.sessionId` | **会话 ID** | `costUsdTicks / 1e10` / `reasoningTokens` |
| **`muse` / `antigravity` / `cursor`** | 各自日志/账单 | 无直接 `cwd`（`muse`/`antigravity` 尝试按 `sessionId` 反查 T3，`cursor` 恒为未归属） | 同左 | `stream.id` / 会话 ID / 无 | 会话 ID / 无 | 见既有解析器 |

> **关键设计发现（实测防踩坑）**：
> 1. **`omp` 的 `title` 行在 `session` 行之前**（line 0 是 `type:"title"`，line 1 才是 `type:"session"`），`ompUsageFormat` 的状态机需暂存 `pendingTitle`，遇到 `session.id` 后绑定并保留到 `readSessionTitles(state)`。
> 2. **`claude` 的 `ai-title`/`custom-title` 出现在消息之后**，因此标题必须由格式状态机 `readSessionTitles(state)`（文件级映射 `sessionId -> title`）收集，而不能依赖单条 `UsageRecord` 写入顺序。
> 3. **Pi / `omp` 在 T3 中的 `nativeThreadRef.nativeId` 存的是会话文件路径而非 UUID**（`packages/provider-pi/src/server/adapter.ts:2301`），因此 `UsageMetadataIndex` 必须同时索引 `nativeId` 原值（匹配文件路径或 UUID）与从 `..._<uuid>.jsonl` 文件名提取的 UUID 后缀，才能让 `omp`/Pi 会话 100% 关联到 T3 线程并支持一键跳转！

---

## 2. Goals / Non-Goals

**Goals:**
1. **向后兼容协议扩展**：在不提升 `USAGE_CONTRACT_VERSION`（保持 `6` 且兼容 `USAGE_MERGE_COMPATIBLE_SINCE = 4`）的前提下，通过可选字段交付项目聚合、Top 50 会话、项目下钻筛选及实报费用拆分，确保 Mobile 与旧版/上游远程服务端零报错。
2. **严格 WebSocket 体积控制**：项目桶按 `(projectKey, provider, sourcePath)` 聚合（典型 5–30 条），`topSessions` 在服务端截断为 Top 50，避免推送海量明细。
3. **高内聚低冲突架构**：新增服务端元数据与项目归并模块独立成文件；新增 Web UI、Store、逻辑与导出全部收敛在 `apps/web/src/fork/usage/*`，上游 `UsagePage.tsx` 仅保留最小 `// fork:` 分派钩子。
4. **严格遵守 Fork 静态门禁**：零未用生产导出（`knip:check:exports`）、零裸 Tailwind 调色板（`shadcn/no-raw-colors`）、零原生 `title` 属性（`t3code/no-native-title-tooltip`）、零嵌套 `<Popover>`（Lesson #7）、无持续重绘动画、10 语言全量 `i18n:check`。

**Non-Goals:**
- 不改造 `apps/mobile` UI。
- 不修改 `apps/desktop` 独立打包入口（`boot.ts` / `compileCache.ts` / `serverCompileCache.ts` / `preload.ts` 零改动，但仍执行本地 macOS 真机打包试装验收）。
- 不新增独立自定义日期选择器与汇率换算。

---

## 3. 核心架构与技术决策

### 3.1 契约与多环境合并（`packages/contracts/src/usage.ts` & `packages/shared/src/usageMerge.ts`）

**决策：全部采用向后兼容可选字段 + 保留 `provider` / `sourcePath` 粒度以支持多环境去重和前端 Provider 过滤。**

1. **`packages/contracts/src/usage.ts` 新增可选类型与字段**：
   ```ts
   export const UNATTRIBUTED_USAGE_PROJECT_KEY = "__unattributed__" as const;

   export const UsageProjectFilter = Schema.Struct({
     projectKey: TrimmedNonEmptyString,
   });
   export type UsageProjectFilter = typeof UsageProjectFilter.Type;

   export const UsageProjectTopModel = Schema.Struct({
     model: TrimmedNonEmptyString,
     costUsd: Schema.Number,
     totalTokens: NonNegativeInt,
   });

   export const UsageProjectBucket = Schema.Struct({
     projectKey: TrimmedNonEmptyString,
     label: TrimmedNonEmptyString,
     workspaceRoot: Schema.optional(TrimmedNonEmptyString),
     t3ProjectId: Schema.optional(TrimmedNonEmptyString),
     worktreeCount: NonNegativeInt,
     unattributed: Schema.optional(Schema.Literal(true)),
     provider: UsageProviderKind,
     sourcePath: Schema.optional(TrimmedNonEmptyString),
     totals: UsageTokenTotals,
     costUsd: Schema.Number,
     providerReportedCostUsd: Schema.optional(Schema.Number),
     cacheSavingsUsd: Schema.Number,
     records: NonNegativeInt,
     unpricedRecords: NonNegativeInt,
     sessions: NonNegativeInt,
     topModels: Schema.optional(ForwardCompatibleArray(UsageProjectTopModel)),
   });
   export type UsageProjectBucket = typeof UsageProjectBucket.Type;

   export const UsageSessionSummary = Schema.Struct({
     sessionId: TrimmedNonEmptyString,
     provider: UsageProviderKind,
     sourcePath: Schema.optional(TrimmedNonEmptyString),
     title: Schema.optional(TrimmedNonEmptyString),
     t3ThreadId: Schema.optional(TrimmedNonEmptyString),
     t3ProjectId: Schema.optional(TrimmedNonEmptyString),
     projectKey: TrimmedNonEmptyString,
     projectLabel: TrimmedNonEmptyString,
     cwd: Schema.optional(TrimmedNonEmptyString),
     primaryModel: TrimmedNonEmptyString,
     models: ForwardCompatibleArray(TrimmedNonEmptyString),
     totals: UsageTokenTotals,
     costUsd: Schema.Number,
     providerReportedCostUsd: Schema.optional(Schema.Number),
     records: NonNegativeInt,
     unpricedRecords: NonNegativeInt,
     firstTimestampMs: Schema.Number,
     lastTimestampMs: Schema.Number,
   });
   export type UsageSessionSummary = typeof UsageSessionSummary.Type;
   ```
   - `UsageBucket` 增加可选 `providerReportedCostUsd: Schema.optional(Schema.Number)`（精确核算「仅实报费用」软预算口径，旧服务端缺省时前端按 `costSource === "providerReported" ? costUsd : 0` 降级估算）。
   - `UsageSummaryInput` 增加可选 `projectFilter: Schema.optional(UsageProjectFilter)`。
   - `UsageSummary` 增加可选：
     - `projects: Schema.optional(ForwardCompatibleArray(UsageProjectBucket))`
     - `topSessions: Schema.optional(ForwardCompatibleArray(UsageSessionSummary))`
     - `projectFilter: Schema.optional(UsageProjectFilter)`

   > **备选方案与权衡**：如果把 `projects` 预合并为不含 `provider` 的数组，当用户在前端勾选隐藏某个 Provider 或点击独显某个 Provider 时，项目表无法重新过滤出正确数值。按 `(projectKey, provider, sourcePath)` 输出 `UsageProjectBucket` 后，单环境也只有几十条以内，却能直接复用 `mergeUsage` 的 `ownedContribution` 跨环境去重与前端 `withoutProviders` 零延迟过滤！

2. **`packages/shared/src/usageMerge.ts` 扩展**：
   - `MergedUsage` 新增：
     - `providerReportedCostUsd: number`（精确汇总实报费用，支持软预算 `reportedOnly` 口径）
     - `projects: readonly MergedProjectTotals[]`（按 `projectKey` 跨环境/跨 Provider 合并，含 `worktreeCount`、`providers`、`topModel`、`modelContributions`（供模型详情弹窗显示项目分布）、`costShare`、`tokenShare`）
     - `topSessions: readonly MergedSessionTotals[]`（按 `(provider, sessionId)` 去重合并并附带 `environmentId` 供跳转 T3 线程，截断 Top 50）
     - `hasProjectAttribution: boolean`（任一贡献环境返回 `summary.projects !== undefined` 时为 `true`，供前端在连接旧远程服务端时展示诚实降级提示）
     - `hasSessionAttribution: boolean`（同上）
   - `apps/web/src/state/usage.ts` 的 `withoutProviders` 同步按 `provider` 过滤 `summary.projects` 与 `summary.topSessions`，并扩展 `useUsage` 支持 `projectFilter` 参数与可选 `comparisonWindow` 环比查询（复用同一 `usageByWindowAtom` 缓存家族）。

---

### 3.2 服务端扫描、缓存与项目/线程归因

1. **`packages/provider-core/src/server/usage.ts`**：
   - `UsageRecord` 新增可选 `readonly cwd?: string`。
   - `TranscriptUsageFormat<State>` 新增可选 `readSessionTitles?(state: State): ReadonlyMap<string, string>`（与现有 `readMalformedRecords?(state: State)` 同构）。
   - `ProviderUsageScan.files[number]` 新增可选 `readonly sessionTitles?: ReadonlyMap<string, string>`（供 `OpenCode` 这类 `kind: "scan"` 读取器直接传递 SQLite `session.title`）。

2. **各 Provider 解析器补齐**：
   - `packages/provider-omp/src/server/usage.ts`：`OmpScanState` 增加 `cwd: Schema.mutableKey(Schema.optionalKey(Schema.String))`、`pendingTitle`、`titles: Record<string, string>`；`usageMarkers` 追加 `'"type":"title"'`；`selectFields` 追加 `cwd: true, title: true`；实现 `readSessionTitles`。**严守 Lesson #6：绝不继承 `PI_CODING_AGENT_*`**。
   - `packages/provider-pi/src/server/usage.ts`：`PiScanState` 增加 `cwd` 与 `titles`；`usageMarkers` 追加 `'"session_info"'`；`selectFields` 追加 `cwd: true, name: true`；实现 `readSessionTitles`。
   - `apps/server/src/provider/Drivers/claudeUsage.ts`：`selectFields` 追加 `cwd: true, aiTitle: true, customTitle: true`；`usageMarkers` 追加 `'"ai-title"'`, `'"custom-title"'`；`parseClaudeRecord` 在 `assistant` 行直接写入 `cwd`；引入轻量 `ClaudeScanState = { titles: Record<string, string> }`（可选字段），在遇到 `ai-title` / `custom-title` 时记录 `titles[sessionId]` 并通过 `readSessionTitles` 暴露。
   - `apps/server/src/provider/Drivers/codexUsage.ts`：`CodexScanState` 增加可选 `cwd`；`selectFields.payload` 追加 `cwd: true`；在 `session_meta` 解析 `payload.cwd` 并带到每个 `codexRequestRecord`。
   - `packages/provider-opencode/src/server/usage.ts`：在已有只读 SQLite 事务内，一次性查 `session` / `session_v2` 的 `(id, directory, title)` 构造内存 Map，给每条 `UsageRecord` 填充 `cwd` 并把 `sessionTitles` 附在 `ProviderUsageScan.files` 上。

3. **扫描缓存升级（`apps/server/src/usage/usageScanCache.ts`）**：
   - `USAGE_SCAN_CACHE_VERSION` 从 `17` 升至 `18`（`SCAN_CACHE_FILE_NAME = "usage-scan-cache-v18.json"`，将 `usage-scan-cache-v17.json` 加入 `LEGACY_SCAN_CACHE_FILE_NAMES`）。
   - `SerializedCache` 增加可选 `cwds?: readonly string[]` intern 表；`SerializedRecord` 末尾追加可选 `cwdIndex?: number | null`；`SerializedFile` 增加可选 `st?: Readonly<Record<string, string>>` 保存 `sessionTitles`。
   - 从 `v17` 迁移时：对于 `claude`/`codex`/`omp`/`pi` 文件标记 `legacy = true`（`size: -1`），在下次扫描时自动增量重解析以补齐 `cwd` 和 `title`，同时已删除日志文件的历史记录仍保留不丢失。

4. **新增 `apps/server/src/usage/UsageMetadataIndex.ts`（独立文件，零测试破坏）**：
   - 使用 Effect `Context.Reference`（完全复用 `UsageLimitResetFallback` 同款模式），默认空实现（返回空项目列表与空会话映射），确保现有 `UsageService.test.ts` 无需改动测试 Layer！
   - `UsageMetadataIndex.layer` 在 `apps/server/src/server.ts` 中由 `ProjectStore.ProjectStoreV2` + `SqlClient.SqlClient` 提供，单次 `snapshot` 读取：
     - 所有项目（含已删以保留历史名称）：`projectId`, `title`, `workspaceRoot`。
     - 所有非删除（及历史）线程与 `orchestration_v2_projection_provider_threads` 关联：构建 `byNativeId` 与 `bySessionUuid`（自动剥离 `..._<uuid>.jsonl` 文件名后缀以兼容 `omp`/`pi`！）双索引，以及 `byWorktreePath` 索引。
     - 任一 SQL 读取失败时静默降级返回空快照并记 debug 日志，绝不阻断 `/usage` 扫描。

5. **新增 `apps/server/src/usage/usageProjectResolution.ts`（独立纯逻辑 + 受控 Git common-dir 归并）**：
   - 规范化 `cwd` 归并优先级：
     1. 若会话命中 T3 线程且所属 `projectId` 存在 → `projectKey = "t3:" + projectId`，`label = project.title`，`workspaceRoot = project.workspaceRoot`，`t3ProjectId = projectId`。
     2. 若 `cwd` 命中 T3 线程的 `worktreePath` 或项目 `workspaceRoot`（精确或路径规范化匹配）→ 归入对应 T3 项目。
     3. 若 `cwd` 非空：通过进程内缓存解析 `.git` 文件（若为文本文件且含 `gitdir:` 指向 `.../.git/worktrees/<name>`，追溯其主仓库根目录；读 `.git` 使用单次轻量只读 fs 检查且跳过 macOS TCC 敏感目录如 `~/Desktop`、`~/Documents`、`~/Downloads` 以防挂起，遵循 `AgentSessionScanner.ts` 教训），生成 `projectKey = "path:" + normalizedRepoRoot`，`label = basename(normalizedRepoRoot)`。
     4. 否则 → `projectKey = "__unattributed__"`，`label = "Unattributed"`，`unattributed = true`。
   - 统计每个 `projectKey` 下观测到的去重 worktree 目录数量（`worktreeCount`：当存在独立于 `workspaceRoot` 的 worktree 目录或去重 `cwd > 1` 时记录实际工作树数）。

6. **聚合与 `projectFilter`（`apps/server/src/usage/usageAggregation.ts` & `UsageService.ts`）**：
   - `UsageAggregator` 同步累积：
     - 现有 `buckets`（新增 `providerReportedCostUsd` 字段）；
     - `projectBuckets`（按 `(projectKey, provider, sourcePath)` 聚合，附每个桶 Top 5 模型明细）；
     - `sessions`（按 `(provider, sessionId, sourcePath)` 聚合，结束时按 `costUsd` 降序 + 补足高 `totalTokens` 未定价会话截断 Top 50）。
   - 当 `UsageSummaryInput.projectFilter` 传入时：先在 `UsageAggregator.add` 内解析该记录的 `projectKey`，仅保留匹配的记录，并使 `distinctSessions` 与所有图表/KPI/模型表严格一致（走既有内存 `fileCache`，重算耗时毫秒级）。

---

### 3.3 导出契约与 Knip 防回归约束（Group 1 — `omp` 负责）

> **强制导出纪律（`knip:check:exports`）**：仅导出下列标注 `PUBLIC` 的符号；所有内部辅助函数与未跨文件消费的常量 **严禁 `export`**。

#### A. `apps/web/src/fork/usage/usageOptionsStore.ts`
**PUBLIC Exports：**
```ts
export const USAGE_UI_OPTIONS_STORAGE_KEY = "t3lab:usage-ui:v1";

export type UsageDashboardView = "overview" | "limits";
export type UsageChartMode = "stacked-bar" | "line";
export type UsagePeriodPreset = "today" | "24h" | "7d" | "mtd" | "30d" | "90d";
export type UsageBudgetScope = "all" | "reportedOnly";

export interface UsageUiOptions {
  readonly view: UsageDashboardView;
  readonly metric: "cost" | "tokens";
  readonly period: UsagePeriodPreset;
  readonly chartMode: UsageChartMode;
  readonly showQuotaStrip: boolean;
  readonly showShareBars: boolean;
  readonly showComparison: boolean;
  readonly showBudget: boolean;
  readonly dailyBudgetUsd: number | null;
  readonly monthlyBudgetUsd: number | null;
  readonly budgetScope: UsageBudgetScope;
  readonly hiddenProviders: readonly UsageProviderKind[];
}

export interface UsageOptionsStoreState extends UsageUiOptions {
  setView: (view: UsageDashboardView) => void;
  setMetric: (metric: "cost" | "tokens") => void;
  setPeriod: (period: UsagePeriodPreset) => void;
  setChartMode: (mode: UsageChartMode) => void;
  toggleOption: (key: "showQuotaStrip" | "showShareBars" | "showComparison" | "showBudget") => void;
  setBudget: (patch: {
    readonly dailyBudgetUsd?: number | null;
    readonly monthlyBudgetUsd?: number | null;
    readonly budgetScope?: UsageBudgetScope;
  }) => void;
  setHiddenProviders: (providers: readonly UsageProviderKind[]) => void;
  resetUsageUiOptions: () => void;
}

export function parseUsageUiOptions(raw: unknown): UsageUiOptions;
export function readPersistedUsageUiOptions(
  storage?: Pick<Storage, "getItem"> | null,
): UsageUiOptions;
export function isDefaultUsageUiOptions(options: UsageUiOptions): boolean;
export const useUsageOptionsStore: UseBoundStore<StoreApi<UsageOptionsStoreState>>;
```
- **Defaults（INTERNAL）**：`{ view: "overview", metric: "cost", period: "30d", chartMode: "stacked-bar", showQuotaStrip: true, showShareBars: true, showComparison: true, showBudget: true, dailyBudgetUsd: null, monthlyBudgetUsd: null, budgetScope: "all", hiddenProviders: [] }`。
- 首次从旧版 `t3code:usage-page-preferences:v1` 迁移时仅继承 `hiddenProviders`（不继承旧版默认 `metric: "limits"`，确保首屏默认落 `overview`）。

#### B. `apps/web/src/fork/usage/usageDashboard.logic.ts`
纯函数模块，所有时间均通过 `now: Date` / `nowMs: number` 显式注入，保证单测 100% 确定性。

**PUBLIC Exports：**
```ts
export interface UsageWindowPair {
  readonly current: UsageSummaryInput;
  readonly previous: UsageSummaryInput;
  readonly preset: UsagePeriodPreset;
}

export function buildUsageWindowPair(
  preset: UsagePeriodPreset,
  now?: Date,
  timeZone?: string,
): UsageWindowPair;

export interface UsageDelta {
  readonly current: number;
  readonly previous: number;
  readonly percentChange: number | null; // previous <= 0 时返回 null（绝不输出 Infinity/NaN）
  readonly direction: "up" | "down" | "flat" | "unknown";
}

export function computeUsageDelta(current: number, previous: number | null): UsageDelta;

export type UsageRiskTone = "normal" | "warning" | "error";

export interface UsageBudgetStatus {
  readonly periodKind: "daily" | "monthly";
  readonly spentUsd: number;
  readonly limitUsd: number;
  readonly ratio: number;
  readonly tone: UsageRiskTone;
  readonly scope: UsageBudgetScope;
}

export function deriveSoftBudgetStatus(input: {
  readonly preset: UsagePeriodPreset;
  readonly totalCostUsd: number;
  readonly reportedCostUsd: number;
  readonly dailyBudgetUsd: number | null;
  readonly monthlyBudgetUsd: number | null;
  readonly budgetScope: UsageBudgetScope;
  readonly showBudget: boolean;
}): UsageBudgetStatus | null;

export interface UsageKpiSnapshot {
  readonly costUsd: number;
  readonly totalTokens: number;
  readonly sessions: number;
  readonly activePeriods: number;
  readonly burnPerActivePeriodCostUsd: number | null;
  readonly burnPerActivePeriodTokens: number | null;
  readonly costPerMillionTokens: number | null;
  readonly cacheHitRate: number | null;
  readonly cacheSavingsUsd: number;
  readonly cacheSavingsMultiplier: number | null;
  readonly cachedInputTokens: number;
  readonly cacheCreationTokens: number;
  readonly outputTokens: number;
  readonly reasoningTokens: number;
  readonly reasoningShare: number | null;
  readonly speedPremiumUsd: number;
  readonly providerReportedShare: number;
  readonly modelPricedShare: number;
  readonly unpricedShare: number;
  readonly providerReportedCostUsd: number;
}

export function deriveUsageKpis(
  merged: MergedUsage,
  resolution: "day" | "hour",
): UsageKpiSnapshot;

export function quotaRiskTone(remainingPercent: number): UsageRiskTone;

export type UsageModelSortKey = "cost" | "tokens" | "share" | "cacheHit" | "perMillion" | "model";
export type UsageProjectSortKey = "cost" | "tokens" | "share" | "sessions" | "label";
export type UsageSessionSortKey = "cost" | "tokens" | "cacheHit" | "lastActive" | "title";
export type UsageSortDirection = "asc" | "desc";

export function sortAndFilterUsageModels(
  models: readonly ModelTotals[],
  options: {
    readonly query: string;
    readonly sortKey: UsageModelSortKey;
    readonly direction: UsageSortDirection;
    readonly metric: "cost" | "tokens";
  },
): readonly ModelTotals[];

export function sortAndFilterUsageProjects(
  projects: readonly MergedProjectTotals[],
  options: {
    readonly query: string;
    readonly sortKey: UsageProjectSortKey;
    readonly direction: UsageSortDirection;
    readonly metric: "cost" | "tokens";
  },
): readonly MergedProjectTotals[];

export function sortAndFilterUsageSessions(
  sessions: readonly MergedSessionTotals[],
  options: {
    readonly query: string;
    readonly sortKey: UsageSessionSortKey;
    readonly direction: UsageSortDirection;
  },
): readonly MergedSessionTotals[];

export function serializeUsageExportCsv(input: {
  readonly merged: MergedUsage;
  readonly window: UsageSummaryInput;
  readonly breakdownTab: "model" | "project" | "session" | "time";
}): string;

export function serializeUsageExportJson(input: {
  readonly merged: MergedUsage;
  readonly window: UsageSummaryInput;
  readonly comparison: MergedUsage | null;
}): string;
```

---

### 3.4 UI 组件树与设计系统约束（Group 2 — `agy` 负责）

```
apps/web/src/components/usage/UsagePage.tsx (// fork: 薄壳入口，挂载 fork/usage/UsageDashboard)
  └─ apps/web/src/fork/usage/UsageDashboard.tsx (AppRouteModal + 全宽内容容器 max-w-none)
       ├─ UsageTopbar.tsx
       │    ├─ WorkspaceBreadcrumb (Usage / EnvFilter / ProviderFilter)
       │    ├─ ActiveFilterChips (Solo Provider / ProjectFilter / Locked Day-Hour 一键清除)
       │    ├─ Period Selector (Today / 24h / 7d / MTD / 30d / 90d)
       │    ├─ View & Metric Controls (Overview[Cost|Tokens] / Limits)
       │    ├─ Explicit Actions: [Model Prices] [Export CSV/JSON Menu] [🎛 Options & Soft Budget Menu] [Refresh] [Close]
       ├─ [Overview]
       │    ├─ UsageQuotaStrip.tsx (存在订阅额度 && showQuotaStrip 时渲染；独立 60s 倒计时叶节点；点击跳 Limits)
       │    ├─ UsageKpiCards.tsx (4 卡网格：总览+环比+来源+软预算 / 燃速均价 / 缓存效率 / 输出思考)
       │    ├─ Main Split Grid (Provider 排行点击联动过滤 + UsageTrendChart.tsx 堆叠柱/折线切换+点击锁定单日)
       │    ├─ Semantic Share Bars (showShareBars 时渲染；使用 index.css 语义 Token)
       │    └─ UsageBreakdownSection.tsx (Model / Project / Top Sessions / Day-Hour 4 Tab)
       │         ├─ Model Row -> UsageModelDialog (// fork: 追加 Reasoning 与项目分布)
       │         ├─ Project Row -> 激活 top-level projectFilter 重算总览
       │         ├─ Session Row -> 命中 t3ThreadId 直接 navigate 关弹窗跳线程，否则开 UsageSessionDialog.tsx
       │         └─ Day/Hour Row -> 修复 Tokens 模式显示 formatTokens，点击高亮趋势柱
       └─ [Limits]
            └─ UsageLimitsEnhanced.tsx (风险分级卡片 + Plan/精确重置时间/60s 倒计时/Pace/多账号池/Reset Credit + 管理 Hub 快捷跳转)
```

**关键 UI 守卫**：
- **语义色 Token（严格通过 `shadcn/no-raw-colors`）**：
  - 占比条：`Input` → `var(--info)`，`Cache read` → `var(--success)`，`Cache write` → `var(--warning)`，`Output` → `var(--guest)`，`Reasoning` → `var(--update)`，`Other` → `var(--muted-foreground)`。
  - 风险分级（Quota / Soft Budget）：Normal → `bg-success` / `text-success-foreground`；Warning → `bg-warning` / `text-warning-foreground`；Critical → `bg-error` / `text-error-foreground`。
- **绝不嵌套 `<Popover>`（Lesson #7）**：顶栏 `🎛`、导出、筛选统一用原生 `<Menu>` + `<MenuCheckboxItem variant="switch" closeOnClick={false}>`；软预算数值输入放在菜单内安全区域或独立 `<Dialog>`，避免焦点外移误关。
- **绝不使用原生 `title` 属性（`t3code/no-native-title-tooltip`）**：所有提示使用 `<Tooltip>` 或 `aria-label`。
- **低开销倒计时（性能规范）**：仅在独立倒计时叶组件挂载 60 秒 `setInterval`（`60_000ms`），零 CSS 持续动画、零整页重绘。
- **React Compiler 兼容**：零手动 `useMemo`/`useCallback`，遵循 `apps/web/src/components/ui` 原语规范（`shadcn/no-restyle`）。

---

## 4. Risks / Trade-offs

- **[Risk] 历史 `usage-scan-cache-v17.json` 升级 `v18` 后首次打开 `/usage` 触发一次重扫** → **Mitigation**：仅对需补齐 `cwd`/`title` 的本地日志类 Provider 触发增量重解析，已删除文件保留原记录不丢数据；前端在扫描期间沿用 `provisional` 渐进展示与半透明 loading 态，不阻塞页面。
- **[Risk] 对非 T3 目录调用 Git worktree 解析在 macOS 上触碰 TCC 受保护目录（Desktop/Documents）导致阻塞** → **Mitigation**：严格优先走 `ProjectStore` + `ThreadStore` 内存/SQLite 映射；文件系统回退仅读 `<cwd>/.git` 单文件（禁止启动子进程），跳过已知 TCC 敏感前缀，并在单次读取失败时缓存负结果，绝不阻塞事件循环。
- **[Risk] 环比查询引入额外一次 `usageSummary` RPC** → **Mitigation**：上一周期数据几乎全部落在已预热的内存 `fileCache` 中，聚合耗时为毫秒级；且用户可在 `🎛` 中关闭 `showComparison`（关闭后彻底不发该查询），在 `Limits` 视图下也不触发。
- **[Risk] 上游同步 `UsageService.ts` / `usageMerge.ts` 冲突** → **Mitigation**：项目归并逻辑独立放在 `usageProjectResolution.ts`，T3 元数据查询独立放在 `UsageMetadataIndex.ts`，所有契约扩展集中在结构体尾部并标注 `// fork:`，前端 95% 新代码完全隔离在 `apps/web/src/fork/usage/*`。

---

## 5. Migration & Verification Plan

- **数据迁移**：`usage-scan-cache-v17.json` 自动平滑迁移为 `v18` 并在写盘成功后沿用上游既有清理逻辑移除旧缓存；`t3code:usage-page-preferences:v1` 保留不删，首次读取 `t3lab:usage-ui:v1` 时仅继承 `hiddenProviders`。
- **验证策略**：
  1. Group 1 单元测试：覆盖 `omp`/`pi`/`claude`/`codex`/`opencode` 的 `cwd`/标题解析、`usageProjectResolution` worktree 归并、`UsageMetadataIndex` 路径型/UUID 型线程匹配、`usageScanCache` v17→v18 迁移、`UsageService` `projectFilter` + Top 50 截断、`usageMerge` 多环境去重与实报费用汇总、`usageOptionsStore` & `usageDashboard.logic`。
  2. Group 2 浏览器测试（`apps/web/src/fork/usage/usageDashboard.browser.test.tsx`）：真实 Chromium 验证双视角首屏、Quota Strip 自动显隐与跳转、4 卡 KPI + 环比 + 软预算口径、堆叠柱/折线切换与点击锁定、Provider 点击独显、4 Tab 明细排序搜索、项目点击跨页联动、Top 会话跳转 T3 线程与外部详情弹窗、`Day/Hour` Tokens 模式修复、CSV/JSON 导出、`🎛` 持久化、Limits 风险色与管理 Hub 链接，以及旧服务端无 `projects`/`topSessions` 降级提示。
  3. 独立 Visual QA：在 worktree 内用 `vp run dev --no-seed` + `ego-browser` 验收明/暗双主题视觉层次与交互（零触碰 `~/.t3/userdata`）。
  4. Group 3 跨模型只读 Review（`omp`）→ `Broken by hand` 证伪 → `vp run check:changed origin/lmx-lab` + `forkIdentity.guard.test.ts` + `vp run i18n:check` → 本地 macOS DMG 试装 Dogfood 验收（`bash fork/scripts/install-local-mac.sh <ver>`）。
