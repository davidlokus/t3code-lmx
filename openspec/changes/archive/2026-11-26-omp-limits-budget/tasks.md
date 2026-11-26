# Tasks: omp 生态级接入 Wave 2a — 额度、HUD 子后端映射与费用/时长护栏

## 1. Group 1：费用/时长护栏、RPC 通知与自动配额源（`packages/provider-omp` + `apps/server`）

- [x] 1.1 在 `packages/provider-omp/src/settings.ts` 新增向后兼容的一等字段 `warnCostUsd`、`maxCostUsd`、`maxTime`（按 design.md 精确文案、`clearWhenEmpty: "omit"`、排序位于 `advisor` 与 `launchArgs` 之间），在 `packages/provider-omp/src/server/dialect.ts` 实现正数 USD 与 `omp v19.2.1` 时长语法校验、与 `launchArgs` 的冲突拦截、会话透传及 `shortLived` 剥离，补全 `dialect.test.ts` 并验证 `vp test run packages/provider-omp/src/server/dialect.test.ts && vp run --filter @t3tools/provider-omp typecheck`。
- [x] 1.2 在 `packages/provider-omp/src/server/protocol.ts` 将 `omp` 的 `{ type: "notice", level, message }` 翻译为通知帧，并处理 `prompt_result` 的 `cost_cap` 错误（与同文错误 `notice` 去重且在回合边界重置），补全 `protocol.test.ts` 并验证 `vp test run packages/provider-omp/src/server/protocol.test.ts`。
- [x] 1.3 在 `packages/provider-omp/src/server.ts` 导出 `isValidOmpProfileName` / `resolveOmpInstancePaths` / `OmpInstancePaths`；升级 `apps/server/src/usage/sources/omp.ts` 的 `resolveOmpDbPath`（支持 `omp://default` 的 `OMP_PROFILE` 优先级、`omp://profile/<name>` 校验且绝不读 `PI_CODING_AGENT_*`）及零 sidecar 只读 SQLite 读取（缺失/干净库用 `?immutable=1`，活跃 WAL+SHM 只读打开，孤儿 WAL/rollback journal 返回错误，保持 `quotaAccounts` 不绑定 `providerInstanceId` 以防旧版面板串流），补全 `omp.test.ts` 并验证 `vp test run apps/server/src/usage/sources/omp.test.ts`。
- [x] 1.4 在 `apps/server/src/usage/UsageLimitSources.ts` 自动为启用的 `omp` 实例读取各自 `paths.dbPath`（与手动 `kind: "omp"` 源按规范 `dbPath` 去重防双读/双计、缺失 `agent.db` 静默省略、响应实例启停与配置变更并在 `withSettingsSnapshot` 原子防禁用后回流、保留 `keepLastGoodReadings`），补全 `UsageLimitSources.test.ts` 并验证 `vp test run apps/server/src/usage/UsageLimitSources.test.ts && vp run --filter t3 typecheck`。

## 2. Group 2：HUD 子后端配额映射、设置表单 10 语言本地化与文档（`apps/web` + `docs`）

- [x] 2.1 在 `apps/web/src/fork/hud/hudMetrics.logic.ts` 实现 `resolveOmpThreadHudLimits` 并接入 `apps/web/src/fork/hud/ThreadHudSections.tsx`（含 `useHudLegacySuppression`），仅展示与当前 `omp` 活动模型子后端匹配的配额窗口、无匹配时诚实隐藏，补全 `hudMetrics.logic.test.ts` 与 `hudUi.browser.test.tsx` 回归用例并验证全绿。
- [x] 2.2 更新 `apps/web/src/components/settings/ProviderSettingsForm.tsx` 的 `PACKAGE_FIELD_TEXT` 与 `ProviderSettingsForm.test.ts`，执行 `vp run --filter @t3tools/web i18n:generate` 并补全全部 10 个 `apps/web/src/i18n/translations/*.json` 翻译，同步更新 `docs/user/providers-omp.md`，验证 `vp run i18n:check` 与 Web typecheck/单测全绿。

## 3. Group 3：独立跨模型只读 Review、手工证伪与 Fork 收尾

- [x] 3.1 通过本地 Pre-Review 门禁后，拉起异构模型全新只读 Reviewer 对 `git diff <plan-sha>` 执行 `openspec-verify-change omp-limits-budget`，修复全部 CRITICAL/WARNING 发现并清理 `hc` 子会话。
- [x] 3.2 执行 `Broken by hand` 证伪验证（至少破坏 `dialect.ts` 费用/时长校验守卫与 `sources/omp.ts` `PI_*` 隔离或 `UsageLimitSources.ts` `dbPath` 去重守卫并确认单测真实 RED → GREEN）。
- [x] 3.3 归档 OpenSpec（同步 `omp-limits-budget` 主规格并归档变更）、更新 `openspec/epics/omp-ecosystem.md` / `FORK.md` / `LESSONS.md`，运行 `vp run check:changed origin/lmx-lab`、`vp test run packages/shared/src/forkIdentity.guard.test.ts`、`vp run i18n:check`，开 PR 合入 `origin/lmx-lab` 并回收 worktree。
