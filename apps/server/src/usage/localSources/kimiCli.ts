// @effect-diagnostics nodeBuiltinImport:off - Kimi's event store is external and read-only.
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import { NonNegativeInt, TrimmedNonEmptyString } from "@t3tools/contracts";
import {
  type ProviderUsageScan,
  type UsageRecord,
  parseTimestampMs,
  tokenCount,
  totalTokens,
} from "@t3tools/provider-core/server/usage";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

const sequence = Schema.optional(NonNegativeInt);
const optionalText = Schema.optional(Schema.NullOr(Schema.String));
const decodeStep = Schema.decodeUnknownOption(
  Schema.fromJsonString(
    Schema.Struct({
      kind: Schema.Literal("event"),
      seq: sequence,
      envelope: Schema.Struct({
        type: Schema.Literal("turn.step.completed"),
        seq: sequence,
        session_id: TrimmedNonEmptyString,
        timestamp: Schema.String,
        payload: Schema.Struct({
          stepId: optionalText,
          model: optionalText,
          usage: Schema.Struct({
            inputOther: Schema.optional(Schema.Unknown),
            inputCacheRead: Schema.optional(Schema.Unknown),
            inputCacheCreation: Schema.optional(Schema.Unknown),
            output: Schema.optional(Schema.Unknown),
          }),
        }),
      }),
    }),
  ),
);

function parseRecords(contents: string): UsageRecord[] {
  const records: UsageRecord[] = [];
  for (const line of contents.split("\n")) {
    if (!line.includes("turn.step.completed")) continue;
    const event = Option.getOrUndefined(decodeStep(line));
    if (event === undefined) continue;
    const { session_id: sessionId, seq, timestamp, payload } = event.envelope;
    const step = payload.stepId?.trim() || (seq ?? event.seq);
    const timestampMs = parseTimestampMs(timestamp);
    if (step === undefined || timestampMs === null) continue;
    const { usage } = payload;
    const totals = {
      uncachedInputTokens: tokenCount(usage.inputOther),
      cachedInputTokens: tokenCount(usage.inputCacheRead),
      cacheCreationTokens: tokenCount(usage.inputCacheCreation),
      outputTokens: tokenCount(usage.output),
      reasoningTokens: 0,
    };
    if (totalTokens(totals) === 0) continue;
    records.push({
      provider: "kimi",
      model: payload.model?.trim() || "kimi",
      timestampMs,
      sessionId,
      totals,
      reportedCostUsd: null,
      speed: "standard",
      dedupeKey: `kimiCli:${sessionId}:${step}`,
    });
  }
  return records;
}

interface ParsedFile {
  readonly size: number;
  readonly mtimeMs: number;
  readonly records: readonly UsageRecord[];
}

export function makeKimiCliScanner() {
  let cached: Map<string, ParsedFile> | undefined;
  let generation = 0;
  return async (options: {
    readonly home: string;
    readonly windowStartMs: number;
    readonly directory?: string;
  }): Promise<ProviderUsageScan> => {
    const dir = options.directory ?? NodePath.join(options.home, ".kimi-code", "server", "events");
    const previous = cached;
    const scan = ++generation;
    const next = new Map<string, ParsedFile>();
    try {
      const entries = await NodeFSP.readdir(dir, { withFileTypes: true });
      const files: NonNullable<ProviderUsageScan["files"]>[number][] = [];
      let unread = 0;
      for (const entry of entries) {
        if (!entry.isFile() || !entry.name.startsWith("session_") || !entry.name.endsWith(".jsonl"))
          continue;
        const path = NodePath.join(dir, entry.name);
        try {
          // Stat before reading: an append during the read invalidates this key on the next scan.
          const { size, mtimeMs } = await NodeFSP.stat(path);
          if (mtimeMs < options.windowStartMs) continue;
          const hit = previous?.get(path);
          const parsed =
            hit?.size === size && hit.mtimeMs === mtimeMs
              ? hit
              : { size, mtimeMs, records: parseRecords(await NodeFSP.readFile(path, "utf8")) };
          next.set(path, parsed);
          files.push({
            path,
            records: parsed.records.filter((record) => record.timestampMs >= options.windowStartMs),
          });
        } catch {
          unread++;
        }
      }
      return unread === 0
        ? { dir, files, status: "ok" }
        : {
            dir,
            files,
            status: "partial",
            message: `${unread} Kimi CLI event file(s) could not be read.`,
          };
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === "ENOENT"
        ? { dir, files: null, status: "missing" }
        : { dir, files: [], status: "failed", message: "Could not read Kimi CLI event files." };
    } finally {
      if (scan === generation) cached = next;
    }
  };
}
