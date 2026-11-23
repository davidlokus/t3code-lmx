# Tasks

## 1. <!-- 核心实现 -->

- [ ] 1.1 <!-- 实现内容与对应的单测/验证命令 -->

## 2. Verification & Fork Closeout

- [ ] 2.1 运行 `vp run check:changed origin/lmx-lab` 与 `vp test run packages/shared/src/forkIdentity.guard.test.ts` 全部通过
- [ ] 2.2 按需完成条件门禁（文案补 `vp run i18n:check`；桌面打包/启动补完整 DMG + `verify-mac-dmg.sh` + `smoke-desktop-app.ts`）及 `Broken by hand` 手工证伪
- [ ] 2.3 汇总三段式审计证据（`Verified` / `Broken by hand` / `Not tried`）并确认是否需要更新 `FORK.md` 分叉台账或 `LESSONS.md`
