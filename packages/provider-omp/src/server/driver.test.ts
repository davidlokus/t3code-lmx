import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import { ProviderInstanceId } from "@t3tools/contracts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import * as ProviderLatestVersions from "@t3tools/provider-core/server/ProviderLatestVersions";
import * as TestProviderHost from "@t3tools/provider-testing/TestProviderHost";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/http/HttpClient";
import * as Layer from "effect/Layer";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import { OmpDriver } from "./driver.ts";

const layerTest = TestProviderHost.layer({ runBackgroundWork: false }).pipe(
  Layer.provideMerge(NodeServices.layer),
  Layer.provideMerge(IdAllocator.layer),
  Layer.provideMerge(McpProviderSessions.layer),
  Layer.provideMerge(ProviderLatestVersions.layer),
  Layer.provideMerge(
    Layer.succeed(
      HttpClient.HttpClient,
      HttpClient.make(() => Effect.die("Unexpected HTTP request")),
    ),
  ),
);

it.effect.each([
  { profile: "work", code: 0 },
  { profile: "", code: 1 },
])("refreshes the catalog for the selected instance, exit status $code", ({ profile, code }) =>
  Effect.gen(function* () {
    const launches: Array<ChildProcess.StandardCommand> = [];
    const spawner = ChildProcessSpawner.make((command) =>
      Effect.sync(() => {
        if (!ChildProcess.isStandardCommand(command)) throw new Error("Expected an omp command");
        launches.push(command);
        const refresh = command.args[1] === "refresh";
        const stdout = command.args.includes("--version")
          ? "omp/19.2.1\n"
          : refresh
            ? ""
            : JSON.stringify({ models: [{ provider: "test", id: "model" }] });
        return ChildProcessSpawner.makeHandle({
          pid: ChildProcessSpawner.ProcessId(999_999_999),
          exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(refresh ? code : 0)),
          isRunning: Effect.succeed(false),
          kill: () => Effect.void,
          unref: Effect.succeed(Effect.void),
          stdin: Sink.drain,
          stdout: Stream.encodeText(Stream.make(stdout)),
          stderr: Stream.empty,
          all: Stream.empty,
          getInputFd: () => Sink.drain,
          getOutputFd: () => Stream.empty,
        });
      }),
    );
    const instance = yield* OmpDriver.create({
      instanceId: ProviderInstanceId.make("omp-fixture"),
      enabled: true,
      displayName: undefined,
      environment: [],
      config: {
        ...OmpDriver.defaultConfig(),
        binaryPath: "/omp-fixture/bin/omp",
        profile,
        agentDir: "~/instance",
        launchArgs: "--config /fixture/settings.yml --config relative.yml --extension /bad/ext.ts",
      },
    }).pipe(
      Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
      Effect.provideService(HostProcess.Environment, {
        HOME: "/omp-fixture",
        PI_CODING_AGENT_DIR: "/ambient/pi",
      }),
    );
    const snapshot = yield* instance.snapshot.refresh;
    expect(snapshot.models.map((model) => model.slug)).toEqual(["default", "test/model"]);
    expect(launches.some((command) => command.args.includes("refresh"))).toBe(false);

    if (!instance.refreshModels) throw new Error("Expected enabled omp to support refresh");
    if (code === 0) {
      yield* instance.refreshModels();
    } else {
      const error = yield* instance.refreshModels().pipe(Effect.flip);
      expect(error.detail).toContain(`exited with code ${code}`);
    }
    expect((yield* instance.snapshot.getSnapshot).models).toEqual(snapshot.models);
    const launch = launches.at(-1);
    expect(launch?.args).toEqual([
      "models",
      "refresh",
      "--no-extensions",
      "--config",
      "/fixture/settings.yml",
      ...(profile ? ["--profile", profile] : []),
    ]);
    expect(launch?.options.env?.PI_CODING_AGENT_DIR).toBe(
      profile ? undefined : "/omp-fixture/instance",
    );
  }).pipe(Effect.provide(layerTest)),
);
