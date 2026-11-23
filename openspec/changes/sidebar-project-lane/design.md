# Design: `sidebar-project-lane`（跨 Agent 契约与低冲突架构）

## Context

参见 `proposal.md` 与 `prd.md §4 / §6`。本设计文档同时作为 **Data & Logic（Owner: `omp`）** 与 **UI Components & Upstream Wiring（Owner: `agy`）** 之间的精确 TypeScript 接口契约，保证双方零歧义交接、零文件冲突。

## Goals / Non-Goals

- **Goals**
  - 所有新逻辑与新组件集中在 `apps/web/src/fork/sidebar/`，纯逻辑零 React 依赖、可毫秒级单测。
  - 上游文件（`SidebarChrome.tsx`、`SidebarProjectFolderHeader.tsx`、`Sidebar.tsx`、`SidebarThreadRow.tsx`）仅留最小 `// fork:` 接线，保留全部上游现有功能（拖拽排序、搜索、草稿、唤醒、延后、右键菜单、快捷键 `Mod+1..9`、`Sidebar.browser.test.tsx` 与 `Sidebar.drag.browser.test.tsx`）。
  - 遵循 React Compiler（禁止手动 `useMemo` / `useCallback` / `"use memo"`）、`shadcn/no-restyle`、`t3code/no-untranslated-copy`，且不破坏 `Sidebar.browser.test.tsx` 的渲染隔离断言（快捷 `Mod` 键不触发 `SortableThreadRow` 重渲染）。
- **Non-Goals**
  - 不改 `packages/contracts`、`apps/server`、`apps/mobile`。
  - 不实现右侧栏 HUD（留给 PR 2 `thread-hud-panel`）。

## Decisions

### 1. 模块边界与精确 TypeScript 契约（`omp` 负责实现，`agy` 直接消费）

#### 1.1 `apps/web/src/fork/sidebar/sidebarOptionsStore.ts`

使用 `zustand` 的 `create`（与 `apps/web/src/uiStateStore.ts` 一致），提供安全 `localStorage` 持久化：

```ts
export const SIDEBAR_OPTIONS_STORAGE_KEY = "t3lab:sidebar-ui:v1";

export type SidebarGroupBy = "project" | "status";

export type SidebarDisplayBooleanOptionKey =
  | "compactSingleLine"
  | "dimWhenRead"
  | "showBranch"
  | "showModel"
  | "showModeBadge";

export interface PersistedSidebarUiOptions {
  readonly groupBy: SidebarGroupBy;
  readonly compactSingleLine: boolean;
  readonly dimWhenRead: boolean;
  readonly showBranch: boolean;
  readonly showModel: boolean;
  readonly showModeBadge: boolean;
}

export interface SidebarUiOptions extends PersistedSidebarUiOptions {
  readonly activityOnly: boolean;
}

export const DEFAULT_SIDEBAR_UI_OPTIONS: SidebarUiOptions = {
  groupBy: "project",
  compactSingleLine: false,
  dimWhenRead: true,
  showBranch: true,
  showModel: true,
  showModeBadge: true,
  activityOnly: false,
};

export function parseSidebarUiOptions(raw: unknown): PersistedSidebarUiOptions;
export function readPersistedSidebarUiOptions(storage?: Pick<Storage, "getItem"> | null): PersistedSidebarUiOptions;
export function writePersistedSidebarUiOptions(
  options: PersistedSidebarUiOptions,
  storage?: Pick<Storage, "setItem"> | null,
): void;

export interface SidebarOptionsStoreState extends SidebarUiOptions {
  setGroupBy: (groupBy: SidebarGroupBy) => void;
  toggleOption: (key: SidebarDisplayBooleanOptionKey) => void;
  setOption: (key: SidebarDisplayBooleanOptionKey, value: boolean) => void;
  toggleActivityOnly: () => void;
  setActivityOnly: (value: boolean) => void;
  resetSidebarOptions: () => void;
}

export const useSidebarOptionsStore: UseBoundStore<StoreApi<SidebarOptionsStoreState>>;
```

约束：

- `activityOnly` 为会话内瞬态过滤态，不写入 `localStorage`，重载始终为 `false`。
- `localStorage` 读写必须兼容无 `window` 环境及 `SecurityError`/`QuotaExceededError`（try/catch 静默回退默认值）。
- 禁止使用 `any`；严格按 `typeof` / 属性守卫解析 `unknown`。

#### 1.2 `apps/web/src/fork/sidebar/sidebarPresentation.logic.ts`

纯函数模块（**禁止导入 React 或 DOM API**），导出以下全部类型与函数：

```ts
import type {
  EnvironmentMachineKind,
  ProviderDriverKind,
  ProviderInteractionMode,
  RuntimeMode,
} from "@t3tools/contracts";
import type { SidebarThreadStatus } from "../../components/Sidebar.logic";
import type { EnvironmentPresence } from "../../sidebarProjectGrouping";

export interface ProjectHostInput {
  readonly projectKey: string;
  readonly displayName: string;
  readonly environmentId: string;
  readonly environmentPresence: EnvironmentPresence;
  readonly memberEnvironmentIds: readonly string[];
  readonly environmentLabel: string | null;
  readonly remoteEnvironmentLabels: readonly string[];
  readonly machineKind: EnvironmentMachineKind;
}

export interface ProjectHeaderHostContext {
  readonly label: string;
  readonly machineKind: EnvironmentMachineKind;
  readonly reason: "collision" | "remote-only";
}

export function formatCompactHostLabel(label: string | null | undefined): string | null;

export function resolveProjectHeaderHostContextMap(input: {
  readonly groups: ReadonlyArray<ProjectHostInput>;
  readonly primaryEnvironmentId: string | null;
  readonly connectedEnvironmentCount: number;
}): ReadonlyMap<string, ProjectHeaderHostContext>;

export function resolveThreadRowEnvironmentLabel(input: {
  readonly view: "project-folder" | "status-card" | "search";
  readonly environmentId: string;
  readonly environmentLabel: string | null;
  readonly primaryEnvironmentId: string | null;
  readonly hasMultipleEnvironments: boolean;
  readonly folderEnvironmentPresence: EnvironmentPresence | null;
}): string | null;

export type StatusLaneKind =
  | "working"
  | "failed"
  | "approval"
  | "input"
  | "request"
  | "woke"
  | "unread-done"
  | "draft"
  | "none";

export function resolveStatusLaneKind(input: {
  readonly status: SidebarThreadStatus;
  readonly isUnread: boolean;
  readonly isWoke: boolean;
  readonly hasUnsentDraft: boolean;
}): StatusLaneKind;

export function shouldDimReadTitle(input: {
  readonly dimWhenRead: boolean;
  readonly status: SidebarThreadStatus;
  readonly isUnread: boolean;
  readonly isWoke: boolean;
  readonly isActive: boolean;
  readonly isSelected: boolean;
}): boolean;

export function isAttentionThread(input: {
  readonly status: SidebarThreadStatus;
  readonly isUnread: boolean;
  readonly isWoke: boolean;
}): boolean;

export type RightSignalPresentation =
  | {
      readonly kind: "loud-pill";
      readonly tone: "approval" | "input" | "request" | "failed" | "limited";
    }
  | { readonly kind: "working-duration" }
  | { readonly kind: "woke" }
  | { readonly kind: "quiet-time"; readonly emphasized: boolean };

export function resolveRightSignalPresentation(input: {
  readonly status: SidebarThreadStatus;
  readonly isUnread: boolean;
  readonly isWoke: boolean;
}): RightSignalPresentation;

export type SidebarModeBadgeKind = "plan" | "full";

export function resolveSidebarModeBadges(input: {
  readonly showModeBadge: boolean;
  readonly interactionMode: ProviderInteractionMode;
  readonly runtimeMode: RuntimeMode;
}): ReadonlyArray<SidebarModeBadgeKind>;

export function formatCompactModelName(rawModel: string | null | undefined): string | null;

export interface FallbackProviderVisual {
  readonly inferredDriverKind: ProviderDriverKind | null;
  readonly fallbackInitials: string;
  readonly displayName: string;
}

export function resolveFallbackProviderVisual(input: {
  readonly instanceId: string;
  readonly runtimeProviderName: string | null | undefined;
  readonly knownDriverKinds: ReadonlySet<string>;
}): FallbackProviderVisual;

export function shouldRenderSecondMetaRow(input: {
  readonly compactSingleLine: boolean;
  readonly showBranch: boolean;
  readonly branch: string | null;
  readonly showModeBadge: boolean;
  readonly modeBadgesCount: number;
  readonly showModel: boolean;
  readonly modelLabel: string | null;
  readonly environmentLabel: string | null;
  readonly hasPr: boolean;
  readonly hasIssue: boolean;
  readonly hasDiff: boolean;
  readonly runningTerminalCount: number;
}): boolean;

export type CollapseAllAction = "collapse-all" | "expand-all" | null;

export function resolveCollapseAllAction(
  folders: ReadonlyArray<{ readonly collapsed: boolean }>,
): CollapseAllAction;
```

核心算法约定：

1. **`formatCompactHostLabel`**：trim 后去掉结尾重复编号后缀如 ` (2)`（仅正则 `/\s+\(\d+\)$/`），空串返回 `null`。
2. **`resolveProjectHeaderHostContextMap`**：
   - 统计所有 `groups` 覆盖的去重 `environmentId` 集合，当 `distinctEnvs.size <= 1 && connectedEnvironmentCount <= 1` 时判定为单机环境，返回空 Map。
   - 多机环境下，按 `displayName.trim().toLowerCase()` 聚合各 group 所属的去重 `environmentId`；若同一名称跨越 `> 1` 个环境，则所有同名 group 均写入 `reason: "collision"`（label 取该 group 首个非空 `environmentLabel` 或 `remoteEnvironmentLabels[0]`，经 `formatCompactHostLabel` 精简）。
   - 未碰撞但 `environmentPresence === "remote-only"` 的 group，写入 `reason: "remote-only"`（label 取 `remoteEnvironmentLabels[0] ?? environmentLabel`）。
3. **`resolveThreadRowEnvironmentLabel`**：
   - `!hasMultipleEnvironments` → `null`。
   - `view === "project-folder"` 且 `folderEnvironmentPresence !== "mixed"` → `null`（避免和项目头重复）。
   - 其余情况（`status-card`、`search`、`mixed` 合并项目）仅在 `environmentId !== primaryEnvironmentId` 时返回 `formatCompactHostLabel(environmentLabel)`；主环境返回 `null`。
4. **`formatCompactModelName`**：
   - 空值、空白、或 `"default"`（大小写不敏感）返回 `null`（绝不编造）。
   - 去掉开头 provider 命名空间（取最后一个 `/` 后段，如 `openai-codex/gpt-5.4` → `gpt-5.4`）。
   - 去掉末尾 8 位日期戳（如 `-20250929` / `@20250929`）和 `:latest`。
   - Claude 家族缩写：`claude-opus-4-6` / `claude-4-6-opus` → `opus-4.6`，`claude-sonnet-4-5` → `sonnet-4.5`，`claude-haiku-4-5` → `haiku-4.5`（将 `major-minor` 规范为 `major.minor`）。
   - 其他模型名保持精简原貌（如 `glm-5.4`、`k3.1-pro`、`gpt-6.2-sol`）。
5. **`resolveFallbackProviderVisual`**：
   - 别名映射（大小写不敏感匹配 `runtimeProviderName` 与 `instanceId` 首段 `split(/[-_:\s]+/)[0]`）：
     - `claude` / `claude-code` / `claudeagent` → `"claudeAgent"`
     - `codex` / `openai-codex` → `"codex"`
     - `omp` / `oh-my-pi` → `"omp"`
     - `pi` → `"pi"`
     - `cursor` / `cursor-agent` → `"cursor"`
     - `opencode` → `"opencode"`
     - `antigravity` / `agy` → `"antigravity"`
     - `kiro` → `"kiro"`
     - `grok` → `"grok"`
     - `muse` → `"muse"`
     - `fx` → `"fx"`
   - 仅当推断出的 driver 存在于 `knownDriverKinds` 中时返回 `inferredDriverKind: ProviderDriverKind.make(matched)`，否则 `null`。
   - `fallbackInitials` 始终为 1–2 个大写字母/数字（如 `"OM"` / `"?"`），绝不为空串。

### 2. UI 接线与渲染性能隔离（`agy` 负责实现）

- **避免破坏现有 `Sidebar.browser.test.tsx` 渲染隔离**：
  - `SidebarThreadRow` 内部直接通过细粒度 selector 读取 `useSidebarOptionsStore`（或接收原始布尔/字符串 prop，绝不传入每次 render 新建的匿名对象），保证 `memo(SidebarThreadRow)` 稳定。
  - 保留 `data-testid="sidebar-project-folder"`、`data-testid="sidebar-row-folder"`、`data-testid="sidebar-row-card"`、`data-testid="sidebar-row-slim"`、`data-sidebar-row` 等现有测试钩子。
- **与 `boringSidebarEnabled` 兼容**：
  - `Sidebar.tsx` 读取 `sidebarOptionsStore.groupBy`（默认 `"project"`）；但为了不破坏 `Sidebar.browser.test.tsx` 中通过 `__setClientSettingsForTests({ boringSidebarEnabled: false })` 测 `normal` 模式的显式场景，且允许用户在 `🎛` 菜单一键在 `按项目` / `按状态` 间切换，我们在 `Sidebar.tsx` 中将 `useProjectFolders = sidebarGroupBy === "project"`，并确认 `Sidebar.browser.test.tsx` 全部用例（含 `new thread`、`numbered jumps`、`render isolation`、`rename`、`click`、`menu`、`settled pagination`）全部通过。
- **遵循 `docs/internals/10_web-ui.md`**：
  - 弹出菜单使用 `Popover` / `PopoverTrigger` / `PopoverPopup` + `Switch` + `Button`（不 restyle `components/ui` 控件，布局类放父容器）。
  - 动画克制：仅 `working` 状态的细环使用 `animate-spin motion-reduce:animate-none`（非静默态无常驻重绘动画）。
  - 所有可见文案走 `gt-react`（`<T>` / `useGT()`），完成后在 `apps/web` 执行 `vp run i18n:generate` 并手工补全所有语言翻译目录（含 `zh-CN` 等），确保 `vp run i18n:check` 0 报错。

## Risks / Trade-offs

- **现有浏览器测试兼容风险** → `Sidebar.browser.test.tsx` 对默认布局、`SortableThreadRow` 重渲染次数和 `New thread` 按钮有强断言；落地后必跑 `Sidebar.browser.test.tsx`、`Sidebar.drag.browser.test.tsx`、`Sidebar.logic.test.ts` 与 `reactCompilerCoverage.test.ts`。
- **i18n 词条覆盖全语言风险** → 运行 `vp run i18n:generate` 后检查 `apps/web/src/i18n/translations/*.json`，确保所有新增 key 在每个语言文件均有恰当翻译且 `vp run i18n:check` 通过。
- **上游同步合并风险** → 所有新增逻辑与组件收口到 `apps/web/src/fork/sidebar/`，上游 4 个文件仅加最小 `// fork:` 钩子。
