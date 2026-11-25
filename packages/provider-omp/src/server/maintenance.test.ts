import { expect, it } from "@effect/vitest";
import * as ByteSize from "effect/ByteSize";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as TestClock from "effect/testing/TestClock";

import { OMP_MAINTENANCE_RESOLVER } from "./maintenance.ts";

const standalonePath = "/home/fixture/.local/bin/omp";
const context = {
  binaryPath: "omp",
  resolvedCommandPath: standalonePath,
  realCommandPath: standalonePath,
  platform: "darwin",
  env: { PATH: "/fixtures/bin", OPENAI_API_KEY: "not-for-updates" },
} as const;

const testFile: FileSystem.File.Info = {
  type: "File",
  mtime: Option.none(),
  atime: Option.none(),
  birthtime: Option.none(),
  dev: 1n,
  ino: Option.none(),
  mode: 0o755,
  nlink: Option.none(),
  uid: Option.none(),
  gid: Option.none(),
  rdev: Option.none(),
  size: ByteSize.bytes(1),
  blksize: Option.none(),
  blocks: Option.none(),
};

const permitWritesExcept = (readOnly?: string, portPath?: string) =>
  FileSystem.makeNoop({
    stat: () => Effect.succeed(testFile),
    access: (path, options) =>
      options?.writable && path === readOnly
        ? Effect.fail(
            PlatformError.systemError({
              _tag: "PermissionDenied",
              module: "FileSystem",
              method: "access",
            }),
          )
        : Effect.void,
    exists: (path) => Effect.succeed(path === portPath),
  });

const processHandle = (stdout: string | null, code = 0) =>
  ChildProcessSpawner.makeHandle({
    pid: ChildProcessSpawner.ProcessId(999_999_999),
    exitCode: stdout === null ? Effect.never : Effect.succeed(ChildProcessSpawner.ExitCode(code)),
    isRunning: Effect.succeed(stdout === null),
    kill: () => Effect.void,
    unref: Effect.succeed(Effect.void),
    stdin: Sink.drain,
    stdout: stdout === null ? Stream.never : Stream.encodeText(Stream.make(stdout)),
    stderr: Stream.empty,
    all: Stream.empty,
    getInputFd: () => Sink.drain,
    getOutputFd: () => Stream.empty,
  });

const noSpawn = ChildProcessSpawner.make(() => Effect.die("Unexpected maintenance subprocess"));
const resolve = (
  install: Parameters<typeof OMP_MAINTENANCE_RESOLVER.resolve>[0],
  fs = permitWritesExcept(),
  spawner = noSpawn,
) =>
  OMP_MAINTENANCE_RESOLVER.resolve(install).pipe(
    Effect.provideService(FileSystem.FileSystem, fs),
    Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
    Effect.provide(Path.layer),
  );

it.effect("exposes the native updater only when the executable and its parent are writable", () =>
  Effect.gen(function* () {
    const capabilities = yield* resolve(context);
    expect(capabilities.update).toMatchObject({
      executable: standalonePath,
      command: "omp update",
      args: ["update"],
      lockKey: "omp-native",
    });
    expect(capabilities.update?.env).not.toHaveProperty("OPENAI_API_KEY");
    expect(capabilities.latestVersionCacheKey).toContain(standalonePath);
    for (const path of [standalonePath, "/home/fixture/.local/bin"]) {
      expect(yield* resolve(context, permitWritesExcept(path))).toMatchObject({
        update: null,
        manualCommand: "omp update",
      });
    }
    expect(yield* resolve(null)).toMatchObject({ update: null, manualCommand: "omp update" });
  }),
);

it.effect.each([
  "/nix/store/hash-omp/bin/omp",
  "/opt/homebrew/Cellar/omp/19.2.1/bin/omp",
  "/custom/Caskroom/omp/19.2.1/bin/omp",
  "/opt/local/bin/omp",
  "/home/fixture/.local/share/mise/installs/omp/19.2.1/omp",
  "/custom/npm/lib/node_modules/oh-my-pi/bin/omp",
])("rejects a writable launcher resolving into a managed install: %s", (realCommandPath) =>
  Effect.gen(function* () {
    const capabilities = yield* resolve({ ...context, realCommandPath });
    expect(capabilities).toMatchObject({
      installPath: realCommandPath,
      update: null,
      manualCommand: "omp update",
    });
    expect(capabilities.latestVersionCacheKey).toContain(realCommandPath);
  }),
);

it.effect("does not offer self-update when a custom MacPorts registry owns the CLI", () =>
  Effect.gen(function* () {
    const portPath = "/custom/ports/bin/port";
    const realCommandPath = "/custom/ports/bin/omp";
    const spawner = ChildProcessSpawner.make((command) => {
      if (!ChildProcess.isStandardCommand(command) || command.command !== portPath) {
        return Effect.die("Expected MacPorts ownership probe");
      }
      return Effect.succeed(processHandle(`${realCommandPath} is provided by: omp\n`));
    });
    expect(
      yield* resolve(
        { ...context, realCommandPath },
        permitWritesExcept(undefined, portPath),
        spawner,
      ),
    ).toMatchObject({ update: null, manualCommand: "omp update" });
  }),
);

it.effect.each([
  {
    stdout: "Current version: 19.2.1\n\u001b[32m✔ Already up to date\u001b[0m",
    code: 0,
    version: "19.2.1",
  },
  {
    stdout: "Current version: 19.2.1\n\u001b[36mNew version available: 19.3.0\u001b[0m",
    code: 0,
    version: "19.3.0",
  },
  { stdout: "Current version: 19.2.1\nLatest version: v19.2.3", code: 0, version: "19.2.3" },
  { stdout: "Update available: 19.2.1 → 19.2.3", code: 0, version: "19.2.3" },
  { stdout: "v19.2.1 -> v19.2.3", code: 0, version: "19.2.3" },
  { stdout: "New version: 19.2.3", code: 0, version: "19.2.3" },
  {
    stdout: "Current version: 19.2.1\nUpstream returned HTTP 503 for 20.2.1",
    code: 0,
    version: null,
  },
  { stdout: "Latest version: 19.2.3", code: 1, version: null },
])(
  "checks release status without prompting an update from ambiguous output: $stdout",
  ({ stdout, code, version }) =>
    Effect.gen(function* () {
      const spawner = ChildProcessSpawner.make((command) =>
        Effect.sync(() => {
          if (!ChildProcess.isStandardCommand(command)) throw new Error("Expected an update check");
          expect(command.command).toBe(standalonePath);
          expect(command.args).toEqual(["update", "--check"]);
          expect(command.options.env).not.toHaveProperty("OPENAI_API_KEY");
          expect(command.options.extendEnv).toBe(false);
          return processHandle(stdout, code);
        }),
      );
      const { lookupLatestVersion } = yield* resolve(context, permitWritesExcept(), spawner);
      if (!lookupLatestVersion) throw new Error("Expected a lazy update check");
      expect(yield* lookupLatestVersion).toBe(version);
    }),
);

it.effect("returns no update advisory after ten seconds of no response", () =>
  Effect.gen(function* () {
    const spawned = yield* Deferred.make<void>();
    const spawner = ChildProcessSpawner.make(() =>
      Deferred.succeed(spawned, undefined).pipe(Effect.as(processHandle(null))),
    );
    const { lookupLatestVersion } = yield* resolve(context, permitWritesExcept(), spawner);
    if (!lookupLatestVersion) throw new Error("Expected a lazy update check");
    const probe = yield* lookupLatestVersion.pipe(Effect.forkScoped);
    yield* Deferred.await(spawned);
    yield* TestClock.adjust("10 seconds");
    expect(yield* Fiber.join(probe)).toBeNull();
  }),
);
