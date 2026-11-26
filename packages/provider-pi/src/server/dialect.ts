// fork: the OMP driver shares the Pi adapter without sharing Pi's CLI or wire format.
import type { OrchestrationV2ProviderCapabilities, ProviderDriverKind } from "@t3tools/contracts";
import type { McpProviderSessionConfig } from "@t3tools/provider-core/server/mcpSession";
import type * as Effect from "effect/Effect";
import type * as FileSystem from "effect/FileSystem";
import type { PlatformError } from "effect/PlatformError";
import type { Scope } from "effect/Scope";
import type { ChildProcessSpawner } from "effect/process/ChildProcessSpawner";

import type { PiLaunchArgsResolution } from "./mcpInjection.ts";
import type { PiRpcConnection, PiRpcError, PiRpcSpawnOptions } from "./rpc.ts";

export interface PiDialectConnectOptions extends PiRpcSpawnOptions {
  readonly mcpSession?: McpProviderSessionConfig | undefined;
}

export interface PiDialectLaunchInput {
  readonly launchArgs: ReadonlyArray<string>;
  readonly environment: NodeJS.ProcessEnv;
  readonly mcpSession: McpProviderSessionConfig | undefined;
  readonly extensionPath: string | undefined;
  readonly sessionPath?: string | undefined;
  // fork: OMP forwards extra roots via --add-dir.
  readonly extraRoots?: ReadonlyArray<string> | undefined;
  readonly ephemeral?: boolean;
  readonly shortLived?: boolean;
  readonly disableExtensions?: boolean;
  readonly disableTools?: boolean;
  readonly runtimeMode?: "approval-required" | "auto-accept-edits" | "auto" | "full-access";
}

export interface PiDialectLaunch {
  readonly args: ReadonlyArray<string>;
  readonly env: NodeJS.ProcessEnv;
}

export interface PiDialect {
  readonly driverKind: ProviderDriverKind;
  readonly defaultBinary: string;
  readonly capabilities: OrchestrationV2ProviderCapabilities;
  // fork: OMP accepts auto, which Pi does not.
  readonly thinkingLevels?: ReadonlySet<string>;
  // Extension statuses are shown in a Pi-specific banner.
  readonly showsExtensionStatuses?: boolean;
  // A native session grant is enforced by the agent, not by Pi's host-side approval cache.
  readonly forwardsSessionApproval?: boolean;
  // A supplied reader must find the cwd in the bounded header; unknown cwd requires a fork.
  readonly readSessionCwd?: (headerLines: ReadonlyArray<string>) => string | undefined;
  readonly materializeExtension: (
    cacheDir: string,
  ) => Effect.Effect<string | undefined, PlatformError, FileSystem.FileSystem>;
  readonly resolveLaunchArgs: (launchArgs: string) => PiLaunchArgsResolution;
  readonly buildLaunch: (input: PiDialectLaunchInput) => PiDialectLaunch;
  readonly connect: (
    options: PiDialectConnectOptions,
  ) => Effect.Effect<PiRpcConnection, PiRpcError, ChildProcessSpawner | Scope>;
}
