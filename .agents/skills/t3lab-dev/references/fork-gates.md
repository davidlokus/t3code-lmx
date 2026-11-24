# Fork Lifecycle Hooks & Verification Gates

Modeled after OpenSpec lifecycle hooks (`auto` = follow without asking; `suggest` = offer and follow only if the user accepts). Authoritative policy remains [FORK.md](../../../../FORK.md) and [LESSONS.md](../../../../LESSONS.md).

## Lifecycle hooks

| Hook                | Mode      | Action                                                                                                                                                                                                                                               |
| ------------------- | --------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apply.before`      | `auto`    | Confirm dedicated branch + adjacent worktree (`../t3code-lmx-<topic>`), never directly on `lmx-lab` or `main`. Verify live `~/.t3/userdata` will not be touched.                                                                                     |
| `apply.completed`   | `auto`    | Run the matching verification gates below (fast loop first, then one `check:changed` pass) and report three-part evidence: `Verified`, `Broken by hand` (or `N/A` for pure docs/config), and `Not tried`.                                            |
| `archive.before`    | `suggest` | If the change adds, modifies, or removes a long-lived Fork divergence, update the 「分叉改动台账」 table in `FORK.md`.                                                                                                                               |
| `archive.completed` | `auto`    | Explicitly audit whether rework, real-app regressions, or CI failures from this change produced 0–2 new lessons for `LESSONS.md` (advancing `reviewed-through`, or stating `No new lessons`). Promote repeated issues ≥ 2 to `FORK.md` + guard test. |

## Verification cadence (Fast Loop → Heavy Gate)

1. **Fast iteration loop** (3–8s per fix): run `vp run --filter <touched-pkg> typecheck` and `vp test run <touched-tests>` until green. Never re-run full `check:changed` on every single typo fix.
2. **Pre-Review / Pre-Push heavy gate** (run once after the fast loop is green):
   - `vp run check:changed origin/lmx-lab`
   - `vp test run packages/shared/src/forkIdentity.guard.test.ts`
   - When UI copy or translations change: `vp run i18n:check`
   - If a local macOS run hits a known upstream macOS-only test quirk (e.g. `ChatView.browser.test.tsx:872` or `UsageService.test.ts` `/var` vs `/private/var`), check the baseline table in `LESSONS.md` instead of modifying unrelated upstream test harnesses; rely on Ubuntu `Fork CI` for final proof.

## Dogfood-first gate (UI & Provider experience changes)

For user-facing UI or Provider changes where live feel matters (e.g. Sidebar, HUD, `omp` runtime behavior):

- Prefer building and locally overwrite-installing `/Applications/T3 Lab (Extend).app` **from the feature worktree first** via:
  ```bash
  bash fork/scripts/install-local-mac.sh <version>
  ```
- Let the user verify on real sessions, fix any real-world data gaps in the same branch, and only then archive OpenSpec, open the Fork PR, pass `Fork CI`, and squash-merge to `lmx-lab`.

## Verification gate matrix

- **Always before pushing**:
  - `vp run check:changed origin/lmx-lab`
  - `vp test run packages/shared/src/forkIdentity.guard.test.ts`
- **When UI copy or translations change**:
  - `vp run i18n:check`
- **When desktop startup, identity, packaging, or `apps/desktop/vite.config.ts` changes** (never set `T3CODE_DESKTOP_UNTRUSTED_BUNDLE=true`):
  - Run `bash fork/scripts/install-local-mac.sh <version>` (or run the 3 steps manually: `vp run dist:desktop:dmg:arm64` → `bash fork/scripts/verify-mac-dmg.sh release/T3-Lab-Extend-*.dmg` → `node scripts/smoke-desktop-app.ts --executable "/Applications/T3 Lab (Extend).app/Contents/MacOS/T3 Lab (Extend)"`).
- **When creating or merging PRs** (only when explicitly requested by the user):
  - Create: `gh pr create --repo davidlokus/t3code-lmx --base lmx-lab`
  - Merge feature PR: `gh pr merge <n> --repo davidlokus/t3code-lmx --match-head-commit <sha> --squash --delete-branch`
  - Merge upstream sync PR: `gh pr merge <n> --repo davidlokus/t3code-lmx --match-head-commit <sha> --merge --delete-branch`
