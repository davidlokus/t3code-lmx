// @effect-diagnostics nodeBuiltinImport:off - Magpie's gateway log is external and read-only.
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import type { UsageProviderKind } from "@t3tools/contracts";
import { expandHomePath } from "@t3tools/provider-core/server/pathExpansion";
import {
  type ProviderUsageScan,
  type UsageRecord,
  parseTimestampMs,
  tokenCount,
  totalTokens,
} from "@t3tools/provider-core/server/usage";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

const PROVIDERS: Readonly<Record<string, UsageProviderKind | undefined>> = {
  antigravity: "antigravity",
  gemini: "antigravity",
  "google-antigravity": "antigravity",
  anthropic: "claude",
  claude: "claude",
  "claude-code": "claude",
  codex: "codex",
  openai: "codex",
  "openai-codex": "codex",
  cursor: "cursor",
  grok: "grok",
  xai: "grok",
  "xai-oauth": "grok",
  kimi: "kimi",
  "kimi-code": "kimi",
  "kimi-coding": "kimi",
  "kimi-for-coding": "kimi",
  meta: "muse",
  muse: "muse",
  "muse-bridge": "muse",
  "muse-code": "muse",
  opencode: "opencode",
  "opencode-go": "opencode",
  "opencode-zen": "opencode",
  "opencode-zen-free": "opencode",
  bigmodel: "zai",
  "z.ai": "zai",
  zai: "zai",
  "zai-coding-cn": "zai",
  "zai-coding-plan": "zai",
  zcode: "zai",
  zhipu: "zai",
};
const OTHER_ROUTE_PREFIXES = {
  auto: true,
  commandcode: true,
  "commandcode-plan": true,
  deepseek: true,
  "deepseek-official": true,
  magpie: true,
};
const NATIVE_AGENTS = {
  antigravity: true,
  claude: true,
  "claude-code": true,
  codex: true,
  cursor: true,
  grok: true,
  magpie: true,
  muse: true,
  omp: true,
  opencode: true,
  pi: true,
  t3code: true,
};

const optionalText = Schema.optional(Schema.NullOr(Schema.String));
const optionalId = Schema.optional(Schema.NullOr(Schema.Union([Schema.String, Schema.Finite])));
const decodeRow = Schema.decodeUnknownOption(
  Schema.fromJsonString(
    Schema.Struct({
      t: Schema.String,
      agent: optionalText,
      provider: Schema.String,
      model: optionalText,
      req: optionalText,
      served: optionalText,
      in: Schema.optional(Schema.Unknown),
      out: Schema.optional(Schema.Unknown),
      cache_read: Schema.optional(Schema.Unknown),
      cache_write: Schema.optional(Schema.Unknown),
      response_id: optionalText,
      route_id: optionalId,
      rid: optionalId,
      session: optionalText,
      kind: optionalText,
    }),
  ),
);

function stripRoutePrefix(model: string): string {
  const slash = model.indexOf("/");
  if (slash < 0) return model;
  const prefix = model.slice(0, slash).toLowerCase();
  if (!Object.hasOwn(PROVIDERS, prefix) && !Object.hasOwn(OTHER_ROUTE_PREFIXES, prefix))
    return model;
  return model.slice(slash + 1).trim();
}

function idPart(id: string | number | null | undefined): string | undefined {
  return typeof id === "number" ? String(id) : id?.trim() || undefined;
}

interface MagpieOptions {
  readonly home: string;
  readonly windowStartMs: number;
  readonly configDirectory?: string | undefined;
  readonly usagePath?: string;
  readonly excludeKimiCli: boolean;
  readonly excludeZcode: boolean;
}

type MagpieScan = {
  readonly status: "ok" | "missing" | "failed";
  readonly sources: readonly (ProviderUsageScan & { readonly provider: UsageProviderKind })[];
};

interface ParsedMagpieRow {
  readonly agent: string;
  readonly provider: UsageProviderKind;
  readonly timestampMs: number;
  readonly model: string;
  readonly sessionId: string;
  readonly totals: UsageRecord["totals"];
  readonly key: string | undefined;
}

function parseMagpieFile(contents: string): readonly ParsedMagpieRow[] {
  const parsed: ParsedMagpieRow[] = [];
  for (const line of contents.split("\n")) {
    if (!line.trim()) continue;
    const row = Option.getOrUndefined(decodeRow(line));
    if (row === undefined) continue;
    const kind = row.kind?.trim();
    if (kind && kind !== "chat") continue;
    const agent = row.agent?.trim().toLowerCase() || "magpie";
    if (Object.hasOwn(NATIVE_AGENTS, agent)) continue;
    const providerId = row.provider.trim().toLowerCase();
    const provider = Object.hasOwn(PROVIDERS, providerId) ? PROVIDERS[providerId] : undefined;
    const timestampMs = parseTimestampMs(row.t);
    if (provider === undefined || timestampMs === null) continue;
    const model = stripRoutePrefix(
      row.model?.trim() || row.served?.trim() || row.req?.trim() || "",
    );
    if (!model) continue;
    const totals = {
      uncachedInputTokens: tokenCount(row.in),
      cachedInputTokens: tokenCount(row.cache_read),
      cacheCreationTokens: tokenCount(row.cache_write),
      outputTokens: tokenCount(row.out),
      reasoningTokens: 0,
    };
    if (totalTokens(totals) === 0) continue;
    const responseId = idPart(row.response_id);
    const route = idPart(row.route_id);
    const rid = idPart(row.rid);
    const sessionId = row.session?.trim() ?? "";
    // Magpie emits billed HandedOn retry rows sharing route_id without response_id, and seeds
    // route_id per boot; only collapse by response_id or exact row content (never route_id/rid alone).
    const key =
      responseId ??
      (route !== undefined || rid !== undefined
        ? `row:${NodeCrypto.createHash("sha256")
            .update(
              JSON.stringify([
                row.t,
                agent,
                provider,
                model,
                sessionId,
                route ?? "",
                rid ?? "",
                totals.uncachedInputTokens,
                totals.cachedInputTokens,
                totals.cacheCreationTokens,
                totals.outputTokens,
              ]),
            )
            .digest("hex")}`
        : undefined);
    parsed.push({
      agent,
      provider,
      timestampMs,
      model,
      sessionId,
      totals,
      key,
    });
  }
  return parsed;
}

export function makeMagpieScanner() {
  let cached:
    | {
        readonly path: string;
        readonly size: number;
        readonly mtimeMs: number;
        readonly rows: readonly ParsedMagpieRow[];
      }
    | undefined;
  return async (options: MagpieOptions): Promise<MagpieScan> => {
    const configDirectory = options.configDirectory?.trim();
    const path =
      options.usagePath ??
      (configDirectory
        ? NodePath.resolve(expandHomePath(configDirectory, options.home), "usage.jsonl")
        : NodePath.join(options.home, ".config", "magpie", "usage.jsonl"));
    let rows: readonly ParsedMagpieRow[];
    try {
      const stat = await NodeFSP.stat(path);
      if (!stat.isFile()) return { status: "failed", sources: [] };
      if (
        cached !== undefined &&
        cached.path === path &&
        cached.size === stat.size &&
        cached.mtimeMs === stat.mtimeMs
      ) {
        rows = cached.rows;
      } else {
        rows = parseMagpieFile(await NodeFSP.readFile(path, "utf8"));
        cached = { path, size: stat.size, mtimeMs: stat.mtimeMs, rows };
      }
    } catch (error) {
      return {
        status: (error as NodeJS.ErrnoException).code === "ENOENT" ? "missing" : "failed",
        sources: [],
      };
    }

    const seen = new Set<string>();
    const byProvider = new Map<UsageProviderKind, UsageRecord[]>();
    for (const row of rows) {
      if (
        (options.excludeKimiCli &&
          (row.agent === "kimi" || row.agent === "kimi-cli" || row.agent === "kimi-code")) ||
        (options.excludeZcode && row.agent === "zcode")
      ) {
        continue;
      }
      if (row.timestampMs < options.windowStartMs) continue;
      if (row.key !== undefined && seen.has(row.key)) continue;
      if (row.key !== undefined) seen.add(row.key);

      const record: UsageRecord = {
        provider: row.provider,
        timestampMs: row.timestampMs,
        model: row.model,
        sessionId: row.sessionId,
        totals: row.totals,
        reportedCostUsd: null,
        speed: "standard",
        dedupeKey: row.key === undefined ? null : `magpie:${row.key}`,
      };
      const records = byProvider.get(row.provider);
      if (records === undefined) byProvider.set(row.provider, [record]);
      else records.push(record);
    }
    return {
      status: "ok",
      sources: Array.from(byProvider, ([provider, records]) => ({
        provider,
        dir: path,
        status: "ok",
        files: [{ path, records }],
      })),
    };
  };
}
