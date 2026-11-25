# Proposal: omp 生态级接入 Wave 1 — 底座与核心闭环

> **关联 Epic Charter**：[openspec/epics/omp-ecosystem.md](../../epics/omp-ecosystem.md)（Wave 1 / 底座 PR）
> **OpenSpec 档位**：`L2 Full Spec`（跨 `provider-omp` / `provider-pi` / `web` / `i18n` / `docs` 的底座契约与能力升级）

## Why

当前 `packages/provider-omp` 仅实现了基础对话 RPC 与 `/usage` 历史扫描，距离 T3 一等公民及 omp 生态能力仍有 5 处基础断层：（1）多实例只能手写 `launchArgs`/环境变量，且文档建议的 `PI_CODING_AGENT_DIR` 与 `usage.ts` 的 `OMP_CODING_AGENT_DIR` 解析分裂，也不识别 omp 原生 `--profile`（`~/.omp/profiles/<name>/agent`）；（2）多目录线程未将 `workspace.extraRoots` 透传为 `--add-dir`；（3）`OmpDriver` 明确禁用了应用级 Text Generation（自动标题、Commit/PR 文案等）与模型目录主动刷新（`omp models refresh`）；（4）思考强度缺少 omp 原生支持的 `"auto"` 档位，缺少 `--service-tier` / `--smol` / `--slow` / `--plan` / `--advisor` 一等配置；（5）更新检查完全停留在静态手动提示，未接入 `omp update --check` 与可验证自管安装的一键 `omp update`。作为 Epic 的 Wave 1，必须先把单一路径事实源、配置契约、模型/文本生成与维护能力夯实，为 Wave 2（额度/成本护栏/会话导入）和 Wave 3（`task`/`todo`/Plan/`ask`/登录）提供零重复、零污染的底座。

## What Changes

1. **统一路径与 Profile 一等配置（`paths.ts` + `OmpSettings`）**
   - 在 [`packages/provider-omp/src/settings.ts`](../../../packages/provider-omp/src/settings.ts) 中为 `OmpSettings` 新增可选一等字段（向后兼容旧配置，空值自动省略）：
     - `profile`（隔离 Profile 名称，校验规则与 `omp` 一致）
     - `agentDir`（自定义 agent 数据目录，仅注入当前 omp 实例子进程 `PI_CODING_AGENT_DIR`，不污染宿主与 Pi）
     - `serviceTier`（会话级 OpenAI 服务层级下拉：`""` / `none` / `auto` / `default` / `flex` / `scale` / `priority` / `ultrafast`）
     - `smolModel` / `slowModel` / `planModel`（可选角色模型）与 `advisor`（布尔开关）
   - 新增 [`packages/provider-omp/src/server/paths.ts`](../../../packages/provider-omp/src/server/paths.ts) 作为单一路径事实源（`resolveOmpInstancePaths`），按实测 `omp v19.2.1` 优先级（`profile` > `agentDir` > 实例显式 `OMP_CODING_AGENT_DIR` > `~/.omp/agent`）解析 `agentDir`、`sessionsDir`、`dbPath`，并同步接入 `usage.ts`、`status.ts`、`dialect.ts`、`adapter.ts`，严禁继承宿主 `PI_CODING_AGENT_*`。
   - 启动参数护栏校验一等字段与手写 `launchArgs` 的冲突（如同时指定 `profile` 与 `--profile`、或 `serviceTier` 与 `--service-tier` 时给出明确错误）。

2. **多目录工作区透传（`extraRoots` → `--add-dir`）**
   - 在 [`packages/provider-pi/src/server/dialect.ts`](../../../packages/provider-pi/src/server/dialect.ts) 的 `PiDialectLaunchInput` 新增可选 `extraRoots?: ReadonlyArray<string>`，由 [`packages/provider-pi/src/server/adapter.ts`](../../../packages/provider-pi/src/server/adapter.ts) 透传 `input.runtimePolicy.workspace?.extraRoots`。
   - `buildOmpRpcLaunch` 对去重后的有效 `extraRoots` 生成可重复 `--add-dir <path>` 参数，支持多仓库/多目录线程。

3. **应用级 Text Generation（`textGeneration.ts`）与模型目录刷新（`refreshModels`）**
   - 新增 [`packages/provider-omp/src/server/textGeneration.ts`](../../../packages/provider-omp/src/server/textGeneration.ts)，复用 `OMP_DIALECT` + `makeOmpRpcConnection` 启动短生命周期、无会话、无扩展、无工具、无 LSP 的 RPC 进程（`--no-session --no-extensions --no-tools --no-title --no-lsp --no-skills --no-rules --no-context-files`），通过 `set_model` / `set_thinking_level` / `prompt` / `get_last_assistant_text` 提供完整 `ProviderTextGeneration` 能力（支持显式模型，选 `default` 且配置了 `smolModel` 时优先用 `smolModel`，否则走 omp 默认模型）。
   - [`status.ts`](../../../packages/provider-omp/src/server/status.ts) 与 [`driver.ts`](../../../packages/provider-omp/src/server/driver.ts) 接入 `makeOmpTextGeneration`，仅在可用模型为空或探活失败时降级 `supportsTextGeneration: false`；`OmpDriver` 实现 `refreshModels()`，执行 `omp models refresh --no-extensions`（携带实例 `profile`/`agentDir` 配置）刷新本地模型缓存。

4. **思考强度 `auto` 档位支持**
   - [`modelCapabilities.ts`](../../../packages/provider-omp/src/server/modelCapabilities.ts) 为推理模型暴露 `"auto"`（`Auto`）思考强度选项，并与 `customModelEditor.logic.ts` 预设对齐。
   - [`packages/provider-pi/src/server/dialect.ts`](../../../packages/provider-pi/src/server/dialect.ts) 新增可选 `thinkingLevels?: ReadonlySet<string>`；[`adapter.ts`](../../../packages/provider-pi/src/server/adapter.ts) 按方言集合放行 `set_thinking_level`，使 `omp` 真正下发 `"auto"` 而不影响 Pi 的既有集合。

5. **可验证自更新与版本探测（`maintenance.ts`）**
   - 新增 [`packages/provider-omp/src/server/maintenance.ts`](../../../packages/provider-omp/src/server/maintenance.ts)，在 `enableProviderUpdateChecks` 开启时通过 `omp update --check` 解析最新版本；依据 [`docs/internals/03_providers.md`](../../../docs/internals/03_providers.md) 校验真实二进制路径归属，排除 `/nix/store/`、Homebrew、MacPorts、mise、`node_modules` 及不可写目录，仅对确认为可写独立安装的二进制提供一键 `omp update`，其余安全降级为 `manual-only`（`manualCommand: "omp update"`）。

6. **Settings UI 本地化与用户文档纠偏**
   - 在 [`apps/web/src/components/settings/ProviderSettingsForm.tsx`](../../../packages/web/src/components/settings/ProviderSettingsForm.tsx) 的 `PACKAGE_FIELD_TEXT` 中补齐新增 `OmpSettings` 字段的英文 key 与 `msg(...)` 映射，生成并翻译全部 10 种 Web 语言包。
   - 更新 [`docs/user/providers-omp.md`](../../../docs/user/providers-omp.md)：修正过时的「omp history is not included on the Usage page」声明，补充 `Profile` / `Agent directory` / 角色模型 / Text Generation / `omp update` 使用说明。

## Capabilities

### New Capabilities

- `omp-provider-core`: First-class OMP instance path/profile isolation, multi-folder `--add-dir` workspace forwarding, `thinking=auto` and session role/service-tier configuration, catalog refresh (`omp models refresh`), ephemeral-RPC application text generation, and ownership-verified self-update maintenance.

### Modified Capabilities

- （无既有 `openspec/specs/` 需求需要修改；`usage-sources-omp-cn` 保持不变，其多 profile 联动将在 Wave 2 演进。）

## Assumptions

- 实测 `omp v19.2.1` 显示 `set_service_tier` RPC 命令不存在（`Unknown command: set_service_tier`），`--service-tier` 为会话启动级 CLI 参数（`none | auto | default | flex | scale | priority | ultrafast`），因此 `serviceTier` 放在实例设置 `OmpSettings` 中而非每轮模型选项（避免触发 Pi 扩展专用的 `/t3-service-tier` 命令报错）。
- `omp` 自身不支持 `OMP_CODING_AGENT_DIR` 环境变量（实测读取 `PI_CODING_AGENT_DIR` 和 `--profile`/`OMP_PROFILE`，且 `profile` 优先于 `PI_CODING_AGENT_DIR`）。为严格守住 `LESSONS.md #6`，实例表单中的 `agentDir` 仅在启动 omp 子进程时注入为该进程的 `PI_CODING_AGENT_DIR`，而 `resolveOmpInstancePaths()` 永远不读取宿主 `process.env.PI_CODING_AGENT_*`（同时保留对旧版 `OMP_CODING_AGENT_DIR` / `OMP_CODING_AGENT_SESSION_DIR` 的兼容）。
- 当 `OmpTextGeneration` 使用 `default` 模型且用户配置了 `smolModel` 时，短生命周期文本生成优先将 `smolModel` 作为目标模型（加快标题/Commit 生成速度并降本），未配置则沿用 omp 默认模型；显式选择了具体 `provider/model` 时严格按所选模型执行。
- 费用护栏字段（`warnCostUsd` / `maxCostUsd` / `maxTime`）留到 Wave 2 与额度治理、触达上限错误分类一起上线，不在 Wave 1 暴露半成品设置。

## Out of Scope

- `omp usage --json` 主动额度刷新、`agent.db` 多 profile 自动绑定、Thread HUD 配额映射、`omp usage reset` 与费用护栏（归属 Wave 2a `feat/omp-limits-budget`）。
- 终端会话扫描/导入（`AgentSessionSource`）与 `omp session lease --json` 并发写检测（归属 Wave 2b `feat/omp-session-import`）。
- 原生 `task` 子代理卡片、`todo` 列表卡片、Plan 模式 / `proposed_plan`、原生 `ask` / `rpc-ui`（归属 Wave 3a `feat/omp-orchestration-rich`）。
- 应用内 OAuth 登录控制器 `ProviderAuthController`（归属 Wave 3b `feat/omp-auth-controller`）。
- omp 专属 `skill` 市场、`plugin`/`agents`/`memory`/`collab`/`ps` UI 面板。

## 上游同步冲突面与文件归属围栏

- **新增独立文件（0 上游冲突）**：
  - `openspec/epics/omp-ecosystem.md`
  - `openspec/changes/omp-ecosystem-wave1/{proposal.md,design.md,tasks.md,specs/omp-provider-core/spec.md}`
  - `packages/provider-omp/src/server/paths.ts` + `paths.test.ts`
  - `packages/provider-omp/src/server/textGeneration.ts` + `textGeneration.test.ts`
  - `packages/provider-omp/src/server/maintenance.ts` + `maintenance.test.ts`
- **Fork 自有包更新（0 上游冲突）**：
  - `packages/provider-omp/src/settings.ts`
  - `packages/provider-omp/src/server/{dialect,adapter,status,modelCapabilities,driver,usage}.ts` 及对应 `*.test.ts`
  - `docs/user/providers-omp.md`
- **上游文件最小 `// fork:` 钩子**：
  - `packages/provider-pi/src/server/dialect.ts`（`PiDialectLaunchInput.extraRoots`、`PiDialect.thinkingLevels`）
  - `packages/provider-pi/src/server/adapter.ts`（3 处最小钩子：透传 `extraRoots`、按 `dialect.thinkingLevels` 校验思考强度、无其他逻辑侵入）
  - `apps/web/src/components/settings/ProviderSettingsForm.tsx`（在 `PACKAGE_FIELD_TEXT` 追加新增 `OmpSettings` 字段翻译条目）
  - `apps/web/src/components/settings/customModelEditor.logic.ts`（为 `omp` 自定义模型思考预设追加 `"auto"`，独立常量不改 Pi 预设）
  - `apps/web/src/i18n/translations/*.json`（Wave 1 独占 i18n 写入者，10 语言翻译）

## Surface Matrix

| Surface       | Status  | Notes                                                                                                                                                                                                |
| ------------- | ------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Web**       | Changed | `ProviderSettingsForm` 自动渲染新增 `OmpSettings` 字段并本地化文案；`customModelEditor` 为 `omp` 补齐 `auto` 思考选项；Text Generation 面板可选 `omp` 实例                                           |
| **Desktop**   | Changed | 随 Web + Server 一起打包验证；不新增 `apps/desktop` 独立打包入口（`boot.ts`/`compileCache.ts` 等）依赖，仍需在收尾执行本地 DMG Dogfood 验收                                                          |
| **Mobile**    | N/A     | `OmpSettings` 由 `packages/provider-omp/settings` 统一导出且保持浏览器/RN 安全，不新增移动端契约枚举或布局改动；`omp` 思考强度选项由服务端快照动态驱动                                               |
| **Server**    | Changed | `OmpDriver` 接入 `textGeneration`、`refreshModels`、可验证 `maintenance`；`ws.ts` / `TextGeneration.ts` / `ProviderRegistry.ts` 无需改动即可自动消费                                                 |
| **Contracts** | N/A     | 复用既有 `ServerProviderModel`、`ProviderSettingsFormAnnotation`、`ProviderTextGeneration`、`ProviderMaintenanceCapabilities`，零破坏性契约改动                                                      |
| **Providers** | Changed | `packages/provider-omp` 新增 `paths`/`textGeneration`/`maintenance` 并升级 `settings`/`dialect`/`modelCapabilities`/`status`/`driver`/`usage`；`packages/provider-pi` 增加 2 个最小 `PiDialect` 字段 |
| **i18n**      | Changed | `ProviderSettingsForm` 新增字段标题/描述/选项文案经 `vp run i18n:generate` 生成并在全部 10 个 Web 语言包补齐翻译，通过 `vp run i18n:check`                                                           |

## Impact

- 直接提升 `omp` 在 T3 Lab (Extend) 中的日常可用性：开箱支持多 Profile 隔离、多仓库工作区、自动标题/Commit 生成、模型主动刷新、`auto` 思考与可验证自更新。
- 统一 `resolveOmpInstancePaths()` 彻底消除当前运行目录与 `/usage` 扫描目录之间的隐性分裂，并为 Wave 2 的 `agent.db` 联动和终端会话导入提供可复用的单一事实源。
- 对上游同步高度友好：上游文件改动严格收敛在 `provider-pi` 的 2 个可选方言字段、`ProviderSettingsForm.tsx` 文案表和 `customModelEditor.logic.ts` 一行映射。
