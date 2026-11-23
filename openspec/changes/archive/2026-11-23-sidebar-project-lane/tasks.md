# Tasks: `sidebar-project-lane`

## 1. Data, Store & Pure Logic [Owner: omp]

- [x] 1.1 实现 `apps/web/src/fork/sidebar/sidebarOptionsStore.ts`（`t3lab:sidebar-ui:v1` 持久化、`parseSidebarUiOptions` 容错、瞬态 `activityOnly` 与 Zustand store），严格对齐 `design.md §1.1`，并验证 `vp run --filter @t3tools/web typecheck` 与 `vp lint apps/web/src/fork/sidebar/sidebarOptionsStore.ts` 通过
- [x] 1.2 实现 `apps/web/src/fork/sidebar/sidebarPresentation.logic.ts`（跨机 Host 消歧、状态车道优先级、`dimWhenRead`、`isAttentionThread`、右侧信号分级、`Plan`/`Full` 角标、精简模型名、已删除 Provider 图标兜底、单双行自适应折叠、全部折叠/展开判定），严格对齐 `design.md §1.2`，零 React 依赖
- [x] 1.3 编写全面单元测试 `apps/web/src/fork/sidebar/sidebarPresentation.logic.test.ts`（覆盖单机/多机同名碰撞/纯远程/混合项目、9 档状态车道优先级、`dimWhenRead`、已删 `omp_omp_3` 兜底、`default` 模型不编造、单双行折叠、损坏 `localStorage` 容错、全部折叠/展开），验证 `vp test run apps/web/src/fork/sidebar/sidebarPresentation.logic.test.ts` 全绿

## 2. UI Components, Minimal Upstream Wiring & i18n [Owner: agy]

- [x] 2.1 实现 `apps/web/src/fork/sidebar/SidebarStatusLane.tsx`（固定 18px 垂直对齐状态车道，覆盖 `working`/`failed`/`approval`/`input`/`request`/`woke`/`unread-done`/`draft`/`none`）与 `apps/web/src/fork/sidebar/SidebarOptionsPopover.tsx`（项目区顶部控制条：全部折叠/展开、`🔔` 活跃过滤与角标、`🎛` 显示选项 Popover + 活跃过滤提示条），符合 `docs/internals/10_web-ui.md`（无 `shadcn/no-restyle` 违规、无手动 `useMemo`/`useCallback`）
- [x] 2.2 最小 `// fork:` 接线至 `SidebarChrome.tsx`（`T3 Lab` 字标与无障碍标签）、`SidebarProjectFolderHeader.tsx`（紧凑 Host 消歧标签）、`Sidebar.tsx`（接入 `sidebarOptionsStore`、Host 消歧 Map、顶部控制条、`🔔` 活跃过滤与全部折叠/展开）和 `SidebarThreadRow.tsx`（接入状态车道、已读降噪、右侧胶囊/定宽时间、第二行分支/Worktree/模式/精简模型槽位、自适应单行折叠、已删 Provider 实例图标兜底）
- [x] 2.3 在 `apps/web` 运行 `vp run i18n:generate` 并补全全部语言目录新词条，验证 `vp run i18n:check` 通过
- [x] 2.4 运行受影响的浏览器/单测回归套件（`Sidebar.logic.test.ts`、`Sidebar.browser.test.tsx`、`Sidebar.drag.browser.test.tsx`、`reactCompilerCoverage.test.ts`）确认全绿，并使用 `test-t3-app` 对浅色/深色主题、单双行、显示选项菜单和活跃过滤完成实机视觉验收

## 3. Cross-Review, Gates & Fork Closeout [Owner: omp + agy]

- [x] 3.1 由 `omp` 以只读 Reviewer 视角运行 `openspec-verify-change sidebar-project-lane` 复核前端实现与规格一致性，并修复有效发现
- [x] 3.2 执行 `Broken by hand` 手工证伪（破坏新逻辑或守卫确认测试真正失败后恢复），运行 `vp run check:changed origin/lmx-lab`、`vp test run packages/shared/src/forkIdentity.guard.test.ts`、`vp run i18n:check` 全部通过
- [x] 3.3 执行 `openspec archive sidebar-project-lane --yes` 归档变更并同步 `openspec/specs/fork-sidebar-navigation/spec.md`，更新 `FORK.md`「分叉改动台账」，汇总三段式审计证据（`Verified` / `Broken by hand` / `Not tried`）并走 Fork PR 流程
