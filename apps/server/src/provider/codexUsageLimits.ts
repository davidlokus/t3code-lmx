import type {
  ProviderUsageLimitsUpdate,
  ServerProviderResetCredits,
  ServerProviderUsageLimits,
  ServerProviderUsageWindow,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";
import type * as CodexErrors from "effect-codex-app-server/errors";

import { clampPercent, makeUsageLimits } from "@t3tools/provider-core/server/usageLimits";

interface CodexRateLimitWindow {
  readonly usedPercent: number;
  readonly resetsAt?: number | null;
  readonly windowDurationMins?: number | null;
}

export interface CodexRateLimitSnapshot {
  readonly limitId?: string | null;
  readonly planType?: string | null;
  readonly rateLimitReachedType?: string | null;
  readonly primary?: CodexRateLimitWindow | null;
  readonly secondary?: CodexRateLimitWindow | null;
  readonly credits?:
    | {
        readonly hasCredits: boolean;
        readonly unlimited: boolean;
        readonly balance?: string | null | undefined;
      }
    | null
    | undefined;
  readonly subscriptionActiveUntil?: string | number | null | undefined;
  readonly individualLimit?: {
    readonly remainingPercent: number;
    readonly resetsAt: number;
    readonly used?: string | null;
    readonly limit?: string | null;
  } | null;
}

export interface CodexResetCreditsSummary {
  readonly availableCount: number;
  readonly credits?: ReadonlyArray<{
    readonly status: string;
    readonly expiresAt?: number | null;
  }> | null;
}

const SESSION_MINS = 5 * 60;
const WEEK_MINS = 7 * 24 * 60;
const MONTH_MINS = 30 * 24 * 60;

function isoFromEpochSeconds(value: number | null | undefined): string | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return undefined;
  const millis = value * 1000;
  if (millis > 8.64e15) return undefined;
  const dt = DateTime.make(millis);
  return Option.isSome(dt) ? DateTime.formatIso(dt.value) : undefined;
}

function parseFiniteDecimal(value: string | null | undefined): number | undefined {
  const text = value?.trim();
  if (!text || !/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(text)) return undefined;
  const number = Number(text);
  return Number.isFinite(number) ? number : undefined;
}

function subscriptionExpiry(value: CodexRateLimitSnapshot["subscriptionActiveUntil"]) {
  if (typeof value !== "string") return isoFromEpochSeconds(value);
  const text = value.trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) {
    const midnight = DateTime.make(`${text}T00:00:00Z`);
    return Option.isSome(midnight) && DateTime.formatIso(midnight.value).startsWith(`${text}T`)
      ? text
      : undefined;
  }
  const date =
    /^((?:\d{4}|[+-]\d{6})-\d{2}-\d{2})T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})$/.exec(
      text,
    )?.[1];
  if (!date) return isoFromEpochSeconds(parseFiniteDecimal(text));
  const midnight = DateTime.make(`${date}T00:00:00Z`);
  // JS date parsing rolls impossible dates forward rather than rejecting them.
  if (Option.isNone(midnight) || !DateTime.formatIso(midnight.value).startsWith(`${date}T`)) {
    return undefined;
  }
  const expiry = DateTime.make(text);
  return Option.isSome(expiry) ? DateTime.formatIso(expiry.value) : undefined;
}

function codexPlanTier(value: CodexRateLimitSnapshot["planType"]) {
  const plan = value?.trim();
  switch (plan?.toLowerCase()) {
    case undefined:
    case "":
    case "unknown":
      return undefined;
    case "free":
      return "Free";
    case "go":
      return "Go";
    case "plus":
      return "Plus";
    case "pro":
      return "Pro";
    case "prolite":
      return "Pro 100";
    case "promax":
      return "Pro 500";
    case "self_serve_business_prolite":
      return "Business Premium";
    case "team":
    case "business":
    case "self_serve_business_usage_based":
      return "Business";
    case "ent26":
    case "enterprise":
    case "enterprise_cbp_automation":
    case "enterprise_cbp_usage_based":
      return "Enterprise";
    default:
      return plan;
  }
}

// undefined means unmeasured; null means the provider explicitly reports no credits.
function creditBalance(credits: CodexRateLimitSnapshot["credits"]) {
  if (!credits || credits.unlimited) return undefined;
  if (!credits.hasCredits) return null;
  const balance = parseFiniteDecimal(credits.balance);
  return balance === undefined ? undefined : Math.max(0, balance);
}

function usageBalances(
  remaining: number | null | undefined,
): ServerProviderUsageLimits["balances"] {
  if (remaining === undefined) return undefined;
  if (remaining === null) return [];
  return [{ id: "codex-credits", label: "Credits", remaining, unit: "credits", kind: "credits" }];
}

function kindForDuration(mins: number): ServerProviderUsageWindow["kind"] {
  if (mins >= MONTH_MINS) return "monthly";
  if (mins >= WEEK_MINS) return "weekly";
  return "session";
}

function labelForKind(kind: ServerProviderUsageWindow["kind"]): string {
  return kind === "session" ? "Session" : kind === "weekly" ? "Weekly" : "Monthly";
}

/** primary/secondary are positions; without windowDurationMins, paid plans use 5-hour/weekly windows and Free/Go use monthly. */
function codexRateLimitsToWindows(
  snapshot: CodexRateLimitSnapshot,
): ReadonlyArray<ServerProviderUsageWindow> {
  // Keep model-specific limits out of main allowance rows; older CLIs omit limit IDs.
  if (snapshot.limitId && snapshot.limitId !== "codex") return [];
  const isMonthlyPlan = snapshot.planType === "free" || snapshot.planType === "go";
  const positions = [
    ["primary", snapshot.primary, isMonthlyPlan ? MONTH_MINS : SESSION_MINS],
    ["secondary", snapshot.secondary, WEEK_MINS],
  ] as const;
  const windows: ServerProviderUsageWindow[] = [];
  for (const [id, window, fallbackMins] of positions) {
    if (!window || !Number.isFinite(window.usedPercent)) continue;
    const windowDurationMins =
      typeof window.windowDurationMins === "number" ? window.windowDurationMins : fallbackMins;
    const kind = kindForDuration(windowDurationMins);
    const resetsAt = isoFromEpochSeconds(window.resetsAt);
    windows.push({
      id,
      kind,
      label: labelForKind(kind),
      category: "plan",
      usedPercent: clampPercent(window.usedPercent),
      windowDurationMins,
      ...(resetsAt ? { resetsAt } : {}),
    });
  }
  const individualLimit = snapshot.individualLimit;
  if (individualLimit && Number.isFinite(individualLimit.remainingPercent)) {
    const resetsAt = isoFromEpochSeconds(individualLimit.resetsAt);
    const used = parseFiniteDecimal(individualLimit.used);
    const limit = parseFiniteDecimal(individualLimit.limit);
    windows.push({
      id: "individual",
      kind: "monthly",
      label: "Monthly credit limit",
      category: "balance",
      usedPercent: clampPercent(100 - individualLimit.remainingPercent),
      ...(used !== undefined && used >= 0 && limit !== undefined && limit > 0
        ? {
            usedAmount: used,
            limitAmount: limit,
            remainingAmount: Math.max(0, limit - used),
            unit: "credits",
          }
        : {}),
      ...(resetsAt ? { resetsAt } : {}),
    });
  }
  return windows;
}

function codexResetCreditsToContract(
  summary: CodexResetCreditsSummary | null | undefined,
): ServerProviderResetCredits | undefined {
  if (!summary) return undefined;
  const expiries = (summary.credits ?? [])
    .filter((credit) => credit.status === "available")
    .map((credit) => credit.expiresAt)
    .filter((value): value is number => typeof value === "number");
  const nextExpiresAt =
    expiries.length > 0 ? isoFromEpochSeconds(Math.min(...expiries)) : undefined;
  return {
    availableCount: Math.max(0, summary.availableCount),
    ...(nextExpiresAt ? { nextExpiresAt } : {}),
  };
}

export function codexRateLimitsToLimits(input: {
  readonly snapshot: CodexRateLimitSnapshot;
  readonly rateLimitsByLimitId?:
    | Readonly<Record<string, CodexRateLimitSnapshot>>
    | null
    | undefined;
  readonly resetCredits?: CodexResetCreditsSummary | null | undefined;
  readonly checkedAt: string;
}): ServerProviderUsageLimits {
  const resetCredits = codexResetCreditsToContract(input.resetCredits);
  const candidate = input.rateLimitsByLimitId?.codex ?? input.snapshot;
  const snapshot = !candidate.limitId || candidate.limitId === "codex" ? candidate : undefined;
  return {
    ...makeUsageLimits({
      checkedAt: input.checkedAt,
      windows: snapshot ? codexRateLimitsToWindows(snapshot) : [],
      planTier: snapshot ? codexPlanTier(snapshot.planType) : undefined,
      balances: snapshot ? usageBalances(creditBalance(snapshot.credits)) : undefined,
      subscriptionExpiresAt: snapshot
        ? subscriptionExpiry(snapshot.subscriptionActiveUntil)
        : undefined,
    }),
    ...(resetCredits ? { resetCredits } : {}),
  };
}

export function codexRateLimitsToUpdate(
  snapshot: CodexRateLimitSnapshot,
  previous?: CodexRateLimitSnapshot,
): ProviderUsageLimitsUpdate | undefined {
  if (snapshot.limitId && snapshot.limitId !== "codex") return undefined;
  const previousWindows = previous ? codexRateLimitsToWindows(previous) : [];
  // Token ticks repeat session-cached limits that may predate an account probe or reset.
  const windows = codexRateLimitsToWindows(snapshot).filter((window) => {
    const existing = previousWindows.find((candidate) => candidate.id === window.id);
    return (
      !existing ||
      existing.kind !== window.kind ||
      existing.usedPercent !== window.usedPercent ||
      existing.resetsAt !== window.resetsAt ||
      existing.windowDurationMins !== window.windowDurationMins ||
      (window.usedAmount !== undefined &&
        (existing.usedAmount !== window.usedAmount || existing.limitAmount !== window.limitAmount))
    );
  });
  const balance = creditBalance(snapshot.credits);
  const balances =
    balance !== undefined && balance !== creditBalance(previous?.credits)
      ? usageBalances(balance)
      : undefined;
  const expiry = subscriptionExpiry(snapshot.subscriptionActiveUntil);
  const subscriptionExpiresAt =
    expiry !== undefined && expiry !== subscriptionExpiry(previous?.subscriptionActiveUntil)
      ? expiry
      : undefined;
  if (windows.length === 0 && balances === undefined && subscriptionExpiresAt === undefined) {
    return undefined;
  }
  const planTier = codexPlanTier(snapshot.planType);
  return {
    windows,
    ...(planTier !== undefined && planTier !== codexPlanTier(previous?.planType)
      ? { planTier }
      : {}),
    ...(balances !== undefined ? { balances } : {}),
    ...(subscriptionExpiresAt !== undefined ? { subscriptionExpiresAt } : {}),
  };
}

export function codexRateLimitsFailureMessage(error: CodexErrors.CodexAppServerError): string {
  switch (error._tag) {
    case "CodexAppServerRequestError":
      return `Codex could not read usage (JSON-RPC ${error.code}).`;
    case "CodexAppServerSpawnError":
      return "Codex could not be started to read usage.";
    case "CodexAppServerProcessExitedError":
      return "Codex exited before it could report usage.";
    default:
      return "Codex did not answer the usage request.";
  }
}

/** Rate-limit notifications are partial: omitted fields preserve earlier session values. */
export function mergeCodexRateLimits(
  previous: CodexRateLimitSnapshot | undefined,
  update: CodexRateLimitSnapshot,
): CodexRateLimitSnapshot | undefined {
  // Model-specific snapshots must not overwrite the main allowance.
  if (update.limitId && update.limitId !== "codex") return previous;
  if (!previous) return update;
  return {
    ...previous,
    ...(update.limitId !== undefined ? { limitId: update.limitId } : {}),
    ...(update.planType !== undefined ? { planType: update.planType } : {}),
    ...(update.rateLimitReachedType !== undefined
      ? { rateLimitReachedType: update.rateLimitReachedType }
      : {}),
    ...(update.primary !== undefined ? { primary: update.primary } : {}),
    ...(update.secondary !== undefined ? { secondary: update.secondary } : {}),
    ...(update.individualLimit !== undefined ? { individualLimit: update.individualLimit } : {}),
    ...(update.credits !== undefined ? { credits: update.credits } : {}),
    ...(update.subscriptionActiveUntil !== undefined
      ? { subscriptionActiveUntil: update.subscriptionActiveUntil }
      : {}),
  };
}

/** All exhausted windows must reset before a continuation can run. */
export function codexUsageLimitResetAt(
  snapshot: CodexRateLimitSnapshot | undefined,
): string | null {
  if (!snapshot) return null;
  const windows = codexRateLimitsToWindows(snapshot).filter((window) => window.usedPercent >= 100);
  if (windows.length === 0 || windows.some((window) => !window.resetsAt)) return null;
  return windows.reduce<string | null>(
    (latest, window) =>
      latest === null || Date.parse(window.resetsAt!) > Date.parse(latest)
        ? window.resetsAt!
        : latest,
    null,
  );
}

const CODEX_RESET_TEXT =
  /[Tt]ry again at (?:([A-Z][a-z]{2}) (\d{1,2})(?:st|nd|rd|th), (\d{4}) )?(\d{1,2}):(\d{2}) ([AP]M)\./;
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** The zone Codex prints reset times in: its own `TZ`, else the server's. */
export function codexTimeZone(
  environment: Readonly<Record<string, string | undefined>>,
): DateTime.TimeZone {
  return Option.getOrElse(
    DateTime.zoneMakeNamed(environment.TZ?.replace(/^:/, "") ?? ""),
    DateTime.zoneMakeLocal,
  );
}

/**
 * Codex writes a usage limit's reset into its error text in its own local time:
 * "Try again at 3:37 PM." for today, else "try again at Nov 11th, 2026 3:37 PM.".
 * It is the only reset left when a proxy such as CLIProxyAPI strips the rate-limit snapshot.
 * `failedAt` is when Codex reported the failure, which fixes the date of today's form.
 */
export function codexMessageResetAt(
  message: string,
  failedAt: DateTime.DateTime,
  zone: DateTime.TimeZone,
): string | null {
  const match = CODEX_RESET_TEXT.exec(message);
  if (!match) return null;
  const [, month, day, year, hour, minute, meridiem] = match;
  const monthIndex = month === undefined ? undefined : MONTHS.indexOf(month);
  if (monthIndex === -1) return null;
  const today = DateTime.toParts(DateTime.setZone(failedAt, zone));
  const reset = DateTime.makeZoned(
    {
      year: monthIndex === undefined ? today.year : Number(year),
      month: monthIndex === undefined ? today.month : monthIndex + 1,
      day: monthIndex === undefined ? today.day : Number(day),
      hour: (Number(hour) % 12) + (meridiem === "PM" ? 12 : 0),
      minute: Number(minute),
    },
    // The repeated hour at a DST fall-back takes its later instant so a resume never fires early.
    { timeZone: zone, adjustForTimeZone: true, disambiguation: "later" },
  );
  if (Option.isNone(reset)) return null;
  // Codex drops the seconds, so the next minute is the first one past the reset.
  const resetAt = DateTime.add(reset.value, { minutes: 1 });
  return DateTime.isGreaterThan(resetAt, failedAt) ? DateTime.formatIso(resetAt) : null;
}
