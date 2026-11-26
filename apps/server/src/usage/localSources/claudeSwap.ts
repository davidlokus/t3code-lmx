// @effect-diagnostics nodeBuiltinImport:off - claude-swap metadata and cached quota are external read-only files.
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import {
  ProviderDriverKind,
  type ServerProviderUsageLimits,
  type ServerProviderUsageWindow,
  type UsageLimitSourceAccount,
  TrimmedNonEmptyString,
} from "@t3tools/contracts";
import { parseTimestampMs } from "@t3tools/provider-core/server/usage";
import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

const FRESHNESS_MS = 2 * 60 * 60 * 1_000;
const SLOT_CONFIG = /^\.claude-config-(\d+)-.+\.json$/;
const CLAUDE_DRIVER = ProviderDriverKind.make("claudeAgent");
const ERROR_CODE =
  /^(?:timeout|network|bad-response|invalid_grant|no_refresh_token|http-[1-5]\d{2})$/;
const CACHE_UNAVAILABLE = "No fresh claude-swap usage is available for this account.";

const optionalText = Schema.optional(Schema.NullOr(Schema.String));
const decodeConfig = Schema.decodeUnknownOption(
  Schema.fromJsonString(
    Schema.Struct({
      oauthAccount: Schema.optional(
        Schema.NullOr(
          Schema.Struct({
            accountUuid: optionalText,
            organizationUuid: optionalText,
            emailAddress: optionalText,
            planDisplayName: optionalText,
            seatTier: optionalText,
            organizationRateLimitTier: optionalText,
          }),
        ),
      ),
    }),
  ),
);
const decodeCache = Schema.decodeUnknownOption(
  Schema.fromJsonString(
    Schema.Struct({
      schemaVersion: Schema.Literal(2),
      accounts: Schema.Record(Schema.String, Schema.Unknown),
    }),
  ),
);
const decodeRow = Schema.decodeUnknownOption(
  Schema.Struct({
    email: optionalText,
    organizationUuid: optionalText,
    fetchedAt: Schema.optional(Schema.NullOr(Schema.Finite)),
    lastError: optionalText,
    lastGood: Schema.optional(
      Schema.NullOr(
        Schema.Struct({
          five_hour: Schema.optional(Schema.Unknown),
          seven_day: Schema.optional(Schema.Unknown),
          scoped: Schema.optional(Schema.Unknown),
        }),
      ),
    ),
  }),
);
const windowFields = { pct: Schema.Finite, resets_at: Schema.optional(Schema.Unknown) };
const CacheWindow = Schema.Struct(windowFields);
const decodeWindow = Schema.decodeUnknownOption(CacheWindow);
const decodeScopedWindow = Schema.decodeUnknownOption(
  Schema.Struct({ ...windowFields, name: TrimmedNonEmptyString }),
);

interface ClaudeIdentity {
  readonly accountUuid?: string | undefined;
  readonly organizationUuid?: string | undefined;
  readonly email?: string | undefined;
}

function identityText(value: string | null | undefined): string | undefined {
  return value?.trim().toLowerCase() || undefined;
}

function matchesActiveIdentity(slot: ClaudeIdentity, candidate: ClaudeIdentity): boolean {
  // Two organizations under the same email/accountUuid represent distinct Claude workspaces.
  if (
    slot.organizationUuid !== undefined &&
    candidate.organizationUuid !== undefined &&
    slot.organizationUuid !== candidate.organizationUuid
  ) {
    return false;
  }
  const hasUserIdentity =
    (slot.accountUuid !== undefined && candidate.accountUuid !== undefined) ||
    (slot.email !== undefined && candidate.email !== undefined);
  if (hasUserIdentity) {
    // Distinct users sharing a team/enterprise organization must not suppress each other.
    return (
      (slot.accountUuid !== undefined && candidate.accountUuid === slot.accountUuid) ||
      (slot.email !== undefined && candidate.email === slot.email)
    );
  }
  return (
    slot.organizationUuid !== undefined &&
    candidate.organizationUuid !== undefined &&
    slot.organizationUuid === candidate.organizationUuid
  );
}

function identityOf(identity: {
  readonly accountUuid?: string | null | undefined;
  readonly organizationUuid?: string | null | undefined;
  readonly email?: string | null | undefined;
}): ClaudeIdentity {
  return {
    accountUuid: identityText(identity.accountUuid),
    organizationUuid: identityText(identity.organizationUuid),
    email: identityText(identity.email),
  };
}

async function readConfig(path: string) {
  try {
    if (!(await NodeFSP.stat(path)).isFile()) return undefined;
    return Option.getOrUndefined(decodeConfig(await NodeFSP.readFile(path, "utf8")));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      // A dangling symlink means the target config cannot be proved absent; fail closed.
      const linkExists = await NodeFSP.lstat(path).then(
        () => true,
        () => false,
      );
      return linkExists ? undefined : null;
    }
    return undefined;
  }
}

async function readCache(path: string) {
  try {
    if (!(await NodeFSP.stat(path)).isFile()) return undefined;
    return Option.getOrUndefined(decodeCache(await NodeFSP.readFile(path, "utf8")))?.accounts;
  } catch {
    return undefined;
  }
}

function lastErrorMessage(value: string | null | undefined): string | undefined {
  const code = value?.trim();
  if (!code) return undefined;
  // Only claude-swap's error codes may leave the host, not arbitrary cache text.
  return ERROR_CODE.test(code) ? code : "claude-swap's last usage update failed.";
}

function mapWindow(
  row: typeof CacheWindow.Type,
  window: Omit<ServerProviderUsageWindow, "usedPercent" | "resetsAt">,
): ServerProviderUsageWindow {
  const reset = parseTimestampMs(row.resets_at);
  return {
    ...window,
    usedPercent: Math.max(0, Math.min(row.pct, 100)),
    ...(reset === null ? {} : { resetsAt: DateTime.formatIso(DateTime.makeUnsafe(reset)) }),
  };
}

function usageForSlot(
  input: unknown,
  identity: ClaudeIdentity,
  nowMs: number,
): ServerProviderUsageLimits {
  const row = Option.getOrUndefined(decodeRow(input));
  const rowEmail = identityText(row?.email);
  const rowOrg = identityText(row?.organizationUuid);
  const matchesSlot =
    (identity.email === undefined || rowEmail === undefined || identity.email === rowEmail) &&
    (identity.organizationUuid === undefined
      ? identity.email !== undefined && identity.email === rowEmail
      : identity.organizationUuid === rowOrg);
  const fetchedAtMs = (row?.fetchedAt ?? NaN) * 1_000;
  const age = nowMs - fetchedAtMs;
  const lastError = matchesSlot ? lastErrorMessage(row?.lastError) : undefined;
  const good = row?.lastGood;
  if (matchesSlot && age >= 0 && age <= FRESHNESS_MS && good != null) {
    const windows: ServerProviderUsageWindow[] = [];
    const session = Option.getOrUndefined(decodeWindow(good.five_hour));
    if (session !== undefined) {
      windows.push(
        mapWindow(session, {
          id: "five_hour",
          kind: "session",
          label: "Session",
          windowDurationMins: 300,
        }),
      );
    }
    const weekly = Option.getOrUndefined(decodeWindow(good.seven_day));
    if (weekly !== undefined) {
      windows.push(
        mapWindow(weekly, {
          id: "seven_day",
          kind: "weekly",
          label: "Weekly",
          windowDurationMins: 10_080,
        }),
      );
    }
    const scopedIds = new Set<string>();
    if (Array.isArray(good.scoped)) {
      for (const input of good.scoped) {
        const scoped = Option.getOrUndefined(decodeScopedWindow(input));
        if (scoped === undefined) continue;
        const id = `seven_day_${scoped.name.toLowerCase().replace(/[^a-z0-9]+/g, "_")}`;
        if (scopedIds.has(id)) continue;
        scopedIds.add(id);
        windows.push(
          mapWindow(scoped, {
            id,
            kind: "weekly",
            label: `Weekly · ${scoped.name}`,
            scopeLabel: scoped.name,
            category: "plan",
            windowDurationMins: 10_080,
          }),
        );
      }
    }
    if (windows.length > 0) {
      return {
        checkedAt: DateTime.formatIso(DateTime.makeUnsafe(fetchedAtMs)),
        windows,
        ...(lastError === undefined
          ? {}
          : { serviceNotice: { message: lastError, severity: "warning" } }),
      };
    }
  }
  return {
    checkedAt: DateTime.formatIso(DateTime.makeUnsafe(nowMs)),
    windows: [],
    unavailable: { reason: "probeFailed", message: lastError ?? CACHE_UNAVAILABLE },
  };
}

export async function readClaudeSwapUsage(options: {
  readonly home: string;
  readonly nowMs: number;
  readonly activeIdentities?: readonly ClaudeIdentity[];
}): Promise<UsageLimitSourceAccount[]> {
  const stash = NodePath.join(options.home, ".claude-swap-backup");
  const configs = NodePath.join(stash, "configs");
  const entries = await NodeFSP.readdir(configs, { withFileTypes: true }).catch(() => []);
  if (entries.length === 0) return [];

  let active: readonly ClaudeIdentity[];
  if (options.activeIdentities === undefined) {
    const config = await readConfig(NodePath.join(options.home, ".claude.json"));
    // An unreadable active config cannot prove which saved account is inactive.
    if (config === undefined) return [];
    const account = config?.oauthAccount;
    if (account == null) {
      active = [];
    } else {
      const identity = identityOf({ ...account, email: account.emailAddress });
      if (!identity.accountUuid && !identity.organizationUuid && !identity.email) return [];
      active = [identity];
    }
  } else {
    active = options.activeIdentities.map(identityOf);
  }

  const cached = await readCache(NodePath.join(stash, "cache", "usage.json"));
  const accounts = new Map<string, UsageLimitSourceAccount>();
  for (const entry of entries) {
    const slot =
      entry.isFile() || entry.isSymbolicLink() ? SLOT_CONFIG.exec(entry.name)?.[1] : undefined;
    if (slot === undefined) continue;
    const config = (await readConfig(NodePath.join(configs, entry.name)))?.oauthAccount;
    if (config == null) continue;
    const identity = identityOf({ ...config, email: config.emailAddress });
    const { accountUuid, organizationUuid, email } = identity;
    if (accountUuid === undefined && organizationUuid === undefined && email === undefined)
      continue;
    if (active.some((candidate) => matchesActiveIdentity(identity, candidate))) {
      continue;
    }

    const plan = [config.planDisplayName, config.seatTier, config.organizationRateLimitTier]
      .map((text) => text?.trim())
      .find(Boolean);
    const id = `claudeSwap:${NodeCrypto.createHash("sha256")
      .update(`${accountUuid ?? email ?? ""}\0${organizationUuid ?? ""}`)
      .digest("hex")}`;
    const row = cached !== undefined && Object.hasOwn(cached, slot) ? cached[slot] : undefined;
    const usageLimits = usageForSlot(row, identity, options.nowMs);
    const previous = accounts.get(id)?.usageLimits;
    if (
      previous?.unavailable === undefined &&
      previous !== undefined &&
      (usageLimits.unavailable !== undefined || previous.checkedAt >= usageLimits.checkedAt)
    ) {
      continue;
    }
    accounts.set(id, {
      id,
      driver: CLAUDE_DRIVER,
      ...(email === undefined ? {} : { email }),
      ...(organizationUuid === undefined ? {} : { workspaceId: organizationUuid }),
      ...(plan === undefined ? {} : { plan }),
      usageLimits,
    });
  }
  return [...accounts.values()];
}
