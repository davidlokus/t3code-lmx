// @effect-diagnostics nodeBuiltinImport:off - tests seed isolated SQLite usage stores.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeSqlite from "node:sqlite";
import { describe, expect, it } from "vite-plus/test";
import { scanZcode } from "./zcode.ts";

const SINCE = Date.parse("2026-08-01T00:00:00Z");
const TABLE = `CREATE TABLE model_usage (
  id TEXT PRIMARY KEY, session_id TEXT, provider_id TEXT, model_id TEXT, status TEXT,
  started_at INTEGER, input_tokens INTEGER, output_tokens INTEGER, reasoning_tokens INTEGER,
  cache_read_input_tokens INTEGER, cache_creation_input_tokens INTEGER, computed_total_tokens INTEGER
)`;

async function withTempDir<T>(prefix: string, run: (dir: string) => Promise<T>): Promise<T> {
  const dir = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), prefix));
  try {
    return await run(dir);
  } finally {
    await NodeFSP.rm(dir, { recursive: true, force: true });
  }
}

describe("ZCode usage", () => {
  it("keeps only completed BigModel rows in the window and removes cache and reasoning overlap", async () => {
    await withTempDir("zcode-usage-", async (home) => {
      const dir = NodePath.join(home, ".zcode", "cli", "db");
      const path = NodePath.join(dir, "db.sqlite");
      await NodeFSP.mkdir(dir, { recursive: true });
      const db = new NodeSqlite.DatabaseSync(path);
      try {
        db.exec(TABLE);
        const insert = db.prepare(
          "INSERT INTO model_usage VALUES (?, 'session-1', ?, 'GLM-5.4', ?, ?, ?, 25, 30, 20, 10, 999)",
        );
        insert.run(
          "individual",
          "account:bigmodel-individual-coding-plan",
          "completed",
          SINCE,
          100,
        );
        insert.run("start", "ACCOUNT:BIGMODEL-START-PLAN", "completed", SINCE, 15);
        insert.run("upstream", "account:anthropic", "completed", SINCE, 100);
        insert.run("cancelled", "zai", "cancelled", SINCE, 100);
        insert.run("error", "bigmodel", "error", SINCE, 100);
        insert.run("old", "zhipu", "completed", SINCE - 1, 100);
      } finally {
        db.close();
      }

      const scan = scanZcode({ home, windowStartMs: SINCE });
      expect(scan.status).toBe("ok");
      expect(scan.files?.[0]?.records).toMatchObject([
        {
          provider: "zai",
          sessionId: "session-1",
          model: "GLM-5.4",
          dedupeKey: "zcode:individual",
          timestampMs: SINCE,
          totals: {
            uncachedInputTokens: 70,
            cachedInputTokens: 20,
            cacheCreationTokens: 10,
            outputTokens: 25,
            reasoningTokens: 25,
          },
        },
        { dedupeKey: "zcode:start", totals: { uncachedInputTokens: 0 } },
      ]);
    });
  });

  it("reads live WAL rows when a writer holds an active -shm index without creating extra sidecars", async () => {
    await withTempDir("zcode-usage-", async (home) => {
      const path = NodePath.join(home, "usage #.sqlite");
      const options = { home, windowStartMs: SINCE, databasePath: path };
      const writer = new NodeSqlite.DatabaseSync(path);
      try {
        writer.exec(`PRAGMA journal_mode = WAL; PRAGMA wal_autocheckpoint = 0; ${TABLE}`);
        writer
          .prepare(
            "INSERT INTO model_usage VALUES ('wal', 's', 'Z.ai', 'glm', 'completed', ?, 20, 5, 0, 0, 0, 25)",
          )
          .run(SINCE);
        expect((await NodeFSP.stat(`${path}-wal`)).size).toBeGreaterThan(0);
        const before = (await NodeFSP.readdir(home)).sort();
        const liveScan = scanZcode(options);
        expect(liveScan.status).toBe("ok");
        expect(liveScan.files?.[0]?.records.map((row) => row.dedupeKey)).toEqual(["zcode:wal"]);
        expect((await NodeFSP.readdir(home)).sort()).toEqual(before);
      } finally {
        writer.close();
      }
      expect(await NodeFSP.readdir(home)).toEqual([NodePath.basename(path)]);
      expect(scanZcode(options).files?.[0]?.records.map((row) => row.dedupeKey)).toEqual([
        "zcode:wal",
      ]);
      expect(await NodeFSP.readdir(home)).toEqual([NodePath.basename(path)]);
    });
  });

  it("refuses an orphan WAL or rollback journal without creating sidecars", async () => {
    await withTempDir("zcode-usage-", async (home) => {
      const path = NodePath.join(home, "orphan.sqlite");
      const options = { home, windowStartMs: SINCE, databasePath: path };
      const db = new NodeSqlite.DatabaseSync(path);
      try {
        db.exec(TABLE);
      } finally {
        db.close();
      }
      await NodeFSP.writeFile(`${path}-wal`, Buffer.alloc(64, 1));
      const before = (await NodeFSP.readdir(home)).sort();
      expect(scanZcode(options)).toMatchObject({ status: "failed", files: [] });
      expect((await NodeFSP.readdir(home)).sort()).toEqual(before);
    });
  });

  it("distinguishes missing from corrupt without creating or repairing either file", async () => {
    await withTempDir("zcode-usage-", async (home) => {
      const path = NodePath.join(home, "db.sqlite");
      const options = { home, windowStartMs: SINCE, databasePath: path };
      expect(scanZcode(options)).toMatchObject({ status: "missing", files: null });
      expect(await NodeFSP.readdir(home)).toEqual([]);
      const junk = "not a SQLite file";
      await NodeFSP.writeFile(path, junk);
      expect(scanZcode(options)).toMatchObject({ status: "failed", files: [] });
      expect(await NodeFSP.readFile(path, "utf8")).toBe(junk);
      expect(await NodeFSP.readdir(home)).toEqual(["db.sqlite"]);
    });
  });
});
