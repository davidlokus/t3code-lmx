import type {
  HttpQuotaAccount,
  ServerProviderUsageWindow,
  UsageLimitSourceRegion,
  UsageLimitSourceSnapshot,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import type { ReadQuotaJson } from "../UsageLimitSources.ts";

type KimiReading = Pick<UsageLimitSourceSnapshot, "accounts" | "quotaAccounts" | "error">;
type QuotaWindow = Pick<ServerProviderUsageWindow, "id" | "kind" | "label" | "windowDurationMins">;

const SESSION = {
  id: "session",
  kind: "session",
  label: "Session",
  windowDurationMins: 300,
} as const;
const WEEKLY = {
  id: "weekly",
  kind: "weekly",
  label: "Weekly",
  windowDurationMins: 10_080,
} as const;
const MONTHLY_TOTAL = { id: "monthly_total", kind: "monthly", label: "Monthly Total" } as const;
const MONTHLY_CODING = { id: "monthly_coding", kind: "monthly", label: "Monthly Coding" } as const;
const RESET_FIELDS = ["reset_time", "resetAt", "resetTime", "reset_at"] as const;

export function kimiUsageEndpoint(region: UsageLimitSourceRegion | undefined): string {
  return region === "global"
    ? "https://api.kimi.ai/coding/v1/usages"
    : "https://api.kimi.com/coding/v1/usages";
}

function asRecord(value: unknown): Readonly<Record<string, unknown>> | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  return value as Readonly<Record<string, unknown>>;
}

function finiteNumber(value: unknown): number | undefined {
  if (typeof value === "string" && value.trim() !== "") value = Number(value);
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function resetTime(data: Readonly<Record<string, unknown>> | undefined): string | undefined {
  if (data === undefined) return undefined;
  for (const field of RESET_FIELDS) {
    const value = data[field];
    const epoch = finiteNumber(value);
    let millis: number;
    if (epoch !== undefined) {
      if (epoch <= 0) continue;
      millis = epoch < 1_000_000_000_000 ? epoch * 1_000 : epoch;
    } else if (
      typeof value === "string" &&
      /^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:\d{2})$/.test(value)
    ) {
      millis = Date.parse(value);
    } else {
      continue;
    }
    const date = DateTime.make(millis);
    if (Option.isSome(date)) return DateTime.formatIso(date.value);
  }
  return undefined;
}

function windowDurationMins(
  window: Readonly<Record<string, unknown>> | undefined,
): number | undefined {
  const duration = finiteNumber(window?.duration);
  if (duration === undefined || duration <= 0) return undefined;
  let minutes = duration;
  switch (window?.timeUnit) {
    case "TIME_UNIT_MINUTE":
      break;
    case "TIME_UNIT_HOUR":
      minutes *= 60;
      break;
    case "TIME_UNIT_DAY":
      minutes *= 1_440;
      break;
    case "TIME_UNIT_WEEK":
      minutes *= 10_080;
      break;
    default:
      return undefined;
  }
  return Number.isSafeInteger(minutes) ? minutes : undefined;
}

function reading(
  window: QuotaWindow,
  usedPercent: number,
  resetsAt: string | undefined,
): ServerProviderUsageWindow {
  return {
    ...window,
    usedPercent,
    category: "plan",
    ...(resetsAt === undefined ? {} : { resetsAt }),
  };
}

function summaryReading(
  window: QuotaWindow,
  value: unknown,
): ServerProviderUsageWindow | undefined {
  const summary = asRecord(value);
  const ratio = finiteNumber(summary?.used_ratio ?? summary?.usedRatio);
  if (ratio === undefined || ratio < 0 || ratio > 1) return undefined;
  return reading(window, ratio * 100, resetTime(summary));
}

function counterReading(
  window: QuotaWindow,
  counter: Readonly<Record<string, unknown>> | undefined,
  legacyWindow: Readonly<Record<string, unknown>> | undefined,
): ServerProviderUsageWindow | undefined {
  const limit = finiteNumber(counter?.limit);
  if (limit === undefined || limit <= 0) return undefined;
  const explicitUsed = finiteNumber(counter?.used);
  const remaining = finiteNumber(counter?.remaining);
  if (explicitUsed === undefined && remaining !== undefined && remaining < 0) return undefined;
  // Derive usage from remaining when `used` is omitted; a fresh legacy window with neither reports 0%.
  const used =
    explicitUsed !== undefined
      ? explicitUsed
      : remaining !== undefined
        ? Math.max(0, limit - remaining)
        : 0;
  const percent = Math.min(100, Math.max(0, (used / limit) * 100));
  return reading(window, percent, resetTime(legacyWindow) ?? resetTime(counter));
}

function legacySession(limits: unknown): ServerProviderUsageWindow | undefined {
  if (!Array.isArray(limits)) return undefined;
  for (const value of limits) {
    const entry = asRecord(value);
    const window = asRecord(entry?.window);
    if (windowDurationMins(window) !== SESSION.windowDurationMins) continue;
    const session = counterReading(SESSION, asRecord(entry?.detail), window);
    if (session !== undefined) return session;
  }
  return undefined;
}

function legacyWeekly(value: unknown): ServerProviderUsageWindow | undefined {
  const usage = asRecord(value);
  const window = asRecord(usage?.window);
  return counterReading(
    { ...WEEKLY, windowDurationMins: windowDurationMins(window) ?? WEEKLY.windowDurationMins },
    usage,
    window,
  );
}

function preferLegacyWhenStale(
  summary: ServerProviderUsageWindow | undefined,
  legacy: ServerProviderUsageWindow | undefined,
): ServerProviderUsageWindow | undefined {
  if (summary === undefined) return legacy;
  // A zero summary must not erase usage reported by a live legacy counter.
  if (summary.usedPercent === 0 && legacy !== undefined && legacy.usedPercent > 0) {
    const compatibleReset =
      legacy.resetsAt === undefined &&
      summary.resetsAt !== undefined &&
      legacy.kind === summary.kind &&
      legacy.windowDurationMins === summary.windowDurationMins
        ? { resetsAt: summary.resetsAt }
        : {};
    return { ...legacy, ...compatibleReset };
  }
  return summary;
}

function mapQuotaAccount(value: unknown): HttpQuotaAccount | undefined {
  const envelope = asRecord(value);
  if (envelope === undefined) return undefined;
  const quota = asRecord(asRecord(envelope.data)?.quota) ?? envelope;
  const usages = asRecord(quota.usages);

  let session = summaryReading(SESSION, usages?.limit_5h ?? usages?.limit5h);
  if (session === undefined || session.usedPercent === 0) {
    session = preferLegacyWhenStale(session, legacySession(quota.limits));
  }
  let weekly = summaryReading(WEEKLY, usages?.limit_7d ?? usages?.limit7d);
  if (weekly === undefined || weekly.usedPercent === 0) {
    weekly = preferLegacyWhenStale(weekly, legacyWeekly(quota.usage));
  }

  const windows = [
    session,
    weekly,
    summaryReading(MONTHLY_TOTAL, usages?.limit_month_total),
    summaryReading(MONTHLY_CODING, usages?.limit_month_code),
  ].filter((window) => window !== undefined);
  const wallet = asRecord(quota.booster_wallet ?? quota.boosterWallet);
  const amountLeft = finiteNumber(asRecord(wallet?.balance)?.amountLeft);
  if (windows.length === 0 && amountLeft === undefined) return undefined;

  const level = asRecord(asRecord(quota.user)?.membership)?.level;
  const planTier =
    typeof level === "string" && /^LEVEL_[A-Z0-9]+(?:_[A-Z0-9]+)*$/.test(level)
      ? level
          .slice("LEVEL_".length)
          .toLowerCase()
          .replaceAll("_", " ")
          .replace(/\b[a-z]/g, (letter) => letter.toUpperCase())
      : undefined;

  return {
    id: "kimi-code",
    label: "Kimi Code",
    windows,
    ...(planTier === undefined ? {} : { planTier }),
    ...(amountLeft === undefined
      ? {}
      : {
          balances: [
            {
              id: "kimi-booster",
              label: "Booster",
              // The wallet counts millionths of a cent, not millionths of USD.
              remaining: amountLeft / 100_000_000,
              unit: "USD",
              kind: "balance",
            },
          ],
        }),
  };
}

export const readKimiUsage = Effect.fn("UsageLimitSources.readKimiUsage")(function* (
  endpoint: string,
  key: string,
  readJson: ReadQuotaJson,
): Effect.fn.Return<KimiReading> {
  const response = yield* readJson(endpoint, { "x-api-key": key });
  if (response === undefined) {
    return { accounts: [], error: "Could not read Kimi Code usage." };
  }
  if (response.status === 401 || response.status === 403) {
    return { accounts: [], error: `Kimi Code rejected the API key (HTTP ${response.status}).` };
  }
  if (response.status < 200 || response.status >= 300) {
    return { accounts: [], error: `Kimi Code usage request failed (HTTP ${response.status}).` };
  }
  const account = mapQuotaAccount(response.body);
  return account === undefined
    ? { accounts: [], error: "Kimi Code returned no usable quota data." }
    : { accounts: [], quotaAccounts: [account] };
});
