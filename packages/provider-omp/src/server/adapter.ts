import type {
  ProviderAdapterDriver,
  ProviderAdapterDriverCreateInput,
} from "@t3tools/provider-core/server/adapterDriver";
import { ProviderAdapterDriverCreateError } from "@t3tools/provider-core/server/adapterDriver";
import { mergeProviderInstanceEnvironment } from "@t3tools/provider-core/server/instanceEnvironment";
import * as ProviderContinuationRequests from "@t3tools/provider-core/server/ProviderContinuationRequests";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { makePiAdapterV2, type PiAdapterV2DriverEnv } from "@t3tools/provider-pi/server/adapter";
import {
  parsePiDiscoveredCommands,
  type PiDiscoveredCommands,
} from "@t3tools/provider-pi/server/commands";
import type { PiDialectConnectOptions } from "@t3tools/provider-pi/server/dialect";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import type { PiSettings } from "@t3tools/provider-pi/settings";

import { OmpSettings } from "../settings.ts";
import { OMP_DIALECT, OMP_PROVIDER, resolveOmpSettingsLaunchArgs } from "./dialect.ts";
import { makeOmpRpcConnection } from "./connection.ts";
import type { OmpInstancePaths } from "./paths.ts";
import { projectOmpCommands } from "./protocol.ts";

const DEFAULT_OMP_SETTINGS = Schema.decodeSync(OmpSettings)({});

// The shared replay harness passes the legacy Pi-shaped config to either adapter.
type OmpAdapterConfig = PiSettings & Partial<OmpSettings>;

const INHERITED_OMP_ENV: Readonly<Record<string, true>> = {
  PATH: true,
  HOME: true,
  USERPROFILE: true,
  HOMEDRIVE: true,
  HOMEPATH: true,
  APPDATA: true,
  LOCALAPPDATA: true,
  SYSTEMROOT: true,
  WINDIR: true,
  COMSPEC: true,
  PATHEXT: true,
  USER: true,
  USERNAME: true,
  LOGNAME: true,
  SHELL: true,
  TMP: true,
  TEMP: true,
  TMPDIR: true,
  LANG: true,
  LANGUAGE: true,
  TZ: true,
  XDG_CONFIG_HOME: true,
  XDG_DATA_HOME: true,
  XDG_STATE_HOME: true,
  XDG_CACHE_HOME: true,
  XDG_RUNTIME_DIR: true,
  HTTP_PROXY: true,
  HTTPS_PROXY: true,
  ALL_PROXY: true,
  NO_PROXY: true,
  SSL_CERT_FILE: true,
  SSL_CERT_DIR: true,
  NODE_EXTRA_CA_CERTS: true,
  T3CODE_OMP_PROBE_TIMEOUT_MS: true,
};

export function ompBaseEnvironment(host: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const base: NodeJS.ProcessEnv = {};
  // OMP accepts credentials from many providers, so only inherit environment needed to run it.
  for (const [name, value] of Object.entries(host)) {
    const upper = name.toUpperCase();
    if (Object.hasOwn(INHERITED_OMP_ENV, upper) || upper.startsWith("LC_")) {
      base[name] = value;
    }
  }
  return base;
}

export function withOmpAgentDir(
  settings: Pick<Partial<OmpSettings>, "agentDir">,
  env: NodeJS.ProcessEnv,
  paths: OmpInstancePaths,
): NodeJS.ProcessEnv {
  return settings.agentDir &&
    paths.profile === undefined &&
    env.PI_CODING_AGENT_DIR !== paths.agentDir
    ? { ...env, PI_CODING_AGENT_DIR: paths.agentDir }
    : env;
}

export const ompInstanceEnvironment = Effect.fn("OmpAdapter.instanceEnvironment")(function* (
  config: Partial<OmpSettings>,
  environment: ProviderAdapterDriverCreateInput<OmpSettings>["environment"],
) {
  const env = yield* mergeProviderInstanceEnvironment(
    environment,
    ompBaseEnvironment(yield* HostProcess.Environment),
  );
  const launchArgs = yield* resolveOmpSettingsLaunchArgs(config, env);
  return { env: launchArgs.ok ? withOmpAgentDir(config, env, launchArgs.paths) : env, launchArgs };
});

/** The Pi adapter running against omp's RPC dialect. */
export const OmpAdapterV2Driver = {
  driverKind: OMP_PROVIDER,
  configSchema: OmpSettings,
  defaultConfig: (): OmpSettings => DEFAULT_OMP_SETTINGS,
  create: Effect.fn("OmpAdapterV2Driver.create")(
    function* (
      input: ProviderAdapterDriverCreateInput<OmpAdapterConfig> & {
        readonly onCommands?:
          | ((cwd: string, catalog: PiDiscoveredCommands) => Effect.Effect<void>)
          | undefined;
      },
    ) {
      const { onCommands } = input;
      const { env, launchArgs } = yield* ompInstanceEnvironment(input.config, input.environment);
      const continuationRequests = yield* ProviderContinuationRequests.ProviderContinuationRequests;
      return yield* makePiAdapterV2({
        instanceId: input.instanceId,
        settings: { ...input.config, enabled: input.enabled },
        environment: env,
        continuationRequests,
        dialect: {
          ...OMP_DIALECT,
          resolveLaunchArgs: () => launchArgs,
          ...(onCommands === undefined
            ? {}
            : {
                connect: Effect.fn("OmpAdapter.connect")(function* (
                  options: PiDialectConnectOptions,
                ) {
                  const cwd = options.cwd;
                  // Fork inspection cannot report the catalog of the live session.
                  if (cwd === undefined || options.args.at(-2) === "--fork") {
                    return yield* OMP_DIALECT.connect(options);
                  }
                  let pushedCatalog = false;
                  const connection = yield* makeOmpRpcConnection({
                    ...options,
                    onCommands: (frame) =>
                      Effect.suspend(() => {
                        pushedCatalog = true;
                        return onCommands(
                          cwd,
                          parsePiDiscoveredCommands(projectOmpCommands(frame)),
                        );
                      }),
                  });
                  yield* connection.request({ type: "get_commands" }).pipe(
                    Effect.flatMap((data) =>
                      pushedCatalog
                        ? Effect.void
                        : onCommands(cwd, parsePiDiscoveredCommands(data)),
                    ),
                    Effect.ignore,
                    Effect.forkScoped,
                  );
                  return connection;
                }),
              }),
        },
      });
    },
    (effect, input) =>
      effect.pipe(
        Effect.mapError(
          (cause) =>
            new ProviderAdapterDriverCreateError({
              driver: OMP_PROVIDER,
              instanceId: input.instanceId,
              detail: "Failed to create omp adapter.",
              cause,
            }),
        ),
      ),
  ),
} satisfies ProviderAdapterDriver<OmpSettings, PiAdapterV2DriverEnv>;
