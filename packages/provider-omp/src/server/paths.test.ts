import { expect, it } from "@effect/vitest";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as Path from "effect/Path";

import { resolveOmpInstancePaths } from "./paths.ts";

const home = "/home/omp-fixture";
const resolve = (
  settings: Parameters<typeof resolveOmpInstancePaths>[0],
  args: ReadonlyArray<string> = [],
  environment: NodeJS.ProcessEnv = {},
) =>
  resolveOmpInstancePaths(settings, args, { HOME: home, ...environment }).pipe(
    Effect.provideService(HostProcess.Platform, "darwin"),
    Effect.provide(Path.layer),
  );

it.effect("resolves profiles in settings, argv, then env order", () =>
  Effect.gen(function* () {
    const environment = {
      OMP_PROFILE: "from-env",
      OMP_CODING_AGENT_SESSION_DIR: "/legacy/sessions",
      OMP_CODING_AGENT_DIR: "/legacy/agent",
    };
    const settings = { profile: "work.team-1_a", agentDir: "~/ignored" };
    const args = ["--profile", "from-args", "--session-dir", "/extra/sessions"];
    const agentDir = `${home}/.omp/profiles/work.team-1_a/agent`;
    expect(yield* resolve(settings, args, environment)).toEqual({
      profile: settings.profile,
      agentDir,
      dbPath: `${agentDir}/agent.db`,
      sessionsDir: `${agentDir}/sessions`,
      extraSessionDirs: ["/extra/sessions"],
    });
    expect(yield* resolve({ agentDir: settings.agentDir }, args, environment)).toMatchObject({
      sessionsDir: `${home}/.omp/profiles/from-args/agent/sessions`,
    });
    expect(yield* resolve({}, [], environment)).toMatchObject({
      sessionsDir: `${home}/.omp/profiles/from-env/agent/sessions`,
    });
  }),
);

it.effect("treats profile 'default' as no profile to match omp runtime path resolution", () =>
  Effect.gen(function* () {
    expect(yield* resolve({ profile: "default" })).toEqual({
      profile: undefined,
      agentDir: `${home}/.omp/agent`,
      dbPath: `${home}/.omp/agent/agent.db`,
      sessionsDir: `${home}/.omp/agent/sessions`,
      extraSessionDirs: [],
    });
    expect(yield* resolve({ profile: "default", agentDir: "~/custom" })).toMatchObject({
      profile: undefined,
      agentDir: `${home}/custom`,
      sessionsDir: `${home}/custom/sessions`,
    });
    expect(yield* resolve({}, ["--profile", "default"])).toMatchObject({
      profile: undefined,
      agentDir: `${home}/.omp/agent`,
    });
    expect(yield* resolve({}, [], { OMP_PROFILE: "default" })).toMatchObject({
      profile: undefined,
      agentDir: `${home}/.omp/agent`,
    });
  }),
);

it.effect("preserves legacy OMP directory overrides without using the host's Pi paths", () =>
  Effect.gen(function* () {
    const piEnv = {
      PI_CODING_AGENT_DIR: "/pi/agent",
      PI_CODING_AGENT_SESSION_DIR: "/pi/sessions",
    };
    expect(yield* resolve({}, [], piEnv)).toMatchObject({
      sessionsDir: `${home}/.omp/agent/sessions`,
    });
    const environment = { ...piEnv, OMP_CODING_AGENT_DIR: "~/legacy" };
    expect(yield* resolve({}, [], environment)).toMatchObject({
      sessionsDir: `${home}/legacy/sessions`,
    });
    expect(
      yield* resolve({ agentDir: "~/custom" }, ["--session-dir", "~/custom/sessions"], environment),
    ).toMatchObject({ sessionsDir: `${home}/custom/sessions`, extraSessionDirs: [] });
    expect(
      yield* resolve({}, ["--session-dir", "relative"], {
        ...environment,
        OMP_CODING_AGENT_SESSION_DIR: "~/legacy-sessions",
      }),
    ).toMatchObject({ sessionsDir: `${home}/legacy-sessions`, extraSessionDirs: [] });
  }),
);

it.effect.each([
  ".",
  "..",
  "../escape",
  ".hidden",
  "Mixed",
  "work.",
  "con",
  "prn.toml",
  "aux",
  "nul.txt",
  "com0.txt",
  "com9",
  "lpt0",
  "lpt9.rc",
  "a".repeat(65),
])("rejects profile %s rather than resolving another directory", (profile) =>
  Effect.gen(function* () {
    expect(yield* resolve({ profile })).toBeNull();
  }),
);

it.effect("allows 64 characters and rejects an invalid environment profile", () =>
  Effect.gen(function* () {
    const profile = "a".repeat(64);
    expect(yield* resolve({ profile })).toMatchObject({ profile });
    expect(yield* resolve({}, [], { OMP_PROFILE: "bad profile" })).toBeNull();
  }),
);
