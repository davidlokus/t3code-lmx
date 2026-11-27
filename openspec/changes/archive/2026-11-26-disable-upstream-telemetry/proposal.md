# Proposal

## Why

当前 Fork（T3 Lab (Extend)）继承了上游 `pingdotgg/t3code` 的产品遥测默认配置：正式打包版默认开启 `AnalyticsService`，向官方 `https://ingest.t3.codes/batch/` 发送带硬编码 PostHog Key 的使用统计并写入 `anonymous-id` 文件；同时尚未支持 `DO_NOT_TRACK`，且保留了上游 Agent Feedback 入口、Connect 向导默认勾选 `publishAgentActivity` 及 Mobile 端默认 Axiom URL / opt-out 诊断开关。需要在 Fork 中采用低冲突出口封堵策略彻底默认切断上游遥测与追踪，并固化到守卫测试中防止未来上游同步回归。

## What Changes

- **Server / Shared 遥测出口硬切断与 `DO_NOT_TRACK` 支持**：
  - 在 `packages/shared/src/otelEnvironment.ts` 新增 `isDoNotTrackEnabled(env)`，并将 `isRelayTracingEnabled(env)` 改为默认 `false`（仅显式 `T3CODE_TELEMETRY_ENABLED=true` 且未设置 `DO_NOT_TRACK` 与 OTel 禁用开关时开启）；保留用户自建 OTLP 导出（`OtelEnvironment.load`）不受影响。
  - 在 `apps/server/src/telemetry/AnalyticsService.ts` 移除官方硬编码 PostHog Key（`phc_XOWci4oZP4VvLiEyrFqkFjP4CZn55mjYYBMREK5Wd6m`）与默认域名 `https://ingest.t3.codes`，将 `T3CODE_TELEMETRY_ENABLED` 默认改为 `false`，接入 `DO_NOT_TRACK` 检查，并在禁用态直接返回零 IO 空实现（不生成 `anonymous-id`、不启 10s flush 后台任务）。
  - 在 `apps/server/src/environment/ServerEnvironment.ts` 将 `capabilities.agentFeedback` 设为 `false`，自动隐藏 Web（Settings → Labs 与设置搜索）及 Mobile 端的官方 Agent Feedback 开关。
- **Contracts / Desktop 登录 Shell 与 WSL 环境变量透传**：
  - 在 `packages/contracts/src/resourceTelemetry.ts`、`apps/desktop/src/shell/DesktopShellEnvironment.ts` 与 `apps/desktop/src/backend/DesktopBackendConfiguration.ts` 补齐 `DO_NOT_TRACK` 透传与缓存，与上游及 Cockpit Tools 环境变量契约一致。
- **Web / Mobile 默认隐私收敛**：
  - 在 `apps/web/src/components/cloud/ConnectOnboardingDialog.tsx` 将「Publish agent activity」初始默认值改为 `false`（已开启环境回填与手动开启保持正常）。
  - 在 `apps/mobile/app.config.ts` 移除默认 `https://api.axiom.co/v1/traces` 回退；将 `apps/mobile/src/features/observability/{diagnosticsSetting,ConnectionTracesSwitch,observe}.ts` 与 `apps/mobile/src/features/diagnostics/SettingsDiagnosticsRouteScreen.tsx` 的连接追踪与崩溃上报默认改为 opt-in（`=== true`）。
- **防上游同步回归守卫**：
  - 在 `packages/shared/src/forkIdentity.guard.test.ts` 新增遥测清理守卫断言，并补齐各受影响模块单元测试。

## Assumptions

- 不逐个删改业务代码中的 `analytics.record(...)` 调用点，而是在出口边界统一切断，最大限度降低后续 `sync/upstream-*` 合并冲突。
- 保留 About 页官方隐私政策外链不变，不改动文案与翻译文件（0 i18n 变更）。
- 保留用户自建 OpenTelemetry OTLP 导出（Settings → Maintenance → Diagnostics）与纯本地资源/上下文遥测（`DesktopTelemetryPublisher`、HUD、Composer 环）。
- 保留移动端 `linkEnvironmentToCloudWithPreference`（显式点击开启手机通知的动作）语义，仅将 Web Connect 引导弹窗的默认勾选改为 `false`。

## Out of Scope

- 不新增类似 Cockpit Tools 的设置页隐私面板 UI 或多语言文案。
- 不修改或删除本机资源监控（`resourceTelemetry` / `DesktopTelemetryPublisher`）或本地 NDJSON trace 文件。
- 不修改或删除上游 `.github/workflows/*.yml` 或历史文档。

## 上游同步冲突面

- **新增独立文件**：`openspec/changes/disable-upstream-telemetry/{proposal,tasks}.md`
- **上游文件最小 `// fork:` 钩子**：
  - `packages/shared/src/otelEnvironment.ts`
  - `packages/contracts/src/resourceTelemetry.ts`
  - `apps/server/src/telemetry/AnalyticsService.ts`
  - `apps/server/src/environment/ServerEnvironment.ts`
  - `apps/desktop/src/shell/DesktopShellEnvironment.ts`
  - `apps/desktop/src/backend/DesktopBackendConfiguration.ts`
  - `apps/web/src/components/cloud/ConnectOnboardingDialog.tsx`
  - `apps/mobile/app.config.ts`
  - `apps/mobile/src/features/observability/{diagnosticsSetting,ConnectionTracesSwitch,observe}.ts`
  - `apps/mobile/src/features/diagnostics/SettingsDiagnosticsRouteScreen.tsx`
  - 对应测试与 `packages/shared/src/forkIdentity.guard.test.ts`

## Payload Truth Table & 4-Quadrant Defense Matrix

N/A

## Surface Matrix

| Surface   | Status   | Notes                                                                                                                                 |
| --------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| Web       | Affected | Connect 向导默认取消勾选 `publishAgentActivity`；借 `agentFeedback: false` 自动隐藏 Labs 与设置搜索入口                               |
| Desktop   | Affected | 透传并缓存 `DO_NOT_TRACK`（POSIX/Windows/WSL）；默认关闭 Relay Tracing IPC 放行                                                       |
| Mobile    | Affected | 移除默认 Axiom URL；连接追踪与崩溃上报改为默认关闭（opt-in）；自动隐藏 Beta Agent feedback 入口                                       |
| Server    | Affected | 移除官方 PostHog Key/`ingest.t3.codes` 默认值、默认关闭遥测且零 `anonymous-id` 写入、支持 `DO_NOT_TRACK`、关闭 `agentFeedback` 能力位 |
| Contracts | Affected | `ShellEnvironmentPatch` 增加可选字段 `DO_NOT_TRACK`（与上游命名一致）                                                                 |
| Providers | N/A      | 不影响 Provider 适配器                                                                                                                |
| i18n      | N/A      | 无用户可见文案新增或变更                                                                                                              |
