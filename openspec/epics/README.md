# Fork Epics (`openspec/epics/`)

跨多个 PR 或多个并行波次（Wave）的大型 Fork 需求，在此目录下维护一份**单页 Epic Charter**（`openspec/epics/<epic-name>.md`），作为整个需求的全局锚点。单个 PR 的详细规划与验收仍放在各自的 `openspec/changes/<change>/` 中，合并后按常规归档。

> `openspec/**` 在 `.github/scripts/ci-changes.cjs` 中保持惰性，不触发全仓 CI 重建。

## 何时创建 Epic Charter

- 需求拆分为 **≥ 2 个有依赖顺序或并行波次的 PR**；
- 多个 PR 共享同一组**冻结契约字段**（例如 `packages/contracts` schema、插件注册表接口）或**互不重叠的文件归属围栏**；
- 需要在多会话 / 多 Agent（`agy × omp`）之间持续同步 PR 状态与跨 PR 不变量。

## 单页模板（复制到 `openspec/epics/<epic-name>.md`）

```markdown
# Epic: <名称>

- **状态**：Planned | In Progress | Completed
- **总览目标**：1–2 句说明端到端交付目标与非目标边界。
- **关键架构不变量**：
  - 例如：独立运行时环境隔离，严禁跨账号/跨来源双计；
  - 例如：保持契约大版本兼容，旧服缺字段静默降级。

## 1. 冻结契约与共享接口（Wave 1 锁定，后续 Wave 只消费不破坏）

- `packages/contracts/src/...`：列出新增可选字段及默认值/语义
- 共享纯计算模块 / 注册表接口签名与对外导出清单

## 2. Wave DAG 与 PR 拆解

| Wave | PR / 分支      | OpenSpec 档位 | 文件归属围栏（Exclusive Ownership）      | 依赖   | 状态 / PR / SHA |
| ---- | -------------- | ------------- | ---------------------------------------- | ------ | --------------- |
| 1    | `feat/<pr-1>`  | L2 Full Spec  | `packages/contracts/...`、`apps/web/...` | 无     | Planned         |
| 2    | `feat/<pr-2a>` | L1+           | `apps/server/src/...`                    | Wave 1 | Planned         |
| 2    | `feat/<pr-2b>` | L1+           | `packages/provider-...`                  | Wave 1 | Planned         |

## 3. 并行低冲突合流约定

- **i18n 单写者**：同一 Wave 内最多 1 个 PR 编辑 `apps/web/src/i18n/translations/*.json`。
- **共享文档推迟**：`FORK.md` 台账与 `LESSONS.md` 推迟至合入前 rebase 或 Wave 收尾 PR 统一更新。
- **Dogfood 门禁**：Wave 1 契约/主 UI 完成后可先本地试装，后续纯后端 Wave 统一在 Wave 收尾汇总一次 `bash fork/scripts/install-local-mac.sh <ver>`。
```
