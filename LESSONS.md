<!-- reviewed-through: bc15649e28 (2026-11-24) -->

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
- **铁证**：PR #11（`82588d0e53`）47 个单元/浏览器测试、两轮跨模型 Review 与 `Replay (dev)` 视觉 QA 全绿合并后，真机运行 `omp` 立刻暴露 4 处缺口：`thinking` 存的是字符串 `{ id: "thinking", value: "high" }` 而非布尔、第 1 轮运行中速度为空、`usage.cost.total` 与 `reasoningTokens` 被 Pi/omp 适配器丢弃、`omp` JSONL 独有 `model_usage` 记录；不得不追加 PR #12（`bc15649e28`）补齐。
- **代码守卫**：`apps/web/src/fork/hud/hudMetrics.logic.test.ts`、`apps/web/src/fork/hud/hudUi.browser.test.tsx`、`packages/provider-omp/src/server/adapter.test.ts`、`packages/provider-omp/src/server/usage.test.ts`。
- **Seen**：1（2026-11-24，PR #11 → PR #12）

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
