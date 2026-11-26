// @effect-diagnostics nodeBuiltinImport:off - the OMP cache is an external SQLite file opened read-only.
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeSqlite from "node:sqlite";
import * as NodeURL from "node:url";

import {
  type HttpQuotaAccount,
  ProviderDriverKind,
  type ServerProviderUsageBalance,
  type ServerProviderUsageWindow,
  type UsageLimitSourceAccount,
  type UsageLimitSourceSnapshot,
} from "@t3tools/contracts";
import { expandHomePath } from "@t3tools/provider-core/server/pathExpansion";
import { isValidOmpProfileName } from "@t3tools/provider-omp/server";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";

const NATIVE_DRIVERS: Readonly<Record<string, ProviderDriverKind | undefined>> = {
  "openai-codex": ProviderDriverKind.make("codex"),
  cursor: ProviderDriverKind.make("cursor"),
  "xai-oauth": ProviderDriverKind.make("grok"),
  "muse-code": ProviderDriverKind.make("muse"),
  "opencode-go": ProviderDriverKind.make("opencode"),
  "google-antigravity": ProviderDriverKind.make("antigravity"),
  anthropic: ProviderDriverKind.make("claudeAgent"),
  claude: ProviderDriverKind.make("claudeAgent"),
};

const CACHE_KEY =
  /^usage_cache:report:(?:(\d+):)?([a-zA-Z0-9][a-zA-Z0-9._-]*):([^|]+):(oauth|api_key)\|(.+)$/;
const IDENTITY_SEGMENT =
  /^(account|email|org|project|enterprise|region|inference|selected-org|secret):([^\u0000-\u001f\u007f]+)$/;
const CACHE_RETENTION_MS = 24 * 60 * 60_000;
const READ_ERROR = { accounts: [], error: "Could not read the OMP usage cache." } as const;
type OmpReading = Pick<UsageLimitSourceSnapshot, "accounts" | "quotaAccounts" | "error">;

interface CachedReport {
  readonly identityKey: string;
  readonly provider: string;
  readonly driver: ProviderDriverKind | undefined;
  readonly version: number;
  readonly fetchedAt: number;
  readonly windows: readonly ServerProviderUsageWindow[];
  readonly balances: readonly ServerProviderUsageBalance[];
  readonly email: string | undefined;
  readonly accountId: string | undefined;
  readonly orgId: string | undefined;
  readonly planTier: string | undefined;
}

export function resolveOmpDbPath(
  url: string,
  env = process.env,
  home = NodeOS.homedir(),
): string | null {
  const isDefault = url === "omp://default";
  const profilePrefix = "omp://profile/";
  if (!isDefault && !url.startsWith(profilePrefix)) {
    return NodePath.resolve(expandHomePath(url, home));
  }
  const profile = isDefault
    ? env.OMP_PROFILE?.trim() || undefined
    : url.slice(profilePrefix.length).trim();
  if (profile !== undefined && !isValidOmpProfileName(profile)) return null;
  if (profile !== undefined && profile !== "default") {
    return NodePath.resolve(home, ".omp", "profiles", profile, "agent", "agent.db");
  }
  const agentDir = isDefault ? env.OMP_CODING_AGENT_DIR?.trim() : undefined;
  return NodePath.resolve(
    agentDir ? expandHomePath(agentDir, home) : NodePath.join(home, ".omp", "agent"),
    "agent.db",
  );
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function text(value: unknown): string | undefined {
  return typeof value === "string" ? value.trim() || undefined : undefined;
}

function finite(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function timestamp(value: unknown): number | undefined {
  const millis =
    typeof value === "string" && /^\d{4}-\d{2}-\d{2}(?:T|$)/.test(value)
      ? Date.parse(value)
      : finite(value);
  return millis !== undefined && millis > 0 && millis <= 8.64e15 ? millis : undefined;
}

function windowKind(
  id: string | undefined,
  minutes: number | undefined,
): ServerProviderUsageWindow["kind"] {
  if (minutes !== undefined) {
    if (minutes < 24 * 60) return "session";
    if (minutes >= 28 * 24 * 60) return "monthly";
    if (minutes >= 7 * 24 * 60) return "weekly";
  } else if (id) {
    if (/^(?:limit_)?(?:\d+h|\d+m|session)$/.test(id)) return "session";
    if (/^(?:limit_)?(?:7d|1w|weekly)$/.test(id)) return "weekly";
    if (/^(?:limit_)?(?:\d+mo|monthly)$/.test(id)) return "monthly";
  }
  return "other";
}

function disagrees(left: string | undefined, right: string | undefined): boolean {
  return left !== undefined && right !== undefined && left !== right;
}

function parseCacheKey(key: string) {
  const [, versionText, provider, endpoint, credential, segments] = CACHE_KEY.exec(key) ?? [];
  if (!provider || !endpoint || !credential || !segments) return undefined;
  const version = versionText === undefined ? -1 : Number(versionText);
  if (!Number.isSafeInteger(version)) return undefined;

  const identity = new Map<string, string>();
  for (const segment of segments.split("|")) {
    if (segment === "anonymous" && !identity.has("anonymous")) {
      identity.set("anonymous", "");
      continue;
    }
    const match = IDENTITY_SEGMENT.exec(segment);
    const field = match?.[1];
    const value = text(match?.[2]);
    if (!field || !value || identity.has(field)) return undefined;
    if (field === "secret" && !/^[a-f0-9]+$/.test(value)) return undefined;
    identity.set(field, value);
  }
  const email = identity.get("email")?.toLowerCase();
  const accountId = identity.get("account");
  const orgId = identity.get("org");
  const stableKey = email !== undefined || accountId !== undefined || orgId !== undefined;
  // The producer adds a secret fingerprint or an anonymous marker only for unidentifiable keys.
  if (
    Number(stableKey) + Number(identity.has("secret")) + Number(identity.has("anonymous")) !==
    1
  ) {
    return undefined;
  }
  return {
    provider,
    version,
    email,
    accountId,
    orgId,
    // Only deduplicate versions with the same exact cache endpoint and credential identity.
    identityKey: JSON.stringify([provider, endpoint, credential, segments]),
  };
}

function readReport(row: Record<string, unknown>, now: number): CachedReport | undefined {
  const expiresAt =
    typeof row.expires_at === "number"
      ? row.expires_at
      : typeof row.expires_at === "string" && row.expires_at.trim() !== ""
        ? Number(row.expires_at)
        : Number.NaN;
  if (
    typeof row.key !== "string" ||
    typeof row.value !== "string" ||
    !Number.isSafeInteger(expiresAt) ||
    expiresAt * 1_000 <= now
  ) {
    return undefined;
  }

  let entry: Record<string, unknown> | undefined;
  try {
    entry = record(JSON.parse(row.value));
  } catch {
    return undefined;
  }
  if (!entry) return undefined;
  // OMP's inner expiresAt schedules refreshes. SQLite expires_at and fetchedAt bound durable
  // last-good retention; the original fetchedAt still competes against newer native readings.
  const wrapped = Object.hasOwn(entry, "value");
  if (wrapped && !timestamp(entry.expiresAt)) return undefined;
  const report = wrapped ? record(entry.value) : entry;
  const provider = text(report?.provider);
  const key = parseCacheKey(row.key);
  const fetchedAt = timestamp(report?.fetchedAt);
  if (
    !provider ||
    (key && key.provider !== provider) ||
    fetchedAt === undefined ||
    fetchedAt > now ||
    now - fetchedAt >= CACHE_RETENTION_MS ||
    !Array.isArray(report?.limits)
  ) {
    return undefined;
  }

  const metadata = record(report.metadata);
  const reportedEmail = text(metadata?.email);
  const reportedAccount = text(metadata?.accountId);
  const reportedOrg = text(metadata?.organizationId) ?? text(metadata?.orgId);
  if (
    disagrees(key?.email, reportedEmail?.toLowerCase()) ||
    disagrees(key?.accountId, reportedAccount) ||
    disagrees(key?.orgId, reportedOrg) ||
    disagrees(text(metadata?.organizationId), text(metadata?.orgId))
  ) {
    return undefined;
  }

  const email = reportedEmail ?? key?.email;
  const accountId = reportedAccount ?? key?.accountId;
  const orgId = reportedOrg ?? key?.orgId;
  const planTier =
    text(metadata?.subscriptionPlan) ?? text(metadata?.planType) ?? text(metadata?.tier);
  const driver = Object.hasOwn(NATIVE_DRIVERS, provider) ? NATIVE_DRIVERS[provider] : undefined;
  const windows: ServerProviderUsageWindow[] = [];
  const balances: ServerProviderUsageBalance[] = [];
  const limits: readonly unknown[] = report.limits;
  for (const raw of limits) {
    const limit = record(raw);
    const id = text(limit?.id);
    const label = text(limit?.label);
    if (!limit || !id || !label) continue;
    const scope = record(limit.scope);
    if (
      disagrees(provider, text(scope?.provider)) ||
      disagrees(accountId, text(scope?.accountId)) ||
      disagrees(orgId, text(scope?.organizationId) ?? text(scope?.orgId))
    ) {
      continue;
    }
    const amount = record(limit.amount);
    const usedAmount = finite(amount?.used);
    const limitAmount = finite(amount?.limit);
    const remainingAmount = finite(amount?.remaining);
    const unit = text(amount?.unit);
    const isPercentUnit = unit !== undefined && (unit.toLowerCase() === "percent" || unit === "%");
    const usedFraction =
      finite(amount?.usedFraction) ??
      (usedAmount !== undefined && limitAmount !== undefined && limitAmount > 0
        ? usedAmount / limitAmount
        : undefined);
    const window = record(limit.window);
    const reset = timestamp(window?.resetsAt);
    const resetsAt =
      reset === undefined ? undefined : DateTime.formatIso(DateTime.makeUnsafe(reset));
    const durationMs = finite(window?.durationMs);
    const minutes = durationMs === undefined ? 0 : Math.round(durationMs / 60_000);
    const windowDurationMins = minutes > 0 && Number.isSafeInteger(minutes) ? minutes : undefined;
    const category =
      limit.category === "balance" ||
      limit.category === "bonus" ||
      limit.category === "overage" ||
      limit.category === "plan"
        ? limit.category
        : window === undefined && scope?.windowId === "balance"
          ? "balance"
          : "plan";
    if (category === "balance" && window === undefined && remainingAmount !== undefined && unit) {
      balances.push({
        id,
        label,
        unit,
        remaining: remainingAmount,
        kind: "balance",
        ...(limitAmount === undefined ? {} : { limit: limitAmount }),
        ...(usedAmount === undefined ? {} : { used: usedAmount }),
      });
      continue;
    }
    if (usedFraction === undefined) continue;
    const scopeLabel = text(limit.scopeLabel) ?? text(scope?.tier);
    const modelId = text(scope?.modelId);
    const windowId = text(window?.id) ?? text(scope?.windowId) ?? id;
    windows.push({
      id,
      label,
      kind: windowKind(windowId.toLowerCase(), windowDurationMins),
      usedPercent: Math.max(0, Math.min(100, usedFraction * 100)),
      category,
      ...(resetsAt === undefined ? {} : { resetsAt }),
      ...(windowDurationMins === undefined ? {} : { windowDurationMins }),
      ...(!isPercentUnit && usedAmount !== undefined ? { usedAmount } : {}),
      ...(!isPercentUnit && limitAmount !== undefined ? { limitAmount } : {}),
      ...(!isPercentUnit && remainingAmount !== undefined ? { remainingAmount } : {}),
      ...(!isPercentUnit && unit !== undefined ? { unit } : {}),
      ...(scopeLabel === undefined ? {} : { scopeLabel }),
      ...(modelId && driver && email !== undefined ? { modelIds: [modelId] } : {}),
    });
  }
  if (windows.length === 0 && balances.length === 0) return undefined;

  // Unknown key layouts can still carry valid reports. Do not infer identity from their keys.
  return {
    identityKey: key?.identityKey ?? row.key,
    provider,
    driver,
    version: key?.version ?? -1,
    fetchedAt,
    windows,
    balances,
    email,
    accountId,
    orgId,
    planTier,
  };
}

function readCache(dbPath: string, now: number): OmpReading {
  try {
    if (!NodeFS.statSync(dbPath, { throwIfNoEntry: false })?.isFile()) return READ_ERROR;
    const realPath = NodeFS.realpathSync(dbPath);
    if (NodeFS.lstatSync(`${realPath}-journal`, { throwIfNoEntry: false })) return READ_ERROR;
    const wal = NodeFS.lstatSync(`${realPath}-wal`, { throwIfNoEntry: false });
    if (
      wal !== undefined &&
      (!wal.isFile() || !NodeFS.lstatSync(`${realPath}-shm`, { throwIfNoEntry: false })?.isFile())
    ) {
      return READ_ERROR;
    }
    // A WAL-mode database can create sidecars on read-only open. Only use normal locking with both present.
    const filename =
      wal === undefined ? `${NodeURL.pathToFileURL(realPath).href}?immutable=1` : realPath;
    const db = new NodeSqlite.DatabaseSync(filename, { readOnly: true });
    try {
      db.exec("PRAGMA busy_timeout = 100");
      // An arbitrary configured file must not turn the usage read into a credential view.
      if (
        !db
          .prepare(
            "SELECT 1 FROM pragma_table_list('cache') WHERE schema = 'main' AND type = 'table'",
          )
          .get()
      ) {
        return READ_ERROR;
      }
      // Filter and stringify expires_at in SQL so a single out-of-range 64-bit integer never aborts iteration.
      const rows = db
        .prepare(
          "SELECT key, value, CAST(expires_at AS TEXT) AS expires_at FROM main.cache WHERE key GLOB 'usage_cache:report:*' AND typeof(expires_at) IN ('integer', 'real') AND expires_at > ? AND expires_at <= 9007199254740991 ORDER BY key",
        )
        .iterate(Math.floor(now / 1_000));
      const reports = new Map<string, CachedReport>();
      for (const row of rows) {
        const report = readReport(row, now);
        if (!report) continue;
        const previous = reports.get(report.identityKey);
        if (
          previous &&
          (previous.version > report.version ||
            (previous.version === report.version && previous.fetchedAt >= report.fetchedAt))
        ) {
          continue;
        }
        reports.set(report.identityKey, report);
      }

      const accounts: UsageLimitSourceAccount[] = [];
      const quotaAccounts: HttpQuotaAccount[] = [];
      for (const report of reports.values()) {
        const { provider, driver, planTier, email, accountId, orgId, windows, balances } = report;
        // Cache keys may contain URLs or secret-derived identity. Never publish the key itself.
        const digest = NodeCrypto.createHash("sha256").update(report.identityKey).digest("hex");
        const id = `${driver ?? provider}:${digest}`;
        const metadata = {
          ...(planTier === undefined ? {} : { planTier }),
          ...(balances.length === 0 ? {} : { balances }),
        };
        // Only route to native accounts when a verified email exists for canonical deduplication;
        // email-less rows stay explicitly distinguished as OMP cache quota accounts.
        if (driver && email !== undefined) {
          const workspaceId = orgId ?? accountId;
          accounts.push({
            id,
            driver,
            email,
            ...(workspaceId === undefined ? {} : { workspaceId }),
            ...(planTier === undefined ? {} : { plan: planTier }),
            usageLimits: {
              checkedAt: DateTime.formatIso(DateTime.makeUnsafe(report.fetchedAt)),
              windows,
              ...metadata,
            },
          });
        } else {
          quotaAccounts.push({
            id,
            label: email ? `${provider} · ${email}` : provider,
            windows,
            ...metadata,
          });
        }
      }
      return { accounts, quotaAccounts };
    } finally {
      db.close();
    }
  } catch {
    return READ_ERROR;
  }
}

export const readOmpUsage = Effect.fn("UsageLimitSources.readOmpUsage")(function* (dbPath: string) {
  return readCache(dbPath, yield* Clock.currentTimeMillis);
});
