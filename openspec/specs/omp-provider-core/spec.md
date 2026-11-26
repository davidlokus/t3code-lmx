# omp-provider-core Specification

## Purpose

Defines the core provider contract for native `omp` (oh-my-pi) instances in T3 Lab (Extend), covering profile and agent-directory isolation, multi-folder workspace forwarding, model options and catalog refresh, ephemeral-RPC application text generation, and ownership-verified CLI self-updates.

## Requirements

### Requirement: First-Class OMP Instance Profile and Agent Directory Isolation

An `omp` provider instance SHALL support optional `profile` and `agentDir` settings that resolve through a single canonical path policy aligned with `omp` precedence (`profile` over `agentDir`, default `~/.omp/agent`), SHALL validate `profile` names against `omp`'s naming rules, and SHALL isolate per-instance state without ever inheriting ambient host `PI_CODING_AGENT_*` variables into path resolution or `/usage` scanning.

#### Scenario: Named profile resolves to isolated profile agent directory across runtime and usage

- **WHEN** an `omp` instance is configured with `profile: "work"` (even if `agentDir` or ambient `PI_CODING_AGENT_DIR` is also set)
- **THEN** runtime launches pass `--profile work`, status discovery passes `--profile work`, and `/usage` session scanning resolves `~/.omp/profiles/work/agent/sessions` without reading the default or Pi session directories

#### Scenario: Custom agent directory isolates runtime and usage without polluting Pi

- **WHEN** an `omp` instance sets `agentDir: "~/omp-alt"` with no `profile`
- **THEN** only that `omp` instance's child processes receive `PI_CODING_AGENT_DIR` pointing to the resolved `~/omp-alt` path, `/usage` scans `<resolved agentDir>/sessions`, and ambient host `PI_CODING_AGENT_DIR` never leaks into default `omp` instances

#### Scenario: Invalid profile name or conflicting launch argument fails fast

- **WHEN** an `omp` instance configures `profile: "../escape"` (or a Windows reserved device name) or repeats `--profile` in `launchArgs` while `profile` is set
- **THEN** validation fails with a clear actionable error before spawning `omp`

#### Scenario: Legacy OMP settings without new optional fields remain valid

- **WHEN** persisted settings contain only `enabled`, `binaryPath`, `launchArgs`, and `customModels`
- **THEN** decoding succeeds with safe empty defaults and preserves existing runtime and `/usage` behavior (including legacy `OMP_CODING_AGENT_DIR` and `OMP_CODING_AGENT_SESSION_DIR` overrides)

### Requirement: Multi-Folder Workspace Forwarding via Add-Dir

When a thread's runtime policy supplies workspace folders outside the primary working directory (`workspace.extraRoots`), the `omp` provider SHALL forward each unique non-empty external root as a repeatable `--add-dir` CLI flag on session startup.

#### Scenario: Multi-folder thread passes external workspace roots to omp

- **WHEN** a session opens with `cwd: "/repo/app"` and `workspace.extraRoots: ["/repo/shared", "/repo/shared", "/repo/docs"]`
- **THEN** the spawned `omp --mode rpc` command includes `--add-dir /repo/shared --add-dir /repo/docs` without duplicates

#### Scenario: Single-folder thread omits add-dir flags

- **WHEN** a session opens with no `workspace.extraRoots`
- **THEN** no `--add-dir` flags are appended to the `omp` launch arguments

### Requirement: Auto Thinking Level, Role Models, and Session Service Tier

The `omp` provider SHALL advertise `"auto"` alongside each reasoning model's supported thinking levels and apply `"auto"` via native `set_thinking_level` RPC without altering Pi's thinking-level policy, and SHALL support optional first-class instance settings for session `serviceTier`, role models (`smolModel`, `slowModel`, `planModel`), and `advisor` mode forwarded as validated launch arguments.

#### Scenario: Reasoning model exposes and applies auto thinking

- **WHEN** `omp models --json` returns a reasoning model with `thinking: ["low", "medium", "high", "xhigh"]`
- **THEN** the advertised `thinking` option descriptor includes `off`, `auto`, `low`, `medium`, `high`, and `xhigh`, and selecting `auto` sends `{ type: "set_thinking_level", level: "auto" }` on the live RPC session

#### Scenario: Session service tier, role models, and advisor forward cleanly on launch

- **WHEN** an `omp` instance configures `serviceTier: "priority"`, `smolModel: "openai/gpt-5-mini"`, `slowModel: "anthropic/claude-opus-4-6"`, `planModel: "anthropic/claude-sonnet-4-6"`, and `advisor: true`
- **THEN** session startup includes `--service-tier priority`, `--smol openai/gpt-5-mini`, `--slow anthropic/claude-opus-4-6`, `--plan=anthropic/claude-sonnet-4-6`, and `--advisor`

#### Scenario: Conflicting first-class option and manual launchArgs is rejected

- **WHEN** an `omp` instance sets `serviceTier: "priority"` and also passes `--service-tier flex` in `launchArgs`
- **THEN** launch validation rejects the duplicate configuration with an explicit conflict error

### Requirement: Ephemeral-RPC Application Text Generation and Model Catalog Refresh

An enabled, authenticated `omp` instance SHALL provide application-level text generation (thread titles, commit messages, PR descriptions, branch names, and transcription post-processing) over a short-lived, tool-free, session-free RPC invocation, and SHALL implement explicit model catalog refresh via `omp models refresh`.

#### Scenario: Text generation runs isolated without workspace mutation

- **WHEN** T3 requests a thread title or commit message using an `omp` instance with model `"openai/gpt-5.4"`
- **THEN** the provider spawns `omp --mode rpc --no-session --no-extensions --no-tools --no-title --no-lsp --no-skills --no-rules --no-context-files`, applies the requested model and thinking level, executes the prompt, reads `get_last_assistant_text`, decodes the structured JSON reply, and closes the process cleanly

#### Scenario: Default text generation model prefers configured smolModel

- **WHEN** T3 requests text generation with the `"default"` sentinel model on an `omp` instance that configures `smolModel: "openai/gpt-5-mini"`
- **THEN** the text generation runner selects `openai/gpt-5-mini` rather than spawning a heavier primary model, while leaving the session default intact when `smolModel` is unset

#### Scenario: Provider error or timeout fails with credential-safe detail

- **WHEN** the upstream model provider returns an HTTP 429/5xx error or the text generation process times out
- **THEN** text generation fails with a `TextGenerationError` whose message omits raw upstream response bodies or credentials

#### Scenario: Explicit model refresh updates omp catalog cache

- **WHEN** a user triggers model refresh for an enabled `omp` instance
- **THEN** the driver runs `omp models refresh --no-extensions` under that instance's resolved profile/agentDir environment before re-probing the snapshot

### Requirement: Ownership-Verified CLI Update Check and Self-Update

The `omp` provider SHALL check for newer releases via `omp update --check` when update checks are enabled, and SHALL enable in-app `omp update` execution ONLY when the resolved executable path is proven to be a writable standalone installation not owned by a read-only or external package manager.

#### Scenario: Writable standalone installation supports check and in-app update

- **WHEN** the resolved `omp` executable resides in a writable user directory (such as `~/.local/bin/omp`) outside Nix, Homebrew, MacPorts, mise, and `node_modules`
- **THEN** maintenance capabilities expose `omp update` as the executable update action and `lookupLatestVersion` parses available newer semver versions from `omp update --check`

#### Scenario: Nix, Homebrew, or non-writable installation degrades to manual-only

- **WHEN** the resolved `omp` executable resides under `/nix/store/`, a Homebrew cellar/caskroom, MacPorts, mise, `node_modules`, or a non-writable directory
- **THEN** maintenance capabilities set `update: null` with `manualCommand: "omp update"` so T3 never attempts an unsafe self-update

#### Scenario: Update check failure or offline state never breaks provider readiness

- **WHEN** `omp update --check` times out, exits non-zero, or returns unparseable output
- **THEN** `lookupLatestVersion` resolves to `null` and the provider snapshot remains `ready` without surfacing false update prompts

### Requirement: Settings Localization and Accurate User Documentation

All newly introduced user-facing `omp` instance setting labels, descriptions, placeholders, and select options SHALL be localized across all 10 Web translation catalogs, and `docs/user/providers-omp.md` SHALL accurately reflect `/usage` history inclusion, profile/agentDir isolation, text generation, and update behavior.

#### Scenario: Settings form renders localized labels for new omp fields

- **WHEN** the Providers settings page renders an `omp` instance in any supported locale
- **THEN** the `Profile`, `Agent directory`, `Service tier`, `Smol model`, `Slow model`, `Plan model`, and `Advisor` fields display translated labels and descriptions, and `vp run i18n:check` passes with zero missing keys
