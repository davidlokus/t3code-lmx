# Tasks: omp-auth-controller

## Group 1: Implementation & Unit/Driver Tests

- [x] 1.1 Create `packages/provider-omp/src/server/auth.ts` (`makeOmpAuth`):
  - Wrap `omp [--profile <name>] login` in an interactive PTY flow using `ProviderAuthFlow.make` (`@t3tools/provider-core/server/providerAuthFlow`), `Effect.serviceOption(PtyAdapter.PtyAdapter)`, and `resolveSpawnCommand`.
  - Guarantee `--profile <name>` precedes `login` when a profile is configured, and omit `--profile` otherwise (relying on `processEnv` from `ompInstanceEnvironment`, which sets `PI_CODING_AGENT_DIR` when `agentDir` is set and never inherits host `PI_*`).
  - Bind `credentialBinding` to canonical `agentDir` (`{ owner: "provider", key: \`omp:${canonicalAgentDir}\` }`).
  - Stream PTY output, forward `write` and `resize`, clean up PTY and listeners on cancel/scope exit, surface stripped last output lines via `ProviderSetupError` on non-zero exit, and invoke `onChanged` on exit code `0`.
  - Keep `logout` omitted (honest capability boundary).

- [x] 1.2 Wire `makeOmpAuth` and honest `setup` / `canLogout` capabilities into `packages/provider-omp/src/server/driver.ts` and `packages/provider-omp/src/server/status.ts`:
  - Read optional `PtyAdapter.PtyAdapter` in `OmpDriver.create` without changing `OmpDriverEnv`.
  - Attach `auth` controller to the returned `ProviderInstance` and trigger `snapshot.refresh` on successful login completion.
  - Set `auth.canLogout = false` and `setup: { canInstall: false, canAuthenticate: enabled && installed && hasPty && launchArgs.ok }`.

- [x] 1.3 Add thorough unit and driver tests in `packages/provider-omp/src/server/auth.test.ts`, `driver.test.ts`, and `status.test.ts`:
  - Test default login (`["login"]`), profile login (`["--profile", "work", "login"]`), `agentDir` env isolation (zero host `PI_*`), PTY I/O + resize + exit-0 refresh, non-zero exit error formatting, cancel/close PTY termination, headless no-PTY degradation (`canAuthenticate: false`), invalid `launchArgs` failure, `credentialBinding` canonicalization, and `canLogout === false`.

- [x] 1.4 Run scoped verification (`vp test run`, `vp run --filter @t3tools/provider-omp typecheck`, `vp run --filter t3 typecheck`, scoped `vp lint`, `vp fmt --check`, `vp run knip:check:exports`, and verify zero files outside the exclusive fence).

## Group 2: Cross-Model Review (Author ≠ Reviewer)

- [x] 2.1 Run read-only cross-model review (`devin/swe-2-1`) against plan baseline diff and fix any CRITICAL/WARNING findings until `VERDICT: PASS`.

## Group 3: Falsification, Archive & Ship

- [x] 3.1 Execute 2+ `Broken by hand` RED → GREEN falsifications (e.g. `--profile` flag ordering after `login`, and PTY leak on cancel or `canAuthenticate` when PTY/install is missing).
- [x] 3.2 Run `vp run check:changed origin/lmx-lab`, `vp test run packages/shared/src/forkIdentity.guard.test.ts`, and `vp run i18n:check`.
- [x] 3.3 Archive change under `openspec/changes/archive/2026-11-26-omp-auth-controller`, open PR to `davidlokus/t3code-lmx` (`--base lmx-lab`), verify Fork CI green, and squash-merge.
