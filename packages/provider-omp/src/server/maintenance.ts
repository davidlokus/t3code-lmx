// @effect-diagnostics nodeBuiltinImport:off -- Normalize CLI output before matching version lines.
import * as NodeUtil from "node:util";
import {
  homebrewOwnershipFromCommandPath,
  isNixStoreCommandPath,
  makeManualOnlyProviderMaintenanceCapabilities,
  makeProviderMaintenanceCapabilities,
  normalizeCommandPath,
  resolveMacPortsOwner,
  resolveMiseProviderMaintenance,
  type ProviderMaintenanceCapabilitiesResolver,
} from "@t3tools/provider-core/server/maintenanceResolver";
import { providerProbeEnvironment } from "@t3tools/provider-core/server/snapshotProbe";
import { compareSemverVersions } from "@t3tools/shared/semver";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import { ompBaseEnvironment } from "./adapter.ts";
import { OMP_PROVIDER } from "./dialect.ts";
import { runOmpInventoryCommand } from "./status.ts";

const VERSION = String.raw`v?((?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*))`;
const CURRENT_VERSION = new RegExp(`^Current version:\\s*${VERSION}$`, "i");
const LATEST_VERSION = new RegExp(
  `^(?:Latest version|New version available|New version|Update available):\\s*${VERSION}$`,
  "i",
);
const VERSION_TRANSITION = new RegExp(
  `^(?:Update available:\\s*)?${VERSION}\\s*(?:->|→)\\s*${VERSION}$`,
  "i",
);

function parseOmpUpdateCheckOutput(output: string): string | null {
  let current: string | undefined;
  let latest: string | undefined;
  let upToDate = false;
  for (const line of NodeUtil.stripVTControlCharacters(output).split(/\r?\n/)) {
    const message = line.trim().replace(/^[✔✓ℹ]\s+/, "");
    current ??= CURRENT_VERSION.exec(message)?.[1];
    upToDate ||= /^Already up to date\.?$/i.test(message);
    const transition = VERSION_TRANSITION.exec(message);
    const candidate = LATEST_VERSION.exec(message)?.[1] ?? transition?.[2];
    if (candidate === undefined) continue;
    if (latest !== undefined && candidate !== latest) return null;
    if (transition?.[1] && compareSemverVersions(transition[1], candidate) >= 0) return null;
    latest = candidate;
  }
  if (upToDate) return latest === undefined || latest === current ? (current ?? null) : null;
  if (current && latest && compareSemverVersions(current, latest) > 0) return null;
  return latest ?? null;
}

function isManagedCommandPath(commandPath: string): boolean {
  const normalized = normalizeCommandPath(commandPath);
  return (
    isNixStoreCommandPath(commandPath) ||
    homebrewOwnershipFromCommandPath(commandPath) !== null ||
    normalized.includes("/node_modules/") ||
    /^\/(?:opt\/(?:homebrew|local)|usr\/local\/homebrew|home\/linuxbrew\/\.linuxbrew)\//.test(
      normalized,
    )
  );
}

const OWNER = { provider: OMP_PROVIDER, packageName: null };

export const OMP_MAINTENANCE_RESOLVER: ProviderMaintenanceCapabilitiesResolver = {
  resolve: Effect.fn("OmpMaintenance.resolve")(function* (context) {
    if (context === null) {
      return makeManualOnlyProviderMaintenanceCapabilities({
        ...OWNER,
        manualCommand: "omp update",
      });
    }

    const env = ompBaseEnvironment(context.env);
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const lookupLatestVersion = runOmpInventoryCommand(
      context.resolvedCommandPath,
      ["update", "--check"],
      providerProbeEnvironment(env),
    ).pipe(
      Effect.timeout("10 seconds"),
      Effect.map(({ code, stdout, stderr }) =>
        code === 0 ? parseOmpUpdateCheckOutput(`${stdout}\n${stderr}`) : null,
      ),
      Effect.orElseSucceed(() => null),
      Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
    );
    const manual = () => ({
      ...makeManualOnlyProviderMaintenanceCapabilities({
        ...OWNER,
        installPath: context.realCommandPath,
        manualCommand: "omp update",
        lookupLatestVersion,
      }),
      latestVersionCacheKey: `omp:${context.realCommandPath}`,
    });
    if (
      [context.resolvedCommandPath, context.realCommandPath].some(isManagedCommandPath) ||
      (yield* resolveMiseProviderMaintenance(OWNER, undefined, context)) !== null ||
      (yield* resolveMacPortsOwner({ ...context, env })) !== null
    ) {
      return manual();
    }

    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const parent = path.dirname(context.realCommandPath);
    const writableFile = yield* fs.stat(context.realCommandPath).pipe(
      Effect.flatMap((info) =>
        info.type === "File"
          ? fs.access(context.realCommandPath, { writable: true }).pipe(Effect.as(true))
          : Effect.succeed(false),
      ),
      Effect.orElseSucceed(() => false),
    );
    const writableParent =
      writableFile &&
      (yield* fs.access(parent, { writable: true }).pipe(
        Effect.as(true),
        Effect.orElseSucceed(() => false),
      ));
    if (!writableParent) return manual();

    return {
      ...makeProviderMaintenanceCapabilities({
        ...OWNER,
        updateExecutable: context.resolvedCommandPath,
        updateArgs: ["update"],
        updateLockKey: "omp-native",
        updateCommand: "omp update",
        env,
        latestVersion: null,
        lookupLatestVersion,
      }),
      latestVersionCacheKey: `omp:${context.realCommandPath}`,
    };
  }),
};
