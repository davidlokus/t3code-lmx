# Tasks

## 1. Epic Charter 模板与 Worktree 生命周期脚本

- [x] 1.1 新建 `openspec/epics/README.md`，定义单页 Epic Charter 模板与字段约定（冻结契约、Wave DAG、文件归属围栏、PR 状态表、跨 PR 不变量）；验证 `openspec/epics/*.md` 被 `.github/scripts/ci-changes.cjs` 判为惰性（`affected: []`）
- [x] 1.2 实现零外部依赖 Node ESM 脚本 `fork/scripts/worktree-task.mjs`（支持 `open` / `status` / `close`、`--dry-run`、`--json`、`--no-fetch`、`--no-install`、`--force`、`--keep-branch`、`.t3/setup-running` 活 PID 保护及主仓/受保护分支/当前目录/脏区拦截），满足 `t3code/namespace-node-imports` 与 `t3code/no-global-process-runtime`；验证 `vp lint fork/scripts/worktree-task.mjs` 与 `node fork/scripts/worktree-task.mjs status`
- [x] 1.3 编写隔离临时 Git 仓库自动化单测 `fork/scripts/worktree-task.test.mjs`，覆盖 `open`（正常开仓、非法 slug 拒绝、非 Fork origin 拒绝、`--dry-run`、活 PID `.t3/setup-running` 跳过安装）、`status`（JSON 输出、脏状态、active OpenSpec 识别）与 `close`（正常清理、拒绝主仓/受保护分支/脏工作区/当前目录、`--force` 与 `--keep-branch`）；验证 `vp test run fork/scripts/worktree-task.test.mjs` 全绿

## 2. 工作流规范文档、OpenSpec 模板与守卫测试

- [x] 2.1 更新 `.agents/skills/t3lab-dev/SKILL.md`、`.agents/skills/t3lab-dev/references/handoff.md` 与 `.agents/skills/t3lab-dev/references/fork-gates.md`，固化 Epic Charter、L1+ 增量 Provider 路由、异构 Author ≠ Reviewer、全新只读 Reviewer 会话、并行 Wave（2–3 worktree）低冲突纪律、四象限防御矩阵、Wave 级 Dogfood 与 `worktree-task.mjs` 用法；验证 `vp fmt --check` 通过且保留既有守卫条款
- [x] 2.2 更新 `openspec/config.yaml` 与 `openspec/schemas/t3lab-light/templates/proposal.md`，补齐 Epic 关联与四象限防御检查规则；验证 `openspec status --change epic-workflow` 正常
- [x] 2.3 扩展 `packages/shared/src/forkIdentity.guard.test.ts`，守卫 `fork/scripts/worktree-task.mjs`、`openspec/epics/README.md`、`handoff.md` 异构/全新只读审查及 `worktree-task.mjs` 条款、`openspec/epics/` CI 惰性；验证 `vp test run packages/shared/src/forkIdentity.guard.test.ts` 全绿

## 3. Verification & Fork Closeout

- [x] 3.1 执行 `Broken by hand` 手工证伪：临时破坏 `fork/scripts/worktree-task.mjs` 的脏工作区关闭拦截守卫，运行 `vp test run fork/scripts/worktree-task.test.mjs` 确认断言失败并记录失败原因，随后还原复跑全绿
- [x] 3.2 运行重门禁：`vp run check:changed origin/lmx-lab` 与 `vp test run packages/shared/src/forkIdentity.guard.test.ts` 全部通过（确认 `fork/scripts/worktree-task.test.mjs`、`fmt`、`lint`、`knip`、受影响 `typecheck` 全绿）
- [x] 3.3 归档 OpenSpec 变更（`openspec archive "epic-workflow" --skip-specs --yes`），更新 `FORK.md` 分叉改动台账，审计 `LESSONS.md` 并更新 `reviewed-through`，最后汇总三段式审计证据（`Verified` / `Broken by hand` / `Not tried`）
