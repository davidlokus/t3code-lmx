import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import { expandHomePath } from "@t3tools/provider-core/server/pathExpansion";
import {
  parseTimestampMs,
  tokenCount,
  totalTokens,
  type ProviderUsageReader,
  type TranscriptUsageFormat,
  type UsageRecord,
} from "@t3tools/provider-core/server/usage";
import { piHome } from "@t3tools/provider-pi/server/usage";
import * as HostProcess from "@t3tools/shared/HostProcess";

import type { OmpSettings } from "../settings.ts";
import { ompLaunchSessionDir } from "./dialect.ts";

const OmpScanState = Schema.Struct({ sessionId: Schema.mutableKey(Schema.String) });
const Usage = Schema.Struct({
  input: Schema.optional(Schema.Unknown),
  output: Schema.optional(Schema.Unknown),
  cacheRead: Schema.optional(Schema.Unknown),
  cacheWrite: Schema.optional(Schema.Unknown),
  reasoning: Schema.optional(Schema.Unknown),
  reasoningTokens: Schema.optional(Schema.Unknown),
  cost: Schema.optional(Schema.Struct({ total: Schema.Unknown })),
});
const Identity = { id: Schema.NonEmptyString, timestamp: Schema.String };
const Model = {
  provider: Schema.NonEmptyString,
  model: Schema.NonEmptyString,
  responseModel: Schema.optional(Schema.NonEmptyString),
};
const Entry = Schema.Union([
  Schema.Struct({ type: Schema.Literal("session"), id: Schema.NonEmptyString }),
  Schema.Struct({
    ...Identity,
    type: Schema.Literal("message"),
    message: Schema.Union([
      Schema.Struct({
        ...Model,
        role: Schema.Literal("assistant"),
        usage: Usage,
      }),
      Schema.Struct({ role: Schema.Literal("toolResult"), usage: Usage }),
    ]),
  }),
  Schema.Struct({
    ...Identity,
    ...Model,
    type: Schema.Literals(["model_usage", "usage"]),
    usage: Usage,
  }),
  Schema.Struct({
    ...Identity,
    type: Schema.Literals(["compaction", "branch_summary"]),
    usage: Usage,
  }),
]);
const decodeEntry = Schema.decodeUnknownOption(Entry);

function parseRecord(parsed: unknown, state: typeof OmpScanState.Type): readonly UsageRecord[] {
  const decoded = decodeEntry(parsed);
  if (Option.isNone(decoded)) return [];
  const entry = decoded.value;
  if (entry.type === "session") {
    state.sessionId = entry.id;
    return [];
  }
  const timestampMs = parseTimestampMs(entry.timestamp);
  if (timestampMs === null) return [];
  const source = entry.type === "message" ? entry.message : entry;
  const usage = source.usage;
  const rateModel = "model" in source ? (source.responseModel ?? source.model) : undefined;
  const model = "provider" in source ? `${source.provider}/${rateModel}` : "Tools/summaries";
  const outputTokens = tokenCount(usage.output);
  const totals = {
    uncachedInputTokens: tokenCount(usage.input),
    cachedInputTokens: tokenCount(usage.cacheRead),
    cacheCreationTokens: tokenCount(usage.cacheWrite),
    outputTokens,
    reasoningTokens: Math.min(outputTokens, tokenCount(usage.reasoningTokens ?? usage.reasoning)),
  };
  const cost = usage.cost?.total;
  // Unpriced omp models report zero cost; leave null so shared model pricing can fill when known.
  const reportedCostUsd =
    typeof cost === "number" && Number.isFinite(cost) && cost > 0 ? cost : null;
  if (totalTokens(totals) === 0 && reportedCostUsd === null) return [];
  return [
    {
      provider: "omp",
      timestampMs,
      model,
      ...(rateModel === undefined ? {} : { rateModel }),
      sessionId: state.sessionId,
      totals,
      reportedCostUsd,
      speed: "standard",
      dedupeKey: JSON.stringify(["omp", entry.id, entry.timestamp, model]),
    },
  ];
}

export const ompUsageFormat: TranscriptUsageFormat<typeof OmpScanState.Type> = {
  selectFields: {
    type: true,
    id: true,
    timestamp: true,
    provider: true,
    model: true,
    responseModel: true,
    usage: true,
    message: { role: true, provider: true, model: true, responseModel: true, usage: true },
  },
  usageMarkers: ['"usage"', '"session"'],
  parseLine: (line, state) => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      return [];
    }
    return parseRecord(parsed, state);
  },
  parseProjected: parseRecord,
  state: { initial: () => ({ sessionId: "" }), schema: OmpScanState },
};

export const ompUsageReader: ProviderUsageReader<OmpSettings, Path.Path> = {
  kind: "transcripts",
  provider: "omp",
  format: ompUsageFormat,
  rateModel: (model) => model.slice(model.indexOf("/") + 1),
  directories: Effect.fn("ompUsageReader.directories")(function* ({ config, environment }) {
    const path = yield* Path.Path;
    const home = yield* HostProcess.HomeDirectory;
    const platform = yield* HostProcess.Platform;
    const launchHome = piHome(environment, home, platform);
    const sessionDirArg = config === undefined ? undefined : ompLaunchSessionDir(config.launchArgs);
    const launchDir =
      sessionDirArg === undefined ? undefined : expandHomePath(sessionDirArg, launchHome);
    const defaultDir = resolveOmpSessionsDir(environment, launchHome, path);
    const resolvedLaunchDir =
      launchDir !== undefined && path.isAbsolute(launchDir) ? path.resolve(launchDir) : undefined;
    return [
      ...(resolvedLaunchDir !== undefined && resolvedLaunchDir !== defaultDir
        ? [{ dir: resolvedLaunchDir }]
        : []),
      { dir: defaultDir },
    ];
  }),
};

/** Where omp stores session JSONL files for a provider environment. */
export function resolveOmpSessionsDir(
  environment: NodeJS.ProcessEnv,
  home: string,
  path: Path.Path,
): string {
  // Never inherit ambient PI_CODING_AGENT_* here, or omp would double-count Pi's sessions.
  const sessionDir = environment.OMP_CODING_AGENT_SESSION_DIR?.trim();
  if (sessionDir) return path.resolve(expandHomePath(sessionDir, home));
  const agentDir = environment.OMP_CODING_AGENT_DIR?.trim();
  return path.resolve(
    agentDir ? expandHomePath(agentDir, home) : path.join(home, ".omp", "agent"),
    "sessions",
  );
}
