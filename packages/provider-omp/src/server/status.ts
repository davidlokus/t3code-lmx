import { type ServerProviderModel } from "@t3tools/contracts";
import { causeErrorTag } from "@t3tools/shared/observability";
import { resolveSpawnCommand } from "@t3tools/shared/shell";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import {
  brokenVersionDetail,
  noCompatibilityPolicy,
  type ProviderCompatibilityLookup,
} from "@t3tools/provider-core/server/compatibility";
import {
  buildServerProvider,
  isCommandMissingCause,
  parseCliVersionResult,
  providerModelsFromSettings,
  providerProbeEnvironment,
  resolveProviderProbeTimeoutMs,
  spawnAndCollect,
  type ServerProviderDraft,
} from "@t3tools/provider-core/server/snapshotProbe";
import { withPiBuiltinSlashCommands } from "@t3tools/provider-pi/server/commands";
import {
  piRecordField as recordField,
  piRecordString as recordString,
} from "@t3tools/provider-pi/server/rpc";

import type { OmpSettings } from "../settings.ts";
import {
  OMP_DIALECT,
  OMP_PROVIDER,
  ompInventoryLaunchArgs,
  resolveOmpLaunchArgs,
} from "./dialect.ts";
import { EMPTY_OMP_MODEL_CAPABILITIES, ompModelCapabilities } from "./modelCapabilities.ts";

const OMP_PRESENTATION = {
  displayName: "omp",
  showInteractionModeToggle: false,
  supportedRuntimeModes: ["approval-required", "auto-accept-edits", "full-access"],
  reportsContextWindow: true,
} as const;

const VERSION_PROBE_TIMEOUT_MS = 10_000;
const DISCOVERY_TIMEOUT_MS = 30_000;

const OMP_DEFAULT_MODEL: ServerProviderModel = {
  slug: "default",
  name: "omp default",
  isCustom: false,
  capabilities: EMPTY_OMP_MODEL_CAPABILITIES,
};

const modelsFromSettings = (
  customModels: OmpSettings["customModels"] | undefined,
  discovered: ReadonlyArray<ServerProviderModel> = [],
) =>
  providerModelsFromSettings(
    [OMP_DEFAULT_MODEL, ...discovered],
    customModels ?? [],
    EMPTY_OMP_MODEL_CAPABILITIES,
  );

export function parseOmpModels(
  data: unknown,
  state: unknown,
): ReadonlyArray<ServerProviderModel> | undefined {
  const models = recordField(data, "models");
  if (!Array.isArray(models)) return undefined;
  const active = recordField(state, "model");
  const seen = new Set<string>();
  const parsed: Array<ServerProviderModel> = [];
  for (const model of models) {
    const provider = recordString(model, "provider");
    const id = recordString(model, "id");
    // Image-generation catalog entries have no chat input and cannot start a turn.
    if (provider === undefined || id === undefined || recordField(model, "kind") === "image") {
      continue;
    }
    const slug = `${provider}/${id}`;
    if (seen.has(slug)) continue;
    seen.add(slug);
    const isActive =
      provider === recordString(active, "provider") && id === recordString(active, "id");
    parsed.push({
      slug,
      name: recordString(model, "name") ?? slug,
      subProvider: provider,
      isCustom: false,
      capabilities: ompModelCapabilities(
        model,
        isActive ? recordString(state, "thinkingLevel") : undefined,
      ),
    });
  }
  return parsed;
}

const decodeCatalog = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Unknown));

const readOmpModels = Effect.fn("OmpProviderStatus.readOmpModels")(function* (
  settings: OmpSettings,
  launchArgs: ReadonlyArray<string>,
  environment: NodeJS.ProcessEnv,
  cwd: string | undefined,
) {
  // Plain RPC starts user MCP servers even with --no-session and --no-extensions. Only use
  // the catalog command here; session launch arguments may explicitly load extensions.
  const path = yield* Path.Path;
  const result = yield* runInventoryCommand(
    settings,
    ["models", "--json", "--no-extensions", ...ompInventoryLaunchArgs(launchArgs, path.isAbsolute)],
    environment,
    cwd,
  );
  return result.code === 0
    ? parseOmpModels(Option.getOrUndefined(decodeCatalog(result.stdout)), undefined)
    : undefined;
});

const runInventoryCommand = Effect.fn("OmpProviderStatus.runInventoryCommand")(function* (
  settings: OmpSettings,
  args: ReadonlyArray<string>,
  environment: NodeJS.ProcessEnv,
  cwd?: string,
) {
  const command = settings.binaryPath || OMP_DIALECT.defaultBinary;
  const spawnCommand = yield* resolveSpawnCommand(command, [...args], { env: environment });
  return yield* spawnAndCollect(
    command,
    ChildProcess.make(spawnCommand.command, spawnCommand.args, {
      env: environment,
      cwd,
      extendEnv: false,
      shell: spawnCommand.shell,
    }),
  );
});

export const buildInitialOmpProviderSnapshot = Effect.fn(
  "OmpProviderStatus.buildInitialOmpProviderSnapshot",
)(function* (settings: OmpSettings): Effect.fn.Return<ServerProviderDraft> {
  const checkedAt = yield* Effect.map(DateTime.now, DateTime.formatIso);
  return {
    ...buildServerProvider({
      driver: OMP_PROVIDER,
      presentation: OMP_PRESENTATION,
      enabled: settings.enabled,
      checkedAt,
      models: modelsFromSettings(settings.customModels),
      slashCommands: settings.enabled ? withPiBuiltinSlashCommands([]) : [],
      probe: settings.enabled
        ? {
            installed: true,
            version: null,
            status: "warning",
            auth: { status: "unknown" },
            message: "Checking omp CLI availability...",
          }
        : {
            installed: false,
            version: null,
            status: "warning",
            auth: { status: "unknown" },
            message: "omp is disabled in T3 Code settings.",
          },
    }),
    supportsTextGeneration: false,
  };
});

export const checkOmpProviderStatus = Effect.fn("checkOmpProviderStatus")(function* (
  settings: OmpSettings,
  environment: NodeJS.ProcessEnv = process.env,
  cwd?: string,
  compatibility: ProviderCompatibilityLookup = noCompatibilityPolicy,
): Effect.fn.Return<
  ServerProviderDraft,
  never,
  ChildProcessSpawner.ChildProcessSpawner | Path.Path
> {
  const checkedAt = DateTime.formatIso(yield* DateTime.now);
  const fallbackModels = modelsFromSettings(settings.customModels);
  const draft = (
    probe: Parameters<typeof buildServerProvider>[0]["probe"],
    models = fallbackModels,
  ) => ({
    ...buildServerProvider({
      driver: OMP_PROVIDER,
      presentation: OMP_PRESENTATION,
      enabled: settings.enabled,
      checkedAt,
      models,
      slashCommands: settings.enabled ? withPiBuiltinSlashCommands([]) : [],
      probe,
    }),
    supportsTextGeneration: false,
  });

  if (!settings.enabled) {
    return draft({
      installed: false,
      version: null,
      status: "warning",
      auth: { status: "unknown" },
      message: "omp is disabled in T3 Code settings.",
    });
  }

  const probeEnvironment = providerProbeEnvironment(environment);
  const versionResult = yield* runInventoryCommand(
    settings,
    ["--version"],
    probeEnvironment,
    cwd,
  ).pipe(
    Effect.timeoutOption(
      resolveProviderProbeTimeoutMs("omp", VERSION_PROBE_TIMEOUT_MS, environment),
    ),
    Effect.result,
  );
  if (Result.isFailure(versionResult)) {
    const error = versionResult.failure;
    yield* Effect.logWarning("omp CLI health check failed.", { errorTag: error._tag });
    return draft({
      installed: !isCommandMissingCause(error),
      version: null,
      status: "error",
      auth: { status: "unknown" },
      message: isCommandMissingCause(error)
        ? "omp CLI (`omp`) is not installed or not on PATH. See https://github.com/can1357/oh-my-pi."
        : "Failed to execute omp CLI health check.",
    });
  }
  if (Option.isNone(versionResult.success)) {
    return draft({
      installed: true,
      version: null,
      status: "error",
      auth: { status: "unknown" },
      message: "omp CLI is installed but timed out while running `omp --version`.",
    });
  }
  const versionOutput = versionResult.success.value;
  const version = parseCliVersionResult(versionOutput);
  if (versionOutput.code !== 0) {
    return draft({
      installed: true,
      version,
      status: "error",
      auth: { status: "unknown" },
      message: "omp CLI is installed but failed to run.",
    });
  }
  if (version === null) {
    return draft({
      installed: true,
      version: null,
      status: "error",
      auth: { status: "unknown" },
      message: "T3 Code could not determine the omp version. Update omp, then refresh its status.",
    });
  }
  const broken = brokenVersionDetail({
    name: "omp",
    version,
    advisory: yield* compatibility(OMP_PROVIDER, version),
  });
  if (broken !== undefined) {
    return draft({
      installed: true,
      version,
      status: "error",
      auth: { status: "unknown" },
      message: broken,
    });
  }
  const launchArgs = resolveOmpLaunchArgs(settings.launchArgs);
  if (!launchArgs.ok) {
    return draft({
      installed: true,
      version,
      status: "error",
      auth: { status: "unknown" },
      message: launchArgs.message,
    });
  }

  const discoveryExit = yield* readOmpModels(settings, launchArgs.args, probeEnvironment, cwd).pipe(
    Effect.timeoutOption(resolveProviderProbeTimeoutMs("omp", DISCOVERY_TIMEOUT_MS, environment)),
    Effect.exit,
  );
  if (Exit.isFailure(discoveryExit) || Option.isNone(discoveryExit.value)) {
    if (Exit.isFailure(discoveryExit)) {
      yield* Effect.logWarning("omp model discovery failed.", {
        errorTag: causeErrorTag(discoveryExit.cause),
      });
    }
    return draft({
      installed: true,
      version,
      status: "ready",
      auth: { status: "unknown" },
      message:
        "omp is available, but T3 Code could not refresh its models. The live session will retry startup.",
    });
  }
  const discovery = discoveryExit.value.value;
  if (discovery === undefined) {
    return draft({
      installed: true,
      version,
      status: "ready",
      auth: { status: "unknown" },
      message: "omp returned an unreadable model catalog. The live session will retry startup.",
    });
  }
  const authenticated = discovery.length > 0;
  return draft(
    {
      installed: true,
      version,
      status: authenticated ? "ready" : "warning",
      // The safe catalog excludes extension models, so an empty result does not prove sign-out.
      auth: authenticated ? { status: "authenticated", type: "omp" } : { status: "unknown" },
      ...(authenticated
        ? {}
        : {
            message:
              "omp found no usable models without extensions. Run `omp` and use /login, or configure a provider in ~/.omp/agent.",
          }),
    },
    modelsFromSettings(settings.customModels, discovery),
  );
});
