# Proposal: T3 Lab (Extend) 左侧栏信息架构与项目导航雷达升级

## Why

当前 `T3 Lab (Extend)` 左侧栏存在明显信噪比问题：单机环境下每条对话行反复刷屏设备名（如 `MacBook Pro (2)`），而 Git 分支/Worktree、模型简称、Plan/Full 模式与未读/审批信号藏在悬停 Tooltip 或缺乏垂直对齐锚点；同时顶部品牌字标仍硬编码 `T3 Code`，历史已删除 Provider 实例（如旧 `omp_omp_3`）在行内会图标留白。本变更（PR 1）将左侧栏重构为轻盈的项目导航雷达，同时保持 Phase 1 零后端/零契约改动和低冲突二开边界。

## What Changes

- **品牌与图标兜底**：`SidebarChrome` 品牌字标从硬编码 `"Code"` 改为读取 `forkIdentity` 显示 `T3 Lab`（保留无障碍标签）；已删除 Provider 实例不再返回空占位，回退按 `runtime.providerName` / `instanceId` 推断驱动图标或中性首字母占位标。
- **纯项目聚合与 Orca 跨机消歧**：默认按项目（文件夹）聚合，单机环境下彻底隐藏项目头与行内设备名；多机环境下仅在同名项目碰撞或纯远程项目头展示紧凑 Host 标签，行内仅在状态视图或跨机合并项目且非主环境时展示轻胶囊。
- **左侧 18px 固定状态车道 + 已读标题降噪**：按严格优先级呈现工作旋转环、失败 `⊗`、审批/输入/请求圆点、未读完成圆点、唤醒标、草稿笔标，其余安静已读留白；默认开启 `dimWhenRead` 降低安静已读行标题对比度。
- **右侧信号分级与第二行智能槽位**：审批/输入/请求/失败/限流显示紧凑彩色胶囊，运行中显示等宽计时，静默行右对齐定宽相对时间（悬停平滑切换延后/收尾）；第二行左侧按需展示分支/Worktree（含错分支告警）、Plan/Full 模式角标、PR/Issue/终端徽标，右侧展示前任交接灰阶标 + 当前 Agent 图标 + 精简模型简称；支持紧凑单行与无内容时自动折叠为单行。
- **顶部极简控制收口与本地偏好**：项目区顶部增加全部折叠/展开（多于 1 个项目时）、`🔔` 活跃/待处理过滤（带角标）、`🎛` 显示选项弹出菜单；偏好持久化到 `localStorage`（key `t3lab:sidebar-ui:v1`）。

## Assumptions

- 默认分组方式为按项目（`groupBy: "project"`），可在 `🎛` 菜单一键切回按状态（`status`）；现有上游浏览器测试（`Sidebar.browser.test.tsx`、`Sidebar.drag.browser.test.tsx`）保持全部通过。
- `activityOnly`（`🔔` 只看活跃/待处理）作为当前会话瞬态过滤，不跨刷新持久化，避免重启后用户误以为普通对话消失。
- 模型名为 `"default"` 哨兵或缺失时，按「不编造」原则隐藏模型简称，仅显示 Agent 图标。
- 本 PR 仅覆盖 Phase 1 左侧栏（模块 A），不改 `packages/contracts`、`apps/server`、`apps/mobile` 或右侧栏 HUD（PR 2）。

## Out of Scope

- 右侧栏 `T3 Lab HUD` 6 大卡片（PR 2 `thread-hud-panel`）。
- 服务端接口、`packages/contracts` 契约修改、SQLite migration 及 Phase 2 `provider-omp` 原生 6 桶透传。
- 移动端 `apps/mobile` 原生侧栏改造。

## Capabilities

### New Capabilities

- `fork-sidebar-navigation`: T3 Lab (Extend) 左侧栏项目聚合导航、跨机 Host 消歧、固定状态车道、行内元数据槽位、已删除 Provider 图标兜底与本地显示偏好管理。

### Modified Capabilities

## 上游同步冲突面

- **新增独立文件（0 合并冲突）**：
  - `apps/web/src/fork/sidebar/sidebarOptionsStore.ts`
  - `apps/web/src/fork/sidebar/sidebarPresentation.logic.ts`
  - `apps/web/src/fork/sidebar/sidebarPresentation.logic.test.ts`
  - `apps/web/src/fork/sidebar/SidebarStatusLane.tsx`
  - `apps/web/src/fork/sidebar/SidebarOptionsPopover.tsx`
- **上游文件最小 `// fork:` 钩子**：
  - `apps/web/src/components/sidebar/SidebarChrome.tsx`（品牌字标改读 `forkIdentity`）
  - `apps/web/src/components/sidebar/SidebarProjectFolderHeader.tsx`（可选展示 `hostContext` 紧凑标签）
  - `apps/web/src/components/Sidebar.tsx`（接入 `sidebarOptionsStore`、Host 消歧、顶部控件条、`🔔` 活跃过滤与全部折叠）
  - `apps/web/src/components/sidebar/SidebarThreadRow.tsx`（接入状态车道、已读降噪、右侧信号分级、第二行槽位/单行折叠、已删实例图标兜底）
  - `apps/web/src/i18n/translations/*.json`（`vp run i18n:generate` + 全语言翻译）
  - `FORK.md`（登记分叉改动台账）

## Surface Matrix

| Surface   | Status | Notes                                                             |
| --------- | ------ | ----------------------------------------------------------------- |
| Web       | Yes    | 核心变更落在 `apps/web/src/fork/sidebar/` 与 4 个侧栏组件最小钩子 |
| Desktop   | Yes    | Electron 壳复用 `apps/web`，自动生效（含标题栏字标 `T3 Lab`）     |
| Mobile    | N/A    | 本 PR 不改动 `apps/mobile` 原生导航，将在 PR `Not tried` 明示     |
| Server    | N/A    | Phase 1 零服务端改动                                              |
| Contracts | N/A    | Phase 1 零契约改动，偏好存设备本地 `localStorage`                 |
| Providers | Yes    | 历史已删除自定义 Provider 实例（含旧 `omp_*`）在侧栏提供图标兜底  |
| i18n      | Yes    | 所有新增 UI 文案用 `gt-react` 包裹并补全全部 locale 翻译          |

## Impact

- 影响范围收敛在 `apps/web` 与 `FORK.md`，不改变 RPC 协议与数据持久化表结构。
- 严格遵循 React Compiler（禁手动 `useMemo`/`useCallback`）、`shadcn/no-restyle` 与 `t3code/no-untranslated-copy`，且行级订阅隔离确保流式输出不触发整个侧栏重渲染。
