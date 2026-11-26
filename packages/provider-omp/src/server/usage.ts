import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import type * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import {
  parseTimestampMs,
  tokenCount,
  totalTokens,
  type ProviderUsageReader,
  type TranscriptUsageFormat,
  type UsageRecord,
} from "@t3tools/provider-core/server/usage";
import * as HostProcess from "@t3tools/shared/HostProcess";

import type { OmpSettings } from "../settings.ts";
import { resolveOmpSettingsLaunchArgs } from "./dialect.ts";

const OmpScanState = Schema.Struct({
  sessionId: Schema.mutableKey(Schema.String),
  cwd: Schema.mutableKey(Schema.optionalKey(Schema.String)),
  pendingTitle: Schema.mutableKey(Schema.optionalKey(Schema.String)),
  titles: Schema.mutableKey(Schema.optionalKey(Schema.Record(Schema.String, Schema.String))),
});
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
  Schema.Struct({
    type: Schema.Literal("session"),
    id: Schema.NonEmptyString,
    cwd: Schema.optional(Schema.Unknown),
  }),
  Schema.Struct({ type: Schema.Literal("title"), title: Schema.String }),
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
  if (entry.type === "title") {
    const title = entry.title.trim();
    if (title) {
      if (state.sessionId) state.titles = { ...state.titles, [state.sessionId]: title };
      else state.pendingTitle = title;
    }
    return [];
  }
  if (entry.type === "session") {
    state.sessionId = entry.id;
    if (typeof entry.cwd === "string" && entry.cwd.trim()) state.cwd = entry.cwd.trim();
    else delete state.cwd;
    if (state.pendingTitle !== undefined) {
      state.titles = { ...state.titles, [entry.id]: state.pendingTitle };
      delete state.pendingTitle;
    }
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
      ...(state.cwd === undefined ? {} : { cwd: state.cwd }),
      totals,
      reportedCostUsd,
      speed: "standard",
      dedupeKey: JSON.stringify(["omp", entry.id, entry.timestamp, model]),
    },
  ];
}

const ompUsageFormat: TranscriptUsageFormat<typeof OmpScanState.Type> = {
  selectFields: {
    type: true,
    id: true,
    cwd: true,
    title: true,
    timestamp: true,
    provider: true,
    model: true,
    responseModel: true,
    usage: true,
    message: { role: true, provider: true, model: true, responseModel: true, usage: true },
  },
  usageMarkers: ['"usage"', '"session"', '"title"'],
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
  readSessionTitles: (state) => new Map(Object.entries(state.titles ?? {})),
  state: { initial: () => ({ sessionId: "" }), schema: OmpScanState },
};

export const ompUsageReader = {
  kind: "transcripts",
  provider: "omp",
  format: ompUsageFormat,
  rateModel: (model) => model.slice(model.indexOf("/") + 1),
  directories: Effect.fn("ompUsageReader.directories")(function* ({
    config,
    configured,
    environment,
  }) {
    // The merged history env has no provenance for an OMP_PROFILE identical to the host's.
    const pathsEnvironment =
      environment.OMP_PROFILE !== undefined &&
      (!configured || environment.OMP_PROFILE === (yield* HostProcess.Environment).OMP_PROFILE)
        ? { ...environment, OMP_PROFILE: undefined }
        : environment;
    const launch = yield* resolveOmpSettingsLaunchArgs(config ?? {}, pathsEnvironment);
    if (!launch.ok) return [];
    return [...launch.paths.extraSessionDirs, launch.paths.sessionsDir].map((dir) => ({ dir }));
  }),
} satisfies ProviderUsageReader<OmpSettings, Path.Path>;
