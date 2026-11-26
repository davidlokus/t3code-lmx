// @effect-diagnostics nodeBuiltinImport:off - tests seed isolated event files.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { describe, expect, it, vi } from "vite-plus/test";
import { makeKimiCliScanner } from "./kimiCli.ts";

vi.mock("node:fs/promises", { spy: true });

const SINCE = Date.parse("2026-08-01T00:00:00Z");
const FIRST = "2026-08-01T10:00:00Z";
const SECOND = "2026-08-02T10:00:00Z";
const MTIME = Date.parse(SECOND) / 1_000;

function step(
  overrides: { type?: string; seq?: number; timestamp?: string; payload?: object } = {},
) {
  return JSON.stringify({
    kind: "event",
    seq: 19,
    envelope: {
      type: "turn.step.completed",
      session_id: "session_a",
      timestamp: FIRST,
      ...overrides,
      payload: {
        stepId: "step_a",
        model: "kimi-k3",
        usage: { inputOther: 56_366, output: 43, inputCacheRead: 11, inputCacheCreation: 7 },
        ...overrides.payload,
      },
    },
  });
}

function readCount(path: string) {
  return vi.mocked(NodeFSP.readFile).mock.calls.filter(([file]) => file === path).length;
}

async function withTempDir<T>(prefix: string, run: (dir: string) => Promise<T>): Promise<T> {
  const dir = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), prefix));
  try {
    return await run(dir);
  } finally {
    await NodeFSP.rm(dir, { recursive: true, force: true });
  }
}

describe("Kimi CLI usage", () => {
  it("counts completed steps, ignores old files and junk lines, and falls back to the sequence and model", async () => {
    await withTempDir("kimi-usage-", async (home) => {
      const path = NodePath.join(home, "session_a.jsonl");
      const stale = NodePath.join(home, "session_stale.jsonl");
      const unrelated = NodePath.join(home, "not-session.jsonl");
      await Promise.all([
        NodeFSP.writeFile(
          path,
          [
            '{"type":"turn.step.completed",',
            step({ type: "turn.step.interrupted" }),
            step({ timestamp: "2026-07-30T10:00:00Z" }),
            step({ payload: { usage: {} } }),
            step(),
            step({ seq: 20, payload: { stepId: null, model: null, usage: { output: 2 } } }),
            step({ payload: { stepId: undefined, model: "" } }),
          ].join("\n"),
        ),
        NodeFSP.writeFile(stale, step()),
        NodeFSP.writeFile(unrelated, step()),
      ]);
      await NodeFSP.utimes(stale, MTIME, SINCE / 1_000 - 1);
      await NodeFSP.utimes(path, MTIME, MTIME);

      const scan = await makeKimiCliScanner()({
        home,
        directory: home,
        windowStartMs: SINCE,
      });
      expect(scan.status).toBe("ok");
      expect(readCount(stale)).toBe(0);
      expect(readCount(unrelated)).toBe(0);
      expect(scan.files?.flatMap((file) => file.records)).toMatchObject([
        {
          provider: "kimi",
          model: "kimi-k3",
          timestampMs: Date.parse(FIRST),
          sessionId: "session_a",
          dedupeKey: "kimiCli:session_a:step_a",
          totals: {
            uncachedInputTokens: 56_366,
            outputTokens: 43,
            cachedInputTokens: 11,
            cacheCreationTokens: 7,
            reasoningTokens: 0,
          },
        },
        { model: "kimi", dedupeKey: "kimiCli:session_a:20", totals: { outputTokens: 2 } },
        { model: "kimi", dedupeKey: "kimiCli:session_a:19" },
      ]);
    });
  });

  it("reuses unchanged rows across windows and reparses either a changed size or mtime", async () => {
    await withTempDir("kimi-usage-", async (home) => {
      const dir = NodePath.join(home, ".kimi-code", "server", "events");
      const path = NodePath.join(dir, "session_cache.jsonl");
      const scan = makeKimiCliScanner();
      const options = { home, windowStartMs: SINCE };
      const first = step({ payload: { usage: { output: 3 } } });
      await NodeFSP.mkdir(dir, { recursive: true });
      await NodeFSP.writeFile(path, first);
      await NodeFSP.utimes(path, MTIME, MTIME);

      expect((await scan(options)).files?.[0]?.records[0]?.totals.outputTokens).toBe(3);
      expect(
        (await scan({ ...options, windowStartMs: Date.parse(SECOND) })).files?.[0]?.records,
      ).toEqual([]);
      expect(readCount(path)).toBe(1);

      await NodeFSP.writeFile(path, first.replace('"output":3', '"output":5'));
      await NodeFSP.utimes(path, MTIME + 1, MTIME + 1);
      expect((await scan(options)).files?.[0]?.records[0]?.totals.outputTokens).toBe(5);
      expect(readCount(path)).toBe(2);

      await NodeFSP.appendFile(
        path,
        "\n" + step({ timestamp: SECOND, payload: { stepId: "next" } }),
      );
      await NodeFSP.utimes(path, MTIME + 1, MTIME + 1);
      expect(
        (await scan(options)).files?.[0]?.records.map((row) => row.totals.outputTokens),
      ).toEqual([5, 43]);
      expect(readCount(path)).toBe(3);
      await NodeFSP.unlink(path);
      expect((await scan(options)).files).toEqual([]);
    });
  });

  it("reports missing without creating the events directory", async () => {
    await withTempDir("kimi-usage-", async (home) => {
      const scan = await makeKimiCliScanner()({ home, windowStartMs: SINCE });
      expect(scan).toMatchObject({ status: "missing", files: null });
      expect(await NodeFSP.readdir(home)).toEqual([]);
    });
  });
});
