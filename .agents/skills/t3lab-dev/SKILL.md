---
name: t3lab-dev
description: Entry router for T3 Lab (Extend) development work in this fork. Classifies tasks into L0 Direct (no OpenSpec), L1 Light Spec (proposal + tasks via t3lab-light), or L2 Full Spec (spec-driven), and enforces Fork lifecycle hooks and verification gates. Use when starting a feature, bugfix, refactor, or deciding how much planning ceremony a task needs.
---

# T3 Lab (Extend) Dev Router

Route work by complexity so simple changes stay fast while cross-cutting Fork work gets full spec discipline. Never overwrite or duplicate the built-in `openspec-*` skills.

## 1. Classify the task (L0 / L1 / L2)

| Tier              | Use when                                                                                                                       | Route                                                                                                                                                                |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **L0 Direct**     | Single-file fix, small bugfix, copy/config tweak, test-only change, or `sync/upstream-*` sync                                  | Skip OpenSpec. Read [references/direct-flow.md](references/direct-flow.md) and execute.                                                                              |
| **L1 Light Spec** | Scoped Fork feature, fork script/tooling, or multi-file refactor with clear boundaries and no new durable spec contract        | Use `t3lab-light` (`proposal → tasks`). Read [references/light-spec-flow.md](references/light-spec-flow.md).                                                         |
| **L2 Full Spec**  | New Provider/package, cross-surface feature (Web/Desktop/Mobile/Server/Contracts/i18n), or desktop packaging/identity/security | Use full `spec-driven` OpenSpec workflow (`openspec-explore` → `openspec-propose` → `openspec-apply-change` → `openspec-verify-change` → `openspec-archive-change`). |

### Routing rules

- **State the tier up front in one line** (e.g. `Tier: L0 Direct — ...`), then proceed unless the user explicitly wants a heavier or lighter tier.
- **Keep moving on minor ambiguity**: make reasonable calls and list all assumptions together for one-reply correction. Only stop to ask before proceeding when a wrong guess is costly (architecture boundary, security, or breaking compatibility).
- **In-flight scope escalation**: if an L0/L1 task ends up adding `packages/contracts` fields or touching ≥ 3 workspace packages, keep moving in the same branch/worktree without restarting, but backfill the Surface Matrix and run cross-package typechecks before handoff.
- **Never write wholesale specs for upstream T3 Code**: `openspec/specs/` tracks Fork-owned capabilities and invariants only.
- **Honor explicit user overrides**: if the user explicitly names an `openspec-*` skill or asks to skip planning, follow their choice.

## 2. Lifecycle hooks (apply to all tiers)

Before coding, after verification, and during archive/closeout, read [references/fork-gates.md](references/fork-gates.md) and apply the configured `auto` / `suggest` hooks (`apply.before`, `apply.completed`, `archive.before`, `archive.completed`).

## 3. Cross-agent handoff (`agy × omp` via `hc`)

When splitting L1/L2 work across `agy` (Coordinator/UI) and `omp` (Data/Logic + independent read-only Reviewer) or running cross-model `openspec-verify-change`, read [references/handoff.md](references/handoff.md) for `hc` launch flags, export/token checklists, and prompt templates.

## 4. Quick status & next-step checks

When the user asks where active work stands or what to do next:

1. Check `git status -sb`, `git worktree list`, and `openspec list --json`.
2. Report active branch/worktree state and any active OpenSpec changes with their concrete next command, without modifying files until confirmed.
