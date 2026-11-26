import type { ServerProviderUsageBalance } from "@t3tools/contracts";
import type {
  NormalizedLimitAccount,
  NormalizedLimitWindow,
} from "@t3tools/shared/usageLimitsIntelligence";

import { providerClients } from "~/components/settings/providerDriverMeta";
import { quotaRiskTone, type UsageRiskTone } from "./usageDashboard.logic";
import type { UsageQuotaDisplayMode } from "./usageOptionsStore";

export type AccountRiskTier = 0 | 1 | 2 | 3;

export interface AccountHeaderMeta {
  readonly displayLabel: string;
  readonly planBadge: string | null;
  readonly sourceBadgeKind: NormalizedLimitAccount["sourceKind"] | null;
  readonly whereText: string | null;
}

export interface PlatformPoolWindowMember {
  readonly account: NormalizedLimitAccount;
  readonly window: NormalizedLimitWindow;
}

export interface PlatformPoolWindowSummary {
  readonly key: string;
  readonly label: string;
  readonly kind: NormalizedLimitWindow["kind"];
  readonly remainingPercent: number;
  readonly usedPercent: number;
  readonly tone: UsageRiskTone;
  readonly hasFastBurn: boolean;
  readonly isExhausted: boolean;
  readonly soonestResetWindow: NormalizedLimitWindow | null;
  readonly nextRefillPercent: number | null;
  readonly nextRefillAtMs: number | null;
  readonly members: readonly PlatformPoolWindowMember[];
}

export interface PlatformPoolGroup {
  readonly key: string;
  readonly label: string;
  readonly driver: NormalizedLimitAccount["driver"];
  readonly sourceKind: NormalizedLimitAccount["sourceKind"];
  readonly accentColor: string | undefined;
  readonly plans: readonly string[];
  readonly accounts: readonly NormalizedLimitAccount[];
  readonly windows: readonly PlatformPoolWindowSummary[];
  readonly balances: readonly {
    readonly account: NormalizedLimitAccount;
    readonly balance: ServerProviderUsageBalance;
  }[];
  readonly totalResetCredits: number;
  readonly riskTier: AccountRiskTier;
  readonly hasNoticeOrError: boolean;
}

function normalizeCompareToken(value: string | null | undefined): string {
  if (!value) return "";
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fff]+/gu, " ")
    .trim();
}

export function accountDisplayLabel(account: NormalizedLimitAccount): string {
  if (account.displayName) return account.displayName;
  if (account.driver) return providerClients.get(account.driver)?.label ?? String(account.driver);
  return account.sourceLabel ?? account.key;
}

export function effectiveWindowTone(
  window: Pick<NormalizedLimitWindow, "remainingPercent" | "pace">,
): UsageRiskTone {
  const remaining = Math.round(Math.max(0, Math.min(100, window.remainingPercent)));
  if (window.pace?.status === "exhausted" || remaining <= 10) return "error";
  if (window.pace?.status === "will-exhaust") return remaining <= 15 ? "error" : "warning";
  if (window.pace?.status === "ahead") return "warning";
  return quotaRiskTone(remaining);
}

/**
 * Restrained palette: calm neutral fill for healthy accounts; semantic amber/red reserved for risk.
 */
export function restrainedBarClass(tone: UsageRiskTone): string {
  switch (tone) {
    case "error":
      return "bg-error";
    case "warning":
      return "bg-warning";
    case "normal":
      return "bg-foreground/35";
  }
}

export function restrainedTextClass(tone: UsageRiskTone): string {
  switch (tone) {
    case "error":
      return "text-error-foreground";
    case "warning":
      return "text-warning-foreground";
    case "normal":
      return "text-foreground";
  }
}

export function restrainedCardSurfaceClass(tier: AccountRiskTier): string {
  switch (tier) {
    case 3:
      return "border-error/45 bg-card/75";
    case 2:
      return "border-warning/35 bg-card/70";
    case 1:
    case 0:
      return "border-border/55 bg-card/45";
  }
}

export function accountRiskTier(account: NormalizedLimitAccount): AccountRiskTier {
  if (
    account.limits.unavailable?.reason === "probeFailed" ||
    account.limits.serviceNotice?.severity === "critical"
  ) {
    return 3;
  }
  let tier: AccountRiskTier = account.limits.serviceNotice?.severity === "warning" ? 2 : 0;
  for (const window of account.windows) {
    const tone = effectiveWindowTone(window);
    if (tone === "error") return 3;
    if (tone === "warning") tier = 2;
    else if (window.usedPercent > 0 && tier < 1) tier = 1;
  }
  return tier;
}

export function isAccountAtRisk(account: NormalizedLimitAccount): boolean {
  return accountRiskTier(account) >= 2;
}

function accountMinRemaining(account: NormalizedLimitAccount): number {
  if (account.windows.length === 0) return 101;
  let min = 100;
  for (const window of account.windows) {
    min = Math.min(min, Math.max(0, Math.min(100, window.remainingPercent)));
  }
  return min;
}

function accountSoonestResetMs(account: NormalizedLimitAccount): number {
  let soonest = Number.POSITIVE_INFINITY;
  for (const window of account.windows) {
    if (window.resetsAtMs !== null && window.resetsAtMs < soonest) {
      soonest = window.resetsAtMs;
    }
  }
  return soonest;
}

export function sortAccountsByRisk(
  accounts: readonly NormalizedLimitAccount[],
): readonly NormalizedLimitAccount[] {
  return [...accounts].sort((left, right) => {
    const tierDiff = accountRiskTier(right) - accountRiskTier(left);
    if (tierDiff !== 0) return tierDiff;
    const remainingDiff = accountMinRemaining(left) - accountMinRemaining(right);
    if (remainingDiff !== 0) return remainingDiff;
    const leftReset = accountSoonestResetMs(left);
    const rightReset = accountSoonestResetMs(right);
    if (leftReset !== rightReset) return leftReset < rightReset ? -1 : 1;
    return 0;
  });
}

function hasWholeTokenPhrase(haystackToken: string, needleToken: string): boolean {
  if (!haystackToken || !needleToken) return false;
  return ` ${haystackToken} `.includes(` ${needleToken} `);
}

function sourceKindCanonicalToken(sourceKind: NormalizedLimitAccount["sourceKind"]): string {
  switch (sourceKind) {
    case "native":
      return "";
    case "omp":
      return "omp";
    case "http":
      return "http";
    case "kimi":
      return "kimi";
    case "zai":
      return "zai";
    case "openrouter":
      return "openrouter";
    case "copilot":
      return "copilot";
    case "ollama":
      return "ollama";
    case "openaiApi":
      return "openai api";
    case "claudeSwap":
      return "claude swap";
    case "cliproxy":
      return "cliproxy";
  }
}

export function resolveAccountHeaderMeta(
  account: NormalizedLimitAccount,
  localizedSourceBadge?: string | null,
): AccountHeaderMeta {
  const displayLabel = accountDisplayLabel(account);
  const displayToken = normalizeCompareToken(displayLabel);

  const rawPlan = account.plan?.trim() || null;
  const planToken = normalizeCompareToken(rawPlan);
  const planBadge = rawPlan && planToken !== displayToken ? rawPlan : null;

  const rawWhere =
    account.environments.length > 0
      ? account.environments.map((environment) => environment.label).join(", ")
      : account.sourceLabel?.trim() || null;
  const whereToken = normalizeCompareToken(rawWhere);
  const whereText = rawWhere && whereToken !== displayToken ? rawWhere : null;

  let sourceBadgeKind: NormalizedLimitAccount["sourceKind"] | null =
    account.sourceKind === "native" || account.sourceKind === "cliproxy"
      ? null
      : account.sourceKind;

  if (sourceBadgeKind !== null) {
    const badgeToken = normalizeCompareToken(localizedSourceBadge);
    const kindToken = sourceKindCanonicalToken(sourceBadgeKind);
    const coveredByTitle =
      hasWholeTokenPhrase(displayToken, badgeToken) ||
      (kindToken.length > 0 && displayToken === kindToken);
    const coveredByWhere =
      whereText !== null &&
      (hasWholeTokenPhrase(whereToken, badgeToken) || hasWholeTokenPhrase(whereToken, kindToken));
    if (coveredByTitle || coveredByWhere) {
      sourceBadgeKind = null;
    }
  }

  return {
    displayLabel,
    planBadge,
    sourceBadgeKind,
    whereText,
  };
}

export function dedupeWindowScopeLabel(
  scopeLabel: string | undefined,
  context: {
    readonly displayLabel: string;
    readonly plan?: string | undefined;
    readonly windowLabel: string;
  },
): string | null {
  const trimmed = scopeLabel?.trim();
  if (!trimmed) return null;
  const token = normalizeCompareToken(trimmed);
  if (!token) return null;
  if (
    token === normalizeCompareToken(context.plan) ||
    token === normalizeCompareToken(context.displayLabel) ||
    token === normalizeCompareToken(context.windowLabel)
  ) {
    return null;
  }
  return trimmed;
}

function formatAmountWithUnit(amount: number, unit: string, locale: string): string {
  const trimmed = unit.trim();
  if (/^[A-Z]{3}$/.test(trimmed)) {
    try {
      return new Intl.NumberFormat(locale, {
        style: "currency",
        currency: trimmed,
        maximumFractionDigits: 2,
      }).format(amount);
    } catch {
      return `${amount.toFixed(2)} ${trimmed}`;
    }
  }
  const formatted = new Intl.NumberFormat(locale, { maximumFractionDigits: 2 }).format(amount);
  return trimmed ? `${formatted} ${trimmed}` : formatted;
}

export function formatWindowAmounts(
  window: NormalizedLimitWindow,
  quotaDisplayMode: UsageQuotaDisplayMode,
  locale: string,
): string | null {
  if (!window.unit) return null;
  if (window.usedAmount !== undefined && window.limitAmount !== undefined) {
    const shown =
      quotaDisplayMode === "used"
        ? window.usedAmount
        : (window.remainingAmount ?? Math.max(0, window.limitAmount - window.usedAmount));
    return `${formatAmountWithUnit(shown, window.unit, locale)} / ${formatAmountWithUnit(window.limitAmount, window.unit, locale)}`;
  }
  if (quotaDisplayMode === "remaining" && window.remainingAmount !== undefined) {
    return formatAmountWithUnit(window.remainingAmount, window.unit, locale);
  }
  if (quotaDisplayMode === "used" && window.usedAmount !== undefined) {
    return formatAmountWithUnit(window.usedAmount, window.unit, locale);
  }
  return null;
}

export function formatBalanceAmount(balance: ServerProviderUsageBalance, locale: string): string {
  const remaining = formatAmountWithUnit(balance.remaining, balance.unit, locale);
  if (balance.limit !== undefined) {
    return `${remaining} / ${formatAmountWithUnit(balance.limit, balance.unit, locale)}`;
  }
  return remaining;
}

function platformGroupIdentity(
  account: NormalizedLimitAccount,
  sourceLabels: Readonly<Partial<Record<NormalizedLimitAccount["sourceKind"], string | undefined>>>,
): { readonly key: string; readonly label: string } {
  if (account.driver !== null) {
    return {
      key: `driver:${account.driver}`,
      label: providerClients.get(account.driver)?.label ?? String(account.driver),
    };
  }
  if (account.sourceKind === "http") {
    const label = account.sourceLabel?.trim() || accountDisplayLabel(account);
    return { key: `http:${normalizeCompareToken(label) || account.key}`, label };
  }
  const kindLabel =
    sourceLabels[account.sourceKind] ?? account.sourceLabel?.trim() ?? accountDisplayLabel(account);
  return { key: `source:${account.sourceKind}`, label: kindLabel };
}

export function groupAccountsByPlatformPool(
  accounts: readonly NormalizedLimitAccount[],
  now: number,
  sourceLabels: Readonly<
    Partial<Record<NormalizedLimitAccount["sourceKind"], string | undefined>>
  > = {},
): readonly PlatformPoolGroup[] {
  const bucketOrder: string[] = [];
  const buckets = new Map<
    string,
    {
      label: string;
      driver: NormalizedLimitAccount["driver"];
      sourceKind: NormalizedLimitAccount["sourceKind"];
      accentColor: string | undefined;
      accounts: NormalizedLimitAccount[];
    }
  >();

  for (const account of accounts) {
    const identity = platformGroupIdentity(account, sourceLabels);
    const existing = buckets.get(identity.key);
    if (existing) {
      existing.accounts.push(account);
      if (!existing.accentColor && account.accentColor) {
        existing.accentColor = account.accentColor;
      }
    } else {
      bucketOrder.push(identity.key);
      buckets.set(identity.key, {
        label: identity.label,
        driver: account.driver,
        sourceKind: account.sourceKind,
        accentColor: account.accentColor,
        accounts: [account],
      });
    }
  }

  return bucketOrder.map((groupKey) => {
    const bucket = buckets.get(groupKey)!;
    const plans: string[] = [];
    const seenPlans = new Set<string>();
    const groupLabelToken = normalizeCompareToken(bucket.label);
    let totalResetCredits = 0;
    let riskTier: AccountRiskTier = 0;
    let hasNoticeOrError = false;
    const balances: { account: NormalizedLimitAccount; balance: ServerProviderUsageBalance }[] = [];

    const windowOrder: string[] = [];
    const windowBuckets = new Map<
      string,
      { label: string; kind: NormalizedLimitWindow["kind"]; members: PlatformPoolWindowMember[] }
    >();

    for (const account of bucket.accounts) {
      const tier = accountRiskTier(account);
      if (tier > riskTier) riskTier = tier;
      if (account.limits.serviceNotice || account.limits.unavailable?.reason === "probeFailed") {
        hasNoticeOrError = true;
      }
      totalResetCredits += account.limits.resetCredits?.availableCount ?? 0;

      const plan = account.plan?.trim();
      const planToken = normalizeCompareToken(plan);
      if (plan && planToken && planToken !== groupLabelToken && !seenPlans.has(planToken)) {
        seenPlans.add(planToken);
        plans.push(plan);
      }

      for (const balance of account.limits.balances ?? []) {
        balances.push({ account, balance });
      }

      for (const window of account.windows) {
        const winKey = `${window.kind}:${window.id}`;
        const existingWin = windowBuckets.get(winKey);
        if (existingWin) {
          existingWin.members.push({ account, window });
        } else {
          windowOrder.push(winKey);
          windowBuckets.set(winKey, {
            label: window.label,
            kind: window.kind,
            members: [{ account, window }],
          });
        }
      }
    }

    const windows: PlatformPoolWindowSummary[] = windowOrder.map((winKey) => {
      const winBucket = windowBuckets.get(winKey)!;
      const count = winBucket.members.length;
      const totalRemaining = winBucket.members.reduce(
        (sum, member) => sum + Math.max(0, Math.min(100, member.window.remainingPercent)),
        0,
      );
      const remainingPercent = Math.round(totalRemaining / count);
      const usedPercent = Math.max(0, Math.min(100, 100 - remainingPercent));

      let hasFastBurn = false;
      let isExhausted = false;
      let soonestFuture: NormalizedLimitWindow | null = null;
      let soonestRefillWindow: NormalizedLimitWindow | null = null;
      let firstWithReset: NormalizedLimitWindow | null = null;

      for (const { window } of winBucket.members) {
        if (window.pace?.status === "will-exhaust") hasFastBurn = true;
        if (window.pace?.status === "exhausted" || window.remainingPercent <= 0) {
          isExhausted = true;
        }
        if (window.resetsAt && !firstWithReset) firstWithReset = window;
        if (window.resetsAtMs !== null && window.resetsAtMs > now) {
          if (
            soonestFuture === null ||
            (soonestFuture.resetsAtMs !== null && window.resetsAtMs < soonestFuture.resetsAtMs)
          ) {
            soonestFuture = window;
          }
          if (
            window.usedPercent > 0 &&
            (soonestRefillWindow === null ||
              (soonestRefillWindow.resetsAtMs !== null &&
                window.resetsAtMs < soonestRefillWindow.resetsAtMs))
          ) {
            soonestRefillWindow = window;
          }
        }
      }

      const soonestResetWindow = soonestRefillWindow ?? soonestFuture ?? firstWithReset;
      const nextRefillPercent =
        count > 1 && soonestRefillWindow
          ? Math.round(Math.max(0, Math.min(100, soonestRefillWindow.usedPercent)) / count)
          : null;
      const nextRefillAtMs =
        nextRefillPercent !== null && nextRefillPercent > 0
          ? (soonestRefillWindow?.resetsAtMs ?? null)
          : null;

      const baseTone = quotaRiskTone(remainingPercent);
      const tone: UsageRiskTone =
        baseTone === "error" || (isExhausted && remainingPercent <= 10)
          ? "error"
          : baseTone === "warning" || hasFastBurn
            ? "warning"
            : "normal";

      return {
        key: winKey,
        label: winBucket.label,
        kind: winBucket.kind,
        remainingPercent,
        usedPercent,
        tone,
        hasFastBurn,
        isExhausted,
        soonestResetWindow,
        nextRefillPercent: nextRefillPercent && nextRefillPercent > 0 ? nextRefillPercent : null,
        nextRefillAtMs,
        members: winBucket.members,
      };
    });

    return {
      key: groupKey,
      label: bucket.label,
      driver: bucket.driver,
      sourceKind: bucket.sourceKind,
      accentColor: bucket.accentColor,
      plans,
      accounts: bucket.accounts,
      windows,
      balances,
      totalResetCredits,
      riskTier,
      hasNoticeOrError,
    };
  });
}
