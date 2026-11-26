import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as HttpClient from "effect/http/HttpClient";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import { makeManagedServerProvider } from "@t3tools/provider-core/server/managedProvider";
import { ProviderDriverError } from "@t3tools/provider-core/server/errors";
import {
  defaultProviderContinuationIdentity,
  type ProviderDriver,
  type ProviderInstance,
} from "@t3tools/provider-core/server/driver";
import { withInstanceIdentity } from "@t3tools/provider-core/server/instanceIdentity";
import {
  makeCachedProviderMaintenanceResolution,
  resolveProviderMaintenanceCapabilitiesEffect,
} from "@t3tools/provider-core/server/maintenanceResolver";
import { providerProbeEnvironment } from "@t3tools/provider-core/server/snapshotProbe";
import * as ProviderHost from "@t3tools/provider-core/server/ProviderHost";
import * as ProviderLatestVersions from "@t3tools/provider-core/server/ProviderLatestVersions";
import {
  haveProviderSnapshotSettingsChanged,
  makeProviderSnapshotSettingsSource,
  type ProviderSnapshotSettings,
} from "@t3tools/provider-core/server/snapshotSettings";
import { enrichPiSnapshot } from "@t3tools/provider-pi/server/status";
import type { PiAdapterV2DriverEnv } from "@t3tools/provider-pi/server/adapter";
import {
  withPiBuiltinSlashCommands,
  type PiDiscoveredCommands,
} from "@t3tools/provider-pi/server/commands";
import * as PtyAdapter from "@t3tools/shared/PtyAdapter";

import { OmpSettings } from "../settings.ts";
import { OmpAdapterV2Driver, ompInstanceEnvironment } from "./adapter.ts";
import { makeOmpAuth } from "./auth.ts";
import { OMP_DIALECT, OMP_PROVIDER, ompInventoryLaunchArgs } from "./dialect.ts";
import { OMP_MAINTENANCE_RESOLVER } from "./maintenance.ts";
import {
  buildInitialOmpProviderSnapshot,
  checkOmpProviderStatus,
  runOmpInventoryCommand,
} from "./status.ts";
import { makeOmpTextGeneration } from "./textGeneration.ts";
import { ompUsageReader } from "./usage.ts";

const decodeOmpSettings = Schema.decodeSync(OmpSettings);

export type OmpDriverEnv =
  | PiAdapterV2DriverEnv
  | ProviderHost.ProviderHost
  | ChildProcessSpawner.ChildProcessSpawner
  | FileSystem.FileSystem
  | HttpClient.HttpClient
  | ProviderLatestVersions.ProviderLatestVersions
  | Path.Path;

export const OmpDriver: ProviderDriver<OmpSettings, OmpDriverEnv, Path.Path> = {
  driverKind: OMP_PROVIDER,
  metadata: {
    displayName: "omp",
    supportsMultipleInstances: true,
  },
  configSchema: OmpSettings,
  defaultConfig: (): OmpSettings => decodeOmpSettings({}),
  usage: ompUsageReader,
  create: Effect.fn("OmpDriver.create")(function* ({
    instanceId,
    displayName,
    accentColor,
    environment,
    enabled,
    config,
  }) {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const fileSystem = yield* FileSystem.FileSystem;
    const pathService = yield* Path.Path;
    const httpClient = yield* HttpClient.HttpClient;
    const latestVersions = yield* ProviderLatestVersions.ProviderLatestVersions;
    const host = yield* ProviderHost.ProviderHost;
    const pty = yield* Effect.serviceOption(PtyAdapter.PtyAdapter);
    const probeCwd = pathService.join(host.paths.providerStatusCacheDir, "omp-status-probe");
    const effectiveConfig = { ...config, enabled } satisfies OmpSettings;
    const { env: processEnv, launchArgs } = yield* ompInstanceEnvironment(
      effectiveConfig,
      environment,
    );
    const continuationIdentity = defaultProviderContinuationIdentity({
      driverKind: OMP_PROVIDER,
      instanceId,
    });
    const stampIdentity = withInstanceIdentity({
      instanceId,
      driverKind: OMP_PROVIDER,
      displayName,
      accentColor,
      continuationGroupKey: continuationIdentity.continuationKey,
    });
    const resolveMaintenance = yield* makeCachedProviderMaintenanceResolution(
      resolveProviderMaintenanceCapabilitiesEffect(OMP_MAINTENANCE_RESOLVER, {
        binaryPath: effectiveConfig.binaryPath || OMP_DIALECT.defaultBinary,
        env: processEnv,
      }).pipe(
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
        Effect.provideService(FileSystem.FileSystem, fileSystem),
        Effect.provideService(Path.Path, pathService),
      ),
    );

    const workspaceCommands = new Map<string, PiDiscoveredCommands>();
    const workspaceRescans = yield* Queue.unbounded<string, Cause.Done>();
    yield* Effect.addFinalizer(() => Queue.end(workspaceRescans));
    const orchestrationAdapter = yield* OmpAdapterV2Driver.create({
      instanceId,
      displayName,
      accentColor,
      environment,
      enabled,
      config,
      onCommands: (cwd, catalog) =>
        Effect.sync(() => workspaceCommands.set(pathService.resolve(cwd), catalog)).pipe(
          Effect.andThen(Queue.offer(workspaceRescans, cwd)),
          Effect.asVoid,
        ),
    }).pipe(
      Effect.mapError(
        (cause) =>
          new ProviderDriverError({
            driver: OMP_PROVIDER,
            instanceId,
            detail: "Failed to build omp orchestration adapter.",
            cause,
          }),
      ),
    );

    const textGeneration = yield* makeOmpTextGeneration(effectiveConfig, processEnv);
    const prepareProbeCwd = fileSystem
      .makeDirectory(probeCwd, { recursive: true })
      .pipe(Effect.ignore);
    const checkProvider = prepareProbeCwd.pipe(
      Effect.andThen(
        checkOmpProviderStatus(
          effectiveConfig,
          processEnv,
          probeCwd,
          host.compatibility,
          Option.isSome(pty),
        ),
      ),
      Effect.map(stampIdentity),
      Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
      Effect.provideService(Path.Path, pathService),
    );
    const refreshModels = Effect.fn("OmpDriver.refreshModels")(function* () {
      if (!launchArgs.ok) {
        return yield* new ProviderDriverError({
          driver: OMP_PROVIDER,
          instanceId,
          detail: launchArgs.message,
        });
      }
      yield* prepareProbeCwd;
      const result = yield* runOmpInventoryCommand(
        effectiveConfig.binaryPath,
        [
          "models",
          "refresh",
          "--no-extensions",
          ...ompInventoryLaunchArgs(launchArgs.args, pathService.isAbsolute),
        ],
        providerProbeEnvironment(processEnv),
        probeCwd,
      ).pipe(
        Effect.timeout("30 seconds"),
        Effect.mapError(
          (cause) =>
            new ProviderDriverError({
              driver: OMP_PROVIDER,
              instanceId,
              detail:
                cause._tag === "TimeoutError"
                  ? "omp model refresh timed out."
                  : "Failed to run omp model refresh.",
              cause,
            }),
        ),
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
      );
      if (result.code !== 0) {
        return yield* new ProviderDriverError({
          driver: OMP_PROVIDER,
          instanceId,
          detail: `omp model refresh exited with code ${result.code}.`,
        });
      }
    });

    const snapshotSettings = yield* makeProviderSnapshotSettingsSource(effectiveConfig);
    const snapshot = yield* makeManagedServerProvider<ProviderSnapshotSettings<OmpSettings>>({
      resolveMaintenance,
      getSettings: snapshotSettings.getSettings,
      streamSettings: snapshotSettings.streamSettings,
      haveSettingsChanged: haveProviderSnapshotSettingsChanged,
      initialSnapshot: (settings) =>
        buildInitialOmpProviderSnapshot(settings.provider).pipe(Effect.map(stampIdentity)),
      checkProvider,
      enrichSnapshot: ({ settings, snapshot: currentSnapshot, publishSnapshot }) =>
        resolveMaintenance().pipe(
          Effect.flatMap((maintenanceCapabilities) =>
            enrichPiSnapshot({
              snapshot: currentSnapshot,
              maintenanceCapabilities,
              enableProviderUpdateChecks: settings.enableProviderUpdateChecks,
              publishSnapshot,
            }),
          ),
          Effect.provideService(HttpClient.HttpClient, httpClient),
          Effect.provideService(ProviderLatestVersions.ProviderLatestVersions, latestVersions),
        ),
    }).pipe(
      Effect.mapError(
        (cause) =>
          new ProviderDriverError({
            driver: OMP_PROVIDER,
            instanceId,
            detail: "Failed to build omp snapshot.",
            cause,
          }),
      ),
    );
    const auth = yield* makeOmpAuth({
      instanceId,
      enabled,
      binaryPath: effectiveConfig.binaryPath || OMP_DIALECT.defaultBinary,
      cwd: probeCwd,
      processEnv,
      launchArgs,
      pty,
      onChanged: () => snapshot.refresh.pipe(Effect.asVoid),
    });

    return {
      instanceId,
      driverKind: OMP_PROVIDER,
      continuationIdentity,
      displayName,
      accentColor,
      enabled,
      snapshot,
      workspaceRescans: Stream.fromQueue(workspaceRescans),
      // Background scans only read the command inventory reported by a live session.
      snapshotForCwd: (cwd) =>
        snapshot.getSnapshot.pipe(
          Effect.map((machineSnapshot) => {
            const commands = workspaceCommands.get(pathService.resolve(cwd));
            return commands === undefined
              ? machineSnapshot
              : {
                  ...machineSnapshot,
                  slashCommands: withPiBuiltinSlashCommands(commands.slashCommands),
                  skills: commands.skills,
                  slashCommandsPending: false,
                };
          }),
        ),
      orchestrationAdapter,
      textGeneration,
      auth,
      ...(enabled ? { refreshModels } : {}),
    } satisfies ProviderInstance;
  }),
};
