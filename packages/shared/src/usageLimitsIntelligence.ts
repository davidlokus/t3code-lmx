import type {
  ProviderInstanceId,
  ServerProviderUsageBalance,
  ServerProviderUsageLimits,
  ServerProviderUsageWindow,
  UsageLimitSourceKind,
  UsageLimitSourceSnapshot,
} from "@t3tools/contracts";

import { isLocalLoopbackHost, isWildcardHost } from "./hostClassification.ts";
import {
  type LimitAccount,
  type LimitPresentations,
  parseUsageLimitTimestampMs,
  providersWithLimits,
} from "./usageLimits.ts";

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;

export interface ManualSubscriptionOverride {
  readonly expiresAt?: string;
  readonly monthlyCost?: number;
  readonly currency?: string;
  readonly planLabel?: string;
  readonly notes?: string;
}

export type WindowBurnPaceStatus =
  | "exhausted"
  | "will-exhaust"
  | "ahead"
  | "on-pace"
  | "under-pace"
  | "insufficient-data";

export interface WindowBurnPace {
  readonly status: WindowBurnPaceStatus;
  readonly elapsedShare: number;
  readonly expectedUsedPercent: number;
  readonly headroomPercent: number;
  readonly paceRatio: number | null;
  readonly projectedUsedAtResetPercent: number | null;
  readonly projectedExhaustionMs: number | null;
}

export interface NormalizedLimitWindow extends ServerProviderUsageWindow {
  readonly remainingPercent: number;
  readonly resetsAtMs: number | null;
  readonly resetsInMs: number | null;
  readonly pace: WindowBurnPace | null;
}

type AccountInput = Omit<LimitAccount, "driver"> & {
  readonly driver: LimitAccount["driver"] | null;
  readonly sourceKind: "native" | UsageLimitSourceKind;
  readonly providerInstanceId?: ProviderInstanceId;
};

export interface NormalizedLimitAccount extends AccountInput {
  readonly windows: readonly NormalizedLimitWindow[];
  readonly manualOverride: ManualSubscriptionOverride | undefined;
}

export type ResetTimelineGroup = "next24h" | "next7d" | "later" | "unscheduled";

export interface ResetTimelineEntry {
  readonly account: NormalizedLimitAccount;
  readonly window: NormalizedLimitWindow;
  readonly group: ResetTimelineGroup;
  readonly resetsInMs: number | null;
}

export type LimitAlertSeverity = "critical" | "warning" | "info";
export type LimitAlertKind =
  | "window-exhausted"
  | "window-low"
  | "burn-exhaustion"
  | "credit-expiring"
  | "subscription-expiring"
  | "balance-expiring"
  | "probe-failed"
  | "service-notice";

export interface LimitAlertEntry {
  readonly key: string;
  readonly severity: LimitAlertSeverity;
  readonly kind: LimitAlertKind;
  readonly account?: NormalizedLimitAccount;
  readonly window?: NormalizedLimitWindow;
  readonly expiry?: ExpiryItem;
  readonly sourceLabel?: string;
  readonly message?: string;
}

export type ExpiryItemKind = "subscription" | "reset-credit" | "balance";

export type ExpiryItem = {
  readonly key: string;
  readonly account: NormalizedLimitAccount;
  readonly expiresAtMs: number;
  readonly label: string | undefined;
} & (
  | { readonly kind: "subscription"; readonly source: "provider" | "manual" }
  | { readonly kind: "reset-credit"; readonly source: "provider" }
  | {
      readonly kind: "balance";
      readonly source: "provider";
      readonly balance: ServerProviderUsageBalance;
    }
);

export interface LimitsIntelligenceSnapshot {
  readonly accounts: readonly NormalizedLimitAccount[];
  readonly resets: readonly ResetTimelineEntry[];
  readonly alerts: readonly LimitAlertEntry[];
  readonly expiries: readonly ExpiryItem[];
  readonly accountsWithoutExpiry: readonly NormalizedLimitAccount[];
  readonly monthlySpendByCurrency: Readonly<Record<string, number>>;
  readonly summary: {
    readonly accountCount: number;
    readonly windowCount: number;
    readonly criticalAlertCount: number;
    readonly warningAlertCount: number;
    readonly infoAlertCount: number;
  };
}

type PaceWindow = Pick<
  ServerProviderUsageWindow,
  "usedPercent" | "resetsAt" | "windowDurationMins"
>;

function dateMillis(value: string | undefined): number | null {
  return parseUsageLimitTimestampMs(value);
}

function computePace(
  window: PaceWindow,
  now: number,
  resetsAtMs: number | null,
): WindowBurnPace | null {
  const lengthMs = (window.windowDurationMins ?? 0) * MINUTE;
  if (
    !Number.isFinite(lengthMs) ||
    lengthMs <= 0 ||
    !Number.isFinite(now) ||
    resetsAtMs === null ||
    resetsAtMs <= now ||
    !Number.isFinite(window.usedPercent)
  )
    return null;

  const elapsedMs = Math.max(0, Math.min(lengthMs, lengthMs - (resetsAtMs - now)));
  const elapsedShare = elapsedMs / lengthMs;
  const expectedUsedPercent = elapsedShare * 100;
  const usedPercent = Math.max(0, Math.min(100, window.usedPercent));
  const headroomPercent = Math.round(expectedUsedPercent - usedPercent);
  const base = { elapsedShare, expectedUsedPercent, headroomPercent };
  if (usedPercent >= 100) {
    return {
      ...base,
      status: "exhausted",
      paceRatio: elapsedShare > 0 ? Number((usedPercent / expectedUsedPercent).toFixed(2)) : null,
      projectedUsedAtResetPercent: 100,
      projectedExhaustionMs: now,
    };
  }
  if (usedPercent === 0 || (elapsedShare < 0.05 && elapsedMs < 5 * MINUTE)) {
    return {
      ...base,
      status: "insufficient-data",
      paceRatio: null,
      projectedUsedAtResetPercent: null,
      projectedExhaustionMs: null,
    };
  }
  const projectedUsedAtResetPercent = Math.min(999, Math.round(usedPercent / elapsedShare));
  const exhaustionMs =
    projectedUsedAtResetPercent > 100
      ? Math.round(now + (100 - usedPercent) / (usedPercent / elapsedMs))
      : null;
  const projectedExhaustionMs =
    exhaustionMs !== null && exhaustionMs < resetsAtMs ? exhaustionMs : null;
  const gap = usedPercent - expectedUsedPercent;
  const status =
    projectedExhaustionMs !== null
      ? "will-exhaust"
      : gap > 5
        ? "ahead"
        : gap < -5
          ? "under-pace"
          : "on-pace";
  return {
    ...base,
    status,
    paceRatio: Number((usedPercent / expectedUsedPercent).toFixed(2)),
    projectedUsedAtResetPercent,
    projectedExhaustionMs,
  };
}

export function computeWindowBurnPace(window: PaceWindow, now: number): WindowBurnPace | null {
  return computePace(window, now, dateMillis(window.resetsAt));
}

function overrideFor(
  overrides: Readonly<Record<string, ManualSubscriptionOverride>> | undefined,
  key: string,
): ManualSubscriptionOverride | undefined {
  return overrides && Object.prototype.hasOwnProperty.call(overrides, key)
    ? overrides[key]
    : undefined;
}

function filterDuplicateCursorTotal(
  driver: AccountInput["driver"],
  windows: readonly ServerProviderUsageWindow[],
): readonly ServerProviderUsageWindow[] {
  if (driver !== "cursor") return windows;
  const hasAuto = windows.some((window) => window.id === "autoPercentUsed");
  const hasApi = windows.some((window) => window.id === "apiPercentUsed");
  const total = windows.find((window) => window.id === "totalPercentUsed");
  const auto = windows.find((window) => window.id === "autoPercentUsed");
  const duplicateTotal =
    windows.length === 2 &&
    total !== undefined &&
    auto !== undefined &&
    total.kind === auto.kind &&
    total.usedPercent === auto.usedPercent &&
    total.resetsAt === auto.resetsAt;
  const hideTotal = (hasAuto && hasApi) || duplicateTotal;
  return hideTotal ? windows.filter((window) => window.id !== "totalPercentUsed") : windows;
}

function normalizeAccount(
  account: AccountInput,
  now: number,
  manualOverride: ManualSubscriptionOverride | undefined,
): NormalizedLimitAccount {
  const windows: NormalizedLimitWindow[] = [];
  if (!account.limits.unavailable) {
    const seen = new Set<string>();
    const deduped: ServerProviderUsageWindow[] = [];
    for (const window of account.limits.windows) {
      if (seen.has(window.id)) continue;
      seen.add(window.id);
      deduped.push(window);
    }
    for (const window of filterDuplicateCursorTotal(account.driver, deduped)) {
      const resetsAtMs = dateMillis(window.resetsAt);
      windows.push({
        ...window,
        remainingPercent: 100 - window.usedPercent,
        resetsAtMs,
        resetsInMs: resetsAtMs === null ? null : Math.max(0, resetsAtMs - now),
        pace: computePace(window, now, resetsAtMs),
      });
    }
  }
  return {
    ...account,
    windows,
    manualOverride,
    plan: account.limits.planTier ?? manualOverride?.planLabel ?? account.plan,
  };
}

function hubKey(
  environmentId: string,
  source: UsageLimitSourceSnapshot,
): readonly ["remote", string] | readonly ["local", string, string] {
  const host = source.endpoint?.match(
    /^https?:\/\/(\[[\da-f:.]+\]|[^:/?#@]+)(?::\d+)?(?:\/|$)/,
  )?.[1];
  if (
    !host ||
    isLocalLoopbackHost(host) ||
    isWildcardHost(host) ||
    /\.localhost\.*$|^\[::ffff:(?:127\.|7f[\da-f]{2}:)/i.test(host)
  ) {
    return ["local", environmentId, source.id];
  }
  return ["remote", source.endpoint ?? ""];
}

function baseIdentityTuple(
  driver: LimitAccount["driver"],
  email: string | undefined,
  limits: ServerProviderUsageLimits | undefined,
): readonly [string, string, string] | null {
  const normalizedEmail = email?.trim().toLowerCase();
  if (normalizedEmail) return ["email", String(driver), normalizedEmail];
  if (limits?.credentialFingerprint) {
    return ["credential", String(driver), limits.credentialFingerprint];
  }
  return null;
}

function createCanonicalIdentityResolver(presentations: LimitPresentations) {
  const workspacesByBase = new Map<string, Set<string>>();
  const recordWorkspace = (
    driver: LimitAccount["driver"],
    email: string | undefined,
    workspaceId: string | undefined,
    limits: ServerProviderUsageLimits | undefined,
  ) => {
    if (!workspaceId) return;
    const base = baseIdentityTuple(driver, email, limits);
    if (!base) return;
    const baseKey = JSON.stringify(base);
    let set = workspacesByBase.get(baseKey);
    if (!set) {
      set = new Set<string>();
      workspacesByBase.set(baseKey, set);
    }
    set.add(workspaceId);
  };
  for (const presentation of presentations.values()) {
    for (const provider of presentation.serverConfig?.providers ?? []) {
      if (!provider.enabled) continue;
      recordWorkspace(
        provider.driver,
        provider.auth.email,
        provider.auth.workspaceId,
        provider.usageLimits,
      );
    }
    for (const source of presentation.serverConfig?.usageLimitSources ?? []) {
      for (const account of source.accounts) {
        recordWorkspace(account.driver, account.email, account.workspaceId, account.usageLimits);
      }
    }
  }
  return (
    driver: LimitAccount["driver"],
    email: string | undefined,
    workspaceId: string | undefined,
    limits: ServerProviderUsageLimits | undefined,
  ): string | null => {
    const base = baseIdentityTuple(driver, email, limits);
    if (!base) return null;
    if (workspaceId) return JSON.stringify(["identity", ...base, workspaceId]);
    const known = workspacesByBase.get(JSON.stringify(base));
    if (!known) return JSON.stringify(["identity", ...base, null]);
    return known.size === 1 ? JSON.stringify(["identity", ...base, [...known][0]]) : null;
  };
}

function checkedAtOrder(limits: ServerProviderUsageLimits): number {
  return dateMillis(limits.checkedAt) ?? -Infinity;
}

function hasAccountMetadata(limits: ServerProviderUsageLimits): boolean {
  return Boolean(
    limits.serviceNotice ||
    limits.subscriptionExpiresAt ||
    limits.balances?.length ||
    limits.resetCredits?.availableCount ||
    limits.planTier,
  );
}

function mergeCompatibleWindow(
  winner: ServerProviderUsageWindow,
  fallbacks: readonly ServerProviderUsageWindow[],
): ServerProviderUsageWindow {
  let resetsAt = winner.resetsAt;
  let windowDurationMins = winner.windowDurationMins;
  let limitAmount = winner.limitAmount;
  let unit = winner.unit;
  let category = winner.category;
  let scopeLabel = winner.scopeLabel;
  let usedAmount = winner.usedAmount;
  let remainingAmount = winner.remainingAmount;
  for (const fallback of fallbacks) {
    // Reject cross-cadence matches (e.g. Codex reusing `primary` for 5-hour vs monthly plans).
    const durationCompatible =
      windowDurationMins === undefined ||
      fallback.windowDurationMins === undefined ||
      windowDurationMins === fallback.windowDurationMins;
    if (winner.kind !== fallback.kind || !durationCompatible) continue;

    if (resetsAt === undefined && fallback.resetsAt !== undefined) resetsAt = fallback.resetsAt;
    if (windowDurationMins === undefined && fallback.windowDurationMins !== undefined) {
      windowDurationMins = fallback.windowDurationMins;
    }

    const hasAmounts =
      usedAmount !== undefined || limitAmount !== undefined || remainingAmount !== undefined;
    // Never stitch a currency/unit onto unitless amounts from a separate incomplete report.
    const unitBundleCompatible =
      unit === fallback.unit || (unit === undefined && fallback.unit !== undefined && !hasAmounts);
    const limitCompatible =
      limitAmount === undefined ||
      fallback.limitAmount === undefined ||
      limitAmount === fallback.limitAmount;
    const scopeCompatible =
      scopeLabel === undefined ||
      fallback.scopeLabel === undefined ||
      scopeLabel === fallback.scopeLabel;
    const categoryCompatible =
      category === undefined || fallback.category === undefined || category === fallback.category;

    if (category === undefined && fallback.category !== undefined) category = fallback.category;
    if (scopeLabel === undefined && fallback.scopeLabel !== undefined) {
      scopeLabel = fallback.scopeLabel;
    }
    if (unitBundleCompatible && limitCompatible && scopeCompatible && categoryCompatible) {
      if (unit === undefined && fallback.unit !== undefined) unit = fallback.unit;
      if (limitAmount === undefined && fallback.limitAmount !== undefined) {
        limitAmount = fallback.limitAmount;
      }
      if (winner.usedPercent === fallback.usedPercent) {
        if (usedAmount === undefined && fallback.usedAmount !== undefined) {
          usedAmount = fallback.usedAmount;
        }
        if (remainingAmount === undefined && fallback.remainingAmount !== undefined) {
          remainingAmount = fallback.remainingAmount;
        }
      }
    }
  }
  return {
    ...winner,
    ...(resetsAt === undefined ? {} : { resetsAt }),
    ...(windowDurationMins === undefined ? {} : { windowDurationMins }),
    ...(limitAmount === undefined ? {} : { limitAmount }),
    ...(unit === undefined ? {} : { unit }),
    ...(category === undefined ? {} : { category }),
    ...(scopeLabel === undefined ? {} : { scopeLabel }),
    ...(usedAmount === undefined ? {} : { usedAmount }),
    ...(remainingAmount === undefined ? {} : { remainingAmount }),
  };
}

function mergeIdentityGroup(
  key: string,
  group: readonly AccountInput[],
  overrides: Readonly<Record<string, ManualSubscriptionOverride>> | undefined,
): AccountInput | null {
  const byFreshness = (a: AccountInput, b: AccountInput) =>
    checkedAtOrder(b.limits) - checkedAtOrder(a.limits);
  const readable = group.filter((entry) => !entry.limits.unavailable).sort(byFreshness);
  const windowed = readable.filter((entry) => entry.limits.windows.length > 0);
  const probeFailures = group
    .filter((entry) => entry.limits.unavailable?.reason === "probeFailed")
    .sort(byFreshness);
  const hasManualOverride = overrideFor(overrides, key) !== undefined;

  const primary =
    windowed[0] ??
    readable.find((entry) => hasAccountMetadata(entry.limits) || hasManualOverride) ??
    probeFailures[0] ??
    // Keep manual-only rows visible even when the account now reports unsupported so saved
    // renewals remain inspectable and clearable without making quota readable.
    (hasManualOverride ? [...group].sort(byFreshness)[0] : undefined);
  if (!primary) return null;

  const environments: {
    readonly environmentId: LimitAccount["environments"][number]["environmentId"];
    readonly label: string;
  }[] = [];
  const seenEnvironments = new Set<string>();
  for (const entry of group) {
    for (const environment of entry.environments) {
      if (seenEnvironments.has(environment.environmentId)) continue;
      seenEnvironments.add(environment.environmentId);
      environments.push(environment);
    }
  }

  let mergedLimits = primary.limits;
  if (!primary.limits.unavailable) {
    const subscriptionExpiresAt = readable.find(
      (entry) => entry.limits.subscriptionExpiresAt !== undefined,
    )?.limits.subscriptionExpiresAt;
    const planTier = readable.find((entry) => entry.limits.planTier !== undefined)?.limits.planTier;
    // Respect explicit balance clears (`[]`) from fresher routes; only fall back on omission.
    const balances = readable.find((entry) => entry.limits.balances !== undefined)?.limits.balances;
    const serviceNotice = readable.find((entry) => entry.limits.serviceNotice !== undefined)?.limits
      .serviceNotice;
    const resetCredits = readable.find((entry) => entry.limits.resetCredits !== undefined)?.limits
      .resetCredits;
    const credentialFingerprint = readable.find(
      (entry) => entry.limits.credentialFingerprint !== undefined,
    )?.limits.credentialFingerprint;
    const zeroSpendCap = readable.find((entry) => entry.limits.zeroSpendCap !== undefined)?.limits
      .zeroSpendCap;
    const externalUsage = readable.find((entry) => entry.limits.externalUsage !== undefined)?.limits
      .externalUsage;

    const otherWindowed = windowed.slice(1);
    const mergedWindows =
      otherWindowed.length === 0
        ? primary.limits.windows
        : primary.limits.windows.map((window) => {
            const matchingFallbacks: ServerProviderUsageWindow[] = [];
            for (const other of otherWindowed) {
              const candidate = other.limits.windows.find((item) => item.id === window.id);
              if (candidate) matchingFallbacks.push(candidate);
            }
            return matchingFallbacks.length === 0
              ? window
              : mergeCompatibleWindow(window, matchingFallbacks);
          });

    mergedLimits = {
      ...primary.limits,
      windows: mergedWindows,
      ...(subscriptionExpiresAt === undefined ? {} : { subscriptionExpiresAt }),
      ...(planTier === undefined ? {} : { planTier }),
      ...(balances === undefined ? {} : { balances }),
      ...(serviceNotice === undefined ? {} : { serviceNotice }),
      ...(resetCredits === undefined ? {} : { resetCredits }),
      ...(credentialFingerprint === undefined ? {} : { credentialFingerprint }),
      ...(zeroSpendCap === undefined ? {} : { zeroSpendCap }),
      ...(externalUsage === undefined ? {} : { externalUsage }),
    };
  }

  const hubRedeem = readable.find(
    (entry) => entry.redeem !== null && "sourceId" in entry.redeem.input,
  )?.redeem;
  const creditRedeem = readable.find(
    (entry) => entry.limits.resetCredits !== undefined && entry.redeem !== null,
  )?.redeem;
  const plan =
    readable.find((entry) => entry.plan !== undefined)?.plan ??
    group.find((entry) => entry.plan !== undefined)?.plan;

  return {
    ...primary,
    key,
    sourceKind: environments.length > 0 ? "native" : primary.sourceKind,
    displayName:
      primary.displayName ?? group.find((entry) => entry.displayName !== null)?.displayName ?? null,
    email: primary.email ?? group.find((entry) => entry.email !== undefined)?.email,
    plan,
    accentColor:
      primary.accentColor ?? group.find((entry) => entry.accentColor !== undefined)?.accentColor,
    environments,
    sourceLabel:
      environments.length > 0
        ? null
        : (primary.sourceLabel ??
          group.find((entry) => entry.sourceLabel !== null)?.sourceLabel ??
          null),
    redeem:
      hubRedeem ??
      creditRedeem ??
      primary.redeem ??
      group.find((entry) => entry.redeem !== null)?.redeem ??
      null,
    limits: mergedLimits,
  };
}

function collectAccountInputs(
  presentations: LimitPresentations,
  identityPresentations: LimitPresentations,
  overrides: Readonly<Record<string, ManualSubscriptionOverride>> | undefined,
  alerts: LimitAlertEntry[],
): readonly AccountInput[] {
  const resolveCanonicalKey = createCanonicalIdentityResolver(identityPresentations);
  const grouped = new Map<string, AccountInput[]>();
  const addToGroup = (key: string, input: AccountInput) => {
    const existing = grouped.get(key);
    if (existing) existing.push(input);
    else grouped.set(key, [input]);
  };
  const quotaAccounts: AccountInput[] = [];

  for (const [environmentId, presentation] of presentations) {
    const label = presentation.entry.target.label;
    for (const provider of providersWithLimits(presentation.serverConfig?.providers ?? [])) {
      if (!provider.usageLimits) continue;
      const key =
        resolveCanonicalKey(
          provider.driver,
          provider.auth.email,
          provider.auth.workspaceId,
          provider.usageLimits,
        ) ?? JSON.stringify(["native", environmentId, provider.instanceId]);
      addToGroup(key, {
        key,
        driver: provider.driver,
        sourceKind: "native",
        displayName: provider.displayName?.trim() || null,
        email: provider.auth.email,
        plan: provider.auth.label,
        accentColor: provider.accentColor,
        environments: [{ environmentId, label }],
        sourceLabel: null,
        redeem: provider.usageLimits.unavailable
          ? null
          : { environmentId, input: { instanceId: provider.instanceId } },
        limits: provider.usageLimits,
      });
    }
    for (const source of presentation.serverConfig?.usageLimitSources ?? []) {
      const sourceLabel = presentations.size > 1 ? `${label} · ${source.label}` : source.label;
      if (source.error) {
        alerts.push({
          key: JSON.stringify(["source-error", environmentId, source.id]),
          severity: "warning",
          kind: "probe-failed",
          sourceLabel,
          message: source.error,
        });
      }
      for (const account of source.accounts) {
        const creditId = account.usageLimits.resetCredits?.nextCreditId;
        const key =
          resolveCanonicalKey(
            account.driver,
            account.email,
            account.workspaceId,
            account.usageLimits,
          ) ??
          JSON.stringify([
            source.kind,
            source.kind === "cliproxy" ? hubKey(environmentId, source) : [environmentId, source.id],
            account.id,
            account.workspaceId ?? null,
          ]);
        addToGroup(key, {
          key,
          driver: account.driver,
          sourceKind: source.kind,
          displayName:
            source.kind === "cliproxy" && !account.email
              ? account.id.replace(/\.json$/i, "")
              : null,
          email: account.email,
          plan: account.plan,
          accentColor: undefined,
          environments: [],
          sourceLabel,
          redeem:
            source.kind === "cliproxy" && creditId && !account.usageLimits.unavailable
              ? { environmentId, input: { sourceId: source.id, accountId: account.id, creditId } }
              : null,
          limits: account.usageLimits,
        });
      }
      for (const account of source.quotaAccounts ?? []) {
        const { providerInstanceId } = account;
        const key = JSON.stringify([source.kind, environmentId, source.id, account.id]);
        quotaAccounts.push({
          key,
          sourceKind: source.kind,
          driver: null,
          ...(providerInstanceId === undefined ? {} : { providerInstanceId }),
          displayName: account.label,
          email: undefined,
          plan: undefined,
          accentColor: undefined,
          environments: [],
          sourceLabel,
          redeem: null,
          limits: {
            checkedAt: source.checkedAt,
            windows: account.windows,
            planTier: account.planTier,
            subscriptionExpiresAt: account.subscriptionExpiresAt,
            balances: account.balances,
            serviceNotice: account.serviceNotice,
          },
        });
      }
    }
  }

  const results: AccountInput[] = [];
  for (const [key, group] of grouped) {
    const merged = mergeIdentityGroup(key, group, overrides);
    if (merged) results.push(merged);
  }
  const seenQuotaAccounts = new Set<string>();
  for (const account of quotaAccounts) {
    if (seenQuotaAccounts.has(account.key)) continue;
    seenQuotaAccounts.add(account.key);
    results.push(account);
  }
  return results;
}

function resetGroup(resetsInMs: number | null): ResetTimelineGroup {
  if (resetsInMs === null) return "unscheduled";
  if (resetsInMs <= DAY) return "next24h";
  if (resetsInMs <= 7 * DAY) return "next7d";
  return "later";
}

function windowAlert(
  account: NormalizedLimitAccount,
  window: NormalizedLimitWindow,
  threshold: number,
): LimitAlertEntry | null {
  if (window.resetsInMs === 0) return null;
  const { usedPercent, remainingPercent, pace } = window;
  let kind: LimitAlertKind;
  let severity: LimitAlertSeverity;
  if (usedPercent >= 100) {
    kind = "window-exhausted";
    severity = "critical";
  } else if (pace?.status === "will-exhaust") {
    kind = "burn-exhaustion";
    severity = remainingPercent <= 15 ? "critical" : "warning";
  } else if (remainingPercent <= 10 || usedPercent >= threshold) {
    kind = "window-low";
    severity = remainingPercent <= 10 ? "critical" : "warning";
  } else {
    return null;
  }
  return {
    key: JSON.stringify([account.key, "window", window.id]),
    kind,
    severity,
    account,
    window,
  };
}

function appendAccountExpiries(
  expiries: ExpiryItem[],
  accountsWithoutExpiry: NormalizedLimitAccount[],
  account: NormalizedLimitAccount,
) {
  const { key, limits, manualOverride } = account;
  const reportedExpiry = dateMillis(limits.subscriptionExpiresAt);
  const expiry = reportedExpiry ?? dateMillis(manualOverride?.expiresAt);
  if (expiry === null) accountsWithoutExpiry.push(account);
  else
    expiries.push({
      key: JSON.stringify([key, "subscription"]),
      kind: "subscription",
      source: reportedExpiry === null ? "manual" : "provider",
      label: account.plan,
      expiresAtMs: expiry,
      account,
    });

  const credits = limits.resetCredits;
  if (credits && credits.availableCount > 0) {
    const nextExpiry = dateMillis(credits.nextExpiresAt);
    let nextExpiryShown = false;
    for (const option of credits.options ?? []) {
      const expiresAtMs = dateMillis(option.expiresAt);
      if (option.availableCount <= 0 || expiresAtMs === null) continue;
      nextExpiryShown ||= expiresAtMs === nextExpiry;
      expiries.push({
        key: JSON.stringify([key, "reset-credit", option.creditId]),
        kind: "reset-credit",
        source: "provider",
        label: option.label,
        expiresAtMs,
        account,
      });
    }
    if (!nextExpiryShown && nextExpiry !== null)
      expiries.push({
        key: JSON.stringify([key, "reset-credit"]),
        kind: "reset-credit",
        source: "provider",
        label: undefined,
        expiresAtMs: nextExpiry,
        account,
      });
  }
  for (const balance of limits.balances ?? []) {
    const expiresAtMs = dateMillis(balance.expiresAt);
    if (expiresAtMs === null) continue;
    expiries.push({
      key: JSON.stringify([key, "balance", balance.id]),
      kind: "balance",
      source: "provider",
      label: balance.label,
      expiresAtMs,
      account,
      balance,
    });
  }
}

const EXPIRY_ALERT_KIND: Record<ExpiryItemKind, LimitAlertKind> = {
  subscription: "subscription-expiring",
  "reset-credit": "credit-expiring",
  balance: "balance-expiring",
};
const SEVERITY_RANK: Record<LimitAlertSeverity, number> = { critical: 0, warning: 1, info: 2 };

export function collectLimitsIntelligence(input: {
  readonly presentations: LimitPresentations;
  readonly identityPresentations?: LimitPresentations;
  readonly now: number;
  readonly alertThresholdPercent?: number;
  readonly manualOverrides?: Readonly<Record<string, ManualSubscriptionOverride>>;
}): LimitsIntelligenceSnapshot {
  const { now, presentations, identityPresentations, manualOverrides, alertThresholdPercent } =
    input;
  const threshold =
    alertThresholdPercent !== undefined && Number.isFinite(alertThresholdPercent)
      ? Math.max(50, Math.min(95, alertThresholdPercent))
      : 80;
  const alerts: LimitAlertEntry[] = [];
  const accounts = collectAccountInputs(
    presentations,
    identityPresentations ?? presentations,
    manualOverrides,
    alerts,
  ).map((account) => normalizeAccount(account, now, overrideFor(manualOverrides, account.key)));
  const resets: ResetTimelineEntry[] = [];
  const expiries: ExpiryItem[] = [];
  const accountsWithoutExpiry: NormalizedLimitAccount[] = [];
  const monthlySpend = new Map<string, number>();

  for (const account of accounts) {
    for (const window of account.windows) {
      resets.push({
        account,
        window,
        group: resetGroup(window.resetsInMs),
        resetsInMs: window.resetsInMs,
      });
      const alert = windowAlert(account, window, threshold);
      if (alert) alerts.push(alert);
    }
    const unavailable = account.limits.unavailable;
    if (unavailable?.reason === "probeFailed") {
      alerts.push({
        key: JSON.stringify([account.key, "probe-failed"]),
        kind: "probe-failed",
        severity: "warning",
        account,
        ...(unavailable.message === undefined ? {} : { message: unavailable.message }),
      });
    }
    const notice = account.limits.serviceNotice;
    if (notice)
      alerts.push({
        key: JSON.stringify([account.key, "service-notice"]),
        kind: "service-notice",
        severity: notice.severity ?? "info",
        message: notice.message,
        account,
      });
    appendAccountExpiries(expiries, accountsWithoutExpiry, account);
    const { monthlyCost, currency } = account.manualOverride ?? {};
    if (
      monthlyCost !== undefined &&
      Number.isFinite(monthlyCost) &&
      monthlyCost > 0 &&
      currency &&
      /^[A-Z]{3}$/.test(currency)
    ) {
      monthlySpend.set(currency, (monthlySpend.get(currency) ?? 0) + monthlyCost);
    }
  }

  for (const expiry of expiries) {
    const remaining = expiry.expiresAtMs - now;
    if (remaining > 7 * DAY || (remaining < 0 && expiry.kind !== "subscription")) continue;
    alerts.push({
      key: expiry.key,
      kind: EXPIRY_ALERT_KIND[expiry.kind],
      severity: remaining <= 2 * DAY ? "critical" : "warning",
      account: expiry.account,
      expiry,
    });
  }
  resets.sort((a, b) => (a.window.resetsAtMs ?? Infinity) - (b.window.resetsAtMs ?? Infinity));
  alerts.sort(
    (a, b) =>
      SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] ||
      (a.window?.remainingPercent ?? Infinity) - (b.window?.remainingPercent ?? Infinity) ||
      (a.expiry?.expiresAtMs ?? Infinity) - (b.expiry?.expiresAtMs ?? Infinity),
  );
  expiries.sort((a, b) => a.expiresAtMs - b.expiresAtMs);
  const alertCounts = { critical: 0, warning: 0, info: 0 };
  for (const alert of alerts) alertCounts[alert.severity]++;
  return {
    accounts,
    resets,
    alerts,
    expiries,
    accountsWithoutExpiry,
    monthlySpendByCurrency: Object.fromEntries(monthlySpend),
    summary: {
      accountCount: accounts.length,
      windowCount: resets.length,
      criticalAlertCount: alertCounts.critical,
      warningAlertCount: alertCounts.warning,
      infoAlertCount: alertCounts.info,
    },
  };
}
