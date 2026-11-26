# Design: omp 生态级接入 Wave 2a — 额度、HUD 子后端映射与费用/时长护栏

## 1. Real Binary Payload Truth Table (`omp v19.2.1` 实测取证，`LESSONS.md #5` / `FORK.md #4`)

| Surface / Mechanism                      | Observed `omp v19.2.1` Binary Behavior                                                                                                                                                                                                               | Edge Cases & Error Semantics                                                                                                   |
| ---------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `--warn-cost <usd>` / `--max-cost <usd>` | CLI 解析函数 `m(flag, val)`: `Number(val.trim())`, 要求 `Number.isFinite(n) && n > 0`；覆盖 `session.warnCost` / `session.maxCost`，在 `--mode rpc` 生效                                                                                             | `0`、负数、`NaN`、`Infinity` 或非数字直接 CLI 报错；未设时不传参                                                               |
| `--max-time <duration>`                  | CLI 解析函数 `f(val)`: 正则 `/^(\d+(?:\.\d+)?)([smh])$/` 或纯正数秒，要求 `Number.isFinite(r) && r > 0`；转为 `deadline = Date.now() + maxTime * 1000` 并传入核心循环 `ire()`                                                                        | `0`、`0s`、`-5m`、`1d`（不支持 `d`）均拒绝；到达 deadline 后中止当前 run                                                       |
| RPC `notice` 帧                          | `AgentSession.emitNotice(level, message, source)` 推送 `{ type: "notice", level: "warning" \| "error" \| "info", message: string, source?: string }`；触发 `warnCost` 发 `level:"warning"`，触发 `maxCost` 发 `level:"error"`                        | `PiAdapterV2` 不认识 `type:"notice"`，须在 `protocol.ts` 转为 `extension_ui_request(method:"notify")`                          |
| RPC `prompt_result` 帧                   | 达到 `maxCost` 时推送 `{ type: "prompt_result", id, agentInvoked, status: "error", error: { message, retryable: false, code: "cost_cap" }, sessionSettled }`                                                                                         | 当前 `protocol.ts` 直接吞掉所有 `prompt_result`；须捕获 `cost_cap` 错误并与紧邻的同文 `notice` 去重                            |
| `agent.db` `main.cache`                  | 键模式 `usage_cache:report:*`，`expires_at` 为 Unix 秒，值含 `{ provider, fetchedAt, limits[], metadata? }`；同目录还有 `auth_credentials`（严禁读取）                                                                                               | 缺失文件或纯净库用 `?immutable=1` 零 sidecar；存在活跃 WAL+SHM 时只读打开；孤儿 WAL 或 rollback journal 返回错误且不建 sidecar |
| `omp` 模型前缀与子后端                   | `omp models --json` 中模型 ID 形如 `<provider>/<model>`（如 `openai-codex/gpt-6.2-sol`、`anthropic/claude-opus-4-6`、`google-antigravity/...`、`cursor/...`、`xai-oauth/...`、`opencode-go/...`、`muse-code/...`、`kimi-for-coding/...`、`zai/...`） | 未配置模型时为 `"default"` 哨兵（无 `/`），不可猜测子后端                                                                      |

## 2. 4-Quadrant Defense Matrix (`LESSONS.md #9`)

| Quadrant                                            | Mandatory Design & Test Assertion                                                                                                                                                                                                                                                     |
| --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **1. Legacy settings / mixed client compatibility** | `OmpSettings` 的 `warnCostUsd`/`maxCostUsd`/`maxTime` 均带 `withDecodingDefault("")` + `clearWhenEmpty: "omit"`；`UsageLimitSources` 复用既有 `kind: "omp"` 与 `ForwardCompatibleArray`，零线协议破坏；旧版 11 字段或 4 字段配置无损解码                                              |
| **2. Probe / DB failure retains last-good**         | `UsageLimitSources.keepLastGoodReadings` 对自动发现的 `kind: "omp"` 源同样保留上次成功读数；缺失/损坏/孤儿 WAL `agent.db` 不创建 sidecar、不拖垮其他源；禁用 `omp` 实例时在 `withSettingsSnapshot` 原子段内立即清除不回流                                                             |
| **3. Multi-profile & anti-double-count isolation**  | `resolveOmpDbPath` 严禁读取宿主 `PI_CODING_AGENT_*`（`LESSONS.md #6`）；自动发现的 `omp` 实例按规范 `dbPath` 与手动 `kind: "omp"` 源去重（手动优先，绝不双读）；HUD 优先匹配当前 `omp` 实例专属快照（`omp-instance:<instanceId>`），绝不把另一 profile 或另一子后端的额度串到当前线程 |
| **4. Cache & short-lived run isolation**            | 短周期无工具 `textGeneration`（`shortLived: true`）剥离 `--warn-cost`/`--max-cost`/`--max-time` 与 `--advisor`，避免会话费用/时长上限阻断标题生成；`protocol.ts` 在 `agent_start`/`agent_end`/`session_settled` 重置 `cost_cap` 通知去重缓存                                          |

## 3. Architecture Decisions & Module Contracts

### Decision 1: `OmpSettings` & `dialect.ts` Validation (`packages/provider-omp`)

- Exact `OmpSettings` field metadata (single source of truth for `ProviderSettingsForm.tsx` `PACKAGE_FIELD_TEXT` — no angle brackets in copy):
  - `warnCostUsd`: title `"Cost warning (USD)"`, description `"Warn when session spend reaches this USD threshold (--warn-cost)."`, placeholder `"Optional"`, `clearWhenEmpty: "omit"`.
  - `maxCostUsd`: title `"Max cost (USD)"`, description `"Stop sending new model requests once session spend reaches this USD cap (--max-cost)."`, placeholder `"Optional"`, `clearWhenEmpty: "omit"`.
  - `maxTime`: title `"Max run time"`, description `"Stop a run after this duration in seconds or with s, m, or h units (--max-time)."`, placeholder `"e.g. 30m"`, `clearWhenEmpty: "omit"`.
- Validation helpers (module-internal in `dialect.ts`, unexported for `knip:check:exports`):
  - `isPositiveUsdAmount(raw)`: trims, rejects leading `-`/`+` or whitespace-only, parses `Number(trimmed)`, requires `Number.isFinite(n) && n > 0`.
  - `isValidOmpDuration(raw)`: matches `/^(\d+(?:\.\d+)?)([smh])$/` or plain finite positive number, requires resulting seconds `> 0` and finite.
  - Also validates manual `--warn-cost` / `--max-cost` / `--max-time` values in `resolveOmpLaunchArgs` or when provided via first-class settings; rejects conflict when both first-class setting and matching manual flag appear in `launchArgs`.
- `withoutDisabledLaunchArgs`: when `shortLived === true`, drops `--add-dir`, `--warn-cost`, `--max-cost`, `--max-time`, and `--advisor`.

### Decision 2: RPC `notice` and `cost_cap` Translation (`packages/provider-omp/src/server/protocol.ts`)

- Maintain `noticeSeq` counter and `emittedErrorNotices: Set<string>` (cleared on `agent_start`, `agent_end` when settled, and `session_settled`).
- On `case "notice"`: extract `message = recordString(frame, "message")?.trim()`. If non-empty: map `level` (`"error"` → `"error"`, `"warning"` → `"warning"`, default `"info"`). If `"error"`, record `message` in `emittedErrorNotices`. Return `frames({ type: "extension_ui_request", id: "omp:notice:" + (++noticeSeq), method: "notify", notifyType, message })`.
- On `case "prompt_result"`: if `frame["status"] === "error"`, inspect `error = recordField(frame, "error")`. If `recordString(error, "code") === "cost_cap"`, extract `message = recordString(error, "message")?.trim() || "Session reached its configured cost cap (--max-cost)."`. If `!emittedErrorNotices.has(message)`, add to `emittedErrorNotices` and return `frames({ type: "extension_ui_request", id: "omp:cost-cap:" + (++noticeSeq), method: "notify", notifyType: "error", message })`; otherwise return `frames()`. Non-`cost_cap` `prompt_result` frames stay suppressed as before.

### Decision 3: Unified `agent.db` Resolution & Auto-Discovery (`sources/omp.ts` + `UsageLimitSources.ts`)

- `packages/provider-omp/src/server.ts` exports `isValidOmpProfileName`, `resolveOmpInstancePaths`, `type OmpInstancePaths` (all consumed in production by `apps/server`).
- `apps/server/src/usage/sources/omp.ts`:
  - `resolveOmpDbPath(url, env, home): string | null`:
    - If `url === "omp://default"`: check `env.OMP_PROFILE?.trim()`. If set: validate with `isValidOmpProfileName`; if invalid return `null`; if `"default"` treat as unset; else resolve `<home>/.omp/profiles/<profile>/agent/agent.db`. If no profile: check `env.OMP_CODING_AGENT_DIR?.trim()` → `<agentDir>/agent.db`, else `<home>/.omp/agent/agent.db`. NEVER read `PI_CODING_AGENT_*`.
    - If `url.startsWith("omp://profile/")`: extract `name = url.slice("omp://profile/".length).trim()`. If `!isValidOmpProfileName(name)` return `null`. If `name === "default"` return `<home>/.omp/agent/agent.db`; else `<home>/.omp/profiles/<name>/agent/agent.db`.
    - Otherwise: `NodePath.resolve(expandHomePath(url, home))`.
  - `readCache(dbPath, now, options?)`:
    - Check `existsSync` / `statSync` first (missing file → `READ_ERROR` without creating empty DB).
    - Apply zero-sidecar SQLite guard (rollback journal or orphan WAL without `-shm` → `READ_ERROR`; active WAL+SHM → `{ readOnly: true }`; clean DB → `${pathToFileURL(realPath).href}?immutable=1` with `{ readOnly: true }`).
    - When `options?.providerInstanceId` is provided, stamp `providerInstanceId` onto emitted `quotaAccounts` so HUD can bind non-native quotas to that exact `omp` instance.
- `apps/server/src/usage/UsageLimitSources.ts`:
  - Derive auto-discovered `omp` targets from `settings.providerInstances` where `instance.driver === "omp"` and `resolveProviderInstanceEnabled(instance)`:
    - Decode `OmpSettings`, merge instance environment against `ompBaseEnvironment(hostEnv)` (NEVER ambient `PI_CODING_AGENT_*`), resolve `paths = resolveOmpInstancePaths(ompSettings, launchArgs, mergedEnv)`.
    - Skip if `paths === null` or if an enabled manual `kind: "omp"` source in `settings.usageLimitSources` resolves to the same normalized `dbPath` (or another earlier enabled `omp` instance already claimed the exact same `dbPath` — though keep a deterministic ID `omp-instance:<instanceId>` and label `displayName || (profile ? "omp (" + profile + ")" : "omp")`).
    - If `agent.db` does not exist on disk for an auto-discovered `omp` instance, silently omit the virtual snapshot (do NOT emit a noisy red error banner just because a fresh `omp` profile hasn't fetched quotas yet!). If `agent.db` exists and has valid rows, emit snapshot `{ id: UsageLimitSourceId.make("omp-instance:" + instanceId), kind: "omp", label, checkedAt, accounts, quotaAccounts }`.
    - Include enabled `omp` instances' resolved configs/env in `streamChanges` equality check so toggling `omp` or switching its `profile`/`agentDir` refreshes immediately, and revalidate inside `withSettingsSnapshot` so disabling mid-poll prunes atomically.

### Decision 4: Thread HUD Sub-Backend Quota Resolution (`apps/web/src/fork/hud/`)

- Add pure exported helper `resolveOmpThreadHudLimits` in `apps/web/src/fork/hud/hudMetrics.logic.ts` (and consume in `ThreadHudSections.tsx`):
  - Input: `{ provider, model, providers, sources, nowMs }`.
  - Returns `ThreadDetailsLimits | null` (only when `provider?.driver === "omp"`).
  - Extracts `subProvider = extractModelProviderPrefix(model)` (must have `"/"`, non-empty prefix, not `"default"`).
  - Canonical sub-provider map:
    - Native drivers: `openai-codex` → `codex`, `anthropic` / `claude` → `claudeAgent`, `cursor` → `cursor`, `google-antigravity` → `antigravity`, `xai-oauth` → `grok`, `opencode-go` → `opencode`, `muse-code` → `muse`.
    - Non-native aliases: normalized lowercase sub-provider (e.g. `kimi-for-coding`, `kimi-code`, `kimi`, `zai`, `zai-coding-plan`, `openrouter`, `minimax`, etc.).
  - Priority order (strictly no cross-provider fabrication):
    1. Matching `kind: "omp"` source for this exact `provider.instanceId` (`source.id === "omp-instance:" + provider.instanceId` or any `quotaAccount.providerInstanceId === provider.instanceId`), else other `kind: "omp"` source only if exactly one `omp` source exists:
       - If `mappedDriver` is defined: find all usable `source.accounts` with `account.driver === mappedDriver` (filtering Antigravity windows by model via `antigravityWindowLimitsModel` if `antigravity`). If 1 match → `{ kind: "instance", limits: match.usageLimits }`; if >1 matches → pool via `collectLimitPools` (`{ kind: "pool", windows }`).
       - Also check `source.quotaAccounts` matching `subProvider` (by normalized provider prefix in `account.id` / `account.label`, e.g., `zai:...` or `kimi-for-coding:...`): if 1 usable match → `{ kind: "instance", limits: { checkedAt: source.checkedAt, windows: match.windows, planTier: match.planTier, balances: match.balances } }`.
    2. Fallback to native `ServerProvider` in `providers` with `driver === mappedDriver` and usable `usageLimits` ONLY when exactly 1 such enabled native provider exists (never guess across multiple native accounts!).
    3. Otherwise return `null` (HUD B5 honestly auto-hides).

## 4. Public Export Surface (`knip:check:exports` Discipline)

- `packages/provider-omp/src/server.ts`: add `isValidOmpProfileName`, `resolveOmpInstancePaths`, `type OmpInstancePaths` (consumed by `apps/server`).
- `apps/server/src/usage/sources/omp.ts`: keep `resolveOmpDbPath`, `readOmpUsage` (update signatures minimally, keep internal helpers unexported).
- `apps/web/src/fork/hud/hudMetrics.logic.ts`: export `resolveOmpThreadHudLimits` (consumed by `ThreadHudSections.tsx`).
- No unused exports added anywhere.
