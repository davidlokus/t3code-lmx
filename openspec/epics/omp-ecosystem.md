# Epic: omp（oh-my-pi）完全生态级接入

- **状态**：In Progress（Wave 1 与 Wave 2a 已合入 `lmx-lab`；Wave 2b 已归档待合入；Wave 3 待推进）
- **总览目标**：将 T3 Lab (Extend) 的原生 `omp` Provider 升级为「T3 一等公民 + omp 核心特色自然融合」生态级接入——补齐 Profile/路径统一、多目录 `--add-dir`、应用级 Text Generation、`thinking=auto`/角色模型/服务层级、可验证自更新、全链路额度与费用护栏、终端会话导入与 `lease` 防并发写、以及协议验证驱动的原生 `task`/`todo`/Plan/`ask` 与应用内登录。**非目标**：不抓取终端 ANSI `setWidget`，不在 T3 内构建 omp 专属 `skill` 市场、`plugin`/`agents`/`memory`/`collab`/`ps`/`bench` 独立控制台，不强行屏蔽 omp 原生 `task`，不触碰官方 `~/.t3/userdata`。
- **关键架构不变量**：
  - **单一路径事实源 + 零 Pi 污染**：`packages/provider-omp/src/server/paths.ts`（`resolveOmpInstancePaths()`）成为运行时、`/usage` 扫描、`agent.db` 额度源、终端会话导入与认证状态的唯一路径解析源；严格区分实例显式配置（`profile` / `agentDir`）与宿主环境 `process.env`，严禁继承宿主 `PI_CODING_AGENT_*`（守住 `LESSONS.md #6`）。
  - **边界收口与低冲突演进**：非主循环能力 100% 放在 `packages/provider-omp/src/server/`；对 `packages/provider-pi/src/server/adapter.ts` 仅保留极少量通用 `PiDialect` 扩展点（不塞入 omp 专属业务逻辑）；若 Wave 3 实测编排事件状态机显著分叉，则在 `packages/provider-omp` 独立演进 `OmpAdapterV2`。
  - **诚实能力与真实载荷驱动**：凡消费 omp 运行时载荷或开启 Plan/`ask`/`task`/`todo`/额度/登录，必先在隔离临时 `HOME` 中实测本地 `omp` 二进制载荷并记录真值表（`LESSONS.md #5`），严禁伪造权限、模式或缺失字段。
  - **向后兼容**：`OmpSettings` 所有新增字段均带解码默认值或可选语义，旧版配置零迁移直接解码；已有 `apps/server/src/usage/sources/omp.ts` 只读 SQLite 额度源保持向后兼容。

## 1. 冻结契约与共享接口（Wave 1 锁定，后续 Wave 只消费不破坏）

- **`packages/provider-omp/src/settings.ts`（`OmpSettings`）**：
  - 既有：`enabled`、`binaryPath`、`launchArgs`、`customModels`
  - Wave 1 新增一等字段（全部带安全默认值，空值省略不落脏配置）：
    - `profile: TrimmedString`（默认 `""`；校验与 `omp` 一致：`^[a-z0-9][a-z0-9._-]{0,63}$` 且排除 `.`/`..`/尾点/Windows 保留设备名）
    - `agentDir: TrimmedString`（默认 `""`；自定义 agent 目录，优先级低于 `profile`，注入该实例子进程 `PI_CODING_AGENT_DIR`）
    - `serviceTier: OmpServiceTier`（默认 `""`；枚举 `"" | "none" | "auto" | "default" | "flex" | "scale" | "priority" | "ultrafast"`，作为会话启动 `--service-tier` 传参）
    - `smolModel: TrimmedString`、`slowModel: TrimmedString`、`planModel: TrimmedString`（默认 `""`；可选角色模型，分别对应 `--smol` / `--slow` / `--plan`）
    - `advisor: Schema.Boolean`（默认 `false`；对应 `--advisor`）
    - `warnCostUsd: TrimmedString`、`maxCostUsd: TrimmedString`、`maxTime: TrimmedString`（默认 `""`；Wave 1 先在 Schema/路径边界预留或于 Wave 2 接线消费——**决策：Wave 1 仅暴露 Wave 1 立即生效的字段，费用护栏 3 字段随 Wave 2 额度/成本治理 PR 一起上线，避免死配置**）
- **`packages/provider-omp/src/server/paths.ts`（跨 Wave 共享路径事实源）**：
  - 对外导出：`isValidOmpProfileName`、`resolveOmpInstancePaths`、`OmpInstancePaths`
  - 解析优先级（实测对齐 `omp v19.2.1`）：
    1. `profile`（一等字段 > `launchArgs` 中 `--profile` > 实例显式 `OMP_PROFILE`；精确 `"default"` 按 `omp v19.2.1` 行为归一化为未设置）→ `<home>/.omp/profiles/<profile>/agent`
    2. `agentDir`（一等字段，仅注入当前 omp 子进程 `PI_CODING_AGENT_DIR`）→ `path.resolve(expandHomePath(agentDir, home))`
    3. 历史兼容：实例显式 `OMP_CODING_AGENT_DIR`（不含宿主 `PI_CODING_AGENT_*`）→ `path.resolve(expandHomePath(dir, home))`
    4. 默认：`<home>/.omp/agent`
  - 同步返回 `{ agentDir, sessionsDir, dbPath, profile, extraSessionDirs }`（`sessionsDir` 同时尊重 `OMP_CODING_AGENT_SESSION_DIR` 与 `launchArgs` `--session-dir`）。
- **`packages/provider-pi/src/server/dialect.ts`（`PiDialect` 最小扩展点）**：
  - `PiDialectLaunchInput.extraRoots?: ReadonlyArray<string>`（供多目录线程透传 `--add-dir`）
  - `PiDialect.thinkingLevels?: ReadonlySet<string>`（允许方言声明其 RPC 支持的思考级别集合，omp 含 `"auto"`，Pi 保持默认 7 档不变）

## 2. Wave DAG 与 PR 拆解

| Wave | PR / 分支                     | OpenSpec 档位 | 文件归属围栏（Exclusive Ownership）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | 依赖   | 状态 / PR / SHA               |
| ---- | ----------------------------- | ------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ | ----------------------------- |
| 1    | `feat/omp-ecosystem-wave1`    | L2 Full Spec  | `packages/provider-omp/src/{settings.ts,server/{paths,dialect,adapter,status,modelCapabilities,textGeneration,maintenance,driver,usage}*.ts}`、`packages/provider-pi/src/server/{dialect,adapter}.ts`（最小 `// fork:` 钩子）、`apps/web/src/components/settings/{ProviderSettingsForm.tsx,customModelEditor.logic.ts}`、`apps/web/src/i18n/translations/*.json`、`docs/user/providers-omp.md`、`openspec/{epics/omp-ecosystem.md,specs/omp-provider-core/spec.md,changes/archive/2026-11-25-omp-ecosystem-wave1/**}` | 无     | Merged (PR #25, `bfdbcfba6a`) |
| 2a   | `feat/omp-limits-budget`      | L2 Full Spec  | `packages/provider-omp/src/{settings.ts,server.ts,server/{dialect,protocol}*.ts}`、`apps/server/src/usage/{UsageLimitSources.ts,sources/omp.ts}`、`apps/web/src/fork/hud/*`（OMP 子后端配额映射）、`apps/web/src/components/{chat/ThreadDetailsPanel.tsx,settings/ProviderSettingsForm*}`、`apps/web/src/i18n/translations/*.json`、`docs/user/providers-omp.md`、`openspec/{specs/omp-limits-budget/spec.md,changes/archive/2026-11-26-omp-limits-budget/**}`                                                        | Wave 1 | Merged (PR #27, `53dfaf9b05`) |
| 2b   | `feat/omp-session-import`     | L1+           | `packages/contracts/src/agentSessions.ts`、`packages/provider-omp/src/server/{sessionLease,adapter}*.ts`、`apps/server/src/project/{AgentSessionScanner,AgentSessionImporter}*.ts`、`apps/web/src/components/onboarding/WelcomePage.tsx`（0 `i18n` 编辑）、`openspec/changes/archive/2026-11-26-omp-session-import/**`                                                                                                                                                                                                | Wave 1 | Ready for PR (Archived)       |
| 3a   | `feat/omp-orchestration-rich` | L2 Full Spec  | `packages/provider-omp/src/server/{orchestration,taskSubagent,todoPlan,protocol,adapter,dialect}*.ts`、`apps/server/src/orchestration-v2/testkit/fixtures/*/omp_*`（前置真机 `rpc` / `rpc-ui` 协议抽样真值表）                                                                                                                                                                                                                                                                                                        | Wave 1 | Planned                       |
| 3b   | `feat/omp-auth-controller`    | L1+           | `packages/provider-omp/src/server/{auth,driver}*.ts`（`ProviderAuthController` 封装 `omp login [provider]`）                                                                                                                                                                                                                                                                                                                                                                                                          | Wave 1 | Planned                       |

## 3. 并行低冲突合流约定

- **i18n 单写者**：同一 Wave 内最多 1 个 PR 编辑 `apps/web/src/i18n/translations/*.json`（Wave 1 由 `feat/omp-ecosystem-wave1` 独占；Wave 2 由 `feat/omp-limits-budget` 独占；Wave 3 由 `feat/omp-orchestration-rich` 独占）。
- **共享台账推迟**：`FORK.md` 文末「分叉改动台账」与 `LESSONS.md` 统一在各 PR 合并收尾或 Wave Closeout 同步更新，避免并行 PR 在根 Markdown 尾部冲突。
- **Dogfood 门禁**：Wave 1 涉及设置表单、模型选项、Text Generation 与自更新体验，完成后在独立 worktree 执行 `bash fork/scripts/install-local-mac.sh <ver>` 真机验收；Wave 2 / Wave 3 各自在 Wave Closeout 汇总一次本地 DMG 真机验收。
