# Tasks: omp 生态级接入 Wave 2b — 终端会话导入与跨进程 Session Lease

## 1. Group 1：跨进程 Session Lease 与 Adapter 接线（`packages/provider-omp`）

- [x] 1.1 新增 `packages/provider-omp/src/server/sessionLease.ts` 与 `sessionLease.test.ts`：实现 `OmpSessionLeaseConflictError` 与 `acquireOmpSessionLease`（`<agentDir>/t3-session-leases/<sha256>.lock.json` 原子 `wx` 建锁、同进程互斥、活 PID 冲突拦截、死 PID `ESRCH` 陈旧锁自动回收与 `Scope` 释放 `token` 核验），验证 `vp test run packages/provider-omp/src/server/sessionLease.test.ts`。
- [x] 1.2 在 `packages/provider-omp/src/server.ts` 导出 `isValidOmpProfileName` / `resolveOmpInstancePaths` / `OmpInstancePaths`，并在 `packages/provider-omp/src/server/adapter.ts` 的 `connect` 包装器中为 `--resume <sessionPath>` 常规会话接入 `acquireOmpSessionLease`（排除 `--no-session` 与 `--fork`），补全 `adapter.test.ts` 并验证 `vp test run packages/provider-omp/src/server/adapter.test.ts && vp run --filter @t3tools/provider-omp typecheck`。

## 2. Group 1：终端 `omp` 会话扫描、导入与 Onboarding 映射（`packages/contracts` + `apps/server` + `apps/web`）

- [x] 2.1 在 `packages/contracts/src/agentSessions.ts` 向 `AgentSessionSource` 增加 `"omp"` 并将 `AgentSessionProjectCandidate.sources` 改为 `ForwardCompatibleArray(AgentSessionSource)`；同步更新 `apps/web/src/components/onboarding/WelcomePage.tsx` 的 `IMPORT_SOURCE_NAMES`（`omp: "omp"`）与 4 列图标网格，验证 `vp run --filter @t3tools/contracts --filter @t3tools/web typecheck`。
- [x] 2.2 在 `apps/server/src/project/AgentSessionScanner.ts` 接入已启用 `omp` 实例的目录解析（复用 `resolveOmpInstancePaths` 且严禁继承宿主 `PI_CODING_AGENT_*`）与 `omp` JSONL 解析（首行 `type: "title"`、次行 `type: "session"`、`activePiBranch` 树、`model_change` 模型提取），在 `apps/server/src/project/AgentSessionImporter.ts` 将 `omp` 绑定到 `source.filePath`，补全 `AgentSessionScanner.test.ts` 与 `AgentSessionImporter.test.ts` 并验证 `vp test run apps/server/src/project/AgentSessionScanner.test.ts apps/server/src/project/AgentSessionImporter.test.ts && vp run --filter t3 typecheck`。

## 3. Group 2：独立跨模型只读 Review、手工证伪与 Fork 收尾

- [x] 3.1 通过本地 Pre-Review 门禁（`fmt`/`lint`/`knip:check:exports`/`typecheck`/单测）后，启动异构模型全新只读 Reviewer 对 `git diff <plan-sha>` 执行 `openspec-verify-change omp-session-import`，修复全部 CRITICAL/WARNING 发现并清理 `hc` 子会话。
- [x] 3.2 执行 `Broken by hand` 证伪验证（至少破坏 `sessionLease.ts` 活 PID 冲突守卫与 `AgentSessionScanner.ts` `PI_*` 隔离守卫，确认单测真实 RED → GREEN）。
- [x] 3.3 归档 OpenSpec（`openspec/changes/archive/2026-11-26-omp-session-import`）、更新 `openspec/epics/omp-ecosystem.md` / `FORK.md` / `LESSONS.md`，运行 `vp run check:changed origin/lmx-lab`、`vp test run packages/shared/src/forkIdentity.guard.test.ts`、`vp run i18n:check`，开 PR 合入 `origin/lmx-lab` 并回收 worktree。
