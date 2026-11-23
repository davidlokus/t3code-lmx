# T3 Lab (Extend) Fork 约定

`davidlokus/t3code-lmx` 是 `pingdotgg/t3code` 的个人 Fork。动手前先读本文件与 [LESSONS.md](LESSONS.md)；与 [AGENTS.md](AGENTS.md) 中的上游规则冲突时，以本文件为准。

## 上游规则覆写

- 上游 [CONTRIBUTING.md](CONTRIBUTING.md) 的特性 PR 限制和 `.github/VOUCHED.td` 准入规则不适用于本 Fork。
- 本 Fork 使用 GitHub 和 `gh`，不用上游的 `source.tanstack.com` 镜像或 `src`。
- 本 Fork 使用 [Fork CI](.github/workflows/fork-ci.yml) 与 [Fork Release](.github/workflows/fork-release.yml)，不用上游 Blacksmith `ci.yml`、官方 `release.yml` 或生产 `T3 Connect`。继承的官方工作流原样保留并在 Actions 页面禁用，不设为必过检查，也不接入官方发布凭据或生产连接服务。
- Effect、Oxlint、测试和性能规范沿用 [AGENTS.md](AGENTS.md)。

## 桌面产品身份与隔离

桌面端已使用下列独立身份，集中配置见 [forkIdentity.ts](packages/shared/src/forkIdentity.ts)，由 [forkIdentity.guard.test.ts](packages/shared/src/forkIdentity.guard.test.ts) 持续守卫。默认不读取或迁移官方桌面应用的 Electron 配置。

| 项目              | 配置                                     |
| ----------------- | ---------------------------------------- |
| 产品名            | `T3 Lab (Extend)`                        |
| Bundle ID         | `com.davidlokus.t3lab`                   |
| 安装版数据目录    | `~/.t3lab`                               |
| Electron userData | 正式版 `t3lab-v2`，开发版 `t3lab-dev`    |
| URL Scheme        | 正式版 `t3lab://`，开发版 `t3lab-dev://` |
| CLI shim          | `t3lab`                                  |
| 默认桌面后端端口  | `3973`                                   |
| Node 编译缓存     | `t3lab` 命名空间                         |
| 官方自动更新源    | 禁用；本地与 Fork DMG 不配置官方更新源   |

## Git、分支、Worktree 与 PR

- `origin` 指向 `davidlokus/t3code-lmx`；`upstream` 指向 `pingdotgg/t3code`，只拉取，push URL 保持 `DISABLE`。禁止推送到 `upstream`；未经明确要求，不向上游开 PR。
- `origin/main` 只镜像 `upstream/main`，只能快进，不带 Fork 提交（受 `protect-main-mirror` Ruleset 保护）。GitHub 的 **Sync fork** 仅在确认目标是 `main` 且能快进时使用。
- `origin/lmx-lab` 是 T3 Lab (Extend) 的默认集成分支（受 `protect-lmx-lab` Ruleset 保护，必过 `Fork checks`，无 admin bypass）。所有 Fork PR 都以它为目标。
- 一需求一独立分支和相邻 worktree（`../t3code-lmx-<topic>`），合并后及时 `git worktree remove` 回收。禁止多会话共用同一 worktree；提交前核对 `git show --stat HEAD` 仅包含当前需求文件。
- 创建 PR 必须显式传 `gh pr create --repo davidlokus/t3code-lmx --base lmx-lab`；合并 PR 必须锁死审查过的提交：
  - 功能 / 修复 PR：`gh pr merge <n> --repo davidlokus/t3code-lmx --match-head-commit <sha> --squash --delete-branch`
  - 上游同步 PR（`sync/upstream-*`）：`gh pr merge <n> --repo davidlokus/t3code-lmx --match-head-commit <sha> --merge --delete-branch`（**严禁 squash 或 rebase**）
- 严禁访问、改动或复制官方安装版的 `~/.t3/userdata`，包括上游默认 seed 和以它为源的迁移。

## Agent 交付、审查与自进化协议

1. **三段式审计证据**（每个 PR 与关键 Commit 正文必须明写，不可省略）：
   - `Verified`：实际执行了哪些命令、测试文件数/通过数、真机冒烟结果（不写“测试通过”了事）。
   - `Broken by hand`：对于逻辑/缺陷修复，回退或手工破坏守卫后确认新测试真正 `FAIL` 及失败原因（纯文档或配置变更写 `N/A`）。
   - `Not tried`：本次未验证的平台、真实云服务或路径，必须诚实列出，绝不默认当作已通过。
2. **低冲突二开纪律**：
   - 优先新增独立模块、包或 `fork/` 目录下的脚本；需要接入上游代码时只加最小钩子。不顺手重构无关上游代码。
   - 不删改继承的 `.github/workflows/*.yml`；Fork 自动化统一放在 `.github/workflows/fork-*.yml`。
   - 新增、调整或移除长期分叉时，同步更新文末台账。
3. **教训自进化飞轮**：
   - 每次返工、真机拦截到的回归或 CI 故障，事后记入 [LESSONS.md](LESSONS.md)；
   - 同类失误出现 ≥ 2 次，升级写入本文件硬条款，并尽量下沉为 [forkIdentity.guard.test.ts](packages/shared/src/forkIdentity.guard.test.ts) 或模块回归测试。

## 本地开发与验证门禁

- 主 clone 用 `vp run dev --home-dir "$PWD/.t3" --no-seed`；worktree 用 `vp run dev --no-seed`，自动隔离到自己的 `.t3`。需要数据时使用测试夹具。
- 联调使用 `Replay (dev)`，不消耗真实 provider 额度。
- 推送功能分支前必跑：
  - `vp run check:changed origin/lmx-lab`
  - `vp test run packages/shared/src/forkIdentity.guard.test.ts`
  - 改动文案或翻译时补跑 `vp run i18n:check`
- 桌面打包或启动路径改动，必须完整跑通（**禁止设 `T3CODE_DESKTOP_UNTRUSTED_BUNDLE=true`**）：
  1. `vp run dist:desktop:dmg:arm64`
  2. `bash fork/scripts/verify-mac-dmg.sh release/T3-Lab-Extend-*.dmg`
  3. `node scripts/smoke-desktop-app.ts --executable "/Applications/T3 Lab (Extend).app/Contents/MacOS/T3 Lab (Extend)"`

## 自动化发版流程（Tag ≠ Release）

本 Fork 使用独立标签空间 `vX.Y.Z-lab.N`（如 `v0.1.11-lab.1`），与上游 `vX.Y.Z` / `v*-nightly.*` / `v*-preview.*` 永不冲突。

1. **发版前自检（只读门禁）**：
   ```bash
   node fork/scripts/release-preflight.mjs 0.1.11-lab.1
   ```
   自动核对工作区干净、`HEAD` 与 `origin/lmx-lab` 对齐、目标 Tag 未占用、`lmx-lab` 上已有绿色 `Fork CI`、以及 `forkIdentity.guard.test.ts` 通过。
2. **打 Tag 触发自动构建与冒烟**：
   推送 `vX.Y.Z-lab.N` 后，[.github/workflows/fork-release.yml](.github/workflows/fork-release.yml) 在 `macos-15` 上自动执行：Preflight 校验 → 完整打包 Apple Silicon DMG/ZIP → `verify-mac-dmg.sh` 静态核验 → `scripts/smoke-desktop-app.ts` 真机窗口冒烟 → 生成 `SHA256SUMS` → 防乱序比对后发布 GitHub Release（首次可用 `workflow_dispatch` + `dry_run=true` 演练）。
3. **发版完成四要素**（全部满足才算发布成功，纯加测试的 PR 不单独发版）：
   - 目标 commit（或含它的更晚 `lmx-lab` commit）有完整绿灯 `Fork CI`；
   - Tag 在 `origin/lmx-lab` 祖先链上；
   - GitHub Release 存在且齐备 `T3-Lab-Extend-<ver>-arm64.dmg`、`T3-Lab-Extend-<ver>-arm64.zip`、`SHA256SUMS`；
   - `Latest` 标记落在当前最高的 `v*-lab.*` 版本上。

## 上游同步

1. 选定上游目标：将镜像 `main` 快进到 `upstream/main`，或只拉取 `upstream/main`（`git fetch upstream main`）或稳定标签（`git fetch upstream tag <tag>`）。
2. 拉取 `origin/lmx-lab`，从它新建 `sync/upstream-<target>` 分支和相邻 worktree。在同步分支运行 `git merge --no-ff <target>`。解决冲突时保留上游原文和独立的 Fork 覆写；核对文末台账并记录本次上游 SHA。
3. 必跑 `vp test run packages/shared/src/forkIdentity.guard.test.ts`；小范围同步跑 `vp run check:changed origin/lmx-lab`，大范围同步跑 `vp run typecheck` 与受影响 Fork 模块定向测试。
4. 推送同步分支到 `origin`，向 `lmx-lab` 开 PR，只用 **`--merge`（merge commit）** 合入。

| 日期       | 上游基线     | 记录         |
| ---------- | ------------ | ------------ |
| 2026-11-22 | `9f24cac6d4` | 初始分叉基线 |

## 分叉改动台账

| PR / 分支                       | 改动位置                                                                                        | 保留原因                                                          |
| ------------------------------- | ----------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| #1 `chore/fork-bootstrap`       | `AGENTS.md` 顶部覆写、`CLAUDE.md` 导入、`FORK.md`、`.github/workflows/fork-ci.yml`              | 独立维护 Fork 规则与 CI，不改动上游规则正文和工作流               |
| #2 `feat/t3-lab-identity`       | `forkIdentity.ts`、桌面启动与打包、Web 品牌与 CLI 设置、桌面 Origin、`vite.config.ts` boot 内联 | 与官方桌面版并存，隔离数据、命令、入口和更新源                    |
| #3 `fix/fork-ci-checkout`       | `.github/workflows/fork-ci.yml`                                                                 | 跳过 `.repos/` 孤立 gitlink 并缓存 Playwright Chromium            |
| #4 `chore/agent-eng-foundation` | `LESSONS.md`、`forkIdentity.guard.test.ts`、`fork/scripts/*`、`fork-release.yml`、`FORK.md`     | 建立教训自进化闭环、代码级隔离守卫测试与 Tag 驱动自动化发版流水线 |
