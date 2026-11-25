import type {
  HttpQuotaAccount,
  ServerProviderUsageWindow,
  UsageLimitSourceRegion,
  UsageLimitSourceSnapshot,
} from "@t3tools/contracts";
import { clampPercent } from "@t3tools/provider-core/server/usageLimits";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import type { ReadQuotaJson } from "../UsageLimitSources.ts";

const DAY_MINUTES = 24 * 60;
const MONTH_MINUTES = 30 * DAY_MINUTES;
const UNIT_MINUTES = new Map([
  [3, 60],
  [4, DAY_MINUTES],
  [5, MONTH_MINUTES],
  [6, 7 * DAY_MINUTES],
]);

const METER_IDS = {
  CREDIT_LIMIT: "credit",
  TOKENS_LIMIT: "tokens",
  TIME_LIMIT: "web_searches",
};
const METER_LABELS = {
  CREDIT_LIMIT: "Credits",
  TOKENS_LIMIT: "Tokens",
  TIME_LIMIT: "Searches",
};
type MeterType = keyof typeof METER_LABELS;

export function zaiUsageOrigin(region: UsageLimitSourceRegion | undefined): string {
  return region === "cn" ? "https://open.bigmodel.cn" : "https://api.z.ai";
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function finiteNumber(value: unknown): number | undefined {
  if (typeof value === "string" && value.trim() !== "") value = Number(value);
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function resetDate(value: unknown): string | undefined {
  const millis = finiteNumber(value);
  if (millis === undefined || millis <= 0) return undefined;
  const date = DateTime.make(millis);
  return Option.isSome(date) ? DateTime.formatIso(date.value) : undefined;
}

function meterType(value: unknown): MeterType | undefined {
  return value === "CREDIT_LIMIT" || value === "TOKENS_LIMIT" || value === "TIME_LIMIT"
    ? value
    : undefined;
}

function readWindows(limits: readonly unknown[]): ServerProviderUsageWindow[] | undefined {
  const meters: { type: MeterType; window: ServerProviderUsageWindow }[] = [];
  const counts = new Map<string, number>();
  let malformed = false;
  for (const limit of limits) {
    const entry = asRecord(limit);
    if (!entry) {
      malformed = true;
      continue;
    }
    const type = meterType(entry.type) ?? meterType(entry.name);
    if (!type) continue;

    const used = finiteNumber(entry.currentValue);
    const capacity = finiteNumber(entry.usage);
    const resetsAt = resetDate(entry.nextResetTime);
    const reset = resetsAt === undefined ? {} : { resetsAt };
    let window: ServerProviderUsageWindow;
    if (type === "TIME_LIMIT") {
      if (used === undefined || used < 0 || capacity === undefined || capacity < 0) {
        malformed = true;
        continue;
      }
      window = {
        id: "web_searches",
        kind: "monthly",
        label: "Web Searches",
        usedPercent: capacity > 0 ? clampPercent((Math.min(used, capacity) / capacity) * 100) : 0,
        usedAmount: used,
        limitAmount: capacity,
        remainingAmount: Math.max(0, capacity - used),
        unit: "searches",
        category: "plan",
        windowDurationMins: MONTH_MINUTES,
        ...reset,
      };
    } else {
      const unit = finiteNumber(entry.unit);
      const periods = finiteNumber(entry.number);
      if (unit === undefined || periods === undefined || periods <= 0) {
        malformed = true;
        continue;
      }
      const unitMinutes = UNIT_MINUTES.get(unit);
      if (unitMinutes === undefined) continue;
      const minutes = unitMinutes * periods;
      const windowDurationMins = Math.round(minutes);
      const percentage = finiteNumber(entry.percentage);
      if (
        !Number.isSafeInteger(windowDurationMins) ||
        windowDurationMins < 1 ||
        percentage === undefined
      ) {
        malformed = true;
        continue;
      }
      const kind =
        minutes < DAY_MINUTES ? "session" : minutes >= 28 * DAY_MINUTES ? "monthly" : "weekly";
      window = {
        id: `${kind}_${METER_IDS[type]}_${windowDurationMins}`,
        kind,
        label: kind === "session" ? "Session" : kind === "weekly" ? "Weekly" : "Monthly",
        usedPercent: clampPercent(percentage),
        windowDurationMins,
        category: "plan",
        ...(used !== undefined && used >= 0 && capacity !== undefined && capacity > 0
          ? {
              usedAmount: used,
              limitAmount: capacity,
              remainingAmount: Math.max(0, capacity - used),
              unit: "credits",
            }
          : {}),
        ...reset,
      };
    }
    meters.push({ type, window });
    counts.set(window.label, (counts.get(window.label) ?? 0) + 1);
  }
  if (meters.length === 0 && malformed) return undefined;

  // Window IDs stay invariant across responses (scoped by cadence, meter type, and duration);
  // labels disambiguate only when competing meters share the same cadence label.
  const idOccurrences = new Map<string, number>();
  const labelOccurrences = new Map<string, number>();
  return meters.map(({ type, window }) => {
    const idOccurrence = (idOccurrences.get(window.id) ?? 0) + 1;
    idOccurrences.set(window.id, idOccurrence);
    const id = idOccurrence === 1 ? window.id : `${window.id}_${idOccurrence}`;
    if (counts.get(window.label) === 1) {
      return id === window.id ? window : { ...window, id };
    }
    const baseLabel = `${window.label} · ${METER_LABELS[type]} · ${window.windowDurationMins} min`;
    const labelOccurrence = (labelOccurrences.get(baseLabel) ?? 0) + 1;
    labelOccurrences.set(baseLabel, labelOccurrence);
    return {
      ...window,
      id,
      label: labelOccurrence === 1 ? baseLabel : `${baseLabel} (${labelOccurrence})`,
    };
  });
}

function readSubscription(
  body: unknown,
): Pick<HttpQuotaAccount, "planTier" | "subscriptionExpiresAt"> {
  const root = asRecord(body);
  if (root?.success === false || !Array.isArray(root?.data)) return {};
  let active: Record<string, unknown> | undefined;
  for (const item of root.data) {
    const subscription = asRecord(item);
    if (typeof subscription?.status !== "string" || subscription.status.toUpperCase() !== "VALID") {
      continue;
    }
    active ??= subscription;
    if (subscription.inCurrentPeriod === true) {
      active = subscription;
      break;
    }
  }
  const planTier = typeof active?.productName === "string" ? active.productName.trim() : undefined;
  // A timezone-less wall clock represents the provider's calendar date, not an instant.
  const renewal = typeof active?.nextRenewTime === "string" ? active.nextRenewTime.trim() : "";
  const rawDate = /^(\d{4}-\d{2}-\d{2})(?: \d{2}:\d{2}:\d{2})?$/.exec(renewal)?.[1];
  const parsedDate = rawDate ? DateTime.make(`${rawDate}T00:00:00Z`) : Option.none();
  const date =
    rawDate &&
    Option.isSome(parsedDate) &&
    DateTime.formatIso(parsedDate.value).startsWith(`${rawDate}T`)
      ? rawDate
      : undefined;
  return {
    ...(planTier ? { planTier } : {}),
    ...(date ? { subscriptionExpiresAt: date } : {}),
  };
}

function quotaError(error: string): Pick<UsageLimitSourceSnapshot, "accounts" | "error"> {
  return { accounts: [], error };
}

export const readZaiUsage = Effect.fn("UsageLimitSources.readZaiUsage")(function* (
  origin: string,
  key: string,
  readJson: ReadQuotaJson,
): Effect.fn.Return<Pick<UsageLimitSourceSnapshot, "accounts" | "quotaAccounts" | "error">> {
  const headers = { Authorization: `Bearer ${key}` };
  const quota = yield* readJson(`${origin}/api/monitor/usage/quota/limit`, headers);
  if (!quota) return quotaError("Could not read Z.ai usage quota.");
  if (quota.status === 401 || quota.status === 403) {
    return quotaError("Z.ai rejected the API key.");
  }
  if (quota.status < 200 || quota.status >= 300) {
    return quotaError(`Z.ai quota request failed (HTTP ${quota.status}).`);
  }
  const root = asRecord(quota.body);
  if (root?.success === false) {
    if (finiteNumber(root.code) === 401) return quotaError("Z.ai rejected the API key.");
    if (typeof root.msg === "string" && /coding plan/i.test(root.msg)) {
      return quotaError("No active GLM Coding Plan.");
    }
    return quotaError("Z.ai rejected the quota request.");
  }
  const limits = asRecord(root?.data)?.limits ?? root?.limits;
  const windows = Array.isArray(limits) ? readWindows(limits) : undefined;
  if (!windows) return quotaError("Invalid Z.ai quota response.");

  const subscription = yield* readJson(`${origin}/api/biz/subscription/list`, headers);
  const metadata = readSubscription(
    subscription && subscription.status >= 200 && subscription.status < 300
      ? subscription.body
      : undefined,
  );
  if (windows.length === 0 && !metadata.planTier && !metadata.subscriptionExpiresAt) {
    return { accounts: [], quotaAccounts: [] };
  }
  return {
    accounts: [],
    quotaAccounts: [{ id: "zai", label: "Z.ai / BigModel", windows, ...metadata }],
  };
});
