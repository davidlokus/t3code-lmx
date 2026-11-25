# Tasks: omp 生态级接入 Wave 1 — 底座与核心闭环

## 1. Group 1：配置契约、统一路径事实源与启动参数护栏（`packages/provider-omp` + `packages/provider-pi`）

- [x] 1.1 在 `packages/provider-omp/src/settings.ts` 中为 `OmpSettings` 新增向后兼容的一等字段（`profile`、`agentDir`、`serviceTier`、`smolModel`、`slowModel`、`planModel`、`advisor`）及表单排序与注解，验证旧版 4 字段配置可无损解码且 `vp run --filter @t3tools/provider-omp typecheck` 通过
- [x] 1.2 新增 `packages/provider-omp/src/server/paths.ts` 与 `paths.test.ts` 实现 `isValidOmpProfileName` 与 `resolveOmpInstancePaths`（严格对齐 `profile > agentDir > OMP_CODING_AGENT_DIR > ~/.omp/agent` 优先级并严禁继承宿主 `PI_CODING_AGENT_*`），接入 `packages/provider-omp/src/server/usage.ts` 与 `usage.test.ts` 回归覆盖多 profile / `agentDir` / Pi 环境变量防泄漏，执行 `vp test run packages/provider-omp/src/server/paths.test.ts packages/provider-omp/src/server/usage.test.ts` 全绿
- [x] 1.3 扩展 `packages/provider-pi/src/server/dialect.ts` 与 `packages/provider-pi/src/server/adapter.ts` 的最小 `// fork:` 钩子（`PiDialectLaunchInput.extraRoots` 与 `PiDialect.thinkingLevels`），在 `packages/provider-omp/src/server/{dialect,adapter,modelCapabilities}.ts` 中实现一等设置转启动参数、与 `launchArgs` 的冲突拦截、`extraRoots` 去重转 `--add-dir`、实例专属 `PI_CODING_AGENT_DIR` 注入与 `thinking=auto` 能力透传，并补全 `dialect.test.ts` 与 `adapter.test.ts` 单测后执行 `vp test run packages/provider-omp/src/server/dialect.test.ts packages/provider-omp/src/server/adapter.test.ts` 与 `vp run --filter @t3tools/provider-pi typecheck` 全绿

## 2. Group 1：Text Generation、模型目录刷新与可验证自更新（`packages/provider-omp`）

- [x] 2.1 新增 `packages/provider-omp/src/server/textGeneration.ts` 与 `textGeneration.test.ts` 实现 `makeOmpTextGeneration`（短生命周期无工具 RPC、`smolModel` 默认优先回退、`thinking=auto`、错误脱敏与超时回收），更新 `status.ts` 与 `status.test.ts` 在就绪且有模型时开启 `supportsTextGeneration`，执行 `vp test run packages/provider-omp/src/server/textGeneration.test.ts packages/provider-omp/src/server/status.test.ts` 全绿
- [x] 2.2 新增 `packages/provider-omp/src/server/maintenance.ts` 与 `maintenance.test.ts` 实现所有权与可写性证明（拦截 Nix/Homebrew/MacPorts/mise/`node_modules`/不可写目录回退 `manual-only`）及 `omp update --check` 输出解析，在 `packages/provider-omp/src/server/driver.ts` 接入 `makeOmpTextGeneration`、`OMP_MAINTENANCE_RESOLVER` 与 `refreshModels`（`omp models refresh --no-extensions`），执行 `vp test run packages/provider-omp/src/server/maintenance.test.ts packages/provider-omp/src/server/driver.test.ts`（或全量 `packages/provider-omp/src/server/*.test.ts`）与 `vp run --filter @t3tools/provider-omp typecheck` 全绿

## 3. Group 2：Web 设置表单本地化、自定义模型预设与用户文档（`apps/web` + `docs`）

- [x] 3.1 更新 `apps/web/src/components/settings/ProviderSettingsForm.tsx` 的 `PACKAGE_FIELD_TEXT` 补齐新增 `OmpSettings` 字段标题/描述/选项翻译条目，并在 `apps/web/src/components/settings/customModelEditor.logic.ts` 为 `omp` 思考预设追加 `auto`（不改动 Pi 预设），运行 `vp run i18n:generate` 并补全全部 10 个 `apps/web/src/i18n/translations/*.json` 翻译后验证 `vp run i18n:check` 与相关 Web 单测全绿
- [x] 3.2 更新 `docs/user/providers-omp.md`（修正过时的 `/usage` 历史声明，补充 `Profile`、`Agent directory`、`Service tier`、角色模型、Text Generation 与 `omp update` 文档），核对与实现完全一致

## 4. Group 3：交叉只读 Review、手工证伪与全套 Fork 门禁

- [x] 4.1 在通过本地 Pre-Review 门禁（`vp fmt --check`、`vp lint`、受影响 `typecheck` 与单测）后，启动异构模型全新只读 Reviewer 对 `git diff <plan-sha>` 执行 `openspec-verify-change omp-ecosystem-wave1` 并闭环所有 `CRITICAL`/`WARNING` 发现（含核对无冗余导出，确保 `knip:check:exports` 绿灯）
- [x] 4.2 执行「Broken by hand」手工证伪（依次临时破坏 `paths.ts` 的 Pi 环境变量隔离守卫与 `maintenance.ts` 的只读/Nix 拦截守卫，确认对应新单测真实 `FAIL` 后恢复）
- [x] 4.3 执行完整门禁验证：`vp run check:changed origin/lmx-lab`、`vp test run packages/shared/src/forkIdentity.guard.test.ts`、`vp run i18n:check`，并记录三段式审计证据（`Verified` / `Broken by hand` / `Not tried`）
- [ ] 4.4 在当前功能 worktree 执行 `bash fork/scripts/install-local-mac.sh <ver>`（严禁设置 `T3CODE_DESKTOP_UNTRUSTED_BUNDLE=true`）完成本地真机试装验收：核对设置页新字段、模型 `Auto` 思考强度、Text Generation（标题生成）、模型刷新与更新提示均正常且 `~/.t3/userdata` 零触碰

## Workflow follow-up

- 真机 Dogfood 验收通过后，执行 `openspec-archive-change omp-ecosystem-wave1` 归档规格与变更记录，并同步更新 `openspec/epics/omp-ecosystem.md` 中的 Wave 1 状态。
- 评估并同步更新 `FORK.md` 文末「分叉改动台账」与 `LESSONS.md`（推进 `reviewed-through` 或注明无新教训）。
- 仅在用户明确要求时向 `davidlokus/t3code-lmx`（`--base lmx-lab`）提 PR，等待 `Fork CI` 全绿并 `--match-head-commit <sha> --squash` 合入后用 `node fork/scripts/worktree-task.mjs close omp-ecosystem-wave1` 回收 worktree。
