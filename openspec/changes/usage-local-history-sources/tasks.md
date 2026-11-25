# Tasks

## 1. Group 1 — Contracts, Opt-in Settings & 4 Local Usage Sources (`omp` Worker)

- [ ] 1.1 扩展契约与设置：`packages/contracts/src/usage.ts`（`UsageProviderKind` 增加 `"kimi"`、`"zai"`）、`packages/contracts/src/settings.ts`（新增默认全 `false` 的 `UsageLocalHistorySourcesSettings` 与 `ServerSettingsPatch.usageLocalHistorySources`），同步补全 Web/Mobile 穷举映射（`apps/web/src/components/usage/usageProviders.ts`、`apps/mobile/src/features/usage/{usageProviders,providerColors}.ts`）。
  - Verify: `vp test run packages/contracts/src/settings.test.ts && vp run --filter @t3tools/contracts --filter @t3tools/web --filter @t3tools/mobile typecheck`
- [ ] 1.2 实现 `apps/server/src/usage/localSources/kimiCli.ts` 及 `kimiCli.test.ts`：扫描 `~/.kimi-code/server/events/session_*.jsonl`，提取 `turn.step.completed` 用量、`inputOther`/`inputCacheRead`/`inputCacheCreation`/`output`、`session_id`、`(size, mtimeMs)` 增量缓存、去重键 `kimiCli:<sessionId>:<stepId|seq>`、缺失目录与坏行容错。
  - Verify: `vp test run apps/server/src/usage/localSources/kimiCli.test.ts`
- [ ] 1.3 实现 `apps/server/src/usage/localSources/zcode.ts` 及 `zcode.test.ts`：`node:sqlite` `{ readOnly: true }` 查询 `~/.zcode/cli/db/db.sqlite` 的 `model_usage`，仅统计 `status='completed'` 且 BigModel/Z.ai 行，扣除 `input_tokens` 缓存重叠并约束 `reasoning_tokens <= output_tokens`，缺失库不建空文件、损坏库隔离为 `failed`。
  - Verify: `vp test run apps/server/src/usage/localSources/zcode.test.ts`
- [ ] 1.4 实现 `apps/server/src/usage/localSources/magpie.ts` 及 `magpie.test.ts`：扫描 `$MAGPIE_CONFIG_DIR/usage.jsonl` / `~/.config/magpie/usage.jsonl`，过滤非 chat 行，严格排除 T3 原生 Agent（`claude`/`codex`/`omp`/`cursor`/`opencode`/`pi`/`grok`/`antigravity`/`muse`/`t3code`/`magpie`）及已开启的 `kimi*`/`zcode` agent，按 `response_id ?? route:<route_id> ?? rid` 去重，剥离路由前缀并归因至上游 `UsageProviderKind`。
  - Verify: `vp test run apps/server/src/usage/localSources/magpie.test.ts`
- [ ] 1.5 实现 `apps/server/src/usage/localSources/claudeSwap.ts` 及 `claudeSwap.test.ts`：只读解析 `~/.claude-swap-backup/configs/.claude-config-<slot>-<email>.json` 与 `cache/usage.json`（严格 `schemaVersion === 2`、双向 2h 新鲜度、槽位重编号 `organizationUuid`/`email` 围栏、排除活跃 `~/.claude.json` 账号防双计、`lastError` 告警与绝不读 Keychain / 刷新 token 不变量）。
  - Verify: `vp test run apps/server/src/usage/localSources/claudeSwap.test.ts`
- [ ] 1.6 编写 `apps/server/src/usage/localSources/index.ts` 并接入 `apps/server/src/usage/UsageService.ts`，在 `UsageService.test.ts` 中补充集成测试：验证默认全部关闭零扫描、开启 `kimiCli`/`zcode`/`magpie` 后正确聚合及与原生 transcript 零双计。
  - Verify: `vp test run apps/server/src/usage/UsageService.test.ts apps/server/src/usage/localSources/ && vp run --filter t3 typecheck`

## 2. Group 2 — Post-PR-3b Rebase Wiring & `agy` Independent Cross-Review

- [ ] 2.1 PR 3b 合入 `origin/lmx-lab` 后，rebase 本分支至最新 `origin/lmx-lab`，将 `claudeSwap` opt-in 只读缓存接入 `apps/server/src/usage/UsageLimitSources.ts`（带活跃 Claude 账号去重、失败保留与 `UsageLimitSources.test.ts` 测试），确认 `knip:check:exports` 零未使用导出。
  - Verify: `vp test run apps/server/src/usage/UsageLimitSources.test.ts apps/server/src/usage/localSources/claudeSwap.test.ts`
- [ ] 2.2 Coordinator（`agy`，Author ≠ Reviewer 异构模型）对 `git diff <plan-sha>` 与全部新增文件进行独立只读跨模型审查（核对真实载荷、防双计、只读安全与 `knip`），修复全部 CRITICAL/WARNING 发现。
  - Verify: 审查结论 0 CRITICAL / 0 WARNING 且已 `hc kill` 清理子 worker

## 3. Group 3 — Falsification, Archive & Fork Closeout

- [ ] 3.1 执行 `Broken by hand` 证伪验证（至少破坏一项 Magpie 原生 Agent 排除防双计检查与一项 `claudeSwap` 活跃账号/槽位重编号围栏并确认单测变红，再恢复变绿）。
  - Verify: 记录完整 RED → GREEN 证伪输出
- [ ] 3.2 归档 OpenSpec（`openspec archive usage-local-history-sources --skip-specs --yes`），运行全套 Fork 门禁并提交开 PR 合并至 `origin/lmx-lab`。
  - Verify: `vp run check:changed origin/lmx-lab && vp test run packages/shared/src/forkIdentity.guard.test.ts`
