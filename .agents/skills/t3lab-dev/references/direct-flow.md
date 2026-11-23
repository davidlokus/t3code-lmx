# L0 Direct Flow (No OpenSpec)

For small, self-contained changes where creating `openspec/changes/` artifacts adds friction without reducing risk.

## Steps

1. **Run `apply.before` (`auto`)** from [fork-gates.md](fork-gates.md): confirm you are on a dedicated feature branch and adjacent worktree (`../t3code-lmx-<topic>`), never directly on `lmx-lab` or `main`.
2. **Keep changes minimal and low-conflict**:
   - Prefer isolated modules or `fork/` scripts; touch upstream files only with minimal `// fork:` hooks.
   - Check affected surfaces from `AGENTS.md` (Web / Desktop / Mobile / Server / Contracts / Providers / i18n) and note which ones apply.
3. **Implement and test together**:
   - Land targeted unit/regression tests alongside the change.
   - For logic or bug fixes, perform a `Broken by hand` check (revert or break the guard temporarily and confirm the new test fails for the right reason, then restore).
4. **Run `apply.completed` (`auto`)** from [fork-gates.md](fork-gates.md) and report the three-part evidence (`Verified`, `Broken by hand`, `Not tried`).
5. **Escalate if scope grows**: if the change turns out to span multiple surfaces, add a new package/provider, or touch desktop packaging/security boundaries, stop and switch to L1 (`t3lab-light`) or L2 (`spec-driven`).
