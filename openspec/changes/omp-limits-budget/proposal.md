# Proposal: omp 生态级接入 Wave 2a — 额度、HUD 子后端映射与费用/时长护栏

- **Epic Charter**: [openspec/epics/omp-ecosystem.md](../../epics/omp-ecosystem.md)（Wave 2a：`feat/omp-limits-budget`）
- **Tier**: L2 Full Spec（强用户感知设置、RPC 通知协议翻译、`/usage` 多 Profile 配额自动接入、HUD 子后端配额过滤与 10 语言 i18n）
- **Exclusive File Ownership Fence（与并行 Wave 2b `feat/omp-session-import` 零业务文件冲突）**：
  - `packages/provider-omp/src/settings.ts`
  - `packages/provider-omp/src/server.ts`（仅导出 `isValidOmpProfileName` / `resolveOmpInstancePaths`）
  - `packages/provider-omp/src/server/{dialect,protocol}*.ts`
  - `apps/server/src/usage/{UsageLimitSources,sources/omp}*.ts`
  - `apps/web/src/fork/hud/{hudMetrics.logic,ThreadHudSections,hudUi.browser}*.{ts,tsx}`
  - `apps/web/src/components/settings/ProviderSettingsForm*.{ts,tsx}`
  - `apps/web/src/i18n/translations/*.json`（Wave 2 独占 i18n 写者）
  - `docs/user/providers-omp.md`

## Why

Wave 1（PR #25）完成了 `omp` 路径事实源、核心设置与 Text Generation 底座，但仍存在三项核心生态断层：

1. **费用与时长护栏缺失**：`omp v19.2.1` 原生支持 `--warn-cost`、`--max-cost` 与 `--max-time`，并在 RPC 模式下推送 `notice` 与 `prompt_result(code:"cost_cap")` 帧，但 T3 设置页既无一等配置入口，`protocol.ts` 又会静默丢弃 `prompt_result` 且未把 `notice` 转为通知，导致触顶/预警在界面无感。
2. **多 Profile 配额割裂与手动门槛**：`apps/server/src/usage/sources/omp.ts` 的 `resolveOmpDbPath()` 尚未复用 Wave 1 的 `paths.ts` / Profile 规则，且启用 `omp` 实例后用户仍须手动在 Usage Limit Sources 中逐一添加 `agent.db`，多 Profile 场景下体验割裂。
3. **`omp` 线程 HUD 配额卡（B5）空白**：`omp` 是多后端路由 Provider（同一实例可跑 `openai-codex/*`、`anthropic/*`、`google-antigravity/*`、`zai/*` 等模型），当前线程 HUD 仅读取实例自身的 `ServerProvider.usageLimits`，导致 `omp` 线程右侧 HUD 始终无法按当前活动模型展示对应子后端额度。

## What Changes

- **一等费用与时长护栏（`OmpSettings` + `dialect.ts` + `protocol.ts` + 10 语言设置页）**：
  - `OmpSettings` 新增 3 个向后兼容、空值省略字段：`warnCostUsd`（`--warn-cost`）、`maxCostUsd`（`--max-cost`）、`maxTime`（`--max-time`）。
  - `dialect.ts` 严格校验正数美元金额与 `omp v19.2.1` 时长语法（正数秒或 `^(\d+(?:\.\d+)?)([smh])$`），拦截与 `launchArgs` 的参数冲突，并在短周期无工具 Text Generation（`shortLived`）中剥离会话级费用/时长护栏。
  - `protocol.ts` 将 `omp` 的 `{ type: "notice", level, message }` 翻译为 Pi 兼容通知帧，并在 `prompt_result` 返回 `status: "error"` 且 `error.code === "cost_cap"` 时去重补发错误通知，确保触顶拒发在 T3 线程内清晰可见。
- **统一 `agent.db` 路径与启用实例自动配额源（`sources/omp.ts` + `UsageLimitSources.ts`）**：
  - `resolveOmpDbPath` 复用 `isValidOmpProfileName`，支持 `omp://default`（尊重 `OMP_PROFILE` > `OMP_CODING_AGENT_DIR` > `~/.omp/agent`，严禁 `PI_CODING_AGENT_*`）与 `omp://profile/<name>`（精确 `"default"` 归并为默认路径，非法名 fail-closed）。
  - `readOmpUsage` 升级为零 sidecar 只读 SQLite 读取（缺失/无 WAL 时采用 `?immutable=1`，活跃 WAL+SHM 时只读打开，绝不读取 `auth_credentials`），支持为自动发现源标注 `providerInstanceId`。
  - `UsageLimitSources.ts` 自动为所有已启用的 `omp` 实例只读采集其 `paths.dbPath`（按规范 `dbPath` 与手动 `kind: "omp"` 源去重防双读/双计；响应实例启停与 Profile/目录变更；`withSettingsSnapshot` 原子防禁用后回流）。
- **HUD B5 子后端额度精准匹配（`apps/web/src/fork/hud/*`）**：
  - 新增纯逻辑 `resolveOmpThreadHudLimits`：仅当线程运行在 `omp` 实例时，按活动模型（`servedModel ?? requestedModel`）的 `<subprovider>/` 前缀优先匹配该 `omp` 实例对应的 `kind: "omp"` 配额快照（原生子后端匹配 `accounts`，非原生子后端匹配 `quotaAccounts`），无明确单源匹配时诚实返回 `null` 自动隐藏，绝不混显其他子后端额度。
- **设置表单 10 语言本地化与用户文档**：补全 `ProviderSettingsForm.tsx` 的 `PACKAGE_FIELD_TEXT`、10 个翻译目录与 `docs/user/providers-omp.md`。

## Capabilities

### New Capabilities

- `omp-limits-budget`: First-class `omp` session cost/time guardrails with RPC notice/cost-cap surfacing, profile-unified automatic read-only `agent.db` quota ingestion, and active-model sub-backend HUD quota resolution.

### Modified Capabilities

- None（Wave 1 的 `omp-provider-core` 既有能力契约全部保持兼容；本变更独立定义 Wave 2a 能力规格）。

## Impact

- **受影响包**：`packages/provider-omp`、`apps/server`、`apps/web`、`docs/user/providers-omp.md`。
- **向后兼容**：新增 3 个设置字段均带 `withDecodingDefault("")` 且 `clearWhenEmpty: "omit"`；`UsageLimitSources` 复用既有 `kind: "omp"` 与 `HttpQuotaAccount.providerInstanceId`，零线协议破坏；不改变 Pi 或其他 Provider 行为。
- **零并行冲突**：不触碰 `packages/contracts/src/agentSessions.ts`、`packages/provider-omp/src/server/adapter.ts`、`apps/server/src/project/*` 或 `WelcomePage.tsx`（归 Wave 2b 独占）。
