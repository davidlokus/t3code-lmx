import * as Effect from "effect/Effect";
import type * as Path from "effect/Path";

import { ProviderDriverKind, type OrchestrationV2ProviderCapabilities } from "@t3tools/contracts";
import { tokenizeCliArgs } from "@t3tools/shared/cliArgs";
import { T3_CODE_ORCHESTRATION_INSTRUCTIONS } from "@t3tools/provider-core/server/orchestrationInstructions";
import type {
  PiDialect,
  PiDialectLaunch,
  PiDialectLaunchInput,
} from "@t3tools/provider-pi/server/dialect";
import { PiProviderCapabilitiesV2 } from "@t3tools/provider-pi/server/adapter";
import type { PiLaunchArgsResolution } from "@t3tools/provider-pi/server/mcpInjection";

import type { OmpSettings } from "../settings.ts";
import { makeOmpRpcConnection } from "./connection.ts";
import { OMP_THINKING_LEVELS } from "./modelCapabilities.ts";
import { isValidOmpProfileName, resolveOmpInstancePaths, type OmpInstancePaths } from "./paths.ts";
import { readOmpSessionCwd } from "./protocol.ts";

export const OMP_PROVIDER = ProviderDriverKind.make("omp");

// omp enforces approvals itself (`--approval-mode`), and has no Pi-style subagent tool to surface:
// its `task` tool appears as an ordinary tool call.
const OmpProviderCapabilities = {
  ...PiProviderCapabilitiesV2,
  runtimePolicy: { enforcement: "native" },
  subagents: {
    ...PiProviderCapabilitiesV2.subagents,
    supportsSubagents: false,
    emitsSubagentLifecycle: false,
  },
} satisfies OrchestrationV2ProviderCapabilities;

/** T3's runtime modes as omp's own `--approval-mode` values. */
const APPROVAL_MODES = {
  "approval-required": "always-ask",
  auto: "always-ask",
  "auto-accept-edits": "write",
  "full-access": "yolo",
} as const;

// Flags T3 owns: the mode, session binding, one-shot runs, and anything that would loosen approvals.
const RESERVED_ARGUMENTS = new Set([
  "--mode",
  "--continue",
  "-c",
  "--resume",
  "-r",
  "--session",
  "--from-claude",
  "--from-codex",
  "--fork",
  "--restore",
  "--no-session",
  "--print",
  "-p",
  "--export",
  "--help",
  "-h",
  "--version",
  "-v",
  "--approval-mode",
  "--auto-approve",
  "--yolo",
  "--plan-yolo",
  "--goal",
  "--plan-yolo-into",
  "--cwd",
  "--alias",
  "--no-ui",
  "--omp-profile-boundary",
]);

// Flags that take a value, from `omp --help`; a token after any other flag is a stray prompt.
const ARGUMENTS_WITH_VALUES = new Set([
  "--model",
  "--smol",
  "--slow",
  "--plan",
  "--prewalk-into",
  "--provider",
  "--api-key",
  "--system-prompt",
  "--system-prompt-template",
  "--append-system-prompt",
  "--profile",
  "--config",
  "--plugin-dir",
  "--provider-session-id",
  "--prompt-cache-key",
  "--add-dir",
  "--session-dir",
  "--models",
  "--tools",
  "--thinking",
  "--service-tier",
  "--hook",
  "--extension",
  "--trusted-extension",
  "-e",
  "--skills",
  "--spinner-interval",
  "--max-fps",
  "--motion",
  "--max-time",
  "--warn-cost",
  "--max-cost",
]);

const RESERVED_SHORT_FLAGS = new Set(["c", "r", "p", "h", "v"]);

const INVALID_PROFILE = {
  ok: false,
  message:
    "Invalid omp profile name. Use 1–64 lowercase letters, digits, dots, underscores, or hyphens. Start with a letter or digit and avoid trailing dots and Windows device names.",
} as const;

/** A reserved flag hidden in a short token: `-r=x`, `-rx`, `-cr`. */
function reservedShortFlag(arg: string): string | undefined {
  if (!arg.startsWith("-") || arg.startsWith("--") || arg.length < 2) return undefined;
  for (const flag of arg.slice(1)) {
    if (flag === "=") return undefined;
    if (RESERVED_SHORT_FLAGS.has(flag)) return `-${flag}`;
  }
  return undefined;
}

function resolveOmpLaunchArgs(launchArgs: string): PiLaunchArgsResolution {
  const tokens = tokenizeCliArgs(launchArgs);
  const args: Array<string> = [];
  for (let index = 0; index < tokens.length; index += 1) {
    const arg = tokens[index]!;
    const equals = arg.indexOf("=");
    const option = equals > 0 ? arg.slice(0, equals) : arg;
    const name = reservedShortFlag(option) ?? option;
    if (RESERVED_ARGUMENTS.has(name)) {
      return {
        ok: false,
        message: `omp launch argument '${name}' is controlled by T3 Code and cannot be overridden.`,
      };
    }
    if (option === "--" || arg === "-" || !arg.startsWith("-")) {
      return {
        ok: false,
        message: `omp launch arguments cannot include positional prompt '${arg}'.`,
      };
    }
    if (ARGUMENTS_WITH_VALUES.has(option)) {
      const value = equals > 0 ? arg.slice(equals + 1) : tokens[index + 1];
      // Extension flags can shadow built-ins, so a separated flag-looking token may not be consumed.
      if (value === undefined || value.length === 0 || value.startsWith("-")) {
        return {
          ok: false,
          message: `omp launch argument '${option}' requires a non-flag value.`,
        };
      }
      if (option === "--profile" && !isValidOmpProfileName(value)) return INVALID_PROFILE;
      // The bundled plan extension can treat --plan as a boolean; equals keeps its value out of argv.
      if (option === "--plan") args.push(`${option}=${value}`);
      else args.push(option, value);
      if (equals < 0) index += 1;
    } else if (arg.startsWith("--")) {
      args.push(arg);
    } else {
      return { ok: false, message: `Unsupported omp short launch argument '${option}'.` };
    }
  }
  return { ok: true, args };
}

const SETTINGS_FLAGS = [
  ["profile", "--profile"],
  ["serviceTier", "--service-tier"],
  ["smolModel", "--smol"],
  ["slowModel", "--slow"],
  ["planModel", "--plan"],
  ["advisor", "--advisor"],
] as const;

type OmpLaunchArgsResolution =
  | Extract<PiLaunchArgsResolution, { ok: false }>
  | { readonly ok: true; readonly args: ReadonlyArray<string>; readonly paths: OmpInstancePaths };

export const resolveOmpSettingsLaunchArgs = Effect.fn("OmpDialect.resolveSettingsLaunchArgs")(
  function* (
    settings: Partial<OmpSettings>,
    environment: NodeJS.ProcessEnv,
  ): Effect.fn.Return<OmpLaunchArgsResolution, never, Path.Path> {
    const manual = resolveOmpLaunchArgs(settings.launchArgs ?? "");
    if (!manual.ok) return manual;
    const args = [...manual.args];
    for (const [setting, flag] of SETTINGS_FLAGS) {
      const value = settings[setting];
      if (!value) continue;
      if (manual.args.some((arg) => arg === flag || arg.startsWith(`${flag}=`))) {
        return {
          ok: false,
          message: `omp setting '${setting}' conflicts with '${flag}' in launch arguments. Keep only one.`,
        };
      }
      if (value === true) args.push(flag);
      else if (value.startsWith("-")) {
        return { ok: false, message: `omp setting '${setting}' requires a non-flag value.` };
      } else if (flag === "--plan") args.push(`${flag}=${value}`);
      else args.push(flag, value);
    }
    const paths = yield* resolveOmpInstancePaths(settings, args, environment);
    return paths === null ? INVALID_PROFILE : { ok: true, args, paths };
  },
);

export function ompInventoryLaunchArgs(
  args: ReadonlyArray<string>,
  isAbsolute: (path: string) => boolean,
): ReadonlyArray<string> {
  const inventoryArgs: Array<string> = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    if (!ARGUMENTS_WITH_VALUES.has(arg)) continue;
    const value = args[index + 1];
    if (value === undefined || value.startsWith("-")) continue;
    if (arg === "--profile" || (arg === "--config" && isAbsolute(value))) {
      inventoryArgs.push(arg, value);
    }
    index += 1;
  }
  return inventoryArgs;
}

function withoutDisabledLaunchArgs(
  args: ReadonlyArray<string>,
  disableExtensions: boolean,
  disableTools: boolean,
  shortLived: boolean,
): ReadonlyArray<string> {
  if (!disableExtensions && !disableTools && !shortLived) return args;
  const filtered: Array<string> = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    const nextIsValue = ARGUMENTS_WITH_VALUES.has(arg);
    const dropExtension =
      disableExtensions &&
      (arg === "--extension" ||
        arg === "-e" ||
        arg === "--trusted-extension" ||
        arg === "--hook" ||
        arg === "--plugin-dir");
    if (
      dropExtension ||
      (disableTools && arg === "--tools") ||
      (shortLived && arg === "--add-dir")
    ) {
      if (nextIsValue) index += 1;
      continue;
    }
    filtered.push(arg);
    if (nextIsValue && args[index + 1] !== undefined) filtered.push(args[++index]!);
  }
  return filtered;
}

function buildOmpRpcLaunch(input: PiDialectLaunchInput): PiDialectLaunch {
  const launchArgs = withoutDisabledLaunchArgs(
    input.launchArgs,
    input.disableExtensions === true,
    input.disableTools === true,
    input.shortLived === true || input.ephemeral === true,
  );
  const args = [
    // Plain RPC exposes OMP host tools; do not switch to rpc-ui just to enable the native ask tool.
    "--mode",
    "rpc",
    ...(input.ephemeral === true
      ? ["--no-session"]
      : input.sessionPath !== undefined
        ? ["--resume", input.sessionPath]
        : []),
    ...launchArgs,
    ...(input.disableExtensions === true ? ["--no-extensions"] : []),
    ...(input.disableTools === true ? ["--no-tools"] : []),
    ...(input.ephemeral === true && input.disableTools === true
      ? ["--no-title", "--no-lsp", "--no-skills", "--no-rules", "--no-context-files"]
      : []),
    ...(input.runtimeMode === undefined
      ? []
      : ["--approval-mode", APPROVAL_MODES[input.runtimeMode]]),
    ...(input.mcpSession === undefined
      ? []
      : ["--append-system-prompt", T3_CODE_ORCHESTRATION_INSTRUCTIONS.trim()]),
  ];
  if (input.shortLived !== true && input.ephemeral !== true && input.extraRoots?.length) {
    const added = new Set<string>();
    for (let index = 0; index < launchArgs.length; index += 1) {
      if (launchArgs[index] === "--add-dir" && launchArgs[index + 1] !== undefined) {
        added.add(launchArgs[index + 1]!);
      }
    }
    for (const root of input.extraRoots) {
      if (root.trim().length === 0 || added.has(root)) continue;
      args.push("--add-dir", root);
      added.add(root);
    }
  }
  return { args, env: { ...input.environment } };
}

export const OMP_DIALECT: PiDialect = {
  driverKind: OMP_PROVIDER,
  defaultBinary: "omp",
  capabilities: OmpProviderCapabilities,
  showsExtensionStatuses: false,
  forwardsSessionApproval: true,
  thinkingLevels: OMP_THINKING_LEVELS,
  // Approvals are omp's own and T3's tools arrive as host tools, so there is nothing to install.
  readSessionCwd: readOmpSessionCwd,
  materializeExtension: () => Effect.undefined,
  resolveLaunchArgs: resolveOmpLaunchArgs,
  buildLaunch: buildOmpRpcLaunch,
  connect: makeOmpRpcConnection,
};
