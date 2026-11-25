# Proposal

- **Epic Charter**: [openspec/epics/usage-subscriptions.md](../../epics/usage-subscriptions.md)（Wave 3 / PR 4：`feat/usage-local-history-sources`）
- **Tier**: L1+ Light Spec（严格 opt-in 的 4 个本地历史/缓存数据源 + 防双计隔离 + 零 i18n 冲突）
- **Exclusive File Ownership Fence（并行阶段与 PR 3b `feat/usage-sources-ext` 零文件重叠）**：
  - `packages/contracts/src/usage.ts`（新增 `"kimi"`、`"zai"` 至 `UsageProviderKind`）
  - `packages/contracts/src/settings.ts`（新增默认全 `false` 的 `usageLocalHistorySources` 设置项与 patch 字段）
  - `apps/server/src/usage/localSources/{kimiCli,zcode,magpie,claudeSwap,index}.ts` (+ 对应单元测试)
  - `apps/server/src/usage/UsageService.ts` (+ `UsageService.test.ts`)
  - `apps/web/src/components/usage/usageProviders.ts`
  - `apps/mobile/src/features/usage/{usageProviders,providerColors}.ts`
  - **PR 3b 合入后小幅 rebase 接线**：仅在 PR 3b 合并至 `origin/lmx-lab` 后，在 `apps/server/src/usage/UsageLimitSources.ts` 接入 opt-in `claudeSwap` 本地只读配额缓存（并清理 `knip`），零并行合并冲突。

## Why

除了由 T3 Code 直接驱动的原生 Agent 外，开发者本机常同时使用 Kimi Code CLI、ZCode CLI、Magpie 本地网关（代理 `dsh`/`hermes`/`droid` 等外部工具）以及 `claude-swap` 管理的备用 Claude 账号。将这些本地日志与只读缓存以严格 opt-in、零双计、零凭据风险的方式接入 `/usage`，能完整还原真实消耗与备用账号额度。

## What Changes

- **Opt-in 服务端设置与契约**：
  - `packages/contracts/src/settings.ts`：新增 `UsageLocalHistorySourcesSettings`（`{ kimiCli, zcode, magpie, claudeSwap }`，四项默认全部 `false`），支持通过 `ServerSettingsPatch` 显式开启；旧版客户端解码时自动忽略未知顶层字段，无破坏性影响。
  - `packages/contracts/src/usage.ts`：向 `UsageProviderKind` 增加 `"kimi"`、`"zai"`（`UsageSummary.{buckets,sources,projects,topSessions}` 均使用 `ForwardCompatibleArray`，旧版客户端自动跳过未知 provider）。
  - Web 与 Mobile `usageProviders.ts` / `providerColors.ts`：补全 `"kimi"`（`Kimi Code`）与 `"zai"`（`Z.ai / BigModel`）的品牌展示元数据与配色（纯品牌名，0 i18n 改动，满足 Wave 3 单写者纪律）。
- **4 个独立本地数据源模块（`apps/server/src/usage/localSources/`）**：
  - `kimiCli.ts`：只读扫描 `~/.kimi-code/server/events/session_*.jsonl`（支持目录覆写）；提取 `envelope.payload.usage.{inputOther,inputCacheRead,inputCacheCreation,output}`、`envelope.timestamp`、`envelope.session_id`、`payload.model`（兜底 `"kimi"`）；基于 `(size, mtimeMs)` 增量缓存，使用 `kimiCli:<sessionId>:<stepId|seq>` 确定性 `dedupeKey`；归属 `provider: "kimi"`。
  - `zcode.ts`：以 `node:sqlite` `{ readOnly: true }` 只读查询 `~/.zcode/cli/db/db.sqlite` 的 `model_usage` 表（`status = 'completed' AND started_at >= ?`）；仅保留 BigModel/Z.ai 行（如实机样本 `account:bigmodel-individual-coding-plan`、`account:bigmodel-start-plan`）；扣除重叠缓存 `uncachedInputTokens = max(0, input_tokens - cache_read - cache_write)` 且 `reasoningTokens = min(reasoning_tokens, output_tokens)`；使用 `zcode:<row.id>` 去重键；归属 `provider: "zai"`。
  - `magpie.ts`：只读扫描 `$MAGPIE_CONFIG_DIR/usage.jsonl` 或 `~/.config/magpie/usage.jsonl`；严格跳过非 chat 行（`kind` 存在且非 `"chat"`，如 `provider_test` / `model_list`）；**严格防双计**：排除所有 T3 Code 原生已扫描 Agent（`claude`/`claude-code`/`codex`/`grok`/`cursor`/`opencode`/`antigravity`/`pi`/`omp`/`muse`/`t3code`/`magpie`），且当 `kimiCli` 开启时排除 `kimi`/`kimi-cli`/`kimi-code`、当 `zcode` 开启时排除 `zcode`；在日志内部按 `response_id ?? route:<route_id> ?? rid` 去重；剥离路由前缀（如 `zcode/GLM-5.3-Flash` → `GLM-5.3-Flash`）并将 `dsh`/`hermes`/`droid`/`OpenAI`/`commandcode` 等外部工具请求准确归因至对应上游 `UsageProviderKind`。
  - `claudeSwap.ts`：严格只读解析 `~/.claude-swap-backup/configs/.claude-config-<slot>-<email>.json` 与 `~/.claude-swap-backup/cache/usage.json`（仅接受 `schemaVersion === 2`）；**绝不访问 macOS Keychain、绝不解码/刷新 OAuth token、绝不发起网络请求**；严格排除与当前活跃 `~/.claude.json` 重复的账号（按 `accountUuid` / `organizationUuid` / `email`）；校验槽位重编号（`organizationUuid` / `email` 冲突则丢弃缓存）；强制双向 2 小时新鲜度窗口（`0 <= now - fetchedAt <= 2h`，拒绝过期与未来时间）；准确透传 `lastError` 告警。
- **`UsageService.ts` 接线**：
  - 在 `UsageService.collectDirs` 中，当且仅当 `settings.usageLocalHistorySources.{kimiCli,zcode,magpie}` 对应开关为 `true` 时，并行调用对应本地扫描器；默认全部关闭时行为与现网 100% 一致（零额外磁盘 I/O）。
  - 在 PR 3b 合入后 rebase 并将 `claudeSwap.ts` 接入 `UsageLimitSources.ts`（当且仅当 `settings.usageLocalHistorySources.claudeSwap === true` 时作为只读本地配额快照输出并去重）。

## Assumptions

- **默认严格关闭（Opt-in）**：四项本地源在 `usageLocalHistorySources` 中默认均为 `false`，保护用户隐私并避免未经授权扫描额外本地路径或引入意外双计；开启方式为 `settings.json` / `server.updateSettings` patch。
- **`claude-swap` 定位**：经本机真实 `~/.claude-swap-backup/` 目录核实，其不包含独立 JSONL 会话日志，仅存放备用账号配置快照与 `cache/usage.json` 额度缓存，故 `claudeSwap` 定位为只读本地配额缓存源而非 token 历史日志源。
- **不改 `usage-scan-cache-v18.json` 结构**：本地源扫描器复用现有 `ProviderUsageScan` 路径（与 OpenCode/Cursor/Antigravity 一致），不向文件级 `fileCache` 写入新 provider，因此无需 bump `USAGE_SCAN_CACHE_VERSION`。
- **零 i18n 改动**：遵守 Wave 3 i18n 单写者原则，所有 UI 展示仅涉及不翻译的品牌名（`Kimi Code`、`Z.ai / BigModel`、`claude-swap`）。

## Out of Scope

- 不修改 `apps/web/src/i18n/translations/*.json`（归 Wave 3 PR 3b 独占）。
- 不新增独立 Settings 对话框 UI（本 PR 聚焦安全后端引擎与设置契约；后续如需图形开关可单开轻量 UI PR）。
- 不实现 `claude-swap` Keychain 读取或 Anthropic 实时网络探测（严禁竞态刷新 `cswap` 托管的 OAuth refresh token）。
- 不修改 `FORK.md` / `LESSONS.md`（Wave 3 收尾统一更新）。

## 上游同步冲突面

- **新增独立文件**：
  - `apps/server/src/usage/localSources/kimiCli.ts` & `kimiCli.test.ts`
  - `apps/server/src/usage/localSources/zcode.ts` & `zcode.test.ts`
  - `apps/server/src/usage/localSources/magpie.ts` & `magpie.test.ts`
  - `apps/server/src/usage/localSources/claudeSwap.ts` & `claudeSwap.test.ts`
  - `apps/server/src/usage/localSources/index.ts`
- **上游文件最小 `// fork:` 钩子**：
  - `packages/contracts/src/usage.ts`（`UsageProviderKind` 增加 `"kimi"`, `"zai"`）
  - `packages/contracts/src/settings.ts`（`usageLocalHistorySources` 默认全 `false`）
  - `apps/server/src/usage/UsageService.ts`（`collectDirs` 内最小 opt-in 本地源接入钩子）
  - `apps/web/src/components/usage/usageProviders.ts`
  - `apps/mobile/src/features/usage/{usageProviders,providerColors}.ts`
  - （PR 3b 合入后 rebase 追加）`apps/server/src/usage/UsageLimitSources.ts`（`claudeSwap` 只读缓存 opt-in 钩子）

## Payload Truth Table & 4-Quadrant Defense Matrix

### 1. 本地数据源真实样本真值表（来源：本机只读取证，已脱敏）

| Source       | File / Table                                                                            | Redacted observed fields & types                                                                                                                                                                                                                                                                                                                                                | Empty / malformed / stale / error behavior                                                                                                                                                              | Anti-double-count rule                                                                                                                                                                                                  |
| ------------ | --------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `kimiCli`    | `~/.kimi-code/server/events/session_*.jsonl`                                            | `kind:"event"`, `seq:number`, `envelope.{type:"turn.step.completed",seq,session_id,timestamp:ISO,payload:{stepId,model?,usage:{inputOther,output,inputCacheRead,inputCacheCreation}}}`                                                                                                                                                                                          | 目录缺失返回 `status:"missing"`；非 usage 行（如 `event.session.created`/`turn.step.interrupted`）静默忽略；总 token ≤ 0 跳过；缺 `model` 兜底 `"kimi"`                                                 | `dedupeKey: "kimiCli:<sessionId>:<stepId\|seq>"`；Magpie 启用时自动过滤 `kimi*` agent                                                                                                                                   |
| `zcode`      | `~/.zcode/cli/db/db.sqlite` → `model_usage`                                             | `id:TEXT`, `session_id:TEXT`, `provider_id:TEXT`（实测 `account:bigmodel-individual-coding-plan`, `account:bigmodel-start-plan`）, `model_id:TEXT`（`GLM-5.4`）, `status:TEXT`（`completed`/`cancelled`/`error`）, `started_at:INT(ms)`, `input_tokens`, `output_tokens`, `reasoning_tokens`, `cache_read_input_tokens`, `cache_creation_input_tokens`, `computed_total_tokens` | DB 缺失先 `existsSync` 返回 `missing`（绝不建空库/WAL）；只读打开失败返回 `status:"failed"`；仅统计 `status='completed'` 且 BigModel/Z.ai provider；`uncached = max(0, input - cacheRead - cacheWrite)` | `dedupeKey: "zcode:<id>"`；仅统计 BigModel/Z.ai 行；Magpie 启用时过滤 `zcode` agent                                                                                                                                     |
| `magpie`     | `$MAGPIE_CONFIG_DIR/usage.jsonl` 或 `~/.config/magpie/usage.jsonl`                      | `t:ISO`, `agent:string`（实测含 `dsh`,`hermes`,`droid`,`OpenAI`,`commandcode`,`node`,`curl`,`other` 以及原生 `omp`,`cursor`,`opencode`,`pi`,`claude`,`t3code`）, `provider:string`, `model`/`served`/`req`, `in`,`out`,`cache_read`,`cache_write`, `response_id`,`route_id`,`rid`,`session`,`kind?`（`provider_test`/`model_list`）                                             | 文件缺失返回 `missing`；跳过 `kind && kind !== "chat"`；跳过未知 provider 或总 token ≤ 0；坏 JSON 行安全跳过不拖垮整体扫描                                                                              | 排除全部 T3 原生 Agent（`claude`,`claude-code`,`codex`,`grok`,`cursor`,`opencode`,`antigravity`,`pi`,`omp`,`muse`,`t3code`,`magpie`）及已开启的 `kimi*`/`zcode` agent；按 `response_id ?? route:<route_id> ?? rid` 去重 |
| `claudeSwap` | `~/.claude-swap-backup/configs/.claude-config-<slot>-<email>.json` & `cache/usage.json` | config: `oauthAccount.{accountUuid,emailAddress,organizationUuid,planDisplayName,seatTier,organizationRateLimitTier}`; cache: `schemaVersion:2`, `accounts[slot].{email,organizationUuid,fetchedAt:unixSec,lastError:string\|null,lastGood:{five_hour?:{pct,resets_at?},seven_day?:{pct,resets_at?},scoped?:[{name,pct,resets_at?}]}}`                                          | 仅接受 `schemaVersion===2`；双向 2h 新鲜度（`0 <= now - fetchedAt <= 2h`）；`organizationUuid`/`email` 与槽位配置不一致则判无数据；绝不读 Keychain 或刷新 token                                         | 严格排除与当前活跃 `~/.claude.json` 同 `accountUuid` / `organizationUuid` / `email` 的槽位，避免与原生 Claude 账号双计                                                                                                  |

### 2. 四象限防御检查（`LESSONS.md #9`）

| Quadrant                                           | Mandatory design & test assertion                                                                                                                                                                                                                                                                                            |
| -------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **1. Legacy server / client compatibility**        | `usageLocalHistorySources` 带 `Schema.withDecodingDefault`（旧客户端忽略未知字段）；`UsageProviderKind` 新增 `"kimi"`/`"zai"` 通过 `ForwardCompatibleArray` 向后兼容；全部本地源默认关闭                                                                                                                                     |
| **2. Read failure / corrupt file isolation**       | 缺失目录返回 `status: "missing"`；损坏 SQLite/JSONL/不支持的 `schemaVersion` 隔离为单源错误或跳过坏行，绝不拖垮其它原生 Provider 扫描；`claudeSwap` 保留 `lastError` 语义且不伪造过期数据                                                                                                                                    |
| **3. Multi-account & anti-double-count isolation** | 单测强制验证：(a) 默认关闭时零扫描；(b) Magpie 中 `claude`/`codex`/`omp`/`cursor`/`opencode`/`pi`/`t3code` 行被严格剔除，`dsh`/`hermes` 等外部代理行准确计入且按 `response_id`/`route_id` 去重；(c) `kimiCli` + `magpie`、`zcode` + `magpie` 同时开启不双计；(d) `claudeSwap` 排除活跃 `~/.claude.json` 账号且防御槽位重编号 |
| **4. Cache & storage safety**                      | 本地扫描走 `ProviderUsageScan` 通道，不触碰 `usage-scan-cache-v18.json` 架构；`kimiCli` 文件级 `(size, mtimeMs)` 缓存按 `windowStartMs` 剪枝；SQLite 严守 `{ readOnly: true }` 且不存在时不创建文件                                                                                                                          |

## Surface Matrix

| Surface   | Status   | Notes                                                                                                                                                   |
| --------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Web       | Affected | `apps/web/src/components/usage/usageProviders.ts` 增加 `"kimi"` / `"zai"` 品牌展示元数据与配色                                                          |
| Desktop   | Affected | 复用 Web 界面与内置 Server                                                                                                                              |
| Mobile    | Affected | `apps/mobile/src/features/usage/{usageProviders,providerColors}.ts` 增加 `"kimi"` / `"zai"` 穷举项                                                      |
| Server    | Affected | `apps/server/src/usage/localSources/{kimiCli,zcode,magpie,claudeSwap,index}.ts`、`UsageService.ts`（+ PR 3b 合入后 rebase 接线 `UsageLimitSources.ts`） |
| Contracts | Affected | `packages/contracts/src/usage.ts`（`UsageProviderKind`）、`packages/contracts/src/settings.ts`（`usageLocalHistorySources`）                            |
| Providers | N/A      | 独立本地扫描器，不修改编码 Agent Provider Driver                                                                                                        |
| i18n      | N/A      | 0 文案改动（Wave 3 i18n 由 PR 3b 独占）                                                                                                                 |
