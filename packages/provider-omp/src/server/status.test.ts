import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";
import * as Schema from "effect/Schema";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import { OmpSettings } from "../settings.ts";
import { OMP_PROVIDER } from "./dialect.ts";
import {
  buildInitialOmpProviderSnapshot,
  checkOmpProviderStatus,
  parseOmpModels,
} from "./status.ts";

// Trimmed from `get_state` and `get_available_models` of omp 18.20.2.
const state = {
  model: { provider: "magpie", id: "auto/deepseek-v4.1-flash" },
  thinkingLevel: "high",
  configuredThinkingLevel: "auto",
};
const models = {
  models: [
    {
      id: "auto/deepseek-v4.1-flash",
      name: "DeepSeek V4.1 Flash · routing group",
      provider: "magpie",
      reasoning: true,
      thinking: { mode: "effort", efforts: ["low", "high", "max"] },
    },
    { id: "plain", name: "Plain", provider: "magpie", reasoning: false },
    { id: "codex/gpt-image-2", provider: "magpie", kind: "image" },
    { id: "auto/deepseek-v4.1-flash", name: "Duplicate", provider: "magpie" },
  ],
};

const probeCwd = "/cache/omp-status-probe";
const settings = Schema.decodeSync(OmpSettings)({
  enabled: true,
  binaryPath: "omp",
  profile: "work",
  agentDir: "~/ignored",
  launchArgs: "--extension custom.ts --hook startup.ts --no-lsp",
});

const cliCatalog = {
  models: [
    {
      id: "gpt-5",
      provider: "openai",
      name: "GPT-5",
      reasoning: true,
      thinking: ["low", "high"],
    },
  ],
};

function probeSpawner(version: string, catalog: unknown = cliCatalog) {
  const launches: Array<{ args: ReadonlyArray<string>; cwd?: string; agentDir?: string }> = [];
  const spawner = ChildProcessSpawner.make((command) =>
    Effect.sync(() => {
      if (!ChildProcess.isStandardCommand(command)) throw new Error("Expected an omp command");
      const agentDir = command.options.env?.PI_CODING_AGENT_DIR;
      launches.push({
        args: command.args.map(String),
        ...(command.options.cwd ? { cwd: command.options.cwd } : {}),
        ...(typeof agentDir === "string" ? { agentDir } : {}),
      });
      const output = command.args.includes("--version")
        ? `omp/${version}\n`
        : JSON.stringify(catalog);
      return ChildProcessSpawner.makeHandle({
        pid: ChildProcessSpawner.ProcessId(900_000_001),
        exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(0)),
        isRunning: Effect.succeed(false),
        kill: () => Effect.void,
        unref: Effect.succeed(Effect.void),
        stdin: Sink.drain,
        stdout: Stream.succeed(new TextEncoder().encode(output)),
        stderr: Stream.empty,
        all: Stream.empty,
        getInputFd: () => Sink.drain,
        getOutputFd: () => Stream.empty,
      });
    }),
  );
  return { spawner, launches };
}

describe("omp model discovery", () => {
  it("lists chat models by provider/id and reports each reasoning model's efforts", () => {
    const parsed = parseOmpModels(models, state);
    expect(parsed?.map((model) => model.slug)).toEqual([
      "magpie/auto/deepseek-v4.1-flash",
      "magpie/plain",
    ]);
    expect(parsed?.[0]).toMatchObject({
      name: "DeepSeek V4.1 Flash · routing group",
      subProvider: "magpie",
    });
    const thinking = parsed?.[0]?.capabilities?.optionDescriptors?.[0];
    expect(thinking).toMatchObject({ id: "thinking", type: "select" });
    expect(thinking?.type === "select" ? thinking.options : undefined).toEqual([
      { id: "off", label: "Off" },
      { id: "auto", label: "Auto", isDefault: true },
      { id: "low", label: "Low" },
      { id: "high", label: "High" },
      { id: "max", label: "Max" },
    ]);
    expect(parsed?.[1]?.capabilities?.optionDescriptors).toEqual([]);
  });

  it("returns undefined for an unreadable catalog", () => {
    expect(parseOmpModels({ models: "none" }, state)).toBeUndefined();
    expect(parseOmpModels(undefined, state)).toBeUndefined();
  });

  it.effect("does not start RPC or load session extensions during catalog refresh", () =>
    Effect.gen(function* () {
      const { spawner, launches } = probeSpawner("19.1.1");
      const snapshot = yield* checkOmpProviderStatus(settings, {}, probeCwd).pipe(
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
        Effect.provide(Path.layer),
      );
      expect(launches).toEqual([
        { args: ["--version"], cwd: probeCwd },
        { args: ["models", "--json", "--no-extensions", "--profile", "work"], cwd: probeCwd },
      ]);
      expect(snapshot).toMatchObject({
        status: "ready",
        version: "19.1.1",
        supportsTextGeneration: true,
      });
      expect(snapshot.models.map((model) => model.slug)).toEqual(["default", "openai/gpt-5"]);
      expect(snapshot.models[1]?.capabilities?.optionDescriptors).toMatchObject([
        { id: "thinking", options: [{ id: "off" }, { id: "auto" }, { id: "low" }, { id: "high" }] },
      ]);
    }),
  );

  it.effect(
    "offers PTY sign-in without usable models, but disables setup when the instance is disabled",
    () =>
      Effect.gen(function* () {
        const { spawner, launches } = probeSpawner("19.2.1", {
          models: [
            { provider: "openai", id: "image", kind: "image" },
            { provider: "openai", id: "" },
          ],
        });
        const environment = { HOME: "/fixture-home" };
        const config = { ...settings, profile: "", agentDir: "~/alternate" };
        const probe = (enabled: boolean) =>
          checkOmpProviderStatus(
            { ...config, enabled },
            environment,
            probeCwd,
            undefined,
            true,
          ).pipe(
            Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
            Effect.provide(Path.layer),
          );
        expect(yield* probe(true)).toMatchObject({
          supportsTextGeneration: false,
          auth: { status: "unknown", canLogout: false },
          setup: { canInstall: false, canAuthenticate: true },
        });
        expect(yield* probe(false)).toMatchObject({
          supportsTextGeneration: false,
          auth: { canLogout: false },
          setup: { canInstall: false, canAuthenticate: false },
        });
        expect(launches).toEqual([
          { args: ["--version"], cwd: probeCwd, agentDir: "/fixture-home/alternate" },
          {
            args: ["models", "--json", "--no-extensions"],
            cwd: probeCwd,
            agentDir: "/fixture-home/alternate",
          },
        ]);
      }),
  );

  it.effect.each([
    { profile: "nul.txt", launchArgs: "", error: "Invalid omp profile name" },
    { profile: "work", launchArgs: "--profile=other", error: "'profile' conflicts" },
  ])("rejects $profile / $launchArgs before spawning omp", ({ error, ...config }) =>
    Effect.gen(function* () {
      const { spawner, launches } = probeSpawner("19.2.1");
      const snapshot = yield* checkOmpProviderStatus(
        { ...settings, ...config },
        {},
        probeCwd,
        undefined,
        true,
      ).pipe(
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
        Effect.provide(Path.layer),
      );
      expect(snapshot).toMatchObject({
        status: "error",
        supportsTextGeneration: false,
        setup: { canInstall: false, canAuthenticate: false },
        message: expect.stringContaining(error),
      });
      expect(launches).toEqual([]);
    }),
  );

  it.effect("uses the supplied compatibility policy before discovery", () =>
    Effect.gen(function* () {
      const { spawner, launches } = probeSpawner("99.0.0");
      const snapshot = yield* checkOmpProviderStatus(settings, {}, probeCwd, (driver, version) => {
        expect(driver).toBe(OMP_PROVIDER);
        expect(version).toBe("99.0.0");
        return Effect.succeed({
          status: "broken",
          recommendedVersion: null,
          recommendedRange: ">=100.0.0",
          message: null,
        });
      }).pipe(
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
        Effect.provide(Path.layer),
      );
      expect(launches).toEqual([{ args: ["--version"], cwd: probeCwd }]);
      expect(snapshot.status).toBe("error");
      expect(snapshot.message).toContain(">=100.0.0");
    }),
  );
});

it.effect("does not advertise setup before the CLI has been checked", () =>
  Effect.gen(function* () {
    expect(yield* buildInitialOmpProviderSnapshot(settings)).toMatchObject({
      auth: { canLogout: false },
      setup: { canInstall: false, canAuthenticate: false },
    });
  }),
);

it.effect("does not offer PTY sign-in when the omp executable is missing", () =>
  Effect.gen(function* () {
    const spawner = ChildProcessSpawner.make(() =>
      Effect.fail(
        PlatformError.systemError({
          _tag: "NotFound",
          module: "ChildProcess",
          method: "spawn",
          description: "omp not found",
        }),
      ),
    );
    const snapshot = yield* checkOmpProviderStatus(settings, {}, probeCwd, undefined, true).pipe(
      Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
      Effect.provide(Path.layer),
    );
    expect(snapshot).toMatchObject({
      installed: false,
      auth: { canLogout: false },
      setup: { canInstall: false, canAuthenticate: false },
    });
  }),
);
