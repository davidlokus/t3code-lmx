# Proposal

## Why

后续「/usage 订阅额度情报与多源接入」等跨多 PR / 多波次的大型 Fork 需求，需要把单 PR 维度的 `OpenSpec + hc + agy × omp` 协作协议升级为**可并行、低冲突、防返工的 Epic / Wave 编排工作流**，并把高频重复的 worktree 开仓、状态巡检与回收流程脚本化，避免手误和上下文漂移。

## What Changes

1. **Epic Charter 轻量锚点（`openspec/epics/README.md`）**：定义多 PR 大需求的单页总纲规范（冻结契约字段、Wave DAG、单 PR 文件归属围栏、PR 状态与 SHA 追踪、跨 PR 不变量），复用 `openspec/**` 在 CI 中的惰性隔离规则。
2. **多 PR / 多 Wave 异构协作与审查规范（`.agents/skills/t3lab-dev/references/handoff.md`）**：
   - 明确**写审模型异构（Author ≠ Reviewer）**，包括纯后端 PR（`omp` 写 / `agy` 只读审，或反向）；
   - 规定 Group 3 Reviewer **必须使用全新只读会话**（不复用 Group 1 写作者会话，消除盲区）；
   - 规定并行 Wave 编排纪律（同时活跃 worktree 上限 2–3 个、每 worktree 单写者、独立 worker）；
   - 嵌入开写前强制填写的**真实载荷真值表**与**四象限防御矩阵**（沉淀 `LESSONS.md` #5 / #9）；
   - 明确并行 Wave 低冲突合流纪律（同波次最多 1 个 PR 改 `i18n`；`FORK.md` 台账与 `LESSONS.md` 推迟到合入前 rebase 或 Wave 收尾 PR）。
3. **分级仪式与 Wave 级 Dogfood 收口（`.agents/skills/t3lab-dev/SKILL.md`、`.agents/skills/t3lab-dev/references/fork-gates.md`）**：
   - 新增 **L1+（`t3lab-light` + 真实载荷真值表）** 路由指引，用于沿冻结契约增量扩展 Provider/数据源的 PR；
   - 明确本地 macOS DMG 试装（`install-local-mac.sh`）按 **Wave 收尾** 汇总验收，不为纯后端/契约 PR 重复打包；
   - 将 `fork/scripts/worktree-task.mjs` 纳入 `apply.before` 与收尾回收指引。
4. **OpenSpec 规则与轻模板升级（`openspec/config.yaml`、`openspec/schemas/t3lab-light/templates/proposal.md`）**：
   - 在 `proposal` / `design` 规则与 `t3lab-light` 提案模板中嵌入 Epic 关联字段、真实载荷真值表提示与四象限防御检查（旧服缺字段、失败态保留旧值、多账户/实例隔离防双计、缓存版本与失效）。
5. **Worktree 全生命周期脚手架与单测（`fork/scripts/worktree-task.mjs`、`fork/scripts/worktree-task.test.mjs`）**：
   - 零外部依赖 Node ESM CLI，提供 `open` / `status` / `close` 三个子命令：校验 `origin` 指向 `davidlokus/t3code-lmx` 与合法 topic slug、创建相邻 `../t3code-lmx-<topic>` 并尊重 `.t3/setup-running` 活 PID 后执行 `vp i`、汇总所有 worktree 的分支/脏文件/ahead-behind/OpenSpec 变更/依赖状态（含 `--json`）、安全拦截主仓/受保护分支/当前目录/脏工作区回收；
   - 使用隔离临时 Git 仓库编写完整自动化单测。
6. **Fork 守卫测试扩展（`packages/shared/src/forkIdentity.guard.test.ts`）**：
   - 守卫 `fork/scripts/worktree-task.mjs` 与 `openspec/epics/README.md` 存在；
   - 守卫 `handoff.md` 关键条款（异构审查、全新只读 Reviewer、`worktree-task.mjs`）与 `openspec/epics/**` 在 `ci-changes.cjs` 中保持惰性。

## Assumptions

- `fork/scripts/worktree-task.mjs` 默认以 `origin/lmx-lab` 为基线、`feat` 为分支前缀，并按 `../t3code-lmx-<topic>` 命名相邻目录；通过 `--prefix`、`--base`、`--worktree` 支持按需覆写。
- `status` 子命令默认只读离线执行（快速无网络延迟），显式传 `--fetch` 时才先拉取 `origin/lmx-lab`。
- 不改动上游 `.github/scripts/ci-changes.cjs`；`openspec/epics/**` 已由现有 `/^openspec\//` 规则覆盖保持零上游冲突。

## Out of Scope

- 不启动或修改任何「/usage 订阅额度」业务代码或契约（等 PR #15 上游同步合入 `lmx-lab` 后另开 PR 1）。
- 不修改上游 `.github/workflows/*.yml`、`scripts/` 或 `.agents/skills/openspec-*` 自动生成技能。
- 不触碰现有同步 worktree `../t3code-lmx-sync-3e74a0aac5`、主仓 `lmx-lab`/`main` 分支或正式版 `~/.t3/userdata`。

## 上游同步冲突面

- **新增独立文件**：
  - `fork/scripts/worktree-task.mjs`
  - `fork/scripts/worktree-task.test.mjs`
  - `openspec/epics/README.md`
  - `openspec/changes/epic-workflow/*`（归档后迁入 `openspec/changes/archive/`）
- **改动 Fork 自有文件（0 上游冲突）**：
  - `.agents/skills/t3lab-dev/SKILL.md`
  - `.agents/skills/t3lab-dev/references/handoff.md`
  - `.agents/skills/t3lab-dev/references/fork-gates.md`
  - `openspec/config.yaml`
  - `openspec/schemas/t3lab-light/templates/proposal.md`
  - `packages/shared/src/forkIdentity.guard.test.ts`
  - `FORK.md`（分叉改动台账）
  - `LESSONS.md`（复盘核对 `reviewed-through`）
- **上游文件最小 `// fork:` 钩子**：无

## Surface Matrix

| Surface   | Status | Notes                                                                |
| --------- | ------ | -------------------------------------------------------------------- |
| Web       | N/A    | 纯 Fork 工程工作流、脚手架与文档优化，不改动 Web 运行时或 UI         |
| Desktop   | N/A    | 不改动桌面端启动、身份或打包路径                                     |
| Mobile    | N/A    | 不改动移动端代码                                                     |
| Server    | N/A    | 不改动服务端运行时                                                   |
| Contracts | N/A    | 不改动 wire 契约                                                     |
| Providers | N/A    | 不改动 Provider 适配器实现（仅升级协作文档中的 Provider 真值表规范） |
| i18n      | N/A    | 无用户界面文案改动                                                   |
