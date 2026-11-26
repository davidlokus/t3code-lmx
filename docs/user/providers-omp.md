# omp

Use your existing [omp (oh-my-pi)](https://github.com/can1357/oh-my-pi) installation
in T3 Lab (Extend). omp uses its own accounts, models, skills, extensions, and session files.
It is a separate provider from [Pi](./providers-pi.md).

## Set up omp

1. Install [omp 18.20.0 or newer](https://github.com/can1357/oh-my-pi#install) on the machine running
   the server.
2. Run `omp` there and use `/login`, or add your model provider's API key to omp's **Environment
   variables** in T3 Lab.
3. In **Settings → Providers**, choose that environment, enable **omp**, and refresh it.

If the server cannot find `omp` on its `PATH`, set **Binary path** to the executable. For a separate
account or configuration, add another omp instance and set **Profile** (which maps to
`~/.omp/profiles/<name>/agent` and takes precedence over **Agent directory**) or set **Agent
directory** (passed as `PI_CODING_AGENT_DIR` only to that omp instance, never shared with Pi). Add
any API keys needed by that instance in its **Environment variables** too; keys inherited by the T3
Lab server are not passed to omp. The app controls the execution mode, session, and approval mode,
and rejects duplicate flags between first-class fields and **Launch arguments**.

## Models, roles, and sessions

The picker shows the models and thinking levels that omp reports, including **Auto** thinking on
reasoning models. Choose **omp default** to let omp select the model; when a thread resumes, this
keeps the model saved in the session. Use **Refresh models** in Providers settings to run
`omp models refresh` and update omp's local model catalog cache.

Optional instance settings let you configure omp's session-level **Service tier**
(`--service-tier`), role models (**Smol model**, **Slow model**, **Plan model**), passive
**Advisor** review (`--advisor`), and session budget/time guardrails (**Cost warning (USD)** via
`--warn-cost`, **Max cost (USD)** via `--max-cost`, and **Max run time** via `--max-time`, e.g.
`30m` or `1.5h`). Cost warnings and cost-cap refusals surface directly as session notices; invalid
guardrail values or duplicates in **Launch arguments** fail fast before starting `omp`. Once you
start a thread, the composer offers omp's skills and slash commands for that workspace. Multi-folder
threads forward external workspace directories to omp via repeatable `--add-dir` flags. Use
`/compact` to summarize a long conversation without starting a new thread.

Threads resume with omp's native session files. Where T3 tools are available, omp can use them to
create durable child threads. omp's own `task` tool appears as a regular tool call instead.

## Text generation, usage history, and quota limits

Enabled omp instances support [text generation](./text-generation.md) (automatic thread titles,
commit messages, PR descriptions, branch names, and transcription post-processing) over an isolated,
tool-free ephemeral RPC run that strips session-only guardrails (`--warn-cost`, `--max-cost`,
`--max-time`, and `--advisor`). When the text generation model is set to **omp default** and **Smol
model** is configured on that instance, T3 Lab prefers the smol model first.

Session JSONL history under each instance's resolved sessions directory (`~/.omp/agent/sessions`,
`~/.omp/profiles/<name>/agent/sessions`, `<Agent directory>/sessions`, or an explicit absolute
`--session-dir` path) is scanned for the **Usage** page alongside live session cost and
reasoning-token telemetry in the Thread HUD. Configure custom directories through **Profile** or
**Agent directory** (rather than raw `PI_CODING_AGENT_*` environment variables) so runtime sessions
and Usage history stay aligned without overlapping Pi's directories.

T3 Lab also automatically reads each enabled omp instance's cached quota reports from its resolved
`agent.db` (read-only, without creating SQLite sidecars or reading credentials) and deduplicates
against any manual **OMP Local Cache** source pointing at the same database. In the Thread HUD, the
**Quota** card displays only the windows matching the thread's active model sub-backend (such as
`openai-codex/*` or `anthropic/*`), and stays hidden when the active sub-backend has no quota data.

## Permission modes

omp enforces **Supervised**, **Auto-accept edits**, and **Full access**. It has no **Auto** reviewer;
a thread previously set to **Auto** runs as **Supervised**. Changing the mode restarts omp and
resumes the same conversation.

**Allow for session** remembers approval only when omp offers it for the requested tool. If omp
only offers one-time approval, the app approves just that request and shows a notice. When the app
cannot tell what an omp approval would grant, it denies the request.

## Updates and troubleshooting

- When provider update checks are enabled, T3 Lab checks newer releases with `omp update --check`.
  One-click in-app updates via `omp update` are offered only for writable standalone installations;
  package-managed or read-only installs (such as Nix, Homebrew, MacPorts, or mise) stay manual-only.
- If the provider is unavailable, check **Binary path** and run `omp --version` on the server.
  Update omp with `omp update` (or the package manager that installed it), then refresh the provider.
- If models are missing, open `omp` directly to verify sign-in and model configuration, or trigger
  **Refresh models**.
- If the health check times out, see [provider check timeouts](./install.md#provider-check-timeouts).
