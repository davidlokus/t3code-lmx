# Tasks: Usage Limits Intelligence (Wave 1 / PR 1)

## 1. Group 1 — Contracts, Provider-Core Preservation & Shared Intelligence Engine (`omp`)

- [ ] 1.1 扩展 `packages/contracts/src/providerUsageLimits.ts`：新增向后兼容可选字段（`ServerProviderUsageWindow`: `usedAmount`, `limitAmount`, `remainingAmount`, `unit`, `category`, `scopeLabel`；`ServerProviderUsageBalance`；`ServerProviderUsageLimits`: `subscriptionExpiresAt`, `planTier`, `balances`, `serviceNotice`）；验证 `vp run --filter @t3tools/contracts typecheck`
- [ ] 1.2 更新 `packages/provider-core/src/server/usageLimits.ts` 与 `usageLimits.test.ts`：在 `applyUsageLimitsUpdate` 与 `usageWindowEquals` 中保留新增窗口级与账号级可选字段，补充流式增量不丢字段单测；验证 `vp test run packages/provider-core/src/server/usageLimits.test.ts`
- [ ] 1.3 新增 `packages/shared/src/usageLimitsIntelligence.ts`、`packages/shared/src/usageLimitsIntelligence.test.ts` 及 `packages/shared/package.json` `./usageLimitsIntelligence` 导出：实现 Hermes 兼容的 `computeWindowBurnPace` 与 `collectLimitsIntelligence`（覆盖旧服缺字段、过早样本期、提前耗尽预测、CLIProxyAPI + HTTP `quotaAccounts` 统一汇总、同窗口告警合并、三类到期排序与手动覆写优先级），仅导出 `design.md` 声明的公开符号；验证 `vp test run packages/shared/src/usageLimitsIntelligence.test.ts` 与 `vp lint packages/shared/src/usageLimitsIntelligence.ts`
- [ ] 1.4 扩展 `apps/web/src/fork/usage/usageOptionsStore.ts` 与 `apps/web/src/fork/usage/usageDashboard.logic.ts` + `usageDashboard.logic.test.ts`：新增向后兼容持久化字段（`limitsLens`, `limitsLayout`, `quotaDisplayMode`, `resetTimeMode`, `alertThresholdPercent`, `manualSubscriptionOverrides`）及清洗/默认值测试，并实现 `computeUsageStreak`（含昨天宽容与 `reachesWindowStart` 边界测试）；验证 `vp test run apps/web/src/fork/usage/usageDashboard.logic.test.ts` 与 `vp run --filter @t3tools/shared --filter @t3tools/provider-core --filter @t3tools/contracts typecheck`

## 2. Group 2 — Four-Lens Limits UI, Overview Streak, i18n & Visual QA (`agy`)

- [ ] 2.1 为 `apps/web/src/components/usage/UsageLimitsPooled.tsx` 与 `UsageLimits.tsx` 添加最小 `// fork:` 可选 props（`quotaDisplayMode`、`resetTimeMode`），默认行为保持 100% 兼容上游；验证 `vp test run apps/web/src/components/usage/UsageLimitsPooled.browser.test.tsx`
- [ ] 2.2 在 `apps/web/src/fork/usage/` 实现四视角组件与手动覆写弹窗：`UsageLimitsEnhanced.tsx`、`UsageLimitsMatrixView.tsx`、`UsageLimitsResetsView.tsx`、`UsageLimitsAlertsView.tsx`、`UsageLimitsExpiriesView.tsx`、`UsageSubscriptionOverrideDialog.tsx`，严格使用语义色彩 token 且无嵌套 `<Popover>` / 原生 `title`
- [ ] 2.3 同步联动 `UsageQuotaStrip.tsx`（响应 `Left↔Used`、`Countdown↔Exact` 与预计耗尽提醒）、`UsageTopbar.tsx`（`UsageDisplayOptionsMenu` 同步暴露 Limits 显示与阈值选项）、`UsageKpiCards.tsx` 与 `UsageDashboard.tsx`（接入 `computeUsageStreak`）
- [ ] 2.4 编写全面浏览器集成测试 `apps/web/src/fork/usage/usageLimitsIntelligence.browser.test.tsx`（覆盖四视角切换、Pool↔Matrix、Left↔Used、Countdown↔Exact、告警阈值联动、手动订阅覆写增改删、旧服缺字段降级、HTTP `quotaAccounts` 展示及 Overview Streak），并回归 `usageDashboard.browser.test.tsx`；验证 `vp test run apps/web/src/fork/usage/usageLimitsIntelligence.browser.test.tsx apps/web/src/fork/usage/usageDashboard.browser.test.tsx`
- [ ] 2.5 运行 `vp run i18n:generate`，补齐全部 10 种语言翻译并通过 `vp run i18n:check`；完成 **Pre-Review Gate**（`vp fmt --check`、`vp lint`、受影响 `typecheck` 与单测全绿）
- [ ] 2.6 在隔离开发态（`vp run dev --no-seed`）使用 `ego-browser` 完成 Light / Dark 双主题视觉与交互 QA，核查无遮挡、无溢出、无控制台报错

## 3. Group 3 — Fresh Cross-Model Review, Falsification & Fork Closeout

- [ ] 3.1 终止 Group 1 `omp` 写作者会话后，启动**全新只读** `omp-review-usage-limits-intelligence` 会话对 `git diff <plan-sha>` 执行 `openspec-verify-change` 四维 + 四象限审查，修复所有真实发现直至 `VERDICT: PASS`，清理所有 `hc` 子进程
- [ ] 3.2 执行 `Broken by hand` 手工证伪（破坏 `computeWindowBurnPace` 过早样本保护或 `applyUsageLimitsUpdate` 富字段保真守卫，确认新单测真正失败后还原复跑全绿）
- [ ] 3.3 运行重门禁：`vp run check:changed origin/lmx-lab`、`vp test run packages/shared/src/forkIdentity.guard.test.ts`、`vp run i18n:check` 全部通过；按需执行 Wave 1 本地 macOS 试装验收（`bash fork/scripts/install-local-mac.sh <ver>`），归档 OpenSpec，更新 `openspec/epics/usage-subscriptions.md` 与 `FORK.md` / `LESSONS.md`，汇总三段式审计证据
