# 技术设计：T3 Lab 右侧 Thread HUD 实时仪表盘（`thread-hud-panel`）

## 1. 架构概览与模块边界

本 PR 严格限定在 `apps/web` 内实现，数据流完全只读消费现有 client-runtime 状态与上游 hook，零服务端/协议改动：

```
ChatView.tsx (// fork: 仅透传 compactContext)
  └─ ThreadDetailsPanel.tsx (// fork: 挂载 ThreadHudHeader + ThreadHudSections，去重旧 Usage/Context)
       └─ ThreadDetailsCard.tsx (// fork: 测量豁免追加 [data-thread-hud-panel])
            ├─ ThreadHudHeader [data-thread-hud-panel]
            │    └─ HudOptionsPopover (🎛 -> useHudOptionsStore -> localStorage["t3lab:hud-ui:v1"])
            ├─ [Upstream] Workspace / Version Control / PR / GitActions / Repositories
            ├─ ThreadHudSections [data-thread-hud-panel] (读取 useQuietThreadProjection)
            │    ├─ HudContextCard (B3) ── HudPromptCacheCountdown (独立叶子组件，仅暖态订阅 secondTick)
            │    ├─ HudSessionCard (B4)
            │    ├─ HudQuotaCard   (B5) ── 复用 resolveThreadDetailsLimits (零新增轮询)
            │    ├─ HudActivityCard(B6) ── 子 Agent 点击跳转 + Top 8 工具胶囊
            │    └─ HudSystemCard  (B7) ── 仅在 panelOpen && showSystem 时挂载 HudSystemTelemetryContent
            └─ [Upstream] Servers / Automations / Lineage / SideChats / Fallback Legacy Usage & Context
```

## 2. 导出契约与 Knip 防回归约束（Group 1 — `omp` 负责）

> **强制导出纪律（`knip:check:exports`）**：以下标注 `PUBLIC` 的符号将被 Group 2 UI 组件与单测直接引用；标注 `INTERNAL` 的常量和辅助函数 **严禁 `export`**，避免触发 `knip` 未使用导出报错。

### 2.1 `apps/web/src/fork/hud/hudOptionsStore.ts`

遵循 `apps/web/src/fork/sidebar/sidebarOptionsStore.ts` 的 Zustand + `localStorage` 模式。

**PUBLIC Exports（允许且必须导出）：**

```ts
export const HUD_OPTIONS_STORAGE_KEY = "t3lab:hud-ui:v1";

export type HudCardVisibilityKey =
  | "showContext"
  | "showSession"
  | "showQuota"
  | "showActivity"
  | "showSystem";

export interface HudUiOptions {
  readonly showContext: boolean;
  readonly showSession: boolean;
  readonly showQuota: boolean;
  readonly showActivity: boolean;
  readonly showSystem: boolean;
  readonly systemExpanded: boolean;
}

export interface HudOptionsStoreState extends HudUiOptions {
  toggleCard: (key: HudCardVisibilityKey) => void;
  setCardVisible: (key: HudCardVisibilityKey, value: boolean) => void;
  setSystemExpanded: (expanded: boolean) => void;
  toggleSystemExpanded: () => void;
  resetHudOptions: () => void;
}

export function parseHudUiOptions(raw: unknown): HudUiOptions;
export function readPersistedHudUiOptions(
  storage?: Pick<Storage, "getItem"> | null,
): HudUiOptions;
export function isDefaultHudUiOptions(options: HudUiOptions): boolean;
export const useHudOptionsStore: UseBoundStore<StoreApi<HudOptionsStoreState>>;
```

**Defaults & INTERNAL（严禁导出）：**

- `DEFAULT_HUD_UI_OPTIONS`: `{ showContext: true, showSession: true, showQuota: true, showActivity: true, showSystem: true, systemExpanded: false }`
- `writePersistedHudUiOptions`, `isOptionsObject`, `readBooleanOption` 均为模块私有函数。
- 持久化键名固定 `"t3lab:hud-ui:v1"`；读取损坏 JSON / 非对象 / 存储不可用时静默回退默认值；写入异常（QuotaExceeded / Privacy mode）时保留内存状态不抛错。

---

### 2.2 `apps/web/src/fork/hud/hudMetrics.logic.ts`

纯函数模块，无 React 依赖、无副作用、无 `Date.now()` 隐式调用（所有时间均通过 `nowMs: number` 参数注入，保证单测 100% 确定性）。

**PUBLIC Exports（允许且必须导出）：**

```ts
export type HudThreadStatusKind = "running" | "approval" | "input" | "error" | "waiting" | "idle";

export interface HudHeaderSummary {
  readonly statusKind: HudThreadStatusKind;
  readonly providerLabel: string;
  readonly requestedModel: string | null;
  readonly servedModel: string | null;
  readonly modelDisplay: string | null;
  readonly modelSwitched: boolean;
}

export function deriveHudHeaderSummary(input: {
  readonly runtimeStatus: OrchestrationV2RunStatus | "idle" | null | undefined;
  readonly hasPendingApproval: boolean;
  readonly hasPendingUserInput: boolean;
  readonly lastError: string | null | undefined;
  readonly providerLabel: string;
  readonly requestedModel: string | null | undefined;
  readonly projection: Pick<ThreadStructure, "thread" | "providerTurns"> | null | undefined;
}): HudHeaderSummary;
```

- 状态优先级：`hasPendingApproval` → `"approval"`；`hasPendingUserInput` → `"input"`；`runtimeStatus` 为 `preparing | queued | starting | running` → `"running"`；`runtimeStatus === "waiting"` → `"waiting"`；`runtimeStatus === "failed"` 或非空 `lastError` → `"error"`；其余 → `"idle"`。
- `servedModel` 取活跃 Provider Thread（若 `activeProviderThreadId` 为 null 则全部）下最新已送达（`!turn.promptDropped`）turn 的 `turn.model ?? singleModel(turn.turnTokenUsage?.models)`。`modelSwitched` 仅当 `requestedModel` 和 `servedModel` 均非空且不相等时为 `true`。

```ts
export type HudContextBucketKey = "systemBase" | "tools" | "assistant" | "user";
export type HudContextUsageTone = "normal" | "warning" | "error";
export type HudPromptCacheState = "warm" | "cold" | "unknown";

export interface HudContextBucket {
  readonly key: HudContextBucketKey;
  readonly tokens: number;
  readonly percentOfContext: number;
  readonly percentOfUsed: number;
}

export interface HudContextTurnBreakdownItem {
  readonly key: "input" | "cachedInput" | "output" | "reasoning";
  readonly tokens: number;
}

export interface HudContextMetrics {
  readonly usedTokens: number;
  readonly maxTokens: number | null;
  readonly usedPercentage: number | null;
  readonly usageTone: HudContextUsageTone;
  readonly over200k: boolean;
  readonly autoCompactThreshold: number | null;
  readonly autoCompactTickPercent: number | null;
  readonly hasCompaction: boolean;
  readonly isApproximate: true;
  readonly buckets: readonly HudContextBucket[];
  readonly lastTurnCacheHitRate: number | null;
  readonly cumulativeCacheHitRate: number | null;
  readonly cacheSampleTurnCount: number;
  readonly cacheModel: string | null;
  readonly promptCacheExpiresAtMs: number | null;
  readonly promptCacheState: HudPromptCacheState;
  readonly promptCacheRemainingMs: number | null;
  readonly lastTurnBreakdown: readonly HudContextTurnBreakdownItem[];
}

export function derivePromptCacheCountdown(
  expiresAtMs: number | null,
  nowMs: number,
): {
  readonly state: HudPromptCacheState;
  readonly remainingMs: number | null;
};

export function deriveHudContextMetrics(input: {
  readonly contextWindow: ContextWindowSnapshot | null | undefined;
  readonly liveTokenUsage: OrchestrationV2ProviderTurnTokenUsage | null | undefined;
  readonly projection:
    | Pick<
        ThreadStructure,
        "thread" | "providerThreads" | "providerTurns" | "turnItems" | "messages"
      >
    | null
    | undefined;
  readonly requestedModel: string | null | undefined;
  readonly nowMs: number;
}): HudContextMetrics | null;
```

**Context Lens 关键算法约束：**

1. 若 `contextWindow` 与 `liveTokenUsage` 均不存在（或无有效非负 `usedTokens`），返回 `null`。
2. `usageTone`：`usedPercentage === null || usedPercentage < 65` → `"normal"`；`65 <= usedPercentage < 85` → `"warning"`；`usedPercentage >= 85` → `"error"`。`over200k = usedTokens >= 200_000`。
3. `autoCompactTickPercent`：仅当 `maxTokens > 0 && threshold > 0 && threshold < maxTokens` 时计算 `(threshold / maxTokens) * 100`。
4. **4 桶估算（`buckets` 顺序固定 `systemBase`, `tools`, `assistant`, `user`）**：
   - 先确定 `activeProviderThreadId = projection?.thread.activeProviderThreadId ?? null`。
   - 过滤 `turnItems`：仅保留 `providerThreadId === null || activeProviderThreadId === null || providerThreadId === activeProviderThreadId` 的项。
   - 查找最后一条 `item.type === "compaction" && item.status === "completed"` 的索引 `lastCompactionIndex`；`hasCompaction = lastCompactionIndex >= 0`；仅切片其后的 `turnItems`（若无压缩则全量）。
   - 字符计数：
     - `userChars`：`user_message` 的 `text.length`（若 `textOmitted === true` 且 `text.length === 0`，从 `projection.messages` 按 `messageId` 查找 `text.length`）。
     - `toolChars`：`command_execution`（`input + output`）、`file_change`（`fileName + (diffStr ?? oldStr+newStr)`）、`file_search`（`pattern + results`）、`web_search`（`patterns + results`）、`dynamic_tool`（`toolName + input/output` 安全有限序列化，单条上限 16,384 字符防大 JSON 卡顿）。
     - `assistantChars`：对应切片后 `assistant_message` 的 `messageId` 在 `projection.messages` 中查找已完成（`!streaming`）消息的 `text.length`（若 `messages` 无匹配则 fallback 用 `proposed_plan.markdown.length` + 仅在完全无文本且 `outputTokens > 0` 时用 `outputTokens * 4` 近似）。
   - 令牌分配（严格非负整数且 4 桶 `tokens` 总和 === `usedTokens`）：
     - `usedTokens === 0` 时 4 桶全 `0`。
     - 计算 `estUser = Math.round(userChars / 4)`、`estTools = Math.round(toolChars / 4)`、`estAssistant = Math.round(assistantChars / 4)`，`contentEst = estUser + estTools + estAssistant`。
     - 若 `contentEst <= usedTokens`：`systemBase = usedTokens - contentEst`，其余 3 桶直接取 `est*`。
     - 若 `contentEst > usedTokens`：为 `systemBase` 保留基础份额（压缩摘要 `summary.length / 4` 或 `Math.round(usedTokens * 0.12)`，不超过 `Math.round(usedTokens * 0.35)`），剩余 `usedTokens - systemBase` 按 `estTools : estAssistant : estUser` 比例分配，并将舍入余数补入最大内容桶，确保总和严格等于 `usedTokens`。
   - `percentOfContext = denom > 0 ? (tokens / denom) * 100 : 0`（`denom = maxTokens ?? usedTokens`）；`percentOfUsed = usedTokens > 0 ? (tokens / usedTokens) * 100 : 0`。
5. **单模型 Prompt Cache 命中率隔离**：
   - 解析当前 `activeModel`（活跃 provider thread 最新已送达 turn 的单一模型，否则 `requestedModel`）。
   - 遍历活跃 provider thread 的已送达 turn（`!turn.promptDropped`）：
     - 若 turn 声明了多个不同模型（`turn.turnTokenUsage?.models` 去重后长度 > 1），跳过。
     - 解析 `turnModel = turn.model ?? turn.turnTokenUsage?.models?.[0] ?? null`；若 `activeModel !== null` 且 `turnModel !== null && turnModel !== activeModel`，跳过！若 `activeModel !== null && turnModel === null` 且历史上已出现过其他不同模型的 turn，同样跳过以防混入切模前的旧轮次。
     - 读取 `inputTokens` 与 `cachedInputTokens`（优先 `turn.turnTokenUsage`，回退 `turn.tokenUsage`）；仅当 `inputTokens > 0 && cachedInputTokens !== undefined` 时计入样本，且将 `cachedInputTokens` 钳位在 `[0, inputTokens]`。
   - 若样本非空：`lastTurnCacheHitRate` 取最后一条样本的 `(cached / input) * 100`；`cumulativeCacheHitRate` 取 `(sumCached / sumInput) * 100`。
   - 若 `providerTurns` 无样本但 `contextWindow` 直接提供了 `lastInputTokens > 0 && lastCachedInputTokens != null`（或 `inputTokens > 0 && cachedInputTokens != null`），使用该单快照值。
6. **Prompt Cache 过期时间 `promptCacheExpiresAtMs`**：
   - 优先解析 `liveTokenUsage?.promptCacheExpiresAt`（合法时间戳）。
   - 其次若 `liveTokenUsage?.promptCacheTtlMs > 0` 且 `liveTokenUsage.updatedAt` 合法，取 `Date.parse(updatedAt) + promptCacheTtlMs`。
   - 再次仅当 `lastTurnCacheHitRate !== null && lastTurnCacheHitRate > 0`（确认该 provider 真实使用缓存）且存在最新完成 turn 的 `completedAt` 或 `contextWindow?.updatedAt` 时，使用默认 5 分钟 TTL（`+ 300_000`）。否则保持 `null`（`promptCacheState = "unknown"`），绝不为无缓存 Provider 伪造倒计时。
7. **`lastTurnBreakdown`**：按顺序 `input`、`cachedInput`、`output`、`reasoning` 收集（优先 `contextWindow.last*Tokens` / `liveTokenUsage.*Tokens`），仅保留 `tokens > 0` 的非零项。

```ts
export type HudBillingMode = "cost" | "subscription" | "unknown";

export interface HudSessionMetrics {
  readonly tokensPerSecond: number | null;
  readonly ttftMs: number | null;
  readonly activeDurationMs: number | null;
  readonly wallClockSpanMs: number | null;
  readonly turnCount: number;
  readonly cost: { readonly amount: number; readonly currency: string } | null;
  readonly billingMode: HudBillingMode;
  readonly requestedModel: string | null;
  readonly servedModel: string | null;
  readonly modelDelta: { readonly from: string; readonly to: string } | null;
  readonly thinkingEffort: string | null;
  readonly interactionMode: string | null;
  readonly runtimeMode: string | null;
}

export function deriveHudSessionMetrics(input: {
  readonly contextWindow: ContextWindowSnapshot | null | undefined;
  readonly projection:
    | Pick<ThreadStructure, "thread" | "runs" | "providerTurns">
    | null
    | undefined;
  readonly requestedModel: string | null | undefined;
  readonly hasQuotaLimits: boolean;
  readonly nowMs: number;
}): HudSessionMetrics;
```

**Session KPIs 不编造约束：**

- `tokensPerSecond`：查找最新已完成且 `promptDropped !== true` 且 `startedAt`、`completedAt` 均存在且 `durationMs >= 100` 且 `outputTokens > 0` 的 turn（取 `turn.turnTokenUsage?.outputTokens ?? turn.tokenUsage?.outputTokens`）；若无则检查 `contextWindow.durationMs >= 100 && lastOutputTokens > 0`；否则 `null`。
- `ttftMs`：恒为 `null`（Phase 1 协议无 `firstTokenAt` 字段，绝不伪造）。
- `activeDurationMs`：累加所有已开始 `runs`（优先 `workStartedAt ?? startedAt`）的耗时（已完成用 `completedAt - start`，运行中用 `Math.max(0, nowMs - start)`）；若无 run 则回退 `contextWindow.durationMs`（若 `> 0`），否则 `null`。
- `wallClockSpanMs`：当存在至少一条已开始 run 时，取 `Math.max(0, endMs - earliestStartMs)`（运行中 `endMs = nowMs`，否则取最大 `completedAt`）；否则 `null`。
- `cost` & `billingMode`：当 `contextWindow?.cost` 有效且 `Number.isFinite(amount) && amount >= 0 && currency.trim().length > 0` 时 `billingMode = "cost"`；否则若 `hasQuotaLimits` 为 `true` 时 `billingMode = "subscription"`；否则 `billingMode = "unknown"`。
- `thinkingEffort`：安全从 `projection?.thread.modelSelection.options` 读取 `reasoningEffort` / `effort` / `thinkingLevel` 字符串（或 `thinking: true` → `"enabled"`），不猜测。

```ts
export type HudSubagentStatus = "running" | "waiting" | "completed" | "failed" | "cancelled";

export interface HudSubagentEntry {
  readonly id: string;
  readonly title: string;
  readonly status: HudSubagentStatus;
  readonly model: string | null;
  readonly childThreadId: ThreadId | null;
  readonly remoteChild: OrchestrationV2RemoteTaskChild | null;
  readonly durationMs: number | null;
}

export type HudToolStatus = "running" | "partial_failure" | "failed" | "completed";

export interface HudToolEntry {
  readonly name: string;
  readonly totalCount: number;
  readonly runningCount: number;
  readonly failedCount: number;
  readonly status: HudToolStatus;
}

export interface HudActivityMetrics {
  readonly subagents: readonly HudSubagentEntry[];
  readonly totalSubagentCount: number;
  readonly overflowSubagentCount: number;
  readonly tools: readonly HudToolEntry[];
  readonly totalToolCalls: number;
  readonly overflowToolCount: number;
  readonly isEmpty: boolean;
}

export function deriveHudActivityMetrics(input: {
  readonly projection: Pick<ThreadStructure, "subagents" | "turnItems"> | null | undefined;
  readonly nowMs: number;
  readonly maxSubagents?: number;
  readonly maxTools?: number;
}): HudActivityMetrics;
```

```ts
export type HudSystemCategoryKey = "provider" | "terminal" | "server" | "desktop" | "other";

export interface HudSystemCategorySummary {
  readonly key: HudSystemCategoryKey;
  readonly processCount: number;
  readonly cpuPercent: number;
  readonly rssBytes: number;
}

export interface HudSystemMetrics {
  readonly available: boolean;
  readonly cpuPercent: number | null;
  readonly rssBytes: number | null;
  readonly processCount: number | null;
  readonly healthStatus: ResourceTelemetrySourceStatus | null;
  readonly categories: readonly HudSystemCategorySummary[];
  readonly totalProcessedTokens: number | null;
}

export function deriveHudSystemMetrics(input: {
  readonly snapshot: ResourceTelemetrySnapshot | null | undefined;
  readonly contextWindow: ContextWindowSnapshot | null | undefined;
  readonly projection: Pick<ThreadStructure, "providerTurns"> | null | undefined;
}): HudSystemMetrics;

export function formatHudCompactDuration(ms: number): string;
```

## 3. UI 设计与语义色约束（Group 2 — `agy` 负责）

- **语义色 token（零裸 Tailwind 调色板，严格遵守 `shadcn/no-raw-colors`）**：
  - 4 桶上下文堆叠条：`systemBase` → `bg-guest`、`tools` → `bg-warning`、`assistant` → `bg-success`、`user` → `bg-info`（全部为 `apps/web/src/index.css` 声明的主题色 token，明/暗双主题自动适配且高对比度清晰可辨）。
  - 状态与警示：`normal` / `completed` / `warm` → `text-success-foreground` / `bg-success`；`warning` / `!200k+` / `partial_failure` / `waiting` → `text-warning-foreground` / `bg-warning`；`error` / `failed` → `text-error-foreground` / `bg-error`；`running` → `text-info-foreground` / `bg-info`；`idle` / `cold` / `—` → `text-muted-foreground` / `bg-muted`。
- **禁止原生 `title` 属性**（`t3code/no-native-title-tooltip`）：所有提示统一使用 `Tooltip` / `TooltipTrigger` / `TooltipPopup` 或 `aria-label`。
- **禁止 restyle `components/ui` 导出的原语**（`shadcn/no-restyle`）：Popover / Switch / Button 等原语保持默认规范样式。
- **React Compiler 兼容**：零手动 `useMemo`/`useCallback`/`"use memo"`，不在 `try` 中 `throw` 或使用 `try/finally`。
- **性能与渲染隔离**：
  - `ThreadHudHeader` 与 `ThreadHudSections` 仅订阅 `useQuietThreadProjection(threadRef)`、`useQuietThreadShell(threadRef)`、`useThreadStatus(threadRef)`、`useThreadError(threadRef)`，绝不订阅 `useThreadProjection`。
  - `HudPromptCacheCountdown` 仅在 `expiresAtMs !== null && expiresAtMs > Date.now()` 时挂载内部订阅 `secondTick` 的子组件；一旦变冷即卸载订阅，零空闲计时器。
  - `HudSystemCard` 仅在 `(inlineOpen || popoverOpen) && options.showSystem` 时挂载调用 `useResourceTelemetry(environmentId)` 的子组件；关闭面板或关闭开关立即退订。
- **零单行道与无破坏性兼容**：
  - `ThreadDetailsCard.tsx` 在 `querySelectorAll` 豁免列表追加 `[data-thread-hud-panel]`。
  - `ThreadDetailsPanel.tsx` 在 HUD Context/Quota 启用且可见时抑制旧版 `<ThreadDetailsContext>` / `<ThreadDetailsUsage>` 避免重复渲染；用户关闭 HUD 对应开关后自动恢复上游行为。
  - `ThreadDetailsPanel.tsx` 与 `ThreadHudSections.tsx` 对 `props.usage` 做空值安全防御（兼容 `usage={{} as never}` 的现有单测）。

## 4. 验证策略

1. **Group 1 单元测试 (`hudMetrics.logic.test.ts`)**：覆盖存储读写与损坏降级、单模型缓存隔离、压缩后 4 桶切片与精确求和、不编造 `—` 边界、子 Agent 与工具失败聚合、系统进程分类汇总、格式化函数。
2. **Group 2 浏览器测试 (`hudUi.browser.test.tsx`)**：真实 Chromium 下验证 B1 状态头与 `🎛` 开关持久化/重置、B3 上下文 4 桶 `≈` + `!200k+` + 缓存倒计时 + `/compact` 触发与禁用 Tooltip、B4 Session `—` 不编造与模型漂移、B5 Quota 直接可见倒计时与自动隐藏、B6 Activity 子 Agent 点击跳转与工具失败态及空态自动隐藏、B7 System 默认折叠/展开与关闭即退订 `useResourceTelemetry`。同时复跑上游 `ThreadDetailsPanel.browser.test.tsx`、`ThreadDetailsCard.browser.test.tsx`、`ThreadDetailsUsage.logic.test.ts` 与 `reactCompilerCoverage.test.ts`。
3. **独立 Live Visual QA**：在 worktree 内用 `vp run dev --no-seed`（绝不触碰 `~/.t3/userdata`）配合免费 `Replay (dev)` Provider 走完真实对话并截图检查亮/暗双模式视觉层次与交互细节。
4. **Group 3 交叉评审 + `Broken by hand` + 强门禁**：`omp` 只读执行 `openspec-verify-change thread-hud-panel`；手动制造单测回归证伪后再恢复；运行 `vp run check:changed origin/lmx-lab`、`vp test run packages/shared/src/forkIdentity.guard.test.ts`、`vp run i18n:check`。
