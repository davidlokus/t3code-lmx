# L1 Light Spec Flow (`t3lab-light`)

Two-artifact OpenSpec planning (`proposal.md` → `tasks.md`) for scoped Fork changes that benefit from upfront alignment without full `specs/` + `design.md` ceremony.

## Planning phase (stop before editing code)

1. Confirm OpenSpec root with `openspec context --json`.
2. Create the change with the lightweight schema:
   ```bash
   openspec new change "<kebab-name>" --schema t3lab-light
   ```
3. Draft `proposal.md` and `tasks.md` in `openspec/changes/<kebab-name>/` following `openspec instructions proposal --change "<kebab-name>" --json` and `openspec instructions tasks --change "<kebab-name>" --json`:
   - Fill `Why`, `What Changes`, `Assumptions`, `Out of Scope`, `上游同步冲突面`, and `Surface Matrix`.
   - Every task checkbox in `tasks.md` must name its verification command or test.
   - Include the `Verification & Fork Closeout` group (`check:changed origin/lmx-lab`, `forkIdentity.guard.test.ts`, conditional gates, `Broken by hand`).
4. Present the concise plan and list all `Assumptions` for one-reply correction. **Stop here and wait for user approval before editing project code.**

## Implementation & closeout phase

5. When the user approves implementation, run `apply.before` (`auto`) from [fork-gates.md](fork-gates.md) and execute via `openspec-apply-change` against `<kebab-name>`.
6. Run `apply.completed` (`auto`) from [fork-gates.md](fork-gates.md) and report `Verified`, `Broken by hand`, and `Not tried`.
7. Archive the finished change (`openspec archive "<kebab-name>" --skip-specs --yes`, or keep via `openspec-archive-change`) and run `archive.before` / `archive.completed` (`suggest`) hooks from [fork-gates.md](fork-gates.md).
