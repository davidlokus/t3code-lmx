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
account or configuration, add another omp instance and set `PI_CODING_AGENT_DIR` in its environment
variables or select an omp profile with `--profile` in **Launch arguments**. Add any API keys needed by
that instance there too; keys inherited by the T3 Lab server are not passed to omp. The app controls
the execution mode, session, and approval mode; do not set those in launch arguments.

## Models and sessions

The picker shows the models and thinking levels that omp reports. Choose **omp default** to let omp
select the model; when a thread resumes, this keeps the model saved in the session. Once you start a
thread, the composer offers omp's skills and slash commands for that workspace. Use `/compact` to
summarize a long conversation without starting a new thread.

Threads resume with omp's native session files. Where T3 tools are available, omp can use them to
create durable child threads. omp's own `task` tool appears as a regular tool call instead.

Pick another provider for [text generation](./text-generation.md), such as automatic thread titles
and commit messages. omp history is not included on the Usage page.

## Permission modes

omp enforces **Supervised**, **Auto-accept edits**, and **Full access**. It has no **Auto** reviewer;
a thread previously set to **Auto** runs as **Supervised**. Changing the mode restarts omp and
resumes the same conversation.

**Allow for session** remembers approval only when omp offers it for the requested tool. If omp
only offers one-time approval, the app approves just that request and shows a notice. When the app
cannot tell what an omp approval would grant, it denies the request.

## Troubleshooting

- If the provider is unavailable, check the binary path and run `omp --version` on the server.
  Update omp with the tool you installed it with, then refresh the provider.
- If models are missing, open `omp` directly and check its sign-in and model configuration.
- If the health check times out, see [provider check timeouts](./install.md#provider-check-timeouts).
