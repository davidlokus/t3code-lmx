// @effect-diagnostics nodeBuiltinImport:off - ZCode's external SQLite database is opened read-only.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeSqlite from "node:sqlite";
import * as NodeURL from "node:url";
import {
  type ProviderUsageScan,
  type UsageRecord,
  tokenCount,
  totalTokens,
} from "@t3tools/provider-core/server/usage";

const ZAI_PROVIDER = /bigmodel|z\.?ai|zhipu|zcode/i;
const USAGE_ROWS = `
  SELECT id, session_id, provider_id, model_id, started_at, input_tokens, output_tokens,
         reasoning_tokens, cache_read_input_tokens, cache_creation_input_tokens
    FROM main.model_usage
   WHERE status = 'completed' AND started_at >= ?
`;

function fileVersion(path: string): string | undefined {
  const stat = NodeFS.statSync(path, { bigint: true, throwIfNoEntry: false });
  if (!stat?.isFile()) return undefined;
  return `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`;
}

function hasPendingWal(path: string): boolean {
  return (NodeFS.statSync(`${path}-wal`, { throwIfNoEntry: false })?.size ?? 0) > 0;
}

function hasRollbackJournal(path: string): boolean {
  return (NodeFS.statSync(`${path}-journal`, { throwIfNoEntry: false })?.size ?? 0) > 0;
}

function hasShmIndex(path: string): boolean {
  return (NodeFS.statSync(`${path}-shm`, { throwIfNoEntry: false })?.size ?? 0) > 0;
}

function queryUsageRows(db: NodeSqlite.DatabaseSync, windowStartMs: number): UsageRecord[] {
  const records: UsageRecord[] = [];
  for (const row of db.prepare(USAGE_ROWS).iterate(windowStartMs)) {
    if (typeof row.provider_id !== "string" || !ZAI_PROVIDER.test(row.provider_id)) continue;
    const id = typeof row.id === "string" ? row.id.trim() : "";
    const model = typeof row.model_id === "string" ? row.model_id.trim() : "";
    const timestampMs = row.started_at;
    if (!id || !model || typeof timestampMs !== "number" || !Number.isFinite(timestampMs)) {
      continue;
    }
    const cachedInputTokens = tokenCount(row.cache_read_input_tokens);
    const cacheCreationTokens = tokenCount(row.cache_creation_input_tokens);
    const outputTokens = tokenCount(row.output_tokens);
    const totals = {
      uncachedInputTokens: Math.max(
        0,
        tokenCount(row.input_tokens) - cachedInputTokens - cacheCreationTokens,
      ),
      cachedInputTokens,
      cacheCreationTokens,
      outputTokens,
      reasoningTokens: Math.min(tokenCount(row.reasoning_tokens), outputTokens),
    };
    if (totalTokens(totals) === 0) continue;
    records.push({
      provider: "zai",
      model,
      timestampMs,
      sessionId: typeof row.session_id === "string" ? row.session_id.trim() : "",
      totals,
      reportedCostUsd: null,
      speed: "standard",
      dedupeKey: `zcode:${id}`,
    });
  }
  return records;
}

export function scanZcode(options: {
  readonly home: string;
  readonly windowStartMs: number;
  readonly databasePath?: string;
}): ProviderUsageScan {
  const dir =
    options.databasePath ?? NodePath.join(options.home, ".zcode", "cli", "db", "db.sqlite");
  const missing = { dir, files: null, status: "missing" } as const;
  const failed = {
    dir,
    files: [],
    status: "failed",
    message: "Could not read the ZCode usage database.",
  } as const;
  try {
    // existsSync alone also returns false on permission errors.
    if (!NodeFS.existsSync(dir) && NodeFS.statSync(dir, { throwIfNoEntry: false }) === undefined) {
      return missing;
    }
    const path = NodeFS.realpathSync(dir);
    const before = fileVersion(path);
    if (before === undefined) return failed;
    if (hasRollbackJournal(path)) {
      return { ...failed, message: "ZCode usage is unavailable until its SQLite journal clears." };
    }
    // When ZCode has an active WAL with an existing -shm index, read live committed WAL frames
    // read-only without creating sidecars. Otherwise use immutable mode to avoid creating sidecars.
    if (hasPendingWal(path)) {
      if (!hasShmIndex(path)) {
        return {
          ...failed,
          message: "ZCode usage is unavailable until its SQLite journal clears.",
        };
      }
      const db = new NodeSqlite.DatabaseSync(path, { readOnly: true });
      try {
        db.exec("PRAGMA busy_timeout = 100");
        const records = queryUsageRows(db, options.windowStartMs);
        return { dir, status: "ok", files: [{ path: dir, records }] };
      } finally {
        db.close();
      }
    }
    const uri = `${NodeURL.pathToFileURL(path).href}?immutable=1`;
    const db = new NodeSqlite.DatabaseSync(uri, { readOnly: true });
    let records: UsageRecord[];
    try {
      records = queryUsageRows(db, options.windowStartMs);
    } finally {
      db.close();
    }
    return before !== fileVersion(path) || hasPendingWal(path) || hasRollbackJournal(path)
      ? failed
      : { dir, status: "ok", files: [{ path: dir, records }] };
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT" ? missing : failed;
  }
}
