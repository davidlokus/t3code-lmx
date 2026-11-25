import { UsageProviderKind } from "@t3tools/contracts";
import type { ManualSubscriptionOverride } from "@t3tools/shared/usageLimitsIntelligence";
import * as DateTime from "effect/DateTime";
import * as Schema from "effect/Schema";
import { create, type StoreApi, type UseBoundStore } from "zustand";

export const USAGE_UI_OPTIONS_STORAGE_KEY = "t3lab:usage-ui:v1";

export type UsageDashboardView = "overview" | "limits";
export type UsageChartMode = "stacked-bar" | "line";
const UsagePeriodPresetSchema = Schema.Literals(["today", "24h", "7d", "mtd", "30d", "90d"]);
export type UsagePeriodPreset = typeof UsagePeriodPresetSchema.Type;
export type UsageBudgetScope = "all" | "reportedOnly";
export type UsageLimitsLens = "pools" | "resets" | "alerts" | "expiries";
export type UsageLimitsLayout = "pool" | "matrix";
export type UsageQuotaDisplayMode = "remaining" | "used";
export type UsageResetTimeMode = "countdown" | "exact";

export interface UsageUiOptions {
  readonly view: UsageDashboardView;
  readonly metric: "cost" | "tokens";
  readonly period: UsagePeriodPreset;
  readonly chartMode: UsageChartMode;
  readonly showQuotaStrip: boolean;
  readonly showShareBars: boolean;
  readonly showComparison: boolean;
  readonly showBudget: boolean;
  readonly dailyBudgetUsd: number | null;
  readonly monthlyBudgetUsd: number | null;
  readonly budgetScope: UsageBudgetScope;
  readonly hiddenProviders: readonly UsageProviderKind[];
  readonly limitsLens: UsageLimitsLens;
  readonly limitsLayout: UsageLimitsLayout;
  readonly quotaDisplayMode: UsageQuotaDisplayMode;
  readonly resetTimeMode: UsageResetTimeMode;
  readonly alertThresholdPercent: number;
  readonly manualSubscriptionOverrides: Readonly<Record<string, ManualSubscriptionOverride>>;
}

export interface UsageOptionsStoreState extends UsageUiOptions {
  setView: (view: UsageDashboardView) => void;
  setMetric: (metric: "cost" | "tokens") => void;
  setPeriod: (period: UsagePeriodPreset) => void;
  setChartMode: (mode: UsageChartMode) => void;
  toggleOption: (key: "showQuotaStrip" | "showShareBars" | "showComparison" | "showBudget") => void;
  setBudget: (patch: {
    readonly dailyBudgetUsd?: number | null;
    readonly monthlyBudgetUsd?: number | null;
    readonly budgetScope?: UsageBudgetScope;
  }) => void;
  setHiddenProviders: (providers: readonly UsageProviderKind[]) => void;
  setLimitsLens: (lens: UsageLimitsLens) => void;
  setLimitsLayout: (layout: UsageLimitsLayout) => void;
  setQuotaDisplayMode: (mode: UsageQuotaDisplayMode) => void;
  setResetTimeMode: (mode: UsageResetTimeMode) => void;
  setAlertThresholdPercent: (percent: number) => void;
  setManualSubscriptionOverride: (accountKey: string, override: ManualSubscriptionOverride) => void;
  clearManualSubscriptionOverride: (accountKey: string) => void;
  resetUsageUiOptions: () => void;
}

const LEGACY_STORAGE_KEY = "t3code:usage-page-preferences:v1";
const DEFAULT_OPTIONS: UsageUiOptions = {
  view: "overview",
  metric: "cost",
  period: "30d",
  chartMode: "stacked-bar",
  showQuotaStrip: true,
  showShareBars: true,
  showComparison: true,
  showBudget: true,
  dailyBudgetUsd: null,
  monthlyBudgetUsd: null,
  budgetScope: "all",
  hiddenProviders: [],
  limitsLens: "pools",
  limitsLayout: "pool",
  quotaDisplayMode: "remaining",
  resetTimeMode: "countdown",
  alertThresholdPercent: 80,
  manualSubscriptionOverrides: {},
};
const isProvider = Schema.is(UsageProviderKind);
const isPeriod = Schema.is(UsagePeriodPresetSchema);

function isOptionsObject(raw: unknown): raw is Record<string, unknown> {
  return typeof raw === "object" && raw !== null && !Array.isArray(raw);
}

function budgetUsd(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : null;
}

const RENEWAL_DATE_PATTERN =
  /^\d{4}-\d{2}-\d{2}(?:T(?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d(?:\.\d+)?)?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d))?$/;

function trimmedOption(value: unknown): string | undefined {
  return typeof value === "string" ? value.trim() || undefined : undefined;
}

function renewalDate(value: unknown): string | undefined {
  const date = trimmedOption(value);
  if (!date || !RENEWAL_DATE_PATTERN.test(date) || !Number.isFinite(Date.parse(date))) {
    return undefined;
  }
  const day = date.slice(0, 10);
  const dayMs = Date.parse(day);
  return Number.isFinite(dayMs) && DateTime.formatIsoDate(DateTime.makeUnsafe(dayMs)) === day
    ? date
    : undefined;
}

function alertThreshold(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 50 && value <= 95
    ? value
    : DEFAULT_OPTIONS.alertThresholdPercent;
}

function parseManualOverride(raw: unknown): ManualSubscriptionOverride | undefined {
  if (!isOptionsObject(raw)) return undefined;
  const expiresAt = renewalDate(raw.expiresAt);
  const monthlyCost =
    typeof raw.monthlyCost === "number" && Number.isFinite(raw.monthlyCost) && raw.monthlyCost >= 0
      ? raw.monthlyCost
      : undefined;
  const currency = trimmedOption(raw.currency)?.toUpperCase();
  const planLabel = trimmedOption(raw.planLabel);
  const notes = trimmedOption(raw.notes);
  if (
    expiresAt === undefined &&
    monthlyCost === undefined &&
    planLabel === undefined &&
    notes === undefined
  ) {
    return undefined;
  }
  return {
    ...(expiresAt === undefined ? {} : { expiresAt }),
    ...(monthlyCost === undefined ? {} : { monthlyCost }),
    ...(currency !== undefined && /^[A-Z]{3}$/.test(currency) ? { currency } : {}),
    ...(planLabel === undefined ? {} : { planLabel }),
    ...(notes === undefined ? {} : { notes }),
  };
}

function isOverrideKey(key: string): boolean {
  return key.length > 0 && key.trim() === key && !Object.hasOwn(Object.prototype, key);
}

function parseManualOverrides(raw: unknown): Readonly<Record<string, ManualSubscriptionOverride>> {
  if (!isOptionsObject(raw)) return DEFAULT_OPTIONS.manualSubscriptionOverrides;
  const entries: [string, ManualSubscriptionOverride][] = [];
  for (const [key, value] of Object.entries(raw)) {
    if (!isOverrideKey(key)) continue;
    const override = parseManualOverride(value);
    if (override) entries.push([key, override]);
  }
  return Object.fromEntries(entries);
}

export function parseUsageUiOptions(raw: unknown): UsageUiOptions {
  if (!isOptionsObject(raw)) return DEFAULT_OPTIONS;
  return {
    view: raw.view === "limits" ? "limits" : "overview",
    metric: raw.metric === "tokens" ? "tokens" : "cost",
    period: isPeriod(raw.period) ? raw.period : DEFAULT_OPTIONS.period,
    chartMode: raw.chartMode === "line" ? "line" : "stacked-bar",
    showQuotaStrip: raw.showQuotaStrip !== false,
    showShareBars: raw.showShareBars !== false,
    showComparison: raw.showComparison !== false,
    showBudget: raw.showBudget !== false,
    dailyBudgetUsd: budgetUsd(raw.dailyBudgetUsd),
    monthlyBudgetUsd: budgetUsd(raw.monthlyBudgetUsd),
    budgetScope: raw.budgetScope === "reportedOnly" ? "reportedOnly" : "all",
    hiddenProviders: Array.isArray(raw.hiddenProviders)
      ? [...new Set(raw.hiddenProviders.filter(isProvider))]
      : DEFAULT_OPTIONS.hiddenProviders,
    limitsLens:
      raw.limitsLens === "resets" || raw.limitsLens === "alerts" || raw.limitsLens === "expiries"
        ? raw.limitsLens
        : DEFAULT_OPTIONS.limitsLens,
    limitsLayout: raw.limitsLayout === "matrix" ? "matrix" : DEFAULT_OPTIONS.limitsLayout,
    quotaDisplayMode: raw.quotaDisplayMode === "used" ? "used" : DEFAULT_OPTIONS.quotaDisplayMode,
    resetTimeMode: raw.resetTimeMode === "exact" ? "exact" : DEFAULT_OPTIONS.resetTimeMode,
    alertThresholdPercent: alertThreshold(raw.alertThresholdPercent),
    manualSubscriptionOverrides: parseManualOverrides(raw.manualSubscriptionOverrides),
  };
}

export function readPersistedUsageUiOptions(
  storage?: Pick<Storage, "getItem"> | null,
): UsageUiOptions {
  try {
    const target =
      storage === undefined && typeof window !== "undefined" ? window.localStorage : storage;
    const raw = target?.getItem(USAGE_UI_OPTIONS_STORAGE_KEY);
    if (raw != null) return parseUsageUiOptions(JSON.parse(raw));
    const legacy = target?.getItem(LEGACY_STORAGE_KEY);
    const parsed: unknown = legacy == null ? null : JSON.parse(legacy);
    return isOptionsObject(parsed)
      ? parseUsageUiOptions({ hiddenProviders: parsed.hiddenProviders })
      : DEFAULT_OPTIONS;
  } catch {
    return DEFAULT_OPTIONS;
  }
}

export function isDefaultUsageUiOptions(options: UsageUiOptions): boolean {
  return (
    options.view === DEFAULT_OPTIONS.view &&
    options.metric === DEFAULT_OPTIONS.metric &&
    options.period === DEFAULT_OPTIONS.period &&
    options.chartMode === DEFAULT_OPTIONS.chartMode &&
    options.showQuotaStrip === DEFAULT_OPTIONS.showQuotaStrip &&
    options.showShareBars === DEFAULT_OPTIONS.showShareBars &&
    options.showComparison === DEFAULT_OPTIONS.showComparison &&
    options.showBudget === DEFAULT_OPTIONS.showBudget &&
    options.dailyBudgetUsd === null &&
    options.monthlyBudgetUsd === null &&
    options.budgetScope === DEFAULT_OPTIONS.budgetScope &&
    options.hiddenProviders.length === 0 &&
    options.limitsLens === DEFAULT_OPTIONS.limitsLens &&
    options.limitsLayout === DEFAULT_OPTIONS.limitsLayout &&
    options.quotaDisplayMode === DEFAULT_OPTIONS.quotaDisplayMode &&
    options.resetTimeMode === DEFAULT_OPTIONS.resetTimeMode &&
    options.alertThresholdPercent === DEFAULT_OPTIONS.alertThresholdPercent
  );
}

export const useUsageOptionsStore: UseBoundStore<StoreApi<UsageOptionsStoreState>> =
  create<UsageOptionsStoreState>((set, get) => {
    const setAndPersist = (patch: Partial<UsageUiOptions>) => {
      set(patch);
      try {
        if (typeof window !== "undefined") {
          window.localStorage.setItem(
            USAGE_UI_OPTIONS_STORAGE_KEY,
            JSON.stringify(parseUsageUiOptions(get())),
          );
        }
      } catch {
        // Keep the in-memory settings when storage is disabled or full.
      }
    };

    return {
      ...readPersistedUsageUiOptions(),
      setView: (view) => setAndPersist({ view }),
      setMetric: (metric) => setAndPersist({ metric }),
      setPeriod: (period) => setAndPersist({ period }),
      setChartMode: (chartMode) => setAndPersist({ chartMode }),
      toggleOption: (key) => setAndPersist({ [key]: !get()[key] }),
      setBudget: ({ dailyBudgetUsd, monthlyBudgetUsd, budgetScope }) =>
        setAndPersist({
          ...(dailyBudgetUsd === undefined ? {} : { dailyBudgetUsd: budgetUsd(dailyBudgetUsd) }),
          ...(monthlyBudgetUsd === undefined
            ? {}
            : { monthlyBudgetUsd: budgetUsd(monthlyBudgetUsd) }),
          ...(budgetScope === undefined ? {} : { budgetScope }),
        }),
      setHiddenProviders: (providers) =>
        setAndPersist({ hiddenProviders: [...new Set(providers)] }),
      setLimitsLens: (limitsLens) => setAndPersist({ limitsLens }),
      setLimitsLayout: (limitsLayout) => setAndPersist({ limitsLayout }),
      setQuotaDisplayMode: (quotaDisplayMode) => setAndPersist({ quotaDisplayMode }),
      setResetTimeMode: (resetTimeMode) => setAndPersist({ resetTimeMode }),
      setAlertThresholdPercent: (percent) =>
        setAndPersist({ alertThresholdPercent: alertThreshold(percent) }),
      setManualSubscriptionOverride: (accountKey, value) => {
        if (!isOverrideKey(accountKey)) return;
        const override = parseManualOverride(value);
        if (!override) return;
        setAndPersist({
          manualSubscriptionOverrides: {
            ...get().manualSubscriptionOverrides,
            [accountKey]: override,
          },
        });
      },
      clearManualSubscriptionOverride: (accountKey) => {
        const current = get().manualSubscriptionOverrides;
        if (!Object.hasOwn(current, accountKey)) return;
        const manualSubscriptionOverrides = { ...current };
        delete manualSubscriptionOverrides[accountKey];
        setAndPersist({ manualSubscriptionOverrides });
      },
      // Keep user-recorded manual renewals when resetting view/display/budget preferences.
      resetUsageUiOptions: () =>
        setAndPersist({
          ...DEFAULT_OPTIONS,
          manualSubscriptionOverrides: get().manualSubscriptionOverrides,
        }),
    };
  });
