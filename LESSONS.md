<!-- reviewed-through: 3f26ab16ad (2026-11-25) -->

# Lessons from Fork Work (`davidlokus/t3code-lmx`)

本文件记录本 Fork 在 Agent 编排开发、代码审查、本地真机验收与 CI/发版中真实踩过的坑，以及本应提前拦住它的规则。**动手改代码前先读一遍。**

升级机制（参考 `yetone/magpie`）：

- 每条教训记录：`规则` → `原因` → `铁证（Commit / PR / 现象）` → `Seen` 次数。
- 同一类教训在不同任务/日期出现 **≥ 2 次**，升级为 [FORK.md](FORK.md) 的硬性条款；能自动化拦截的，必须同步写进 [forkIdentity.guard.test.ts](packages/shared/src/forkIdentity.guard.test.ts) 或模块回归测试，用代码代替口头提醒。

---

## 1. 独立打包入口必须显式内联工作区包

- **规则**：凡是被 `apps/desktop/vite.config.ts` 单独打包的入口（`boot.ts`、`compileCache.ts`、`serverCompileCache.ts`、`preload.ts` 等），如果新增了对 `@t3tools/*` 工作区包的导入，必须同时检查该入口的 `deps.alwaysBundle`，并在真实包目录 `cwd` 下验证产物零外置 `@t3tools/` `require`。
- **原因**：`tsdown` / `vp pack` 会根据 `cwd` 下的 `package.json` 自动将 `dependencies` 中的 `@t3tools/*` 外置；打包进 `app.asar` 时只安装运行时外部依赖，外置的工作区包会导致 Electron 在 `app.whenReady()` 前弹致命 `NSAlert` 卡死。
- **铁证**：PR #2（`1d2fd6ee2a`）初版在 `apps/desktop/src/compileCache.ts` 引入 `@t3tools/shared/forkIdentity` 时，`main-process-bundle.test.mjs` 因 `cwd` 指向无 `package.json` 的临时目录而漏网，真机跑 `scripts/smoke-desktop-app.ts` 才抓出 `Cannot find module '@t3tools/shared/forkIdentity'`。
- **代码守卫**：`apps/desktop/scripts/main-process-bundle.test.mjs` + `packages/shared/src/forkIdentity.guard.test.ts`。
- **Seen**：1（2026-11-23）

## 2. 单测绿 ≠ 打包产物能跑，改启动/打包必须真机完整冒烟

- **规则**：修改桌面端启动路径、身份隔离、协议或构建脚本后，严禁仅凭单测或带 `T3CODE_DESKTOP_UNTRUSTED_BUNDLE=true` 的跳过式打包宣告完成。必须执行 `bash fork/scripts/install-local-mac.sh <ver>`（或手工跑完整 `vp run dist:desktop:dmg:arm64` → `verify-mac-dmg.sh` → `scripts/smoke-desktop-app.ts` 拉起真实窗口验收）。
- **原因**：`T3CODE_DESKTOP_UNTRUSTED_BUNDLE=true` 会跳过 `verifyPackagedBundleIsSelfContained` 与 `prepare-server-compile-cache.cjs`，掩盖打包期和启动期缺陷。
- **铁证**：PR #2 初版带 `T3CODE_DESKTOP_UNTRUSTED_BUNDLE=true` 构建“成功”且 325 个单测全绿，但安装后无法启动；完整重打并跑 `smoke-desktop-app.ts` 立刻暴露缺陷，修复后验证窗口正常渲染且 `~/.t3/userdata/statev2.sqlite` 零触碰。
- **代码守卫**：`fork/scripts/verify-mac-dmg.sh`、`fork/scripts/install-local-mac.sh` + `.github/workflows/fork-release.yml` 中的 `build_mac_arm64` 冒烟门禁。
- **Seen**：1（2026-11-23）

## 3. GitHub Actions Checkout 必须排除 `.repos/` 且不触发 submodule 凭据清理

- **规则**：本 Fork 的所有 GitHub Actions workflow 使用 `actions/checkout` 时，必须配置 `sparse-checkout` 排除 `!/.repos/`，且不要带 `persist-credentials: false`（改用 job 级 `permissions: contents: read` 限制权限）。
- **原因**：上游 `.repos/alchemy-effect/submodules/distilled` 是无 `.gitmodules` URL 的孤立 gitlink，`actions/checkout` 的 `persist-credentials: false` 清理步会执行 `git submodule foreach --recursive` 并以退出码 128 失败。
- **铁证**：PR #1 / PR #2 的 `Fork CI` 在 `Checkout` 步连续报错退出 128；PR #3（`a2ddcbceec`）对齐上游 `sparse-checkout` 排除 `!/.repos/` 后，Run `#45148273029` 在 2m57s 全绿通过。
- **代码守卫**：`.github/workflows/fork-ci.yml`、`.github/workflows/fork-release.yml`。
- **Seen**：2（2026-11-23，PR #1 与 PR #2）

## 4. Fork 中执行 `gh` 必须锁死仓库、基线与审查 SHA

- **规则**：创建 PR 必须显式传 `--repo davidlokus/t3code-lmx --base lmx-lab`；合并 PR 必须显式传 `--match-head-commit <reviewed_sha>`；发布前必须通过 `node fork/scripts/release-preflight.mjs <version>` 核对绿灯 CI 与可用版本号。
- **原因**：同时挂有 `origin` 和父仓 `upstream` 时，未指定 `--repo` 的 `gh` 命令可能误指向 `pingdotgg/t3code`；合并时不锁 SHA 存在审查后被新 push 覆盖的风险。
- **铁证**：初始化阶段 `gh repo set-default --view` 为空；已设 `gh repo set-default davidlokus/t3code-lmx`、`upstream` push URL 设为 `DISABLE`，并启用 `protect-lmx-lab` Ruleset（`bypass_actors = []`）。
- **Seen**：1（2026-11-23）

## 5. 消费 Provider 数据前先抽样真实载荷，绝不靠猜写 Fixture

- **规则**：凡涉及读取或展示 Provider 运行时数据（usage、cost、model options、tools、transcripts），写 `design.md` 和测试夹具前，必须抽样核对 `omp`（`~/.omp/agent/sessions/*.jsonl`、`omp --mode rpc`）与至少 1 个上游 Provider 的真实载荷，把字段真值表写进设计文档；涉及 UI / Provider 强感知体验的改动，优先在 worktree 内跑 `bash fork/scripts/install-local-mac.sh <ver>` 真机试装验收后再提 PR 合并。
- **原因**：`Replay (dev)` 与理想 fixture 无法暴露真实 CLI 方言差异。仅凭猜测假定字段形状会写出全部通过测试但真机缺字段的代码。
- **铁证**：① PR #11（`82588d0e53`）47 个单元/浏览器测试、两轮跨模型 Review 与 `Replay (dev)` 视觉 QA 全绿合并后，真机运行 `omp` 立刻暴露 4 处缺口：`thinking` 存的是字符串 `{ id: "thinking", value: "high" }` 而非布尔、第 1 轮运行中速度为空、`usage.cost.total` 与 `reasoningTokens` 被 Pi/omp 适配器丢弃、`omp` JSONL 独有 `model_usage` 记录，不得不追加 PR #12（`bc15649e28`）补齐；② `feat/omp-ecosystem-wave1`（`5991b5ec4f`）跨模型只读 Review 对照 `omp v19.2.1` 真实内嵌源码，抓出 `omp update --check` 真实输出为 ANSI `New version available: <ver>`（原臆测正则 `New version:`/`Latest version:` 永远解析为 `null`）以及 `profile="default"` 实测归并为 `~/.omp/agent` 的路径分裂。已按 ≥ 2 次规则升级写入 `FORK.md` 硬条款。
- **代码守卫**：`apps/web/src/fork/hud/hudMetrics.logic.test.ts`、`apps/web/src/fork/hud/hudUi.browser.test.tsx`、`packages/provider-omp/src/server/{adapter,usage,maintenance,paths}.test.ts`。
- **Seen**：2（2026-11-24 PR #11 → PR #12；2026-11-25 `feat/omp-ecosystem-wave1`）

## 6. `omp` 用量目录解析绝不继承 `PI_CODING_AGENT_*` 环境变量

- **规则**：`packages/provider-omp/src/server/usage.ts` 的 `resolveOmpSessionsDir()` 仅识别 `OMP_CODING_AGENT_SESSION_DIR`、`OMP_CODING_AGENT_DIR`、实例 `--session-dir` 与默认 `~/.omp/agent/sessions`，严禁回退读取 `PI_CODING_AGENT_DIR` / `PI_CODING_AGENT_SESSION_DIR`。
- **原因**：`UsageService` 会把宿主 `process.env` 合并传给所有 `transcriptReaders`。一旦 `omp` 继承 Pi 的环境变量，就会把 Pi 的会话目录当成 `omp` 再扫一遍，在全局 `/usage` 页造成双计。
- **铁证**：PR #12 初版在 `resolveOmpSessionsDir()` 中回退读取 `PI_CODING_AGENT_DIR`，在 `apps/server/src/usage/UsageService.test.ts` 中立即触发跨 Provider 污染；移除回退后单测全绿。
- **代码守卫**：`packages/provider-omp/src/server/usage.test.ts`（显式断言设置 `PI_CODING_AGENT_DIR` 时仍指向 `~/.omp/agent/sessions`）。
- **Seen**：1（2026-11-24，PR #12）

## 7. Base UI 浮层内禁止嵌套第二个 `<Popover>`，改用原生 `<Menu>` 并放行焦点外移

- **规则**：在已处于 `<Popover>` 内的面板（如窄屏态 `ThreadDetailsCard`）中添加设置/选项弹层时，不得嵌套第二个 `<Popover>`；应使用原生 `<Menu>` + `<MenuCheckboxItem variant="switch" closeOnClick={false}>`，并在外层卡片的 `onOpenChange` 外部点击/焦点外移守卫中放行该菜单的 `data-*` 容器属性。
- **原因**：Base UI 嵌套 `<Popover>` 在窄屏卡片下会出现 z-index 层叠被父卡片遮挡，且点击菜单项会触发外层卡片 `focus-out` 导致卡片关闭或变暗。
- **铁证**：PR #11 初版在 `ThreadHudHeader` 使用嵌套 `<Popover>`，在 `ego-browser` 真机视觉 QA 截图中立刻发现选项弹层压在卡片背后且外层卡片失焦变暗；改为 `<Menu>` + `[data-thread-hud-menu]` 放行后彻底解决。
- **代码守卫**：`apps/web/src/fork/hud/hudUi.browser.test.tsx`（测试窄屏 popover 内开关 HUD 选项菜单时卡片保持展开）。
- **Seen**：1（2026-11-23，PR #11）

## 8. 跨模型 Review 前先过本地编译与单测门禁，并区分已知上游 macOS 测试基线差异

- **规则**：① 交给 `omp` 做 Group 3 只读跨模型 Review 前，Coordinator 必须先跑通 `vp fmt --check`、`vp lint`、`vp run --filter <affected> typecheck` 与受影响单测，绝不让高成本跨模型 Reviewer 当编译器用；迭代期先用局部 `typecheck` + 单测快循环，全绿后再跑一次完整 `vp run check:changed origin/lmx-lab`。② 启动 `hc` 后台子会话使用 `hc run --bg --name ...`（不是不存在的 `hc spawn`）。③ 遇到下表已知上游 macOS 基线测试差异时，先与干净 `origin/lmx-lab` 对照确认，严禁顺手修改无关上游测试脚手架。
- **原因**：PR #11 Round 1 将未跑 `typecheck` 的测试文件交给 `omp` 审阅，导致 CRITICAL #1 消耗在 7 个本可 1 秒拦住的 TS 报错上；PR #12 迭代期因直接重跑全量 `check:changed` 浪费了多轮 50s+ 等待。
- **已知上游 macOS 本地测试差异基线**：
  - `apps/web/src/components/ChatView.browser.test.tsx:872`（`a shortcut conditioned on rightPanelOpen sees the thread's open right panel`）：上游 `serverEnvironment.configProjection` 有 5 分钟 `idleTTL`，而 `apps/web/test/fakeEnvironment.ts` 在 `installFakeEnvironment` 时不会向活跃订阅者推送新 `keybindings`。Linux CI（`ubuntu-latest`）因默认 `mod+t === ctrl+t` 掩盖了该问题；macOS（`mod+t === Cmd+T`）仅单跑该用例通过，整文件连续跑会超时（在干净 `origin/lmx-lab` `c86d09f85b` 上稳定复现，Ubuntu `Fork CI` 绿灯）。
  - `apps/server/src/usage/UsageService.test.ts` 部分路径断言：macOS 上 `/var/folders` 与 `/private/var/folders` 符号链接解析差异会导致部分用例本地报路径前缀不等（Linux CI 正常）。
- **铁证**：PR #11（`82588d0e53`）与 PR #12（`bc15649e28`）在 `Fork CI`（`ubuntu-latest`）均一次绿灯通过。
- **代码守卫**：`.agents/skills/t3lab-dev/references/handoff.md`、`.agents/skills/t3lab-dev/references/fork-gates.md`、`packages/shared/src/forkIdentity.guard.test.ts`。
- **Seen**：2（2026-11-23–24，PR #11 与 PR #12）

## 9. 同大版本扩展可选协议字段必须覆盖混合旧服、失败态与缓存版本测试

- **规则**：① 保持 `USAGE_CONTRACT_VERSION` 等协议大版本不变而新增可选过滤/窗口字段时，前端必须基于**服务端回显字段**与去重后**实际贡献源**（`contributingEnvironments`）判断生效范围，在范围失败或全部被旧服排除时绝不渲染伪 `$0` / 预算 / 导出，且当 `AsyncResult` 失败保留旧 `previousSuccess` 时用按环境+时间锚点钉扎避免重查震荡。② 升级服务端持久化缓存版本号（如 `v17 → v18`）时，必须全局搜索旧文件名并同步更新所有升级测试断言。
- **原因**：旧版服务端会静默忽略新可选字段（`projectFilter`、精确 MTD 边界）或拒绝 >24h 的 DST `Today` 请求；同时 React `AsyncResult.getOrElse` 在失败态仍返回上一次成功缓存，若直接按其覆盖降级标记会导致双查询键无限重渲染。
- **铁证**：`feat/usage-dashboard` 在 5 轮跨模型只读 Review 中连续暴露混合舰队 `projectFilter` 污染、失败态伪 `$0`、以及回退/升级期间双键震荡问题；首轮 `check:changed` 亦检出 `UsageService.test.ts:3643` 硬编码 `usage-scan-cache-v17.json` 导致 10 个升级用例失败。
- **代码守卫**：`apps/web/src/state/usage.test.ts`、`apps/web/src/fork/usage/usageDashboard.browser.test.tsx`、`apps/server/src/usage/UsageService.test.ts`。
- **Seen**：1（2026-11-24，`feat/usage-dashboard`）

## 10. macOS 路径探测防 TCC 弹窗须全祖先最外层 `readLink` 且按次扫描隔离

- **规则**：在 macOS 服务端对用户工作目录执行 `.git` 等文件系统探测时，不能仅做词法前缀排除或固定深度截断，也不能跨扫描持久缓存“非符号链接”负结果；必须从文件系统根向外到内逐级调用 `readLink`（仅放行 `/var -> private/var` 与 `/tmp -> private/tmp`），超出上限即 fail-closed，并将缓存作用域限定在单次扫描内。
- **原因**：词法路径检查无法拦住指向 `~/Documents` 等 TCC 受保护目录的符号链接别名；复用 12 层 Git 查找深度会漏检更高层别名，而进程级负缓存会在目录被替换为符号链接后失效，使 `stat` 穿透触发系统弹窗或卡死。
- **铁证**：`feat/usage-dashboard` 跨模型只读 Review 通过注入式文件系统先后验证了 12 层以上深路径别名穿透与二次扫描目录替换穿透，改为全祖先最外层校验 + 按次扫描缓存后彻底闭环。
- **代码守卫**：`apps/server/src/usage/usageProjectResolution.test.ts`（覆盖 16 层深符号链接拦截及二次扫描目录替换重校验）。
- **Seen**：1（2026-11-24，`feat/usage-dashboard`）

## 11. 大跨度上游同步的 Fork CI 须自动分片，并警惕跨文件 Fork 断言漂移

- **规则**：① `.github/workflows/fork-ci.yml` 保持 `plan` → `fast`（≤80 文件且未动根配置/lockfile 时走单机 `check:changed`）与 `sharded`（大同步或改动 `vite.config.ts`/`package.json`/`pnpm-workspace.yaml`/`pnpm-lock.yaml` 时并行拆为 `Static & Typecheck` + `Test Packages` + `Test Web 1..3/3` + `Test Server 1..8/8`，汇总到 `protect-lmx-lab` 必过的 `Fork checks` 门禁）双模式。② 上游同步若 `pnpm-lock.yaml` 冲突或自动合并后报 `ERR_PNPM_LOCKFILE_MISSING_DEPENDENCY`（残留旧 patch hash），先 `git checkout <target> -- pnpm-lock.yaml` 再跑 `vp i`。③ 修改共享注册表/适配器或品牌名（如 `PROVIDER_ORDER`、`PiAdapterV2` `tokenUsage`、`APP_BASE_NAME`）时，不可只依赖 `check:changed` 的同目录测试发现，须跨目录检索并复验图表、Replay 夹具与品牌断言测试。
- **原因**：`apps/server` 配置 `fileParallelism: false`（服务端测试逐个串行），大跨度上游同步会拉起 500+ Vitest 文件，在单机 4 核 `ubuntu-latest` 上既会触发 `check:changed` 默认 `900s` 超时，也会因 CPU 争抢拖死 Chromium 浏览器测试；同时 `check:changed` 只跑变更文件同目录测试，会漏检此前 PR 留下的跨目录断言漂移。
- **铁证**：PR #15（`e745f9705e`，同步 512 个上游提交）在单机 `Fork CI` Run `45556033883` 第 15 分钟因 596 文件超时被杀、Run `45558482027` 跑满 35m11s；改为分片双模式后 Run `45565260782` 11 分钟内直接揪出 PR #12 遗留的 `UsageProviderChart.test.ts`（缺 `omp`）与 `pi_output.ts`（缺 `cost`/`reasoningOutputTokens`）以及上游新增的 `McpAppFrame.browser.test.tsx`（硬编码 `"T3 Code"`），修齐后 Run `45567482753` 全部 13 个分片在 ~9 分钟绿灯通过。
- **代码守卫**：`.github/workflows/fork-ci.yml`、`packages/shared/src/forkIdentity.guard.test.ts`、`apps/web/src/components/chat/McpAppFrame.browser.test.tsx`、`apps/web/src/components/usage/UsageProviderChart.test.ts`、`apps/server/src/orchestration-v2/testkit/fixtures/simple/pi_output.ts`。
- **Seen**：1（2026-11-25，PR #15）

## 12. `Fork Release` 不可用局部 `--filter` 安装配根级 `vp test run`，macOS 打包须用 `macos-26` 且在 Shell 内 `unset GITHUB_REPOSITORY`

- **规则**：① `.github/workflows/fork-release.yml` 的 `preflight` 作业从仓库根执行 `vp test run packages/shared/src/forkIdentity.guard.test.ts` 时，必须使用完整工作区安装（复用 `Fork CI` 缓存的 `pnpm-full-v1-*` store），严禁传 `--filter=@t3tools/shared...`。② `build_mac_arm64` 作业必须运行在 `macos-26`（默认 Xcode 26），满足上游 `apps/desktop/scripts/build-apple-speech.mjs` 对 `-target arm64-apple-macos26.0` 的硬性编译要求，并显式安装 `--filter=@t3tools/web...` 与保存 macOS pnpm store 缓存。③ 清除内置 `GITHUB_REPOSITORY` 以禁用无签名 `app-update.yml` 时，必须在 `run:` Shell 内执行 `unset GITHUB_REPOSITORY T3CODE_DESKTOP_UPDATE_REPOSITORY`，不得依赖 step 级 `env: GITHUB_REPOSITORY: ""`。
- **原因**：根目录 `vite.config.ts` 在 `process.cwd() === import.meta.dirname` 时会自动加载 `TEST_CONFIG_PACKAGES`（含 `apps/web/vite.config.ts` 与 `apps/mobile/vite.config.ts`），`--filter=@t3tools/shared...` 缺少 `@vitejs/plugin-react` 和 `@babel/core` 会直接报 `ERR_MODULE_NOT_FOUND`；上游打包期编译 `t3-apple-speech` 需要 Xcode 26；此外 GitHub Actions Runner 会忽略 step 级 `env:` 对内置 `GITHUB_*` 变量的覆写，导致 `resolveGitHubPublishConfig` 仍读到 `davidlokus/t3code-lmx` 并向无签名 DMG 写入 `app-update.yml`。
- **铁证**：`v0.1.12-lab.5` 首次 `Fork Release`（Run `45572850935`）在 `Preflight` 第 48 秒因缺少 `@vitejs/plugin-react` 和 `@babel/core` 失败；PR #18 修复 `Preflight` 并升 `macos-26` 后，Run `45574745676` 成功打出 arm64 DMG，但 `verify-mac-dmg.sh` 立刻拦住因 step `env: GITHUB_REPOSITORY: ""` 失效而注入的 `app-update.yml`。
- **代码守卫**：`.github/workflows/fork-release.yml`、`packages/shared/src/forkIdentity.guard.test.ts`、`fork/scripts/verify-mac-dmg.sh`。
- **Seen**：2（2026-11-25，`v0.1.12-lab.5` Run `45572850935` 与 Run `45574745676`）

## 13. 跨环境额度归并与富字段合并须坚持全量身份键、严格窗口兼容、显式清空优先与纯日期 UTC 渲染

- **规则**：① 持久化账号级覆写键必须基于**未过滤全量舰队**（`identityPresentations`）做规范身份消歧并使用无碰撞 JSON 元组键（禁止冒号拼接字符串或首路由 key），且「Reset defaults」仅重置视图偏好绝不清空用户数据。② 稀疏流式更新、探测竞态与混合舰队合并仅在窗口 `kind`、时长、`unit`、`limitAmount`、`scopeLabel`、`category` 全部兼容时继承省略字段，严禁将无单位数值与单位声明拼成伪造货币数额，也严禁让旧读数覆盖较新路由的显式清空（如 `balances: []`）。③ 纯日期 `YYYY-MM-DD` 经 `Date.parse` 解析为 UTC 午夜后，前端日历渲染必须传 `timeZone: "UTC"`。
- **原因**：环境筛选会遮蔽携带 `workspaceId` 的节点导致无 workspace 的 hub 路由退化丢键；Codex 会复用 `primary` 窗口 ID 表示 5h 与 monthly 两种周期，若不校验 `kind`/时长会借用已过期的旧重置时间吞掉真实耗尽告警；负 UTC 时区直接按本地时区格式化 `YYYY-MM-DD` 会稳定显示早 1 天。
- **铁证**：`feat/usage-limits-intelligence` 在 `ego-browser` 真机 QA 中捕获 PST 时区 `2026-12-31` 渲染为 `Dec 30, 2026`，并在 4 轮跨模型只读 Review 内存探针中先后复现跨环境过滤丢续费、跨单位 `credits → USD` 串数、旧探针复活 `balances: []` 以及跨周期 `primary` 吞掉 `window-exhausted` 告警，补齐统一守卫后全部闭环。
- **代码守卫**：`packages/shared/src/usageLimitsIntelligence.test.ts`、`packages/provider-core/src/server/usageLimits.test.ts`、`apps/web/src/fork/usage/usageDashboard.logic.test.ts`、`apps/web/src/fork/usage/usageLimitsIntelligence.browser.test.tsx`。
- **Seen**：1（2026-11-25，`feat/usage-limits-intelligence`）

## 14. 扩展设置枚举须双向能力协商，且带 Secret 引用的轮询服务须做 header/trace 防泄与可见态/缓存解耦围栏

- **规则**：① 扩展持久化设置的联合类型（如 `UsageLimitSourceConfig.kind`）必须做**双向能力协商**：客户端通过 `clientCapabilities` 声明支持位，服务端 `redactServerSettingsForClient` 对旧客户端按能力裁剪，避免旧客户端整包解码 `ServerSettings` 失败；同时服务端在 `ExecutionEnvironmentCapabilities` 广播支持位，前端连接旧服时隐藏不支持的新增选项。共享固定端点的独立账号源须分配非复用随机 ID，避免双标签页并发覆盖或删重添后继承旧手动覆写；切换带 `SecretSourceInput` 的类型时必须用 `key` 重挂组件清空内部未提交 picker 状态。② 带凭证的出站配额请求在进入 Fetch `Headers` 构造前必须校验禁止控制字符与非 ISO-8859-1 字节，并用 `Effect.withTracerEnabled(false)` 阻断底层 HTTP 子 span 导出含密钥的传输异常。③ 含 `SecretResolver` 引用的轮询服务必须把**可见快照**与**按 `endpoint + authIdentity`（区分 `key:<sha256>`、`none`、`unresolved`）索引的 last-good 缓存**分离；异步解析与 digest 放在设置写锁外，最终验证有效配置、provider 绑定与 `SecretResolver.revision` 并发布放在 `settingsService.withSettingsSnapshot` 原子段内，且其他写者（如 `consumeResetCredit`）不可用缓存集合覆盖可见快照。
- **原因**：① 仅扩展服务端枚举而不协商新能力位会让旧 mobile/desktop/remote-web 无法解码 `ServerSettings`；② 含换行符的 resolved key 在 native `Headers` 抛出的异常会在外层 `orElseSucceed` 捕获前进入 `makeLocalFileTracer` 导出文件；③ 把可见快照与 last-good 缓存混为一谈会导致：未验证读数不能 fail-closed 隐藏，或隐藏时误删同 key 故障恢复缓存，或无关核销操作把隐藏条目重新推上前端。
- **铁证**：Wave 2 PR 3a（`feat/usage-sources-omp-cn`）在 8 轮跨模型只读 Review（`gpt-6.2-sol:max`）内存探针中先后复现上述 3 类真实缺口（换行 key 进入 trace sink、旧 `httpUsageLimitSources` 客户端解码失败、以及 `secretProviders` 换绑 / `{ fresh: true }` 轮换 / 晚 `invalidate` / 核销重推的并发交错），全部补齐代码与确定性并发回归测试后通过 Round 8 终审。
- **代码守卫**：`apps/server/src/usage/UsageLimitSources.test.ts`、`apps/server/src/serverSettings.test.ts`、`packages/client-runtime/src/connection/{compatibility,resolver}.test.ts`、`apps/web/src/components/settings/AddUsageLimitSourceDialog.{logic,browser}.test.*`。
- **Seen**：1（2026-11-25，Wave 2 `feat/usage-sources-omp-cn`）

## 15. 外部本地数据源扫描须核实上游计费语义、跟随合法软链并防共享组织误排

- **规则**：① 扫描外部网关/CLI 日志时，不得凭直觉以路由或尝试级 ID（如 Magpie `route_id`/`rid`）做首次命中去重；必须核对上游写入源码语义，仅对响应级唯一标识（如 `response_id`）或完整行内容哈希去重，并保留无 ID 行。② 读取外部本地配置与缓存文件时，不得用 `lstat().isFile()` 或 `Dirent.isFile()` 拒绝合法 dotfiles 软链；应使用跟随软链的 `stat().isFile()`（含 `Dirent.isSymbolicLink()`），并在 `ENOENT` 时以 `lstat` 区分断链以维持 fail-closed。③ 多账号活跃排重在双边均带 `organizationUuid` 时须同时比对用户身份（`accountUuid`/`email`），不得仅凭组织相等误排共享团队/企业组织内的其他成员席位。
- **原因**：Magpie 在多尝试 HandedOn 失败后会为已产生真实计费（如 `cache_write`）的尝试写入共享 `route_id` 且无 `response_id` 的独立行，且 `route_id` 按启动时间戳播种会在重启后碰撞，按 `route_id` 去重会静默吞掉真实用量；`chezmoi`/dotfiles 软链管理 `~/.claude.json` 极常见，`lstat().isFile()` 返回 `false` 会触发 fail-closed 导致整源静默清空；共享团队 org 成员拥有相同 `organizationUuid` 但不同席位。
- **铁证**：Wave 3b `feat/usage-local-history-sources` Round 1 独立只读审查（`devin/swe-2-1`）对照 Magpie Go 源码（`internal/gateway/gateway.go` / `trace.go`）与软链复现探针揪出 2 CRITICAL + 2 WARNING，修复并补齐多尝试计费、跨重启碰撞、软链/断链与共享组织回归用例后通过 Round 2 `VERDICT: PASS`。
- **代码守卫**：`apps/server/src/usage/localSources/{magpie,claudeSwap}.test.ts`。
- **Seen**：1（2026-11-25，Wave 3b `feat/usage-local-history-sources`）
