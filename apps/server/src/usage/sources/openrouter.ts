import type {
  ServerProviderUsageBalance,
  ServerProviderUsageWindow,
  UsageLimitSourceSnapshot,
} from "@t3tools/contracts";
import { clampPercent } from "@t3tools/provider-core/server/usageLimits";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";

import type { ReadQuotaJson } from "../UsageLimitSources.ts";

export const OPENROUTER_USAGE_ORIGIN = "https://openrouter.ai";
const API = `${OPENROUTER_USAGE_ORIGIN}/api/v1`;
const KEY_PAGE_SIZE = 100;
const MAX_KEY_PAGES = 50;
const RESET_PERIODS = {
  daily: { unit: "day", span: { days: 1 } },
  weekly: { unit: "week", span: { weeks: 1 } },
  monthly: { unit: "month", span: { months: 1 } },
} as const;
const SPEND_PERIODS = [
  { field: "usage_daily", id: "today", label: "Today" },
  { field: "usage_weekly", id: "this-week", label: "This Week" },
  { field: "usage_monthly", id: "this-month", label: "This Month" },
] as const;

type Reading = Pick<UsageLimitSourceSnapshot, "accounts" | "quotaAccounts" | "error">;
type Quota = Pick<ServerProviderUsageWindow, "id" | "label" | "unit" | "category">;

function record(value: unknown): Readonly<Record<string, unknown>> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : undefined;
}

function finite(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function quotaWindow(
  quota: Quota,
  used: number,
  limit: number,
  now: DateTime.Utc,
  reset?: unknown,
): ServerProviderUsageWindow {
  const kind = reset === "weekly" || reset === "monthly" ? reset : "other";
  const period =
    reset === "daily" || reset === "weekly" || reset === "monthly"
      ? RESET_PERIODS[reset]
      : undefined;
  const start = period && DateTime.startOf(now, period.unit, { weekStartsOn: 1 });
  const end = period && start && DateTime.add(start, period.span);
  return {
    ...quota,
    kind,
    usedPercent: clampPercent((used / limit) * 100),
    usedAmount: used,
    limitAmount: limit,
    remainingAmount: Math.max(0, limit - used),
    ...(start === undefined || end === undefined
      ? {}
      : {
          resetsAt: DateTime.formatIso(end),
          windowDurationMins:
            (DateTime.toEpochMillis(end) - DateTime.toEpochMillis(start)) / 60_000,
        }),
  };
}

const readManagementSpend = Effect.fn("UsageLimitSources.readOpenRouterManagementSpend")(function* (
  headers: Readonly<Record<string, string>>,
  readJson: ReadQuotaJson,
) {
  const totals = { usage_daily: 0, usage_weekly: 0, usage_monthly: 0 };
  for (let page = 0; page < MAX_KEY_PAGES; page++) {
    const response = yield* readJson(
      `${API}/keys?include_disabled=true&include_expired=true&offset=${page * KEY_PAGE_SIZE}`,
      headers,
    );
    if (!response || response.status < 200 || response.status >= 300) return undefined;
    const keys = record(response.body)?.data;
    if (!Array.isArray(keys) || keys.length > KEY_PAGE_SIZE) return undefined;
    for (const value of keys) {
      const key = record(value);
      for (const { field } of SPEND_PERIODS) {
        const amount = finite(key?.[field]);
        if (amount === undefined) return undefined;
        totals[field] += amount;
        if (!Number.isFinite(totals[field])) return undefined;
      }
    }
    if (keys.length < KEY_PAGE_SIZE) return totals;
  }
  // A full last page cannot prove that the totals include every key.
  return undefined;
});

function isValidResetInterval(value: unknown): boolean {
  return (
    value === undefined ||
    value === null ||
    value === "daily" ||
    value === "weekly" ||
    value === "monthly"
  );
}

function isNonNegativeFinite(value: unknown): value is number {
  const n = finite(value);
  return n !== undefined && n >= 0;
}

function isValidKeyData(
  keyData: Readonly<Record<string, unknown>> | undefined,
): keyData is Readonly<Record<string, unknown>> {
  if (keyData === undefined) return false;
  if (keyData.is_management_key !== undefined && typeof keyData.is_management_key !== "boolean") {
    return false;
  }
  if (keyData.is_free_tier !== undefined && typeof keyData.is_free_tier !== "boolean") {
    return false;
  }
  // Both standard and management keys map effective_budget and free_model_daily_requests.
  if (keyData.effective_budget !== undefined && keyData.effective_budget !== null) {
    const budget = record(keyData.effective_budget);
    if (
      !budget ||
      !isNonNegativeFinite(budget.limit_usd) ||
      !isNonNegativeFinite(budget.spend_usd) ||
      !isValidResetInterval(budget.reset_interval)
    ) {
      return false;
    }
  }
  if (
    keyData.free_model_daily_requests !== undefined &&
    keyData.free_model_daily_requests !== null
  ) {
    const free = record(keyData.free_model_daily_requests);
    const freeLimit = finite(free?.limit);
    const freeUsed = finite(free?.used ?? free?.count);
    if (
      !free ||
      freeLimit === undefined ||
      freeLimit < 0 ||
      !Number.isSafeInteger(freeLimit) ||
      freeUsed === undefined ||
      freeUsed < 0 ||
      !Number.isSafeInteger(freeUsed)
    ) {
      return false;
    }
  }
  // Management keys read spend from paginated /api/v1/keys (validated page by page).
  if (keyData.is_management_key === true) return true;
  if (typeof keyData.is_free_tier !== "boolean") return false;
  for (const { field } of SPEND_PERIODS) {
    if (!isNonNegativeFinite(keyData[field])) return false;
  }
  if (
    keyData.usage !== undefined &&
    keyData.usage !== null &&
    !isNonNegativeFinite(keyData.usage)
  ) {
    return false;
  }
  if (
    keyData.limit !== undefined &&
    keyData.limit !== null &&
    !isNonNegativeFinite(keyData.limit)
  ) {
    return false;
  }
  if (
    keyData.limit_remaining !== undefined &&
    keyData.limit_remaining !== null &&
    !isNonNegativeFinite(keyData.limit_remaining)
  ) {
    return false;
  }
  if (!isValidResetInterval(keyData.limit_reset)) return false;
  const limit = finite(keyData.limit);
  if (limit !== undefined && limit > 0) {
    const hasMeasurement =
      finite(keyData.limit_remaining) !== undefined ||
      keyData.limit_reset === "daily" ||
      keyData.limit_reset === "weekly" ||
      keyData.limit_reset === "monthly" ||
      (keyData.limit_reset == null && finite(keyData.usage) !== undefined);
    if (!hasMeasurement) return false;
  }
  return true;
}

export const readOpenRouterUsage = Effect.fn("UsageLimitSources.readOpenRouterUsage")(function* (
  apiKey: string,
  readJson: ReadQuotaJson,
): Effect.fn.Return<Reading> {
  const headers = { Authorization: `Bearer ${apiKey}` };
  const { credits, key } = yield* Effect.all(
    { credits: readJson(`${API}/credits`, headers), key: readJson(`${API}/key`, headers) },
    { concurrency: 2 },
  );
  const creditData =
    credits && credits.status >= 200 && credits.status < 300
      ? record(record(credits.body)?.data)
      : undefined;
  const rawKeyData =
    key && key.status >= 200 && key.status < 300 ? record(record(key.body)?.data) : undefined;
  const keyData = isValidKeyData(rawKeyData) ? rawKeyData : undefined;
  const totalCredits = finite(creditData?.total_credits);
  const totalUsage = finite(creditData?.total_usage);
  const hasCreditsData = totalCredits !== undefined && totalUsage !== undefined;
  // Workspace/management keys intentionally receive HTTP 403 on /credits; any other failure
  // or malformed 200 payload must report an error so last-good credits are preserved.
  const creditsIntentionallyOmitted = credits?.status === 403;
  const creditsFailed = !creditsIntentionallyOmitted && !hasCreditsData;
  const keyFailed = keyData === undefined;
  const now = yield* DateTime.now;
  const windows: ServerProviderUsageWindow[] = [];
  const balances: ServerProviderUsageBalance[] = [];

  if (hasCreditsData) {
    const used = Math.max(0, totalUsage);
    const remaining = Math.max(0, totalCredits - used);
    if (totalCredits > 0) {
      windows.push(
        quotaWindow(
          { id: "credits", label: "Credits", unit: "USD", category: "balance" },
          used,
          totalCredits,
          now,
        ),
      );
    }
    balances.push({ id: "balance", label: "Balance", remaining, unit: "USD", kind: "balance" });
  }

  const management = keyData?.is_management_key === true;
  const spend = management ? yield* readManagementSpend(headers, readJson) : keyData;
  const managementFailed = management && spend === undefined;
  for (const { field, id, label } of SPEND_PERIODS) {
    const amount = finite(spend?.[field]);
    if (amount !== undefined) {
      balances.push({ id, label, remaining: Math.max(0, amount), unit: "USD", kind: "spend" });
    }
  }

  const limit = finite(keyData?.limit);
  const remaining = finite(keyData?.limit_remaining);
  const limitReset = keyData?.limit_reset;
  const keyUsage =
    limitReset === "daily"
      ? keyData?.usage_daily
      : limitReset === "weekly"
        ? keyData?.usage_weekly
        : limitReset === "monthly"
          ? keyData?.usage_monthly
          : limitReset == null
            ? keyData?.usage
            : undefined;
  if (!management && limit !== undefined && limit > 0) {
    const used = remaining === undefined ? finite(keyUsage) : limit - Math.max(0, remaining);
    if (used !== undefined) {
      windows.push(
        quotaWindow(
          { id: "key-limit", label: "Key Limit", unit: "USD", category: "plan" },
          Math.max(0, used),
          limit,
          now,
          limitReset,
        ),
      );
    }
  }
  const budget = record(keyData?.effective_budget);
  const budgetLimit = finite(budget?.limit_usd);
  const budgetUsed = finite(budget?.spend_usd);
  if (budgetLimit !== undefined && budgetLimit > 0 && budgetUsed !== undefined) {
    windows.push(
      quotaWindow(
        { id: "budget", label: "Budget", unit: "USD", category: "plan" },
        Math.max(0, budgetUsed),
        budgetLimit,
        now,
        budget?.reset_interval,
      ),
    );
  }
  const free = record(keyData?.free_model_daily_requests);
  const freeLimit = finite(free?.limit);
  const freeUsed = finite(free?.used ?? free?.count);
  if (
    freeLimit !== undefined &&
    freeLimit > 0 &&
    Number.isSafeInteger(freeLimit) &&
    freeUsed !== undefined &&
    Number.isSafeInteger(freeUsed)
  ) {
    windows.push(
      quotaWindow(
        { id: "free-requests", label: "Free Requests", unit: "requests", category: "plan" },
        Math.max(0, freeUsed),
        freeLimit,
        now,
        "daily",
      ),
    );
  }

  if (
    keyFailed ||
    creditsFailed ||
    managementFailed ||
    (windows.length === 0 && balances.length === 0)
  ) {
    const authFailure =
      key?.status === 401 || key?.status === 403
        ? key.status
        : !creditsIntentionallyOmitted && (credits?.status === 401 || credits?.status === 403)
          ? credits.status
          : undefined;
    return {
      accounts: [],
      error:
        authFailure === undefined
          ? "Could not read usable OpenRouter usage data."
          : `OpenRouter rejected the API key (HTTP ${authFailure}).`,
    };
  }
  const planTier =
    typeof keyData?.is_free_tier === "boolean"
      ? keyData.is_free_tier
        ? "Free tier"
        : "Pay as you go"
      : undefined;
  return {
    accounts: [],
    quotaAccounts: [
      {
        id: "openrouter",
        label: "OpenRouter",
        windows,
        ...(planTier === undefined ? {} : { planTier }),
        ...(balances.length === 0 ? {} : { balances }),
      },
    ],
  };
});
