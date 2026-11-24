import * as Effect from "effect/Effect";

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

import { makeOmpRpcConnection } from "./connection.ts";
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

/** A reserved flag hidden in a short token: `-r=x`, `-rx`, `-cr`. */
function reservedShortFlag(arg: string): string | undefined {
  if (!arg.startsWith("-") || arg.startsWith("--") || arg.length < 2) return undefined;
  for (const flag of arg.slice(1)) {
    if (flag === "=") return undefined;
    if (RESERVED_SHORT_FLAGS.has(flag)) return `-${flag}`;
  }
  return undefined;
}

export function resolveOmpLaunchArgs(launchArgs: string): PiLaunchArgsResolution {
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

export function ompLaunchSessionDir(launchArgs: string): string | undefined {
  const resolved = resolveOmpLaunchArgs(launchArgs);
  if (!resolved.ok) return undefined;
  let sessionDir: string | undefined;
  for (let index = 0; index < resolved.args.length; index += 1) {
    const arg = resolved.args[index];
    if (arg === undefined || !ARGUMENTS_WITH_VALUES.has(arg)) continue;
    index += 1;
    if (arg === "--session-dir") sessionDir = resolved.args[index] || undefined;
  }
  return sessionDir;
}

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
): ReadonlyArray<string> {
  if (!disableExtensions && !disableTools) return args;
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
    if (dropExtension || (disableTools && arg === "--tools")) {
      if (nextIsValue) index += 1;
      continue;
    }
    filtered.push(arg);
    if (nextIsValue && args[index + 1] !== undefined) filtered.push(args[++index]!);
  }
  return filtered;
}

export function buildOmpRpcLaunch(input: PiDialectLaunchInput): PiDialectLaunch {
  const launchArgs = withoutDisabledLaunchArgs(
    input.launchArgs,
    input.disableExtensions === true,
    input.disableTools === true,
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
    ...(input.runtimeMode === undefined
      ? []
      : ["--approval-mode", APPROVAL_MODES[input.runtimeMode]]),
    ...(input.mcpSession === undefined
      ? []
      : ["--append-system-prompt", T3_CODE_ORCHESTRATION_INSTRUCTIONS.trim()]),
  ];
  return { args, env: { ...input.environment } };
}

export const OMP_DIALECT: PiDialect = {
  driverKind: OMP_PROVIDER,
  defaultBinary: "omp",
  capabilities: OmpProviderCapabilities,
  showsExtensionStatuses: false,
  forwardsSessionApproval: true,
  // Approvals are omp's own and T3's tools arrive as host tools, so there is nothing to install.
  readSessionCwd: readOmpSessionCwd,
  materializeExtension: () => Effect.undefined,
  resolveLaunchArgs: resolveOmpLaunchArgs,
  buildLaunch: buildOmpRpcLaunch,
  connect: makeOmpRpcConnection,
};
