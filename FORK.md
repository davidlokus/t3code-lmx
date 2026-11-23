# T3 Lab (Extend) Fork 约定

`davidlokus/t3code-lmx` 是 `pingdotgg/t3code` 的个人 Fork。先读本文件；与 [AGENTS.md](AGENTS.md) 中的上游规则冲突时，以本文件为准。

## 上游规则覆写

- 上游 [CONTRIBUTING.md](CONTRIBUTING.md) 的特性 PR 限制和 `.github/VOUCHED.td` 准入规则不适用于本 Fork。
- 本 Fork 使用 GitHub 和 `gh`，不用上游的 `source.tanstack.com` 镜像或 `src`。
- 本 Fork 使用 [Fork CI](.github/workflows/fork-ci.yml)，不用上游 Blacksmith `ci.yml`、官方 `release.yml` 或生产 `T3 Connect`。继承的官方工作流原样保留；在 Fork 的 Actions 页面禁用，不设为必过检查，也不接入官方发布凭据或生产连接服务。
- Effect、Oxlint、测试和性能规范沿用 [AGENTS.md](AGENTS.md)。

## 产品身份与隔离目标

下表是目标配置；本次只建立规则和 CI，不改变运行时默认值。

| 项目              | 目标                                     |
| ----------------- | ---------------------------------------- |
| 产品名            | `T3 Lab (Extend)`                        |
| Bundle ID         | `com.davidlokus.t3lab`                   |
| 安装版数据目录    | `~/.t3lab`                               |
| Electron userData | 正式版 `t3lab-v2`，开发版 `t3lab-dev`    |
| URL Scheme        | 正式版 `t3lab://`，开发版 `t3lab-dev://` |
| CLI shim          | `t3lab`                                  |
| 默认桌面后端端口  | `3973`                                   |
| 官方自动更新源    | 禁用                                     |

## Git、分支、Worktree 与 PR

- `origin` 指向 `davidlokus/t3code-lmx`；`upstream` 指向 `pingdotgg/t3code`，只拉取，push URL 保持 `DISABLE`。禁止推送到 `upstream`；未经明确要求，不向上游开 PR。
- `origin/main` 只镜像 `upstream/main`，只能快进，不带 Fork 提交。GitHub 的 **Sync fork** 仅在确认目标是 `main` 且能快进时使用。
- `origin/lmx-lab` 是 T3 Lab (Extend) 的默认集成分支，所有 Fork PR 都以它为目标。从 `origin/lmx-lab` 为每个需求建专用分支和相邻 worktree（`../t3code-lmx-<topic>`）。
- 禁止直接提交到 `main` 或 `lmx-lab`，禁止强推任一分支。`lmx-lab` 只通过 PR 更新。
- 在 Fork 中设置 `gh repo set-default davidlokus/t3code-lmx`；创建 PR 时仍须显式使用 `gh pr create --repo davidlokus/t3code-lmx --base lmx-lab`。
- 功能 PR 可 squash merge；`sync/upstream-*` 同步 PR 必须用 merge commit，禁止 squash 或 rebase merge。
- 严禁访问、改动或复制官方安装版的 `~/.t3/userdata`，包括上游默认 seed 和以它为源的迁移。

## 低冲突二开

- 优先新增独立模块或配置；需要接入上游代码时只加最小钩子。不顺手重构无关上游代码。
- 不删改继承的 `.github/workflows/*.yml`；Fork 自动化使用独立工作流。
- 新增、调整或移除长期分叉时，更新文末台账，记录位置和保留原因。

## 本地开发与验证门禁

- 主 clone 用 `vp run dev --home-dir "$PWD/.t3" --no-seed`；worktree 用 `vp run dev --no-seed`，自动隔离到自己的 `.t3`。需要数据时使用测试夹具。
- 联调使用 `Replay (dev)`，不消耗真实 provider 额度。
- 推送功能分支前运行 `vp run check:changed origin/lmx-lab`；改动文案或翻译时再跑 `vp run i18n:check`。
- 桌面打包改动在 Apple Silicon Mac 上运行 `vp run dist:desktop:dmg:arm64`。

## 上游同步

1. 选定上游目标：将镜像 `main` 快进到 `upstream/main`，或只拉取 `upstream/main`（`git fetch upstream main`）或稳定标签（`git fetch upstream tag <tag>`）。
2. 拉取 `origin/lmx-lab`，从它新建 `sync/upstream-<target>` 分支和相邻 worktree。在同步分支运行 `git merge --no-ff <target>`，其中 `<target>` 是选定的上游 ref。解决冲突时保留上游原文和独立的 Fork 覆写；核对文末台账并记录本次上游 SHA。
3. 小范围同步运行 `vp run check:changed origin/lmx-lab`；大范围同步运行 `vp run typecheck`，并对受影响的 Fork 模块运行定向测试。
4. 推送同步分支到 `origin`，向 `lmx-lab` 开 PR，只用 **merge commit** 合入。

| 日期       | 上游基线     | 记录         |
| ---------- | ------------ | ------------ |
| 2026-11-22 | `9f24cac6d4` | 初始分叉基线 |

## 分叉改动台账

| 分支                   | 改动位置                                                                           | 保留原因                                            |
| ---------------------- | ---------------------------------------------------------------------------------- | --------------------------------------------------- |
| `chore/fork-bootstrap` | `AGENTS.md` 顶部覆写、`CLAUDE.md` 导入、`FORK.md`、`.github/workflows/fork-ci.yml` | 独立维护 Fork 规则与 CI，不改动上游规则正文和工作流 |
