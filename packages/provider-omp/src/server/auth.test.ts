import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import { ProviderInstanceId, type ProviderAuthState } from "@t3tools/contracts";
import type { ProviderAuthController } from "@t3tools/provider-core/server/auth";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as PtyAdapter from "@t3tools/shared/PtyAdapter";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

import { OmpSettings } from "../settings.ts";
import { ompInstanceEnvironment } from "./adapter.ts";
import { makeOmpAuth } from "./auth.ts";

const instanceId = ProviderInstanceId.make("omp-auth-test");
const owner = "owner";
const settings = Schema.decodeSync(OmpSettings)({ enabled: true });

const makeController = Effect.fnUntraced(function* (
  home: string,
  overrides: Partial<OmpSettings>,
  pty?: PtyAdapter.PtyAdapter["Service"],
  onChanged = () => Effect.void,
  id = instanceId,
) {
  const path = yield* Path.Path;
  const config = { ...settings, binaryPath: path.join(home, "bin", "omp"), ...overrides };
  const { env, launchArgs } = yield* ompInstanceEnvironment(config, [
    { name: "OMP_FIXTURE_FLAG", value: "configured", sensitive: false },
  ]).pipe(
    Effect.provideService(HostProcess.Environment, {
      HOME: home,
      PATH: path.join(home, "bin"),
      PI_CODING_AGENT_DIR: "/host/pi/agent",
      PI_CODING_AGENT_SESSION_DIR: "/host/pi/sessions",
      PI_OTHER: "ambient",
      OPENAI_API_KEY: "ambient",
      ANTHROPIC_API_KEY: "ambient",
    }),
  );
  return yield* makeOmpAuth({
    instanceId: id,
    enabled: config.enabled,
    binaryPath: config.binaryPath,
    cwd: path.join(home, "probe"),
    processEnv: env,
    launchArgs,
    pty: Option.fromUndefinedOr(pty),
    onChanged,
  });
});

const makeHarness = Effect.fnUntraced(function* (
  overrides: Partial<OmpSettings> = {},
  hasPty = true,
) {
  const fs = yield* FileSystem.FileSystem;
  const home = yield* fs.makeTempDirectoryScoped({ prefix: "t3-omp-auth-" });
  const launches: PtyAdapter.PtySpawnInput[] = [];
  const writes: Array<string | Buffer> = [];
  const sizes: Array<[number, number]> = [];
  let onData: ((data: string) => void) | undefined;
  let onExit: ((event: PtyAdapter.PtyExitEvent) => void) | undefined;
  let kills = 0;
  let changes = 0;
  const pty = PtyAdapter.PtyAdapter.of({
    spawn: (input) =>
      Effect.sync(() => {
        launches.push(input);
        return {
          pid: 123,
          write: (data: string | Buffer) => void writes.push(data),
          resize: (cols: number, rows: number) => void sizes.push([cols, rows]),
          kill: () => {
            kills++;
            onExit?.({ exitCode: 143, signal: 15 });
          },
          onData: (callback: (data: string) => void) => {
            onData = callback;
            return () => {
              onData = undefined;
            };
          },
          onExit: (callback: (event: PtyAdapter.PtyExitEvent) => void) => {
            onExit = callback;
            return () => {
              onExit = undefined;
            };
          },
        };
      }),
  });
  const auth = yield* makeController(home, overrides, hasPty ? pty : undefined, () =>
    Effect.sync(() => {
      changes++;
    }),
  );
  return {
    auth,
    home,
    launches,
    writes,
    sizes,
    printed: (data: string) => {
      if (!onData) throw new Error("Expected a PTY output listener");
      onData(data);
    },
    exit: (...codes: number[]) => {
      const listener = onExit;
      if (!listener) throw new Error("Expected a PTY exit listener");
      for (const exitCode of codes) listener({ exitCode, signal: null });
    },
    changes: () => changes,
    resources: () => ({ kills, data: onData !== undefined, exit: onExit !== undefined }),
  };
});

const observe = (
  auth: ProviderAuthController,
  predicate: (state: ProviderAuthState) => boolean = () => true,
  sessionId = owner,
) =>
  auth
    .subscribe(sessionId)
    .pipe(Stream.filter(predicate), Stream.runHead, Effect.map(Option.getOrThrow));

it.effect.each([
  { profile: "", agentDir: "", args: ["login"], useAgentDir: false },
  {
    profile: "work",
    agentDir: "~/custom",
    args: ["--profile", "work", "login"],
    useAgentDir: false,
  },
  { profile: "", agentDir: "~/custom", args: ["login"], useAgentDir: true },
  { profile: "default", agentDir: "~/custom", args: ["login"], useAgentDir: true },
])("runs isolated login for profile '$profile' and directory '$agentDir'", (row) =>
  Effect.gen(function* () {
    const path = yield* Path.Path;
    const h = yield* makeHarness({
      profile: row.profile,
      agentDir: row.agentDir,
      launchArgs: "--extension unused.ts",
    });
    const methodState = yield* observe(h.auth, (state) => state.methods !== undefined);
    expect(methodState.methods).toMatchObject([{ id: "omp-login", type: "terminal" }]);
    yield* h.auth.start(owner, Effect.void, "omp-login");
    const waiting = yield* observe(h.auth, (state) => state.phase === "waiting");
    expect(h.launches).toEqual([
      expect.objectContaining({
        shell: path.join(h.home, "bin", "omp"),
        args: row.args,
        env: {
          HOME: h.home,
          PATH: path.join(h.home, "bin"),
          OMP_FIXTURE_FLAG: "configured",
          ...(row.useAgentDir ? { PI_CODING_AGENT_DIR: path.join(h.home, "custom") } : {}),
        },
      }),
    ]);
    if (!waiting.flowId) throw new Error("Expected a cancellable flow");
    yield* h.auth.cancel(owner, waiting.flowId);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("streams terminal I/O and refreshes once after a successful exit", () =>
  Effect.gen(function* () {
    const h = yield* makeHarness();
    yield* h.auth.start(owner);
    const waiting = yield* observe(h.auth, (state) => state.phase === "waiting");
    if (!waiting.flowId || waiting.interaction?.type !== "terminal" || !h.auth.respond) {
      throw new Error("Expected a terminal sign-in interaction");
    }
    const input = { instanceId, flowId: waiting.flowId, interactionId: waiting.interaction.id };
    yield* h.auth.respond(owner, {
      ...input,
      response: { type: "terminal", data: "\r", size: { cols: 104, rows: 32 } },
    });
    yield* h.auth.respond(owner, {
      ...input,
      response: { type: "terminal", data: "\u00ff", binary: true },
    });
    expect(h.writes).toEqual(["\r", Buffer.from([255])]);
    expect(h.sizes).toEqual([[104, 32]]);

    const prompt = "Select a provider\r\n";
    h.printed(prompt);
    const first = yield* observe(
      h.auth,
      (state) => state.interaction?.type === "terminal" && state.interaction.output === prompt,
    );
    expect(first.interaction).toMatchObject({ output: prompt, outputOffset: prompt.length });
    const large = "x".repeat(16_400);
    const tail = "\r\nDone";
    const offset = prompt.length + large.length + tail.length;
    h.printed(large);
    h.printed(tail);
    const latest = yield* observe(
      h.auth,
      (state) =>
        state.interaction?.type === "terminal" && state.interaction.outputOffset === offset,
    );
    expect(latest.interaction).toMatchObject({
      output: "x".repeat(16_384 - tail.length) + tail,
      outputOffset: offset,
    });

    h.exit(0, 1);
    yield* observe(h.auth, (state) => state.phase === "succeeded");
    expect(h.changes()).toBe(1);
    expect(h.resources()).toEqual({ kills: 0, data: false, exit: false });
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("reports only the last five visible failure lines to the sign-in owner", () =>
  Effect.gen(function* () {
    const h = yield* makeHarness();
    yield* h.auth.start(owner);
    yield* observe(h.auth, (state) => state.phase === "waiting");
    h.printed(
      "earlier\r\nolder\r\none\r\n \r\n\u001b[31mtwo\u001b[0m\r\nprogress\rthree\r\nfour\r\nfive\r\n",
    );
    h.exit(17, 0);
    const failed = yield* observe(h.auth, (state) => state.phase === "failed");
    expect(failed.message).toBe("omp login exited with code 17. one two three four five");
    const other = yield* observe(h.auth, (state) => state.phase === "failed", "other-client");
    expect(other.message).not.toContain("one two three four five");
    expect(h.changes()).toBe(0);
    expect(h.resources()).toEqual({ kills: 0, data: false, exit: false });
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect.each(["cancel", "shutdown"])("kills the PTY and detaches on %s", (action) =>
  Effect.gen(function* () {
    const scope = yield* Scope.fork(yield* Scope.Scope);
    const h = yield* makeHarness().pipe(Effect.provideService(Scope.Scope, scope));
    yield* h.auth.start(owner);
    const waiting = yield* observe(h.auth, (state) => state.phase === "waiting");
    if (!waiting.flowId) throw new Error("Expected a cancellable flow");
    if (action === "cancel") {
      expect((yield* h.auth.cancel(owner, waiting.flowId)).phase).toBe("cancelled");
    } else {
      yield* Scope.close(scope, Exit.void);
    }
    expect(h.resources()).toEqual({ kills: 1, data: false, exit: false });
    expect(h.changes()).toBe(0);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("rejects direct logout without stopping sessions or changing the running sign-in", () =>
  Effect.gen(function* () {
    const h = yield* makeHarness();
    yield* h.auth.start(owner);
    const waiting = yield* observe(h.auth, (state) => state.phase === "waiting");
    let stopped = false;
    const error = yield* h.auth
      .logout(
        Effect.sync(() => {
          stopped = true;
        }),
      )
      .pipe(Effect.flip);
    expect(error).toMatchObject({ _tag: "ProviderSetupError", instanceId, operation: "logout" });
    expect(stopped).toBe(false);
    expect(yield* observe(h.auth)).toEqual(waiting);
    expect(h.resources()).toEqual({ kills: 0, data: true, exit: true });
    h.exit(0);
    yield* observe(h.auth, (state) => state.phase === "succeeded");
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect.each([
  { config: {}, hasPty: false, reason: "unavailable" },
  { config: { enabled: false }, hasPty: true, reason: "Enable omp" },
  {
    config: { profile: "work", launchArgs: "--profile=other" },
    hasPty: true,
    reason: "launch settings",
  },
])("rejects unavailable sign-in before spawning: $reason", ({ config, hasPty, reason }) =>
  Effect.gen(function* () {
    const h = yield* makeHarness(config, hasPty);
    const state = yield* observe(h.auth, (state) => state.methods !== undefined);
    expect(state.methods).toEqual([]);
    const error = yield* h.auth
      .start(owner, Effect.die("Unexpected stopSessions"))
      .pipe(Effect.flip);
    expect(error).toMatchObject({ _tag: "ProviderSetupError", instanceId, operation: "start" });
    expect(error.detail).toContain(reason);
    expect(h.launches).toEqual([]);
    if (reason === "launch settings") {
      expect(h.auth.credentialBinding).toEqual({ owner: "provider", key: `omp:${instanceId}` });
    }
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("shares a canonical agent directory but isolates distinct profile bindings", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const home = yield* fs.makeTempDirectoryScoped({ prefix: "t3-omp-auth-paths-" });
    const shared = path.join(home, "shared");
    const alias = path.join(home, "alias");
    yield* fs.makeDirectory(shared);
    yield* fs.symlink(shared, alias);
    const direct = yield* makeController(home, { agentDir: shared });
    const linked = yield* makeController(
      home,
      { agentDir: alias },
      undefined,
      undefined,
      ProviderInstanceId.make("omp-linked"),
    );
    expect(direct.credentialBinding).toEqual({
      owner: "provider",
      key: `omp:${yield* fs.realPath(shared)}`,
    });
    expect(linked.credentialBinding).toEqual(direct.credentialBinding);

    for (const profile of ["work", "personal"]) {
      const auth = yield* makeController(home, { agentDir: alias, profile });
      expect(auth.credentialBinding).toEqual({
        owner: "provider",
        key: `omp:${path.resolve(home, ".omp", "profiles", profile, "agent")}`,
      });
    }
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
