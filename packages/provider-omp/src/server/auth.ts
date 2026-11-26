// @effect-diagnostics nodeBuiltinImport:off -- Strip terminal controls from login diagnostics.
import * as NodeUtil from "node:util";
import {
  ProviderSetupError,
  type ProviderAuthMethod,
  type ProviderAuthResponse,
  type ProviderInstanceId,
} from "@t3tools/contracts";
import type { ProviderAuthController } from "@t3tools/provider-core/server/auth";
import * as ProviderAuthFlow from "@t3tools/provider-core/server/providerAuthFlow";
import * as PtyAdapter from "@t3tools/shared/PtyAdapter";
import { resolveSpawnCommand } from "@t3tools/shared/shell";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Queue from "effect/Queue";
import * as Result from "effect/Result";
import * as Stream from "effect/Stream";
import * as SecureRandom from "effect/crypto/SecureRandom";

import type { OmpInstancePaths } from "./paths.ts";

const LOGIN_METHOD = {
  id: "omp-login",
  name: "Sign in with omp",
  description: null,
  type: "terminal",
} satisfies ProviderAuthMethod;

const TERMINAL_OUTPUT_LIMIT = 16_384;
const LOGIN_ERROR_LIMIT = 500;

function lastPrintedLines(output: string): string {
  const detail = NodeUtil.stripVTControlCharacters(output)
    .split("\n")
    .map((line) => line.trimEnd())
    // A carriage return redraws the line; previous content is no longer visible.
    .map((line) => line.slice(line.lastIndexOf("\r") + 1).trim())
    .filter((line) => line.length > 0)
    .slice(-5)
    .join(" ");
  return detail.length > LOGIN_ERROR_LIMIT
    ? `…${detail.slice(-LOGIN_ERROR_LIMIT).trimStart()}`
    : detail;
}

export const makeOmpAuth = Effect.fn("OmpAuth.make")(function* (options: {
  readonly instanceId: ProviderInstanceId;
  readonly enabled: boolean;
  readonly binaryPath: string;
  readonly cwd: string;
  readonly processEnv: NodeJS.ProcessEnv;
  readonly launchArgs:
    | { readonly ok: true; readonly paths: Pick<OmpInstancePaths, "agentDir" | "profile"> }
    | { readonly ok: false };
  readonly pty: Option.Option<PtyAdapter.PtyAdapter["Service"]>;
  readonly onChanged: () => Effect.Effect<void>;
}) {
  const { instanceId, launchArgs, pty } = options;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const agentDir = launchArgs.ok ? launchArgs.paths.agentDir : undefined;
  const canonicalAgentDir =
    agentDir === undefined
      ? instanceId
      : yield* fileSystem
          .realPath(agentDir)
          .pipe(Effect.orElseSucceed(() => path.resolve(agentDir)));
  const login =
    options.enabled && launchArgs.ok && Option.isSome(pty)
      ? Result.succeed({ pty: pty.value, profile: launchArgs.paths.profile })
      : Result.fail(
          new ProviderSetupError({
            instanceId,
            operation: "start",
            detail: !options.enabled
              ? "Enable omp before signing in."
              : !launchArgs.ok
                ? "Fix the omp launch settings before signing in."
                : "Interactive omp sign-in is unavailable in this environment.",
          }),
        );

  // Do not add a span containing failures derived from interactive terminal output.
  const runTerminal = Effect.fnUntraced(function* (
    target: { pty: PtyAdapter.PtyAdapter["Service"]; profile: string | undefined },
    context: ProviderAuthFlow.ProviderAuthFlowContext,
  ) {
    const command = yield* resolveSpawnCommand(
      options.binaryPath,
      target.profile === undefined ? ["login"] : ["--profile", target.profile, "login"],
      { env: options.processEnv, bypassNpmShim: true },
    );
    if (command.shell) {
      return yield* new ProviderSetupError({
        instanceId,
        operation: "start",
        detail: "Set the omp binary path to a native executable to open the sign-in terminal.",
      });
    }

    const exited = yield* Deferred.make<number>();
    const updates = yield* Queue.sliding<void>(1);
    let running = true;
    let output = "";
    let outputOffset = 0;
    const process = yield* Effect.acquireRelease(
      fileSystem.makeDirectory(options.cwd, { recursive: true }).pipe(
        Effect.andThen(
          target.pty.spawn({
            shell: command.command,
            args: [...command.args],
            cwd: options.cwd,
            cols: 80,
            rows: 24,
            env: options.processEnv,
          }),
        ),
        Effect.mapError(
          (cause) =>
            new ProviderSetupError({
              instanceId,
              operation: "start",
              detail: "Could not open the omp sign-in terminal.",
              cause,
            }),
        ),
      ),
      (process) =>
        Effect.sync(() => {
          if (!running) return;
          running = false;
          try {
            process.kill();
          } catch {}
        }),
      { interruptible: true },
    );
    yield* Effect.acquireRelease(
      Effect.sync(() =>
        process.onData((data) => {
          if (!running || data.length === 0) return;
          outputOffset += data.length;
          output =
            data.length >= TERMINAL_OUTPUT_LIMIT
              ? data.slice(-TERMINAL_OUTPUT_LIMIT)
              : (output + data).slice(-TERMINAL_OUTPUT_LIMIT);
          Queue.offerUnsafe(updates, undefined);
        }),
      ),
      (detach) => Effect.sync(detach),
    );
    yield* Effect.acquireRelease(
      Effect.sync(() =>
        process.onExit(({ exitCode }) => {
          if (!running) return;
          running = false;
          Deferred.doneUnsafe(exited, Effect.succeed(exitCode));
        }),
      ),
      (detach) => Effect.sync(detach),
    );

    const terminalClosed = new ProviderSetupError({
      instanceId,
      operation: "respond",
      detail: "The omp sign-in terminal is no longer available.",
    });
    const respond = (response: ProviderAuthResponse) =>
      Effect.suspend(() => {
        if (response.type !== "terminal") return Effect.void;
        if (!running) return Effect.fail(terminalClosed);
        return Effect.try({
          try: () => {
            if (response.size) process.resize(response.size.cols, response.size.rows);
            if (response.data) process.write(PtyAdapter.ptyInput(response.data, response.binary));
          },
          catch: () => terminalClosed,
        });
      });
    const publish = Effect.suspend(() =>
      context.setInteraction({ type: "terminal", id: "terminal", output, outputOffset }, respond),
    );
    if (running) {
      yield* publish;
      yield* Queue.take(updates).pipe(Effect.andThen(publish), Effect.forever, Effect.forkScoped);
    }

    const exitCode = yield* Deferred.await(exited);
    if (exitCode !== 0) {
      const detail = lastPrintedLines(output);
      return yield* new ProviderSetupError({
        instanceId,
        operation: "start",
        detail: `omp login exited with code ${exitCode}.${detail ? ` ${detail}` : ""}`,
      });
    }
  }, Effect.scoped);

  const rejectLogout = Effect.fail(
    new ProviderSetupError({
      instanceId,
      operation: "logout",
      detail: "omp does not support CLI sign-out. Manage credentials directly in omp.",
    }),
  );
  const makeFlow = ProviderAuthFlow.make({
    instanceId,
    credentialBinding: { owner: "provider", key: `omp:${canonicalAgentDir}` },
    methods: Effect.succeed(Result.isSuccess(login) ? [LOGIN_METHOD] : []),
    authenticate: (_methodId, context) =>
      Result.isFailure(login)
        ? Effect.fail(login.failure)
        : runTerminal(login.success, context).pipe(
            Effect.andThen(context.verifying),
            Effect.andThen(options.onChanged),
          ),
    logout: rejectLogout,
  });
  const random = yield* Effect.serviceOption(SecureRandom.SecureRandom);
  const flow = yield* Option.isSome(random)
    ? makeFlow.pipe(Effect.provideService(SecureRandom.SecureRandom, random.value))
    : makeFlow.pipe(Effect.provide(SecureRandom.layerWebCrypto));
  const controller: ProviderAuthController = {
    ...flow,
    ...(Result.isFailure(login) ? { start: () => Effect.fail(login.failure) } : {}),
    // The shared logout flow stops sessions before it invokes the provider callback.
    logout: () => rejectLogout,
    subscribe: (owner) =>
      flow
        .subscribe(owner)
        .pipe(
          Stream.map((state) =>
            state.phase === "failed" && state.flowId === null
              ? { ...state, message: "Sign-in failed. Start again." }
              : state,
          ),
        ),
  };
  return controller;
});
