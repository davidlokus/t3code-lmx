<!-- reviewed-through: a2ddcbceec (2026-11-23) -->

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

- **规则**：修改桌面端启动路径、身份隔离、协议或构建脚本后，严禁仅凭单测或带 `T3CODE_DESKTOP_UNTRUSTED_BUNDLE=true` 的跳过式打包宣告完成。必须执行完整 `vp run dist:desktop:dmg:arm64`（含 bundle 自检与服务端 V8 字节码预热）、运行 `fork/scripts/verify-mac-dmg.sh` 核验 DMG 内容，并运行 `node scripts/smoke-desktop-app.ts` 拉起真实窗口验收。
- **原因**：`T3CODE_DESKTOP_UNTRUSTED_BUNDLE=true` 会跳过 `verifyPackagedBundleIsSelfContained` 与 `prepare-server-compile-cache.cjs`，掩盖打包期和启动期缺陷。
- **铁证**：PR #2 初版带 `T3CODE_DESKTOP_UNTRUSTED_BUNDLE=true` 构建“成功”且 325 个单测全绿，但安装后无法启动；完整重打并跑 `smoke-desktop-app.ts` 立刻暴露缺陷，修复后验证窗口正常渲染且 `~/.t3/userdata/statev2.sqlite` 零触碰。
- **代码守卫**：`fork/scripts/verify-mac-dmg.sh` + `.github/workflows/fork-release.yml` 中的 `build_mac_arm64` 冒烟门禁。
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
