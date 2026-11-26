// @effect-diagnostics nodeBuiltinImport:off - tests seed isolated gateway logs.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { describe, expect, it, vi } from "vite-plus/test";
import { makeMagpieScanner } from "./magpie.ts";

vi.mock("node:fs/promises", { spy: true });

const SINCE = Date.parse("2026-08-01T00:00:00Z");
const OPTIONS = { windowStartMs: SINCE, excludeKimiCli: false, excludeZcode: false };
const CHAT = {
  t: "2026-08-01T10:00:00Z",
  agent: "dsh",
  provider: "OpenAI-Codex",
  model: "codex/gpt-6.1-sol",
  in: 40,
  out: 7,
  cache_read: 2,
  cache_write: 3,
  session: "external-session",
};

async function withTempDir<T>(prefix: string, run: (dir: string) => Promise<T>): Promise<T> {
  const dir = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), prefix));
  try {
    return await run(dir);
  } finally {
    await NodeFSP.rm(dir, { recursive: true, force: true });
  }
}

describe("Magpie usage", () => {
  it("attributes external chat to its upstream, excluding native agents and non-chat rows", async () => {
    await withTempDir("magpie-usage-", async (home) => {
      const scanMagpie = makeMagpieScanner();
      const configDirectory = NodePath.join(home, "gateway");
      const path = NodePath.join(configDirectory, "usage.jsonl");
      await NodeFSP.mkdir(configDirectory);
      const nativeAgents = [
        " Claude ",
        "CLAUDE-CODE",
        "coDex",
        "grok",
        "cursor",
        "opencode",
        "antigravity",
        "pi",
        "OMP",
        "muse",
        "t3code",
        "magpie",
      ];
      const rows = [
        ...nativeAgents.map((agent) => ({ ...CHAT, agent, out: 1_000, response_id: "first" })),
        { ...CHAT, kind: "provider_test", out: 1_000, response_id: "first" },
        { ...CHAT, kind: "model_list", out: 1_000, response_id: "first" },
        { ...CHAT, agent: undefined, response_id: "first" },
        { ...CHAT, t: "2026-07-31T10:00:00Z", response_id: "first" },
        { ...CHAT, provider: "constructor", response_id: "first" },
        { ...CHAT, kind: "chat", response_id: "first" },
        {
          ...CHAT,
          agent: "hermes",
          provider: "opencode-go",
          model: null,
          served: "opencode-go/deepseek-v4.1-flash",
          session: "hermes",
        },
        {
          ...CHAT,
          agent: "commandcode",
          provider: "anthropic",
          model: null,
          served: null,
          req: "anthropic/claude-fable-5",
          session: "commandcode",
        },
      ];
      await NodeFSP.writeFile(
        path,
        ["not-json", ...rows.map((row) => JSON.stringify(row))].join("\n"),
      );

      const scan = await scanMagpie({ ...OPTIONS, home, configDirectory: "~/gateway" });
      expect(scan.status).toBe("ok");
      expect(scan.sources).toMatchObject([
        {
          provider: "codex",
          dir: path,
          status: "ok",
          files: [
            {
              records: [
                {
                  model: "gpt-6.1-sol",
                  sessionId: "external-session",
                  totals: {
                    uncachedInputTokens: 40,
                    cachedInputTokens: 2,
                    cacheCreationTokens: 3,
                    outputTokens: 7,
                  },
                },
              ],
            },
          ],
        },
        {
          provider: "opencode",
          files: [{ records: [{ model: "deepseek-v4.1-flash", sessionId: "hermes" }] }],
        },
        {
          provider: "claude",
          files: [{ records: [{ model: "claude-fable-5", sessionId: "commandcode" }] }],
        },
      ]);
    });
  });

  it("dedupes by response_id or exact row hash without dropping multi-try billed rows, cross-restart route collisions, or ID-less usage", async () => {
    await withTempDir("magpie-usage-", async (home) => {
      const scanMagpie = makeMagpieScanner();
      const path = NodePath.join(home, "usage.jsonl");
      const handedOnTry1 = { ...CHAT, route_id: 100, rid: "try-1", cache_write: 500, out: 0 };
      const handedOnTry2 = { ...CHAT, route_id: 100, rid: "try-2", cache_write: 200, out: 12 };
      const crossRestartSameRoute = {
        ...CHAT,
        t: "2026-08-01T11:00:00Z",
        route_id: 100,
        rid: "try-1",
        cache_write: 500,
        out: 0,
      };
      const rows = [
        // Exact same response_id collapses across providers/retries.
        { ...CHAT, response_id: "response", route_id: 100, rid: "a" },
        { ...CHAT, response_id: "response", route_id: 200, rid: "b", provider: "xai" },
        // Distinct billed tries sharing route_id without response_id must ALL be retained.
        handedOnTry1,
        // Exact log-merge duplicate of try-1 collapses via full-row content hash.
        handedOnTry1,
        handedOnTry2,
        // Cross-restart route_id/rid collision with a different timestamp must be retained.
        crossRestartSameRoute,
        // Distinct rows with identical rid but different payloads must be retained.
        { ...CHAT, rid: "r1", out: 1 },
        { ...CHAT, rid: "r1", out: 1 },
        { ...CHAT, rid: "r1", out: 2 },
        // Truly ID-less rows must never be collapsed.
        CHAT,
        CHAT,
      ];
      await NodeFSP.writeFile(path, rows.map((row) => JSON.stringify(row)).join("\n"));

      const scan = await scanMagpie({ ...OPTIONS, home, usagePath: path });
      expect(scan.sources.map((source) => source.provider)).toEqual(["codex"]);
      const records = scan.sources[0]?.files?.[0]?.records ?? [];
      expect(records).toHaveLength(8);
      expect(records[0]?.dedupeKey).toBe("magpie:response");
      expect(records.slice(1, 6).every((row) => row.dedupeKey?.startsWith("magpie:row:"))).toBe(
        true,
      );
      expect(new Set(records.slice(1, 6).map((row) => row.dedupeKey)).size).toBe(5);
      expect(records.slice(6).map((row) => row.dedupeKey)).toEqual([null, null]);
    });
  });

  it("omits only the Kimi and ZCode agents whose native local source is enabled and caches unchanged files", async () => {
    await withTempDir("magpie-usage-", async (home) => {
      const scanMagpie = makeMagpieScanner();
      const dir = NodePath.join(home, ".config", "magpie");
      await NodeFSP.mkdir(dir, { recursive: true });
      const path = NodePath.join(dir, "usage.jsonl");
      const cases = [
        { agent: "KIMI", provider: "kimi-coding", model: "kimi/kimi-k3" },
        { agent: "kimi-cli", provider: "kimi-coding", model: "kimi/kimi-k3" },
        { agent: "kimi-code", provider: "kimi-coding", model: "kimi/kimi-k3" },
        { agent: "dsh", provider: "kimi-coding", model: "kimi/kimi-k3" },
        { agent: "ZCode", provider: "zhipu", model: "zcode/GLM-5.4" },
        { agent: "hermes", provider: "zhipu", model: "zcode/GLM-5.4" },
      ];
      await NodeFSP.writeFile(
        path,
        cases.map((row) => JSON.stringify({ ...CHAT, ...row, session: row.agent })).join("\n"),
      );
      const options = { ...OPTIONS, home };
      const sessions = async (overrides: Partial<typeof OPTIONS>) =>
        (await scanMagpie({ ...options, ...overrides })).sources.map((source) => [
          source.provider,
          source.files?.[0]?.records.map((row) => row.sessionId),
        ]);
      expect(await sessions({})).toEqual([
        ["kimi", ["KIMI", "kimi-cli", "kimi-code", "dsh"]],
        ["zai", ["ZCode", "hermes"]],
      ]);
      expect(await sessions({ excludeKimiCli: true })).toEqual([
        ["kimi", ["dsh"]],
        ["zai", ["ZCode", "hermes"]],
      ]);
      expect(await sessions({ excludeZcode: true })).toEqual([
        ["kimi", ["KIMI", "kimi-cli", "kimi-code", "dsh"]],
        ["zai", ["hermes"]],
      ]);
      expect(await sessions({ excludeKimiCli: true, excludeZcode: true })).toEqual([
        ["kimi", ["dsh"]],
        ["zai", ["hermes"]],
      ]);
      const reads = vi.mocked(NodeFSP.readFile).mock.calls.filter(([file]) => file === path).length;
      expect(reads).toBe(1);
    });
  });

  it("reports a missing gateway log without inventing a provider", async () => {
    await withTempDir("magpie-usage-", async (home) => {
      const scanMagpie = makeMagpieScanner();
      expect(await scanMagpie({ ...OPTIONS, home })).toEqual({
        status: "missing",
        sources: [],
      });
    });
  });
});
