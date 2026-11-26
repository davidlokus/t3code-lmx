# Proposal: omp 生态级接入 Wave 2b — 终端会话导入与跨进程 Session Lease

- **Epic Charter**: [openspec/epics/omp-ecosystem.md](../../epics/omp-ecosystem.md)（Wave 2b：`feat/omp-session-import`）
- **Tier**: L1+ Light Spec（纯后端 + 最小合同 + Onboarding 品牌图标列扩展，0 i18n 改动，与 Wave 2a 零业务文件冲突）
- **Exclusive File Ownership Fence（与并行 Wave 2a `feat/omp-limits-budget` 零冲突）**：
  - `packages/contracts/src/agentSessions.ts`
  - `packages/provider-omp/src/server.ts`（仅导出 `isValidOmpProfileName` / `resolveOmpInstancePaths`）
  - `packages/provider-omp/src/server/sessionLease.ts` & `sessionLease.test.ts`
  - `packages/provider-omp/src/server/adapter.ts` & `adapter.test.ts`
  - `apps/server/src/project/AgentSessionScanner.ts` & `AgentSessionScanner.test.ts`
  - `apps/server/src/project/AgentSessionImporter.ts` & `AgentSessionImporter.test.ts`
  - `apps/web/src/components/onboarding/WelcomePage.tsx`（仅扩展 `IMPORT_SOURCE_NAMES` 品牌名 `"omp"` 与 4 列图标网格，0 i18n 改动）

## Why

开发者常先在终端用 `omp` 跑任务，随后希望将历史会话导入 T3 Lab 继续协作。当前 `AgentSessionScanner` / `AgentSessionImporter` 仅支持 `claudeAgent`、`codex` 与 `pi`，尚未识别 `omp`（包括多 Profile / `agentDir` 目录与首行 `type: "title"` JSONL 格式）；同时实测 `omp v19.2.1` 源码确认其无跨进程 session 文件锁，若两个进程同时对同一 `.jsonl` 执行 `--resume` 写入存在树损坏风险。

## What Changes

- **会话导入契约扩展（`packages/contracts/src/agentSessions.ts`）**：
  - `AgentSessionSource` 增加 `"omp"`；`AgentSessionProjectCandidate.sources` 改用 `ForwardCompatibleArray(AgentSessionSource)` 提升前向兼容能力。
- **跨进程 Session Lease（`packages/provider-omp/src/server/sessionLease.ts` + `adapter.ts`）**：
  - 实现独立目录原子锁 `<agentDir>/t3-session-leases/<sha256(realpath(sessionPath))>.lock.json`（绝不向 `omp` 的 `sessions/` 目录写入杂文件），使用 `open(..., "wx")` 写入 `{ token, pid, host, acquiredAt, sessionPath, threadId }` 并维护同进程活跃集合。
  - 冲突检测与陈旧锁回收：同主机 PID 已退出（`process.kill(pid, 0)` 抛 `ESRCH`）或损坏且超过宽限期的空锁自动回收并重试一次；存活进程（含 `EPERM`）或远端主机未过期锁立即失败并抛出清晰的 `OmpSessionLeaseConflictError`。
  - 通过 `Effect.acquireRelease` 绑定会话 `Scope` 生命周期，释放前核验 `token` 防止慢释放误删他人新锁。
  - 在 `OmpAdapterV2Driver.create` 的 `connect` 包装器中，仅为常规 `--resume <sessionPath>` 会话获取 lease（不锁定 `--no-session` 短周期文本生成或 `--fork` 检查）。
- **终端 `omp` 会话扫描与导入（`AgentSessionScanner.ts` + `AgentSessionImporter.ts`）**：
  - 仅扫描设置中显式启用的 `omp` 实例（`omp` 默认关闭，关闭时零扫描）；通过 Wave 1 的 `resolveOmpInstancePaths`（严格隔离宿主 `PI_CODING_AGENT_*`，`LESSONS.md #6`）解析 `[paths.sessionsDir, ...paths.extraSessionDirs]`。
  - 适配 `omp` JSONL 真实格式：`TranscriptRecord` 新增可选 `title`、`provider`、`modelId` 字段，支持首行 `type: "title"` 与次行 `type: "session"`（`id`/`cwd`）、`activePiBranch` 树遍历、`session_info.name` > `type: "title"` > 首条用户消息标题优先级，以及从 `model_change` 提取最近模型。
  - `AgentSessionImporter.ts` 将 `thread.source === "omp"` 与 `"pi"` 一样绑定到 `source.filePath` 作为 `nativeThreadId`，导入后可原生通过 `omp --mode rpc --resume <filePath>` 续聊。
- **Onboarding 来源映射（`WelcomePage.tsx`）**：`IMPORT_SOURCE_NAMES` 补齐 `omp: "omp"`（品牌名，0 i18n 改动），图标列从 3 列扩为 4 列。

## Assumptions

- `omp` 默认处于关闭状态，未启用 `omp` 实例的服务器扫描行为零变化。
- T3 的 session lease 为建议性锁：同进程内按规范 `sessionPath` 互斥（即使跨实例配置了重叠 `--session-dir`），跨进程在 `<agentDir>/t3-session-leases/` 下按 `sha256(realpath)` 互斥，且不向 `sessions/` 写入非 `.jsonl` 文件干扰 `omp` 自身。
- 已知边界：不拦截非合作外部终端 `omp` 进程、不覆盖进程重启后的 `switch_session` 恢复路径，以及两个独立 T3 进程使用不同 `agentDir` 却通过 `--session-dir` 指向同一文件目录的极端配置。

## Out of Scope

- 不修改 `apps/web/src/i18n/translations/*.json`（Wave 2 i18n 由 Wave 2a 独占）。
- 不修改 `packages/provider-omp/src/settings.ts`、`dialect.ts`、`protocol.ts` 或 `apps/server/src/usage/*`（归 Wave 2a 独占）。
- 不在 T3 内实现交互式强制接管（kill 外部终端 `omp` 进程）；冲突时明确拒绝并提示用户关闭外部会话后重试。

## 上游同步冲突面

- **新增独立文件**：`packages/provider-omp/src/server/sessionLease.ts`、`packages/provider-omp/src/server/sessionLease.test.ts`
- **上游文件最小 `// fork:` 钩子**：
  - `packages/contracts/src/agentSessions.ts`（`AgentSessionSource` 增加 `"omp"` + `ForwardCompatibleArray`）
  - `apps/server/src/project/AgentSessionScanner.ts`（`omp` 目录解析与首行 `title` / `model_change` 解析）
  - `apps/server/src/project/AgentSessionImporter.ts`（`omp` 复用 `source.filePath` 绑定 `nativeThreadId`）
  - `apps/web/src/components/onboarding/WelcomePage.tsx`（`IMPORT_SOURCE_NAMES` + 4 列网格）

## Payload Truth Table & 4-Quadrant Defense Matrix

### 1. `omp v19.2.1` 会话与锁实测真值表

| Surface                | Observed `omp v19.2.1` Truth                                                                                                                                                                                                           | Edge Cases & Safety Invariant                                                                               |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| Session root           | `resolveOmpInstancePaths`：`profile` (`~/.omp/profiles/<name>/agent/sessions`) > `agentDir` > `OMP_CODING_AGENT_DIR` > `~/.omp/agent/sessions` + `--session-dir`                                                                       | 严禁继承宿主 `PI_CODING_AGENT_*`（`LESSONS.md #6`）；未启用 `omp` 时不扫描                                  |
| JSONL header & entries | Line 0 可为 `{"type":"title","title":"..."}`；其后为 `{"type":"session","version":3,"id":"<uuid>","cwd":"..."}`；消息采用 `id`/`parentId` 树；`{"type":"model_change","provider":"...","modelId":"..."}`；`{"type":"model_usage",...}` | `title` 在 `session` 前不可阻断 `cwd` 读取；非对话记录仅保留树链接防内存暴涨                                |
| Resume semantics       | `omp --mode rpc --resume <sessionFilePath>` 按文件路径恢复                                                                                                                                                                             | `AgentSessionImporter` 必须以 `source.filePath` 作为 `nativeThreadId`                                       |
| Concurrency / lock     | `omp v19.2.1` `SessionManager.isOwnedElsewhere()` 仅进程内检查，无跨进程 OS 锁                                                                                                                                                         | T3 在 `<agentDir>/t3-session-leases/<sha256>.lock.json` 维护原子 `wx` 锁与 PID 存活检查，不污染 `sessions/` |

### 2. 四象限防御检查（`LESSONS.md #9`）

| Quadrant                                 | Mandatory Design & Test Assertion                                                                                                                  |
| ---------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| **1. Disabled / legacy compatibility**   | `omp` 默认关闭时零扫描；`AgentSessionProjectCandidate.sources` 使用 `ForwardCompatibleArray`                                                       |
| **2. Lease conflict & crash recovery**   | 同进程双开或活 PID 跨进程冲突抛出 `OmpSessionLeaseConflictError`；死 PID（`ESRCH`）自动回收重试；`Scope` 关闭时核对 `token` 精准释放不误删他人新锁 |
| **3. Multi-profile & Pi isolation**      | 多 `omp` profile 实例各自扫描对应 `sessionsDir`，设置宿主 `PI_CODING_AGENT_DIR` 绝不污染 `omp` 扫描结果                                            |
| **4. Large / partial transcript safety** | 复用流式 `readTranscriptRecords` 32 MiB 预算与 200 条消息截断；`--no-session` 与 `--fork` 绝不获取会话 lease                                       |

## Surface Matrix

| Surface   | Status   | Notes                                                                     |
| --------- | -------- | ------------------------------------------------------------------------- |
| Contracts | Affected | `packages/contracts/src/agentSessions.ts`                                 |
| Providers | Affected | `packages/provider-omp/src/server/{sessionLease,adapter}.ts`、`server.ts` |
| Server    | Affected | `apps/server/src/project/{AgentSessionScanner,AgentSessionImporter}.ts`   |
| Web       | Affected | `apps/web/src/components/onboarding/WelcomePage.tsx`（0 i18n 改动）       |
| Mobile    | N/A      | 不直接消费 `AgentSessionSource`                                           |
| i18n      | N/A      | 0 翻译改动（Wave 2 i18n 由 Wave 2a 独占）                                 |
