# Fork Lifecycle Hooks & Verification Gates

Modeled after OpenSpec lifecycle hooks (`auto` = follow without asking; `suggest` = offer and follow only if the user accepts). Authoritative policy remains [FORK.md](../../../../FORK.md) and [LESSONS.md](../../../../LESSONS.md).

## Lifecycle hooks

| Hook                | Mode      | Action                                                                                                                                                                                                                                                  |
| ------------------- | --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apply.before`      | `auto`    | Confirm dedicated branch + adjacent worktree (`../t3code-lmx-<topic>`), never directly on `lmx-lab` or `main`. Verify live `~/.t3/userdata` will not be touched.                                                                                        |
| `apply.completed`   | `auto`    | Run the matching verification gates below and report three-part evidence: `Verified`, `Broken by hand` (or `N/A` for pure docs/config), and `Not tried`.                                                                                                |
| `archive.before`    | `suggest` | If the change adds, modifies, or removes a long-lived Fork divergence, offer to update the 「分叉改动台账」 table in `FORK.md`.                                                                                                                         |
| `archive.completed` | `suggest` | ① If rework, regressions, or CI failures occurred, offer to log a lesson in `LESSONS.md` (promote repeated issues ≥ 2 to `FORK.md` + guard test). ② Suggest any new durable constraint for `openspec/config.yaml` `context` (edit only after approval). |

## Verification gate matrix

- **Always before pushing**:
  - `vp run check:changed origin/lmx-lab`
  - `vp test run packages/shared/src/forkIdentity.guard.test.ts`
- **When UI copy or translations change**:
  - `vp run i18n:check`
- **When desktop startup, identity, packaging, or `apps/desktop/vite.config.ts` changes** (never set `T3CODE_DESKTOP_UNTRUSTED_BUNDLE=true`):
  1. `vp run dist:desktop:dmg:arm64`
  2. `bash fork/scripts/verify-mac-dmg.sh release/T3-Lab-Extend-*.dmg`
  3. `node scripts/smoke-desktop-app.ts --executable "/Applications/T3 Lab (Extend).app/Contents/MacOS/T3 Lab (Extend)"`
- **When creating or merging PRs** (only when explicitly requested by the user):
  - Create: `gh pr create --repo davidlokus/t3code-lmx --base lmx-lab`
  - Merge feature PR: `gh pr merge <n> --repo davidlokus/t3code-lmx --match-head-commit <sha> --squash --delete-branch`
  - Merge upstream sync PR: `gh pr merge <n> --repo davidlokus/t3code-lmx --match-head-commit <sha> --merge --delete-branch`
