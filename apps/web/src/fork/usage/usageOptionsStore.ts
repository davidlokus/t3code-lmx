import { UsageProviderKind } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { create, type StoreApi, type UseBoundStore } from "zustand";

export const USAGE_UI_OPTIONS_STORAGE_KEY = "t3lab:usage-ui:v1";

export type UsageDashboardView = "overview" | "limits";
export type UsageChartMode = "stacked-bar" | "line";
const UsagePeriodPresetSchema = Schema.Literals(["today", "24h", "7d", "mtd", "30d", "90d"]);
export type UsagePeriodPreset = typeof UsagePeriodPresetSchema.Type;
export type UsageBudgetScope = "all" | "reportedOnly";

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
};
const isProvider = Schema.is(UsageProviderKind);
const isPeriod = Schema.is(UsagePeriodPresetSchema);

function isOptionsObject(raw: unknown): raw is Record<string, unknown> {
  return typeof raw === "object" && raw !== null && !Array.isArray(raw);
}

function budgetUsd(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : null;
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
    options.hiddenProviders.length === 0
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
      resetUsageUiOptions: () => setAndPersist(DEFAULT_OPTIONS),
    };
  });
