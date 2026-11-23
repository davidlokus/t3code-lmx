# 变更提案：T3 Lab 右侧 Thread HUD 实时仪表盘（PR 2 / Module B）

## 背景与目标

当前 T3 Code 的右侧 `ThreadDetailsPanel` 只承载零散的工作区操作与默认关闭的简易用量条，高频并发驱动多个 Coding Agent 时存在明显可观测性短板：

1. **上下文缺乏透视与可控动作**：只有单色总量条，看不到系统/压缩底座、工具交互、助手回复与用户消息的占比，也没有 Prompt Cache 命中率、5 分钟缓存暖/冷倒计时与原地 `/compact` 触发入口。
2. **会话指标缺失**：缺少实时吞吐（`tok/s`）、活跃耗时 vs 总跨度、真实费用/订阅制归属、实际服务模型漂移（`requested → served`）与思考强度/执行模式汇总。
3. **配额倒计时被隐藏**：上游 `ThreadDetailsUsage` 将窗口重置倒计时藏在 tooltip 中，高频多会话切换时无法一眼扫读各配额窗口的剩余量与重置时间。
4. **运行活动与宿主机负载分散**：子 Agent 跳转与工具调用失败态缺乏统一紧凑视图；T3 进程资源遥测（CPU / RSS 内存 / 进程分类）深埋在 Settings 页面中，且不能在对话侧栏内按需折叠查看。

本变更（PR 2）在不改动任何后端、协议或 SQLite 结构的前提下，将右侧 `ThreadDetailsPanel` 升级为高密、克制、诚实（遵循 `xx-hud` 不编造指标原则）的 **T3 Lab HUD 实时仪表盘**，全部新代码隔离在 `apps/web/src/fork/hud/`，仅通过极简 `// fork:` 挂钩接入上游 `ThreadDetailsPanel.tsx`、`ThreadDetailsCard.tsx` 与 `ChatView.tsx`。

## 范围（In Scope — Phase 1 Web Only）

- **B1 线程状态头 & HUD 选项开关 (`🎛`)**：展示线程状态徽标、当前 Provider/模型（含模型漂移提示）及 `🎛` HUD 自定义 Popover，独立开关 5 张 HUD 卡片（Context / Session / Quota / Activity / System）并持久化于 `localStorage["t3lab:hud-ui:v1"]`，提供一键重置默认。
- **B2 紧凑工作区/Git 感知兼容**：完整保留上游 `Workspace` / `Version Control` / `PR` / `Initialize Git` / `Servers` / `Automations` / `Lineage` 能力与现有测试行为；在 `ThreadDetailsCard` 高度测量豁免选择器中加入 `[data-thread-hud-panel]`，确保 HUD 卡片滚动展开时不会误触发上游密度降级（collapsed to `essential`）。
- **B3 上下文透视卡片 (Context Lens)**：
  - 色彩分级占比（`<65%` 正常、`65–85%` 警告、`≥85%` 危险）与 `≥200k` 琥珀警示标签 `!200k+`。
  - 4 段堆叠条（均采用 `apps/web/src/index.css` 声明的语义色 token）+ 自动压缩阈值刻度线。
  - 明确标注 `≈` 的 4 桶字符权重估算分解（`系统底座`/`压缩底座`、`工具交互`、`助手回复`、`用户消息`），按当前活跃 Provider Thread 及最近一次完成压缩之后的内容切片计算。
  - **单模型隔离**的 Prompt Cache 命中率（`末轮 / 累计`），不跨模型污染。
  - **独立自刷新叶子组件**驱动的 Prompt Cache 暖/冷倒计时（仅在暖态订阅 `@t3tools/client-runtime/clock` 的 `secondTick`，冷态立即停止计时，零父组件重渲染）。
  - 仅展示非零项的末轮 Token 明细。
  - 原地 `/compact` 压缩按钮，直接复用 `ChatView.tsx` 现有 `onCompactContext` / `compactDisabled` 链路（禁用时通过 `<Tooltip>` 说明原因，零新 RPC）。
- **B4 会话 KPI 2×2 卡片 (Session KPIs)**：严格遵守不编造铁律：
  - 速度 & TTFT：仅基于真实已完成轮次输出 Token 与真实耗时计算 `tok/s`，无数据时诚实显示 `—`；Phase 1 协议无首 Token 时间戳，`TTFT` 诚实显示 `—`。
  - 耗时：活跃执行时长 + 会话总跨度 + 轮次数。
  - 费用 / 计费归属：有真实 `contextWindow.cost` 时展示货币金额；否则若存在订阅配额窗口显示“订阅制”，无信息时显示 `—`，绝不伪造 `$0.00`。
  - 模型与模式：展示实际服务模型（若与请求模型不同，展示 `requested → served` 漂移）及思考强度/交互模式。
- **B5 配额窗口卡片 (Quota Limits)**：直接复用上游 `resolveThreadDetailsLimits` 读缓存（零额外轮询），展示所有配额窗口的剩余 `%`、**直接可见的重置倒计时**及节奏刻度线，点击跳转 `/usage`；无配额窗口时整卡自动隐藏。当 HUD Quota/Context 开启时抑制旧版重复的 `ThreadDetailsUsage` / `ThreadDetailsContext`，关闭时保留上游项回退路径（零单行道）。
- **B6 运行活动卡片 (Activity)**：汇总子 Agent 列表（支持点击跳转到子线程/关联线程）与 Top 8 工具调用胶囊（区分运行中、部分失败、全部失败、完成态）；无子 Agent 且无工具调用时整卡自动隐藏。
- **B7 可折叠系统遥测卡片 (System)**：默认折叠，1 行摘要展示真实 T3 进程 CPU%、T3 RSS 内存占用与进程数（绝不伪造宿主机总内存）；点击展开查看进程分类汇总、当前线程本地探测端口快捷跳转及 `Σ totalProcessedTokens`。**严格可见性门控**：仅在右侧栏实际打开（`inlineOpen || popoverOpen`）且 `showSystem === true` 时挂载 `useResourceTelemetry(environmentId)`，关闭即退订。
- **零流式重渲染约束**：HUD 结构指标统一读取 `useQuietThreadProjection(threadRef)`（`ThreadStructure`），绝不订阅流式 `useThreadProjection`。
- **i18n 全量覆盖**：所有新增用户可见文案使用 `gt-react`，生成并翻译 `apps/web/src/i18n/translations/*.json` 全部 10 个语言包，通过 `vp run i18n:check`。

## 明确排除（Out of Scope）

- **Phase 2 服务端/驱动改造**：不在本 PR 修改 `apps/server`、`packages/contracts`、`packages/client-runtime`、`packages/provider-omp` 或 SQLite 迁移（包括原生 6 桶 `contextBreakdown` 上报与 `/usage` 日累计汇总 API）。
- **Mobile 与 Desktop 主进程**：本 PR 不改动 `apps/mobile`、`apps/desktop`、`packages/shared/src/forkIdentity.ts` 或打包配置。
- **额外网络请求**：绝不新增配额轮询或模型定价表硬编码。

## 上游冲突面（Upstream Conflict Footprint）

| 文件路径                                              | 改动性质                                                                                                                   | 预期行数        | 冲突风险       |
| ----------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- | --------------- | -------------- |
| `apps/web/src/fork/hud/*`                             | Fork 新增纯逻辑、Store、UI 组件与测试                                                                                      | ~1,400          | 无（完全隔离） |
| `apps/web/src/components/chat/ThreadDetailsCard.tsx`  | 测量豁免选择器追加 `[data-thread-hud-panel]` (`// fork:`)                                                                  | ~3 行           | 极低           |
| `apps/web/src/components/chat/ThreadDetailsPanel.tsx` | 接收可选 `compactContext` prop，挂载 `<ThreadHudHeader>` 与 `<ThreadHudSections>`，抑制重复旧版 Usage/Context (`// fork:`) | ~35 行          | 低             |
| `apps/web/src/components/ChatView.tsx`                | 向 `<ThreadDetailsPanel>` 传入 `compactContext` (`// fork:`)                                                               | ~8 行           | 极低           |
| `apps/web/src/i18n/translations/*.json`               | 10 个语言包新增 HUD 翻译键                                                                                                 | 自动生成 + 翻译 | 低             |

## 多端表面评估（Multi-Surface Matrix）

- **Web（本地 `t3` & 远端浏览器）**：适用，全部 HUD 卡片在 inline 浮动卡片与窄屏 Popover 模式均可用。
- **Desktop（Electron 渲染进程）**：自动继承 `apps/web` 变更，无主进程/IPC 改动。
- **Mobile（React Native）**：不适用（Phase 1 仅 Web/Desktop；右侧面板仅桌面/宽屏存在）。
- **Providers**：全 Provider 通用，缺失字段（如 Replay/API Key 无配额、无费用、无缓存 TTL）遵循自动隐藏或 `—` 诚实降级。
- **Contracts / Server / Agents**：无协议/服务端变更，原地 `/compact` 复用现有 `sendStandaloneCommand("/compact")`。
- **Reverse States**：每张 HUD 卡片可在 `🎛` Popover 随时关闭与重新打开，支持一键重置默认；关闭 HUD Quota/Context 后可退回上游右键菜单显示项。
- **Connection Modes**：本地、远端与 Tunnel 均通过现有 `useQuietThreadProjection`、`useResourceTelemetry(environmentId)`、`useThreadDiscoveredPorts` 工作，权限不足或断开时优雅降级。

## 关键假设

1. `ThreadDetailsPanel.browser.test.tsx` 在 280×400 视口内传入 `usage={{} as never}`，HUD 组件必须对缺失字段做安全空值防御，且不破坏现有 `Workspace` / `#27513` / `Initialize Git` 断言。
2. `useResourceTelemetry(environmentId)` 仅返回 T3 进程树遥测（`groups.allT3.currentCpuPercent`、`currentRssBytes`、`processCount`、`processes`），不含宿主机物理总内存，故 System 卡片仅展示真实观测值，不估算或虚构宿主机总内存。
