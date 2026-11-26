# Proposal: omp-auth-controller

## Why

Today, users enabling `omp` in **Settings → Providers** have to open an external terminal, manually run `omp` (with the right `--profile` or `PI_CODING_AGENT_DIR`), complete `/login`, and then return to T3 Lab (Extend) to click Refresh. T3 already ships a first-class interactive in-app terminal authentication flow (`ProviderAuthFlow.make` + `ProviderAuthenticationSection` + `ProviderAuthTerminal`), automatically rendered in Settings whenever a provider's snapshot sets `setup.canAuthenticate: true` and its driver provides an `auth: ProviderAuthController`.

## Real Binary Ground Truth (`omp v19.2.1`, `/Users/liamx/.local/bin/omp`)

Directly verified on `/Users/liamx/.local/bin/omp` in an isolated temporary `HOME` (never touching live `~/.omp` or `~/.t3/userdata`):

1. **Why PTY CLI `login`, NOT RPC `login`**:
   - On an unauthenticated fresh profile with no default model, `omp --mode rpc` exits immediately with code `1` (`No default model selected. Use /login...`) BEFORE accepting `get_login_providers` or `login`.
   - Even when RPC boots with an existing key, `omp`'s `rpc-mode.ts` `case "login"` explicitly throws on providers requiring secret input (`S.secret`) or pre-auth prompts (`!v && !S.riskAcknowledgement`).
   - Therefore, interactive PTY execution of `omp [--profile <name>] login` is the ONLY universal, reliable sign-in path across both fresh and existing profiles and all OAuth/API-key providers.
2. **Exact CLI Flag Ordering (verified live)**:
   - `omp --profile <name> login` → **WORKS** (starts interactive provider selection & login inside `~/.omp/profiles/<name>/agent`).
   - `omp login --profile <name>` → **FAILS** (`error: Unknown option '--profile'`).
   - Therefore, `--profile <name>` MUST ALWAYS precede the `login` subcommand!
3. **No CLI `logout` Subcommand (honest boundary)**:
   - `omp --help` confirms there is no `omp logout` CLI subcommand (`omp auth` is export/import only).
   - Therefore, `auth.canLogout` MUST stay `false` and `ProviderAuthController.logout` MUST NOT be exposed (never ship a fake or destructive sign-out button).
4. **Zero UI / i18n Edits Needed**:
   - `apps/web/src/components/settings/ProviderSettingsPanel.tsx:1448-1457` already renders `<ProviderAuthenticationSection>` (and `<ProviderAuthTerminal>`) automatically whenever `liveProvider.setup?.canAuthenticate` is `true`!
   - `apps/server/src/server.ts:834` already provides `PtyAdapter.PtyAdapter` (`NodePtyAdapter.layer`) in `layerRuntimeCoreDependencies`, so `OmpDriver.create` receives it via `Effect.serviceOption(PtyAdapter.PtyAdapter)` without changing `OmpDriverEnv` or touching `apps/server/`.

## What Changes

- **New `packages/provider-omp/src/server/auth.ts` (`makeOmpAuth`)**:
  - Built on `ProviderAuthFlow.make` (`@t3tools/provider-core/server/providerAuthFlow`) and `Effect.serviceOption(PtyAdapter.PtyAdapter)`, modeled directly on `packages/provider-acp-registry/src/server/auth.ts`.
  - Exposes a single terminal auth method (`id: "omp-login"`, `type: "terminal"`, `label: "Sign in with omp"`) when `enabled && launchArgs.ok && Option.isSome(pty)`.
  - Spawns `omp` via `resolveSpawnCommand` in a PTY with exact args:
    - `launchArgs.paths.profile !== undefined` → `["--profile", launchArgs.paths.profile, "login"]`
    - otherwise → `["login"]`
  - Uses `processEnv` from `ompInstanceEnvironment` (strict allowlist, zero inherited host `PI_*`, includes `PI_CODING_AGENT_DIR` when `agentDir` is configured and `profile` is unset).
  - Sets `credentialBinding` to `{ owner: "provider", key: \`omp:${canonicalAgentDir}\` }`(canonicalizing via`fileSystem.realPath`with`path.resolve`fallback so symlinks sharing an`agentDir` coordinate safely while distinct profiles stay isolated).
  - Streams PTY output, forwards user terminal input (`write`) and `resize`, cleanly terminates the PTY and detaches listeners on cancel/scope close, reports the last 5 stripped ANSI lines in `ProviderSetupError` on non-zero exit, and triggers `onChanged` (`snapshot.refresh`) on exit code `0`.
  - Overrides `logout` on the returned `ProviderAuthController` (`logout: () => Effect.fail(ProviderSetupError)`) while keeping `auth.canLogout: false`, ensuring zero upstream `provider-core`/`apps/server` edits and guaranteeing direct RPC `logout` calls fail without invoking `stopSessions` or disturbing active sign-in flows.
- **Wire into `packages/provider-omp/src/server/driver.ts` and `status.ts`**:
  - Obtain `pty = yield* Effect.serviceOption(PtyAdapter.PtyAdapter)` in `OmpDriver.create`.
  - Construct `auth = yield* makeOmpAuth(...)` and attach `auth` to the returned `ProviderInstance`.
  - Compute `canAuthenticate = enabled && Option.isSome(pty) && launchArgs.ok` and stamp `setup: { canInstall: false, canAuthenticate: provider.enabled && provider.installed && canAuthenticate }` and `auth: { ...provider.auth, canLogout: false }` on snapshots (keeping `buildInitialOmpProviderSnapshot` / `checkOmpProviderStatus` clean and testable in `status.ts`).
- **Comprehensive unit & driver tests**:
  - `packages/provider-omp/src/server/auth.test.ts` (new): fake `PtyAdapter` covering default login args (`["login"]`), profile arg order (`["--profile", "work", "login"]`), `agentDir` (`PI_CODING_AGENT_DIR` without host `PI_*`), PTY output/write/resize/exit-0 refresh, non-zero exit ANSI-stripped error detail, cancel/abort PTY cleanup, missing PTY headless degradation, invalid `launchArgs` rejection, and `credentialBinding` isolation across profiles vs shared realpath.
  - `packages/provider-omp/src/server/driver.test.ts` & `status.test.ts`: verify `setup.canAuthenticate` (true only when enabled + installed + valid launchArgs + PTY present; false when disabled, missing binary, invalid launchArgs, or no PTY), `auth.canLogout === false`, and `auth` controller triggers `snapshot.refresh` on successful sign-in.

## Four-Quadrant Defense Matrix

| Quadrant                    | Threat / Edge Case                                                                                                                                         | Defense                                                                                                                                                                                                                                                                                         |
| --------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Input Validation**        | Invalid profile / conflicting `launchArgs`; `--profile` placed after `login`; invalid binary path                                                          | Reuse `resolveOmpSettingsLaunchArgs` result; reject auth start cleanly with `ProviderSetupError` if `!launchArgs.ok`; hard-code `["--profile", profile, "login"]` ordering; resolve binary via `resolveSpawnCommand`                                                                            |
| **State Consistency**       | Stale provider status/models after login completes; `canLogout` advertising broken sign-out; two instances sharing an `agentDir` running concurrent logins | Call `snapshot.refresh` on exit code `0`; explicitly set `canLogout: false` and omit `logout`; bind `credentialBinding` to canonical `agentDir` so T3's auth coordinator serializes concurrent logins on the same directory while keeping separate profiles independent                         |
| **Concurrency & Lifecycle** | User cancels login dialog or server shuts down mid-login; PTY process leaks or listeners fire after close; headless environment without `PtyAdapter`       | Track PTY inside `Scope.Scope` finalizer (`ptyProcess.kill()` + unsubscribe `onData`/`onExit`); guard double-settlement via `Deferred`/flag; use `Effect.serviceOption(PtyAdapter.PtyAdapter)` so headless/test envs degrade cleanly (`canAuthenticate: false`) without breaking `OmpDriverEnv` |
| **Cross-Surface Isolation** | Leaking host `PI_CODING_AGENT_DIR` / `PI_*` / unrelated API keys into `omp login`; colliding with Wave 3a files                                            | Spawn strictly with `processEnv` from `ompInstanceEnvironment`; exclusive file fence (`auth*`, `driver*`, `status*` only — zero overlap with Wave 3a, zero Web/Mobile/i18n/server edits)                                                                                                        |

## Surface Matrix

| Surface                      | Applies?           | Decision                                                                                                                                              |
| ---------------------------- | ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| Entry points                 | Yes                | Settings → Providers renders existing `<ProviderAuthenticationSection>` & `<ProviderAuthTerminal>` automatically when `setup.canAuthenticate` is true |
| Clients (Web/Desktop/Mobile) | Yes (automatic)    | Zero client edits needed; existing provider auth RPC & terminal UI handle `type: "terminal"` flows across Web, Desktop, and Mobile                    |
| Providers                    | Yes                | `omp` gains `auth` controller; other providers untouched                                                                                              |
| Contracts                    | No                 | Uses existing `ProviderAuthController`, `ProviderSetup`, and `ProviderSetupError` contracts                                                           |
| Reverse states               | Yes                | Login terminal supports interactive cancel/close (killing the PTY cleanly); `canLogout` stays honestly `false` since `omp` has no CLI logout          |
| Connection modes             | Yes                | Existing provider auth terminal RPC streams cleanly over local, remote, and relay/tunnel connections                                                  |
| Languages (i18n)             | No                 | Zero UI copy or translation changes                                                                                                                   |
| Docs                         | Handled by Wave 3a | `docs/user/providers-omp.md` is owned by Wave 3a to prevent parallel merge conflicts (or updated post-merge if needed)                                |

## Exclusive File Ownership Fence

- `packages/provider-omp/src/server/auth.ts` (new)
- `packages/provider-omp/src/server/auth.test.ts` (new)
- `packages/provider-omp/src/server/driver.ts`
- `packages/provider-omp/src/server/driver.test.ts`
- `packages/provider-omp/src/server/status.ts`
- `packages/provider-omp/src/server/status.test.ts`
- `openspec/changes/omp-auth-controller/**`
