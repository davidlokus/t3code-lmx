import { expandHomePath } from "@t3tools/provider-core/server/pathExpansion";
import { piHome } from "@t3tools/provider-pi/server/usage";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as Path from "effect/Path";

import type { OmpSettings } from "../settings.ts";

export interface OmpInstancePaths {
  readonly agentDir: string;
  readonly sessionsDir: string;
  readonly dbPath: string;
  readonly profile: string | undefined;
  readonly extraSessionDirs: ReadonlyArray<string>;
}

const PROFILE_NAME = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const WINDOWS_DEVICE_NAME = /^(?:con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/;

export function isValidOmpProfileName(name: string): boolean {
  return PROFILE_NAME.test(name) && !name.endsWith(".") && !WINDOWS_DEVICE_NAME.test(name);
}

function launchValue(args: ReadonlyArray<string>, flag: string): string | undefined {
  const index = args.lastIndexOf(flag);
  return index === -1 ? undefined : args[index + 1];
}

// Values in launchArgs have already been normalized to separate flag/value tokens.
export const resolveOmpInstancePaths = Effect.fn("OmpPaths.resolve")(function* (
  settings: Pick<Partial<OmpSettings>, "profile" | "agentDir">,
  launchArgs: ReadonlyArray<string>,
  environment: NodeJS.ProcessEnv,
): Effect.fn.Return<OmpInstancePaths | null, never, Path.Path> {
  const rawProfile =
    settings.profile ||
    launchValue(launchArgs, "--profile") ||
    environment.OMP_PROFILE ||
    undefined;
  if (rawProfile !== undefined && !isValidOmpProfileName(rawProfile)) return null;
  // omp treats exact "default" as no profile, falling back to agentDir or ~/.omp/agent.
  const profile = rawProfile === "default" ? undefined : rawProfile;

  const path = yield* Path.Path;
  const home = piHome(environment, yield* HostProcess.HomeDirectory, yield* HostProcess.Platform);
  // UsageService passes the host environment too. Pi's variables are not OMP history roots.
  const customAgentDir = settings.agentDir || environment.OMP_CODING_AGENT_DIR?.trim();
  const agentDir =
    profile !== undefined
      ? path.resolve(home, ".omp", "profiles", profile, "agent")
      : customAgentDir
        ? path.resolve(expandHomePath(customAgentDir, home))
        : path.resolve(home, ".omp", "agent");
  const sessionOverride =
    profile === undefined ? environment.OMP_CODING_AGENT_SESSION_DIR?.trim() : undefined;
  const sessionsDir = sessionOverride
    ? path.resolve(expandHomePath(sessionOverride, home))
    : path.join(agentDir, "sessions");
  const launchDir = expandHomePath(launchValue(launchArgs, "--session-dir") ?? "", home);
  const extraDir = path.isAbsolute(launchDir) ? path.resolve(launchDir) : undefined;
  return {
    agentDir,
    sessionsDir,
    dbPath: path.join(agentDir, "agent.db"),
    profile,
    extraSessionDirs: extraDir !== undefined && extraDir !== sessionsDir ? [extraDir] : [],
  };
});
