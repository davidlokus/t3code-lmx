# Design: omp 生态级接入 Wave 1 — 底座与核心闭环

## Context

动机与范围见 [proposal.md](./proposal.md) 与 [Epic Charter](../../epics/omp-ecosystem.md)。本设计在隔离临时 `HOME` 下对本地真实 `omp v19.2.1` 及上游 `packages/provider-pi` 完成了实测抽样，确保所有路径规则、CLI 标志、RPC 命令、设置表单控件和更新检测均基于真值而非猜测。

## Goals / Non-Goals

**Goals:**

- 以 `packages/provider-omp/src/server/paths.ts` 建立 `omp` 全生命周期唯一路径事实源，彻底消除运行目录与 `/usage` 目录分裂，并严格满足 `LESSONS.md #6`（零 Pi 环境变量泄漏）。
- 对 `packages/provider-pi` 仅新增 2 个正交且向后兼容的 `PiDialect` 字段（`extraRoots`、`thinkingLevels`），将所有 Wave 1 新逻辑收口在 `packages/provider-omp`。
- 复用 T3 既有 `ProviderTextGeneration`、`ProviderInstance.refreshModels`、`ProviderMaintenanceCapabilities`、`ProviderSettingsForm` 机制，做到零 `packages/contracts` 破坏、零 `apps/server/src/ws.ts` 改动。

**Non-Goals:**

- 不在 Wave 1 修改 `apps/server/src/usage/sources/omp.ts` 或 `UsageLimitSources.ts`（留给 Wave 2a 统一接入多 profile 联动与 `omp usage --json` 主动刷新）。
- 不在 Wave 1 引入 `AgentSessionSource: "omp"`（留给 Wave 2b）或修改 `PiAdapterV2` 的事件流处理以支持 `task`/`todo`/Plan/`ask`（留给 Wave 3a）。
- 不修改 `apps/desktop` 的任何独立打包入口（`boot.ts` / `compileCache.ts` / `serverCompileCache.ts` / `preload.ts`），经核对均不导入 `@t3tools/provider-omp`，无需调整 `apps/desktop/vite.config.ts` 的 `deps.alwaysBundle`。

## Provider Payload Truth Table（`LESSONS.md #5` 实测真值表）

所有 `omp` 数据均于 2026-11-25 在隔离临时目录（`HOME=$(mktemp -d)`，零触碰 `~/.omp` 与 `~/.t3`）实测自 `/Users/liamx/.local/bin/omp`（`omp/19.2.1`），并与上游 `packages/provider-pi` 源码逐项比对：

| Provider         | Endpoint / Command                                                                                                    | 实测字段与行为（Redacted）                                                                                                                                                                                                                                                                                                                                                                                              | 空值 / 非法值 / 超时 / 离线行为                                                                                                                                                    | 探测与频控                                                                  |
| ---------------- | --------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| `omp` (`19.2.1`) | `omp config path`（默认 / `--profile` / `OMP_PROFILE` / `PI_CODING_AGENT_DIR` / `OMP_CODING_AGENT_DIR`）              | 默认 `<HOME>/.omp/agent`；`--profile work` 或 `OMP_PROFILE=work` 均为 `<HOME>/.omp/profiles/work/agent` 且**优先于** `PI_CODING_AGENT_DIR`；仅设 `PI_CODING_AGENT_DIR` 返回该自定义路径；`OMP_CODING_AGENT_DIR` 被 `omp` 二进制忽略（返回默认目录）                                                                                                                                                                     | 非法 profile（如 `../escape`）立即报错并给出精确规则：`^[a-z0-9][a-z0-9._-]{0,63}$`，禁止 `.`/`..`/尾点/Windows 保留名（`CON`/`PRN`/`AUX`/`NUL`/`COM0-9`/`LPT0-9` 及其带后缀形式） | 纯本地路径推导，零进程开销                                                  |
| `omp` (`19.2.1`) | `omp models --json --no-extensions`                                                                                   | 顶层 `{ models: [...] }`；每项字段为 `contextWindow, cost, id, input, kind, maxTokens, name, pricingStatus, provider, reasoning, selector, thinking`；推理模型 `thinking` 为字符串数组（如 `["low","medium","high","xhigh"]`，**不含 `"auto"`**）；无 `serviceTiers` 字段                                                                                                                                               | 非推理模型 `reasoning: false, thinking: null`；图像模型 `kind: "image"`（需过滤）；无任何凭据时返回空数组或退出失败                                                                | 被动状态探测，30s 超时                                                      |
| `omp` (`19.2.1`) | `omp --mode rpc`（`get_state` / `set_model` / `set_thinking_level` / `get_last_assistant_text` / `set_service_tier`） | `get_state` 返回 `thinkingLevel`（有效档位）、`configuredThinkingLevel`（如 `"auto"`）、`thinkingLevels: ["off","auto","low","medium","high","xhigh"]`、`fastModeEnabled`/`fastModeActive`/`slowModeSupported`；`set_thinking_level { level: "auto" }` 返回 `ok: true`；`get_last_assistant_text` 返回 `ok: true, data: { text? }`；**`set_service_tier` 返回 `ok: false, error: "Unknown command: set_service_tier"`** | 空历史时 `get_last_assistant_text` 返回 `{}`（无 `text` 字段）；不合法 `--service-tier` CLI 启动即报错，合法枚举实测为 `none, auto, default, flex, scale, priority, ultrafast`     | 仅实时会话与按需短生命周期 TextGen 启动                                     |
| `omp` (`19.2.1`) | `omp models refresh --no-extensions`                                                                                  | 刷新本地 `~/.omp/models.db`（或对应 profile/agentDir 下缓存），支持 `--profile` 与绝对路径 `--config`                                                                                                                                                                                                                                                                                                                   | 离线/失败返回非零退出码，不破坏已有快照                                                                                                                                            | 仅用户显式触发 `refreshModels` 时执行（30s 超时）                           |
| `omp` (`19.2.1`) | `omp update --check`                                                                                                  | 实测输出两行：`Current version: 19.2.1` + `✔ Already up to date`（有新版本时输出目标 semver 版本号）                                                                                                                                                                                                                                                                                                                    | 离线、超时（10s）、非零退出或输出不可解析时返回 `null`，绝不影响 provider `ready` 状态                                                                                             | 受 `enableProviderUpdateChecks` 开关与 `ProviderLatestVersions` 1h 缓存门控 |
| `Pi`（上游对比） | `packages/provider-pi/src/server/{modelCapabilities,textGeneration,adapter,driver}.ts`                                | `PI_THINKING_LEVELS` 为 7 档（不含 `"auto"`）；`serviceTier` 通过扩展注入 `/t3-service-tier` 命令每轮发送；`makePiTextGeneration` 用 `--no-session --no-extensions --no-tools` RPC + `get_last_assistant_text`；`PiDriver` 用 `makePackageManagedProviderMaintenanceResolver`                                                                                                                                           | Pi 扩展不存在时 `/t3-service-tier` 会报 protocol error（故 `omp` 不可复用该路径）                                                                                                  | 保持 Pi 全部行为零回退                                                      |

## 4-Quadrant Defense Matrix（`LESSONS.md #9`）

| 象限                                         | 设计防线与强制回归断言                                                                                                                                                                                                                                                                                                                                                 |
| -------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **1. 旧配置/旧服缺失可选字段**               | `OmpSettings` 新增 7 个字段（`profile`、`agentDir`、`serviceTier`、`smolModel`、`slowModel`、`planModel`、`advisor`）全部使用 `Schema.withDecodingDefault`（`""` / `false`）且表单 `clearWhenEmpty: "omit"`；空值不生成任何多余 CLI 参数，旧版持久化 JSON 无需迁移即可无损解码。`PiDialect` 新增字段均为可选，未声明时回退原 Pi 逻辑。                                 |
| **2. 探测/刷新/更新失败态保留与无震荡**      | `omp update --check` 失败/超时返回 `null`（不覆盖已有健康快照、不误报可更新）；`omp models refresh` 失败映射为可观测 `ProviderDriverError` 而不损坏现有运行中会话；`OmpTextGeneration` 在 `set_thinking_level` 不被具体模型支持时吞掉 `PiRpcError` 回退默认思考强度，并在超时/错误时释放进程（`Effect.scoped`）且绝不回显原始上游响应体或密钥。                        |
| **3. 多实例隔离与防双计（`LESSONS.md #6`）** | 每个 `OmpDriver` 实例通过 `resolveOmpInstancePaths()` 绑定独立的 `profile` 或 `agentDir`；设置 `agentDir` 时仅在**该实例的子进程环境**注入 `PI_CODING_AGENT_DIR`；`resolveOmpInstancePaths()` 与 `ompUsageReader` **严禁**读取宿主 `process.env.PI_CODING_AGENT_*`，且回归单测显式断言在宿主设 `PI_CODING_AGENT_DIR` 时默认 `omp` 实例仍扫描 `~/.omp/agent/sessions`。 |
| **4. 缓存失效与版本一致性**                  | `maintenance.ts` 为自更新能力生成包含真实二进制路径的 `latestVersionCacheKey`，避免切换 `binaryPath` 后复用旧版本缓存；`refreshModels` 执行完 `omp models refresh` 后由 `ws.ts` 自动调用 `providerRegistry.refreshInstance` 重探快照；本波次不改动 `usage-scan-cache-v18.json` 格式，无需升级缓存文件名。                                                              |

## Decisions

### Decision 1：`OmpSettings` 一等字段与冲突校验

- **方案**：在 [`packages/provider-omp/src/settings.ts`](../../../packages/provider-omp/src/settings.ts) 中新增 `profile`、`agentDir`、`serviceTier`（`select`）、`smolModel`、`slowModel`、`planModel`、`advisor`（`switch`），表单顺序为 `["binaryPath", "profile", "agentDir", "serviceTier", "smolModel", "slowModel", "planModel", "advisor", "launchArgs"]`。
- **理由**：`ProviderSettingsForm.tsx` 原生支持 `text` / `select` / `switch` 控件（`packages/contracts/src/settings.ts:652`），只需在 Schema 上声明注解并在 `PACKAGE_FIELD_TEXT` 补充 10 语言翻译即可在 Web 自动渲染，零额外自定义表单组件。
- **冲突护栏**：在 `dialect.ts` 中将一等字段合成到启动参数前，校验 `profile` 合法性及与 `launchArgs` 的冲突（例如同时设 `settings.profile` 和 `launchArgs` 里的 `--profile`，或同时设 `settings.serviceTier` 和 `--service-tier`，或同时设 `smolModel`/`slowModel`/`planModel`/`advisor` 与对应 flag），发现冲突立即返回明确错误消息，防止静默覆盖导致排障困难。
- **替代方案**：仅允许在 `launchArgs` 手写，不加一等字段 → 否定，因为 `usage.ts`、Wave 2 `agent.db` 和终端会话导入都需要结构化读取 `profile`/`agentDir`，且手写 `--service-tier` 无下拉枚举提示容易拼错。

### Decision 2：`paths.ts` 单一路径事实源与 `agentDir` 注入边界

- **方案**：新增 `packages/provider-omp/src/server/paths.ts` 导出 `isValidOmpProfileName`、`resolveOmpInstancePaths`、`OmpInstancePaths`。
  - 优先级严格复刻实测 `omp v19.2.1`：
    1. 有效 `profile`（`config.profile` > `launchArgs` `--profile` > 实例显式 `OMP_PROFILE`）→ `path.resolve(home, ".omp", "profiles", profile, "agent")`
    2. 显式 `config.agentDir` → `path.resolve(expandHomePath(config.agentDir, home))`
    3. 向后兼容环境变量 `OMP_CODING_AGENT_DIR` → `path.resolve(expandHomePath(envDir, home))`
    4. 默认 → `path.resolve(home, ".omp", "agent")`
  - `sessionsDir`：若存在 `OMP_CODING_AGENT_SESSION_DIR`（仅非 profile 模式）则优先，否则 `path.join(agentDir, "sessions")`；同时若 `launchArgs` 含绝对 `--session-dir`，一并返回给 `ompUsageReader`。
  - 在 `adapter.ts` 的 `ompInstanceEnvironment` 中：仅当 `config.profile` 为空且 `config.agentDir` 非空时，向该实例的子进程 env 写入 `PI_CODING_AGENT_DIR: resolvedAgentDir`（若用户在实例环境变量里显式设了 `PI_CODING_AGENT_DIR` 且未设 `agentDir`/`profile`，保留实例显式配置供运行，但 `UsageService` 传入的宿主 `process.env.PI_CODING_AGENT_DIR` 永远被 `resolveOmpInstancePaths` 忽略）。
- **注意**：`checkOmpProviderStatus` 与 `refreshModels` 也必须传入与运行时一致的 `profile`/`agentDir` 参数与环境，确保健康检查看到的模型目录与实际会话完全一致。

### Decision 3：多目录工作区（`extraRoots` → `--add-dir`）与 `thinking=auto` 的最小 `PiDialect` 钩子

- **方案**：
  - `PiDialectLaunchInput` 新增可选 `extraRoots?: ReadonlyArray<string>`；`packages/provider-pi/src/server/adapter.ts` 在 `startConnection` 调用 `dialect.buildLaunch` 时透传 `extraRoots: input.runtimePolicy.workspace?.extraRoots`（仅正常会话，短生命周期 `--fork` 与文本生成不传）。`buildOmpRpcLaunch` 过滤空串并去重后追加 `--add-dir <dir>`。
  - `PiDialect` 新增可选 `thinkingLevels?: ReadonlySet<string>`；`packages/provider-pi/src/server/adapter.ts` 在 `applySelection` 中使用 `(dialect.thinkingLevels ?? PI_THINKING_LEVELS).has(thinking)`。`OMP_DIALECT` 传入含 `"auto"` 的 8 档集合（`off/auto/minimal/low/medium/high/xhigh/max`）；`ompModelCapabilities` 为推理模型在 `"off"` 后插入 `{ id: "auto", label: "Auto" }`（支持 `currentThinkingLevel === "auto"` 标记默认）。
- **理由**：对 `packages/provider-pi/src/server/adapter.ts` 仅新增 ~6 行 `// fork:` 钩子，Pi 行为零变化，上游同步冲突接近零。

### Decision 4：`OmpTextGeneration` 复用短生命周期无工具 RPC

- **方案**：新增 `packages/provider-omp/src/server/textGeneration.ts`（`makeOmpTextGeneration`），与 `packages/provider-pi/src/server/textGeneration.ts` 结构对齐，但直接调用 `OMP_DIALECT` + `makeOmpRpcConnection`：
  - 启动参数：`--mode rpc --no-session --no-extensions --no-tools --no-title --no-lsp --no-skills --no-rules --no-context-files` + 实例的 `--profile`（如有）+ 用户允许的 overlay 配置（不加载 extensions/tools）。
  - 模型选择规则：
    - 若请求 `modelSelection.model !== "default"`：校验并 `set_model` 为所选 `provider/model`。
    - 若请求 `modelSelection.model === "default"` 且 `config.smolModel` 非空：尝试按 `resolvePiModelSlug(config.smolModel, availableModels)` 设为 `smolModel`（支持精确 `provider/id`），若不匹配或为空则沿用 omp 默认模型。
  - 若请求指定了合法思考强度（含 `"auto"`），发送 `set_thinking_level`（不支持时静默忽略 `PiRpcError`）。
  - 发出 `prompt`，监听 `connection.events` 直至 `agent_settled`（借助 `makeOmpTranslator` 自动把 omp `agent_end` 转为 `agent_settled`！），取 `get_last_assistant_text` 经 `TextGenerationOperations.decodeJsonReply` 解码返回；错误细节脱敏只保留前导 HTTP 状态码。
  - `status.ts` 在 `buildInitialOmpProviderSnapshot` 与 `checkOmpProviderStatus` 中，仅在禁用或发现可用模型为 0 时标 `supportsTextGeneration: false`，就绪且有模型时允许文本生成。

### Decision 5：可验证自更新与版本检测（`maintenance.ts`）

- **方案**：新增 `packages/provider-omp/src/server/maintenance.ts`（导出 `OMP_MAINTENANCE_RESOLVER` 与 `parseOmpUpdateCheckOutput`）：
  - **所有权与可写性证明（严守 `03_providers.md`）**：
    1. 若 `context === null`，返回 `manual-only`（`manualCommand: "omp update"`）。
    2. 依次排除：`isNixStoreCommandPath`、`homebrewOwnershipFromCommandPath`、`resolveMacPortsOwner`、mise 路径、`node_modules` 路径。
    3. 检查 `context.realCommandPath` 及其父目录是否可写（`fs.access` `W_OK` 或等效权限检查）；不可写或路径归属不明均降级 `manual-only`。
    4. 仅当以上校验全部通过，返回 `updateExecutable: context.resolvedCommandPath`、`updateArgs: ["update"]`、`updateLockKey: "omp-native"`、`updateCommand: "omp update"`。
  - **版本探测 `lookupLatestVersion`**：运行 `omp update --check`（10s 超时，不继承多余密钥环境）；解析输出：
    - 识别 `Already up to date` → 提取 `Current version: X.Y.Z` 作为最新已知版本（无可用更新）。
    - 识别更新提示行（如 `Latest version: X.Y.Z`、`Update available: X.Y.Z → Y.Z.W`、`v?X.Y.Z -> v?Y.Z.W`）→ 提取目标 semver 返回。
    - 超时/退出码非 0/输出异常 → 返回 `null`（不误报更新）。
  - **注意**：即使安装为 `manual-only`（如 Homebrew/Nix），在非只读探测限制下依然可通过 `lookupLatestVersion` 检查是否有新版以展示手动更新提示，但 `update` 动作保持 `null`。

### Decision 6：导出纪律（`knip:check:exports` 防返工清单）

严格区分**对外消费导出**与**模块内部 helper**，防止 `vp run check:changed` 的 `knip` 报错：

| 模块                                                    | 允许 `export` 的公共符号                                                                                                                                                                                | 保持模块私有（不 `export`）                                                |
| ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| `packages/provider-omp/src/settings.ts`                 | `OmpSettings`（类型与 Schema）、`OmpServiceTier`、`OMP_SERVICE_TIERS`                                                                                                                                   | 内部正则或字段校验 helper                                                  |
| `packages/provider-omp/src/server/paths.ts`             | `isValidOmpProfileName`、`resolveOmpInstancePaths`、`OmpInstancePaths`                                                                                                                                  | 内部 Windows 保留名集合、home 推导 helper                                  |
| `packages/provider-omp/src/server/textGeneration.ts`    | `makeOmpTextGeneration`                                                                                                                                                                                 | `runOmpJson`、`ompTurnErrorDetail`、超时常量                               |
| `packages/provider-omp/src/server/maintenance.ts`       | `OMP_MAINTENANCE_RESOLVER`、`parseOmpUpdateCheckOutput`（如仅单测使用则改测 `OMP_MAINTENANCE_RESOLVER.resolve` 或内联消费）                                                                             | `isWritableStandaloneInstall`、版本行正则、probe helper                    |
| `packages/provider-omp/src/server/modelCapabilities.ts` | `EMPTY_OMP_MODEL_CAPABILITIES`、`ompModelCapabilities`、`OMP_THINKING_LEVELS`（被 `dialect.ts` / `textGeneration.ts` 消费）                                                                             | `LABELS`、`isOmpThinkingLevel`（若内部使用）                               |
| `packages/provider-omp/src/server/dialect.ts`           | `OMP_PROVIDER`、`OMP_DIALECT`、`resolveOmpLaunchArgs`、`ompLaunchSessionDir`、`ompInventoryLaunchArgs`、`buildOmpRpcLaunch`、`resolveOmpSettingsLaunchArgs`（若仅同模块/status 使用须确保生产代码消费） | `RESERVED_ARGUMENTS`、`ARGUMENTS_WITH_VALUES`、`withoutDisabledLaunchArgs` |

> 实现时核对：`knip` 不会把仅被 `*.test.ts` 导入的符号视为已使用！因此凡只在测试里断言的逻辑，优先通过公共入口测试，或仅导出生产代码确实引用的符号。

## Risks / Trade-offs

- **[Risk] `omp update --check` 有新版时的输出文案可能随 omp 版本演进变化** → **Mitigation**：`parseOmpUpdateCheckOutput` 兼容多种常见 semver 格式（`Latest version:`、`New version:`、`A -> B`、`Already up to date`），无法解析时保守返回 `null`（绝不误报降级或乱弹窗），并加单元测试覆盖所有分支。
- **[Risk] `OmpTextGeneration` 选 `default` 且用户配了失效的 `smolModel` 导致标题生成失败** → **Mitigation**：仅当 `smolModel` 在 `get_available_models` 中可解析时才 `set_model`，若 `set_model` 被拒则回退 omp 默认模型并记录 debug 日志；显式指定了非 `default` 模型时仍严格报错，避免静默切换用户选定的模型。
- **[Risk] `OmpSettings` 新增较多字段导致设置页视觉拥挤** → **Mitigation**：利用 `ProviderSettingsForm` 既有的紧凑行布局，空值保持 `clearWhenEmpty: "omit"` 且带清晰 placeholder（如 `Optional` / `Automatic`），不新增二级折叠卡片避免复杂化上游组件。
- **[Risk] `OmpDriver` 的 `profile` 与用户手写 `launchArgs: "--profile foo"` 同时存在造成歧义** → **Mitigation**：在启动与状态检查阶段均执行统一冲突校验，返回明确错误信息指示用户只保留一处。

## Cross-Agent Execution & File Ownership Split（`handoff.md`）

若使用 `agy × omp` 协同推进本 Wave：

- **Group 1（`omp` worker，纯后端/契约/单测）**：
  - 归属文件：`packages/provider-omp/src/{settings.ts,server/{paths,dialect,adapter,modelCapabilities,status,textGeneration,maintenance,driver,usage}*.ts}`、`packages/provider-pi/src/server/{dialect,adapter}.ts`（仅最小 `// fork:` 钩子）。
  - 禁止触碰：`apps/web/**`、`docs/**`、`FORK.md`、`LESSONS.md`。
- **Group 2（`agy` Coordinator，UI 接线/文案/i18n/文档/真机 QA）**：
  - 归属文件：`apps/web/src/components/settings/{ProviderSettingsForm.tsx,customModelEditor.logic.ts}`、`apps/web/src/i18n/translations/*.json`、`docs/user/providers-omp.md`。
- **Group 3（全新只读 Reviewer，Author ≠ Reviewer）**：
  - 对 `git diff <plan-sha>` 执行 `openspec-verify-change omp-ecosystem-wave1` 审核后由 Coordinator 收尾、跑 `Broken by hand`、本地 DMG Dogfood 验收与归档。
