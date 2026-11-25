# Epic: `/usage` 订阅额度情报与多源独立接入

- **状态**：In Progress（Wave 1 启动）
- **总览目标**：在不依赖外部 OpenUsage 应用的前提下，为 T3 Lab (Extend) 的 `/usage` 额度页补齐四视角订阅情报引擎（Pools/Matrix、Resets、Alerts、Expiries）、烧毁率预测与手动订阅覆写，并分波次深化现有 Provider 探测与接入多源独立订阅/余额/历史日志。
- **关键架构不变量**：
  - **独立运行时隔离**：严禁跨 Provider / 跨实例共享或污染环境变量与目录（如 `AntigravityDriver` 独立 `profileDirectory`、`ClaudeDriver` `CLAUDE_CONFIG_DIR`、`CodexDriver` `CODEX_HOME`、`OmpDriver` 绝不回退 `PI_CODING_AGENT_*`）；本地多账号日志/代理读取严格按需显式开启并防双计。
  - **零破坏向后兼容**：`ServerProviderUsageWindow` / `ServerProviderUsageLimits` 所有新增字段必须为 `Schema.optional(...)`，旧版服务端缺字段时前端与共享引擎静默降级、绝不编造假数值。
  - **失败态保留与无震荡**：探测失败保留上次成功读数（`resolveUsageLimitsAfterProbe` / `keepLastGoodReadings`），局部流式更新（`applyUsageLimitsUpdate`）不抹除已探测的富字段。
  - **兼容上游最新 `http` 配额源**：对齐上游 PR #15 新增的 `UsageLimitSourceSnapshot.kind: "cliproxy" | "http"` 与 `quotaAccounts`，后续扩展新数据源直接在其联合类型上增量演进。

## 1. 冻结契约与共享接口（Wave 1 锁定，后续 Wave 只消费不破坏）

- `packages/contracts/src/providerUsageLimits.ts`：
  - `ServerProviderUsageWindow` 可选扩展：`usedAmount?`、`limitAmount?`、`remainingAmount?`、`unit?`、`category?`（`"plan" | "balance" | "overage" | "bonus"`）、`scopeLabel?`。
  - `ServerProviderUsageBalance`：`{ id, label, remaining, limit?, used?, unit, expiresAt?, kind? }`。
  - `ServerProviderUsageLimits` 可选扩展：`subscriptionExpiresAt?`、`planTier?`、`balances?`、`serviceNotice?`。
- `packages/provider-core/src/server/usageLimits.ts`：`applyUsageLimitsUpdate` 与 `usageWindowEquals` 完整保留上述可选字段。
- `packages/shared/src/usageLimitsIntelligence.ts`（`@t3tools/shared/usageLimitsIntelligence`，Hermes 安全）：
  - `computeWindowBurnPace`、`collectLimitsIntelligence`、`ManualSubscriptionOverride` 及统一 `LimitsIntelligenceSnapshot`（同时覆盖 native providers、CLIProxyAPI hub accounts 与上游 `http` `quotaAccounts`）。

## 2. Wave DAG 与 6-PR 拆解

| Wave | PR / 分支                          | OpenSpec 档位 | 文件归属围栏（Exclusive Ownership）                                                                                                                                                                                                                                   | 依赖   | 状态 / PR / SHA |
| ---- | ---------------------------------- | ------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ | --------------- |
| 1    | `feat/usage-limits-intelligence`   | L2 Full Spec  | `packages/contracts/src/providerUsageLimits.ts`、`packages/provider-core/src/server/usageLimits*`、`packages/shared/src/usageLimitsIntelligence*`、`apps/web/src/fork/usage/*`、`apps/web/src/components/usage/UsageLimitsPooled.tsx`（最小 `// fork:` 钩子）、`i18n` | 无     | In Progress     |
| 2    | `feat/limits-enrich-core`          | L1+           | `apps/server/src/provider/{claude,codex}UsageLimits*`、`packages/provider-grok/src/server/usageLimits*`、`apps/server/src/usage/cliproxyApi*`                                                                                                                         | Wave 1 | Planned         |
| 2    | `feat/limits-enrich-ide`           | L1+           | `packages/provider-cursor/src/server/usageLimits*`、`apps/server/src/provider/antigravityUsageLimits*`、`packages/provider-opencode/src/server/usageLimits*`、`packages/provider-muse/src/server/usageLimits*`                                                        | Wave 1 | Planned         |
| 2    | `feat/usage-sources-omp-cn`        | L2 Full Spec  | `packages/contracts/src/settings.ts`、`apps/server/src/usage/UsageLimitSources*`、新增 `apps/server/src/usage/sources/{omp,kimi,zai}*`、Settings UI、`i18n`                                                                                                           | Wave 1 | Planned         |
| 3    | `feat/usage-sources-ext`           | L1+           | 新增 `apps/server/src/usage/sources/{openrouter,copilot,ollama,openaiApi}*` + 注册表接线                                                                                                                                                                              | PR 3a  | Planned         |
| 3    | `feat/usage-local-history-sources` | L1+           | 新增 `apps/server/src/usage/localSources/{kimiCli,zcode,magpie,claudeSwap}*`（opt-in + 严格防双计单测）                                                                                                                                                               | PR 3a  | Planned         |

## 3. 并行低冲突合流约定

- **i18n 单写者**：同一 Wave 内最多 1 个 PR 编辑 `apps/web/src/i18n/translations/*.json`（Wave 1 由 PR 1 独占；Wave 2 仅 `feat/usage-sources-omp-cn` 改 `i18n`，PR 2a / 2b 纯后端 0 文案改动）。
- **共享台账推迟**：并行 Wave 中 `FORK.md` 分叉改动台账与 `LESSONS.md` 推迟至合入前 rebase 或 Wave 收尾 PR 统一更新，避免并行冲突。
- **Dogfood 门禁**：Wave 1 完成后跑一次本地试装（`bash fork/scripts/install-local-mac.sh <ver>`）验收四视角 UI；Wave 2 / Wave 3 纯后端 PR 合并完再按 Wave 收尾汇总验收。
