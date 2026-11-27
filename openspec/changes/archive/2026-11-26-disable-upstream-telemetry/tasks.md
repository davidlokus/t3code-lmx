# Tasks

## 1. Shared、Contracts 与 Server 遥测出口切断

- [x] 1.1 更新 `packages/shared/src/otelEnvironment.ts`：新增 `isDoNotTrackEnabled(env)` 并将 `isRelayTracingEnabled(env)` 改为默认 `false`（opt-in 且受 `DO_NOT_TRACK` 拦截）；更新 `packages/shared/src/otelEnvironment.test.ts` 并运行 `vp test run packages/shared/src/otelEnvironment.test.ts` 验证。
- [x] 1.2 更新 `packages/contracts/src/resourceTelemetry.ts`：在 `ShellEnvironmentPatch` 增加可选字段 `DO_NOT_TRACK`；运行 `vp run --filter @t3tools/contracts typecheck` 验证。
- [x] 1.3 更新 `apps/server/src/telemetry/AnalyticsService.ts` 与 `apps/server/src/environment/ServerEnvironment.ts`：移除官方 PostHog Key 与 `https://ingest.t3.codes` 默认值、默认关闭遥测、支持 `DO_NOT_TRACK`、禁用态不创建 `anonymous-id` 且不启后台 flush 循环，并将 `capabilities.agentFeedback` 设为 `false`；更新 `AnalyticsService.test.ts`、`relayTracing.test.ts`、`publicConfig.test.ts`、`ServerEnvironment.test.ts` 并运行单测验证。

## 2. Desktop、Web 与 Mobile 隐私默认收敛

- [x] 2.1 更新 `apps/desktop/src/shell/DesktopShellEnvironment.ts` 与 `apps/desktop/src/backend/DesktopBackendConfiguration.ts` 补齐 `DO_NOT_TRACK` 采集/缓存/WSL 透传；更新 `DesktopShellEnvironment.test.ts`、`DesktopBackendConfiguration.test.ts`、`apps/desktop/src/ipc/methods/window.test.ts` 并运行桌面单测验证。
- [x] 2.2 更新 `apps/web/src/components/cloud/ConnectOnboardingDialog.tsx` 将 `publishAgentActivity` 初始默认值改为 `false`；运行 `vp run --filter @t3tools/web typecheck` 与相关测试验证。
- [x] 2.3 更新 `apps/mobile/app.config.ts`、`apps/mobile/src/features/observability/{diagnosticsSetting,ConnectionTracesSwitch,observe}.ts` 与 `apps/mobile/src/features/diagnostics/SettingsDiagnosticsRouteScreen.tsx` 移除默认 Axiom URL 并将崩溃上报与连接追踪改为 opt-in 默认关闭；运行 `vp run --filter @t3tools/mobile typecheck` 与 `apps/mobile/src/features/cloud/publicConfig.test.ts` 验证。

## 3. Fork 守卫与收尾验证（Verification & Fork Closeout）

- [x] 3.1 在 `packages/shared/src/forkIdentity.guard.test.ts` 新增官方遥测/PostHog/Axiom/`DO_NOT_TRACK`/`agentFeedback`/Connect 默认值守卫测试，运行 `vp test run packages/shared/src/forkIdentity.guard.test.ts` 通过。
- [x] 3.2 执行 `Broken by hand` 手工证伪（临时恢复官方默认遥测值/开关，确认守卫与单测真实 `FAIL`，再恢复通过）。
- [x] 3.3 运行 `vp run check:changed origin/lmx-lab` 与 `vp test run packages/shared/src/forkIdentity.guard.test.ts` 全绿；补跑 `apps/desktop/scripts/main-process-bundle.test.mjs` 通过，更新 `FORK.md` 分叉改动台账，并汇总三段式审计证据（`Verified` / `Broken by hand` / `Not tried`）。
