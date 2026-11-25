import type { Dialog as DialogPrimitive } from "@base-ui/react/dialog";
import { useAtomValue } from "@effect/atom-react";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { settlePromise } from "@t3tools/client-runtime/state/runtime";
import { refreshUsageLimits } from "@t3tools/client-runtime/state/usage";
import { usageLoadingState } from "@t3tools/client-runtime/state/usage-progress";
import {
  type EnvironmentId,
  type ServerProvider,
  type ThreadId,
  type UsageProjectFilter,
  type UsageProviderKind,
  type UsageSummaryInput,
} from "@t3tools/contracts";
import {
  enumerateDays,
  enumerateHourStarts,
  formatCount,
  formatDateTimeShort,
  formatDayShort,
  formatHourShort,
  formatPercent,
  formatTokens,
  formatUsd,
} from "@t3tools/shared/usageFormat";
import { formatUsageContractMismatch, usageSourceMessages } from "@t3tools/shared/usageFormatCopy";
import { usesChatGptSharing, type LimitPresentations } from "@t3tools/shared/usageLimits";
import type { MergedSessionTotals, MergedUsage } from "@t3tools/shared/usageMerge";
import { useNavigate } from "@tanstack/react-router";
import * as Cause from "effect/Cause";
import { Atom } from "effect/reactivity";
import * as AsyncResult from "effect/reactivity/AsyncResult";
import { T, useGT, useLocale, useMessages } from "gt-react";
import { useEffect, useEffectEvent, useRef, useState } from "react";

import { isCommandPaletteOpen } from "~/commandPaletteBus";
import { AppRouteModal } from "~/components/AppRouteModal";
import { ProviderInstanceIcon } from "~/components/chat/ProviderInstanceIcon";
import { ChatGptUsageButton } from "~/components/settings/ChatGptUsageButton";
import { Button } from "~/components/ui/button";
import { ScrollArea } from "~/components/ui/scroll-area";
import { Skeleton } from "~/components/ui/skeleton";
import { UsageModelDialog } from "~/components/usage/UsageModelDialog";
import { UsagePriceOverrides } from "~/components/usage/UsagePriceOverrides";
import {
  readUsagePagePreferences,
  saveUsagePagePreferences,
  type UsagePagePreferences,
} from "~/components/usage/usagePagePreferences";
import {
  PROVIDER_ORDER,
  PROVIDER_PRESENTATION,
  providersWithUsage,
  rankProvidersByMetric,
} from "~/components/usage/usageProviders";
import {
  METRIC_OPTIONS,
  resolveUsageShortcut,
  WINDOW_OPTIONS,
} from "~/components/usage/usageShortcuts";
import { usePrimarySettings } from "~/hooks/useSettings";
import { cn } from "~/lib/utils";
import { isModelPickerOpen } from "~/modelPickerVisibility";
import { appAtomRegistry } from "~/rpc/atomRegistry";
import { environmentPresentations } from "~/state/presentation";
import { primaryServerKeybindingsAtom, serverEnvironment } from "~/state/server";
import { useAtomCommand } from "~/state/use-atom-command";
import { filterUsageEnvironmentsForScope, useUsage, useUsageComparison } from "~/state/usage";
import { buildThreadRouteParams } from "~/threadRoutes";
import { resolveHour12 } from "~/timestampFormat";
import { UsageBreakdownSection, type UsageBreakdownTab } from "./UsageBreakdownSection";
import { UsageBudgetDialog } from "./UsageBudgetDialog";
import {
  buildUsageWindowPair,
  computeUsageDelta,
  computeUsageStreak,
  deriveSoftBudgetStatus,
  deriveUsageKpis,
  serializeUsageExportCsv,
  serializeUsageExportJson,
  type UsageExportBoundsNote,
} from "./usageDashboard.logic";
import { UsageKpiCards } from "./UsageKpiCards";
import { UsageLimitsEnhanced } from "./UsageLimitsEnhanced";
import { type UsagePeriodPreset, useUsageOptionsStore } from "./usageOptionsStore";
import { UsageQuotaStrip } from "./UsageQuotaStrip";
import { UsageSessionDialog } from "./UsageSessionDialog";
import { UsageShareBars } from "./UsageShareBars";
import { UsageTopbar } from "./UsageTopbar";
import { UsageTrendChart } from "./UsageTrendChart";

/** Keep dialog selection outside UsageDashboard so opening/closing rerenders only its host. */
const selectedUsageModelKeyAtom = Atom.make<string | null>(null).pipe(
  Atom.keepAlive,
  Atom.withLabel("fork-usage:selected-model-key"),
);

function selectUsageModel(key: string | null): void {
  appAtomRegistry.set(selectedUsageModelKeyAtom, key);
}

function triggerFileDownload(filename: string, contents: string, mimeType: string): void {
  const blob = new Blob([contents], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}

function sameEnvironmentIdSet(
  left: ReadonlySet<EnvironmentId>,
  right: ReadonlySet<EnvironmentId>,
): boolean {
  if (left.size !== right.size) return false;
  for (const id of left) {
    if (!right.has(id)) return false;
  }
  return true;
}

function sameAnchorPinMap(
  left: ReadonlyMap<EnvironmentId, number>,
  right: ReadonlyMap<EnvironmentId, number>,
): boolean {
  if (left.size !== right.size) return false;
  for (const [id, anchor] of left) {
    if (right.get(id) !== anchor) return false;
  }
  return true;
}

function sameProviderList(
  left: readonly UsageProviderKind[] | undefined,
  right: readonly UsageProviderKind[] | undefined,
): boolean {
  if (left === right) return true;
  if (left === undefined || right === undefined || left.length !== right.length) return false;
  return left.every((value, index) => value === right[index]);
}

function isSameUsageWindow(left: UsageSummaryInput, right: UsageSummaryInput): boolean {
  return (
    left.sinceDay === right.sinceDay &&
    left.untilDay === right.untilDay &&
    left.timeZone === right.timeZone &&
    left.resolution === right.resolution &&
    left.sinceTime === right.sinceTime &&
    left.untilTime === right.untilTime &&
    left.projectFilter?.projectKey === right.projectFilter?.projectKey &&
    sameProviderList(left.providers, right.providers)
  );
}

function toLegacyWindowDays(period: UsagePeriodPreset): UsagePagePreferences["windowDays"] {
  switch (period) {
    case "today":
    case "24h":
      return 1;
    case "7d":
      return 7;
    case "mtd":
    case "30d":
      return 30;
    case "90d":
      return 90;
  }
}

function usageLoading(
  showingKept: boolean,
  selectedEnvironments: Parameters<typeof usageLoadingState>[0],
  refreshingUsage: boolean,
  hiddenProviders: ReadonlySet<UsageProviderKind>,
) {
  if (showingKept) {
    return { partial: true, everyProvider: true, providers: new Set<UsageProviderKind>() };
  }
  const state = usageLoadingState(selectedEnvironments, refreshingUsage);
  const providers = new Set([...state.providers].filter((p) => !hiddenProviders.has(p)));
  return {
    partial: state.everyProvider || providers.size > 0,
    everyProvider: state.everyProvider,
    providers,
  };
}

function UsageModelDialogHost({
  models,
  projects,
  onSetPrice,
  ...dialogProps
}: Omit<Parameters<typeof UsageModelDialog>[0], "model" | "onSetPrice" | "onClose"> & {
  readonly models: MergedUsage["models"];
  readonly onSetPrice: (model: string) => void;
}) {
  const selectedKey = useAtomValue(selectedUsageModelKeyAtom);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- clears the shared selected-model atom on unmount
  useEffect(() => () => selectUsageModel(null), []);
  const model =
    selectedKey === null
      ? undefined
      : models.find((candidate) => `${candidate.provider}:${candidate.model}` === selectedKey);
  if (model === undefined) return null;
  return (
    <UsageModelDialog
      {...dialogProps}
      model={model}
      projects={projects}
      onSetPrice={() => {
        selectUsageModel(null);
        onSetPrice(model.model);
      }}
      onClose={() => selectUsageModel(null)}
    />
  );
}

function filterPresentationsForLimits(
  presentations: LimitPresentations,
  selectedEnvironmentIds: ReadonlySet<EnvironmentId> | null,
  hiddenProviders: ReadonlySet<UsageProviderKind>,
): LimitPresentations {
  const hiddenDrivers = new Set<ServerProvider["driver"]>(
    [...hiddenProviders].map((provider) => PROVIDER_PRESENTATION[provider].driverKind),
  );
  const isVisible = (driver: ServerProvider["driver"]) => !hiddenDrivers.has(driver);
  return new Map(
    [...presentations].flatMap(([id, presentation]) => {
      if (selectedEnvironmentIds !== null && !selectedEnvironmentIds.has(id)) return [];
      const config = presentation.serverConfig;
      if (hiddenDrivers.size === 0 || config === null) return [[id, presentation] as const];
      const driverByInstanceId = new Map(
        config.providers.map((provider) => [provider.instanceId, provider.driver] as const),
      );
      return [
        [
          id,
          {
            ...presentation,
            serverConfig: {
              ...config,
              providers: config.providers.filter((provider) => isVisible(provider.driver)),
              usageLimitSources: config.usageLimitSources?.flatMap((source) => {
                const accounts = source.accounts.filter((account) => isVisible(account.driver));
                const quotaAccounts = source.quotaAccounts?.filter((account) => {
                  if (account.providerInstanceId === undefined) return true;
                  const boundDriver = driverByInstanceId.get(account.providerInstanceId);
                  return boundDriver === undefined || isVisible(boundDriver);
                });
                const droppedAllCliAccounts = source.accounts.length > 0 && accounts.length === 0;
                const droppedAllHttpAccounts =
                  (source.quotaAccounts?.length ?? 0) > 0 && (quotaAccounts?.length ?? 0) === 0;
                if (
                  (droppedAllCliAccounts && (quotaAccounts?.length ?? 0) === 0) ||
                  (droppedAllHttpAccounts && accounts.length === 0)
                ) {
                  return [];
                }
                return [
                  {
                    ...source,
                    accounts,
                    ...(quotaAccounts === undefined ? {} : { quotaAccounts }),
                  },
                ];
              }),
            },
          },
        ] as const,
      ];
    }),
  );
}

function createFreshUsageWindow(
  period: UsagePeriodPreset,
  projectFilter: UsageProjectFilter | null,
  visibleProviders: readonly UsageProviderKind[] | undefined,
  legacyCompatible: boolean,
): { readonly now: Date; readonly input: UsageSummaryInput } {
  const now = new Date();
  const pair = buildUsageWindowPair(period, now, undefined, { legacyCompatible });
  return {
    now,
    input: {
      ...pair.current,
      ...(projectFilter === null ? {} : { projectFilter }),
      ...(visibleProviders === undefined ? {} : { providers: visibleProviders }),
    },
  };
}

export function UsageDashboard() {
  const gt = useGT();
  const locale = useLocale();
  const m = useMessages();
  const navigate = useNavigate();

  const view = useUsageOptionsStore((state) => state.view);
  const metric = useUsageOptionsStore((state) => state.metric);
  const period = useUsageOptionsStore((state) => state.period);
  const chartMode = useUsageOptionsStore((state) => state.chartMode);
  const showQuotaStrip = useUsageOptionsStore((state) => state.showQuotaStrip);
  const showShareBars = useUsageOptionsStore((state) => state.showShareBars);
  const showComparison = useUsageOptionsStore((state) => state.showComparison);
  const showBudget = useUsageOptionsStore((state) => state.showBudget);
  const dailyBudgetUsd = useUsageOptionsStore((state) => state.dailyBudgetUsd);
  const monthlyBudgetUsd = useUsageOptionsStore((state) => state.monthlyBudgetUsd);
  const budgetScope = useUsageOptionsStore((state) => state.budgetScope);
  const persistedHiddenProviders = useUsageOptionsStore((state) => state.hiddenProviders);
  const setView = useUsageOptionsStore((state) => state.setView);
  const setMetric = useUsageOptionsStore((state) => state.setMetric);
  const setPeriod = useUsageOptionsStore((state) => state.setPeriod);
  const setChartMode = useUsageOptionsStore((state) => state.setChartMode);
  const setHiddenProviders = useUsageOptionsStore((state) => state.setHiddenProviders);

  const keybindings = useAtomValue(primaryServerKeybindingsAtom);
  const hour12 = usePrimarySettings((settings) => resolveHour12(settings.timestampFormat));
  const presentations = useAtomValue(environmentPresentations.presentationsAtom);
  const presentationsWithProviders = useAtomValue(
    environmentPresentations.presentationsWithProvidersAtom,
  );
  const refreshProviders = useAtomCommand(serverEnvironment.refreshProviders, {
    reportFailure: false,
  });

  const [windowAnchorNow, setWindowAnchorNow] = useState(() => new Date());
  const [limitsNow, setLimitsNow] = useState(() => Date.now());
  const [isRefreshing, setIsRefreshing] = useState(false);
  const refreshingRef = useRef(false);
  const modalActionsRef = useRef<DialogPrimitive.Root.Actions | null>(null);
  const [priceDialog, setPriceDialog] = useState<{ readonly model?: string } | null>(null);
  const [budgetDialogOpen, setBudgetDialogOpen] = useState(false);
  const [inspectedSession, setInspectedSession] = useState<MergedSessionTotals | null>(null);
  const [selectedEnvironmentIds, setSelectedEnvironmentIds] =
    useState<ReadonlySet<EnvironmentId> | null>(null);
  const [soloProvider, setSoloProvider] = useState<UsageProviderKind | null>(null);
  const [projectSelection, setProjectSelection] = useState<{
    readonly projectKey: string;
    readonly label: string;
    readonly unattributed?: true;
  } | null>(null);
  const [lockedPeriod, setLockedPeriod] = useState<string | null>(null);
  const [breakdownTab, setBreakdownTab] = useState<UsageBreakdownTab>("model");

  const projectFilter: UsageProjectFilter | null =
    projectSelection === null ? null : { projectKey: projectSelection.projectKey };
  const showingLimits = view === "limits";
  const effectiveHiddenProviders = new Set<UsageProviderKind>(
    soloProvider !== null
      ? PROVIDER_ORDER.filter((provider) => provider !== soloProvider)
      : persistedHiddenProviders,
  );

  const [knownLegacyEnvIds, setKnownLegacyEnvIds] = useState<ReadonlySet<EnvironmentId>>(
    () => new Set(),
  );
  // Pin <=24h fallback per rejecting environment for the current anchor only so same-anchor cache cannot oscillate while Refresh on a new anchor can re-probe.
  const [clippedFallbackByEnv, setClippedFallbackByEnv] = useState<
    ReadonlyMap<EnvironmentId, number>
  >(() => new Map());
  const anchorMs = windowAnchorNow.getTime();
  const isSelectedEnvironment = (id: EnvironmentId) =>
    selectedEnvironmentIds === null || selectedEnvironmentIds.has(id);
  const selectedHasKnownLegacy =
    presentations.size === 0
      ? [...knownLegacyEnvIds].some(isSelectedEnvironment)
      : [...presentations.keys()].some(
          (id) => isSelectedEnvironment(id) && knownLegacyEnvIds.has(id),
        );
  const selectedPinnedForAnchor =
    presentations.size === 0
      ? [...clippedFallbackByEnv.entries()].some(
          ([id, pinnedAnchor]) => pinnedAnchor === anchorMs && isSelectedEnvironment(id),
        )
      : [...presentations.keys()].some(
          (id) => isSelectedEnvironment(id) && clippedFallbackByEnv.get(id) === anchorMs,
        );
  const useLegacyCompatibleToday =
    projectFilter === null && (selectedPinnedForAnchor || selectedHasKnownLegacy);
  const visibleProviders =
    effectiveHiddenProviders.size === 0
      ? undefined
      : PROVIDER_ORDER.filter((provider) => !effectiveHiddenProviders.has(provider)).sort();

  const windowPair = buildUsageWindowPair(period, windowAnchorNow, undefined, {
    legacyCompatible: useLegacyCompatibleToday,
  });
  const currentInput: UsageSummaryInput = {
    ...windowPair.current,
    ...(projectFilter === null ? {} : { projectFilter }),
    ...(visibleProviders === undefined ? {} : { providers: visibleProviders }),
  };

  const {
    merged: answeredUsage,
    environments,
    selectedEnvironments,
    excludedLegacyEnvironments,
    answeredEnvironmentIds,
    hasEligibleAnswer,
    eligibleHasLegacyServer,
    detectedLegacyEnvironmentIds,
    isStaleScope,
    isPending,
    shown,
    isPartial,
    refresh,
  } = useUsage(currentInput, selectedEnvironmentIds, effectiveHiddenProviders);

  const nextPinnedByEnv = new Map(clippedFallbackByEnv);
  for (const env of environments) {
    if (env.rejectedOversizedHourlyWindow === true) {
      nextPinnedByEnv.set(env.environmentId, anchorMs);
    }
  }
  if (!sameAnchorPinMap(nextPinnedByEnv, clippedFallbackByEnv)) {
    setClippedFallbackByEnv(nextPinnedByEnv);
  }

  const nextLegacyIds = new Set(knownLegacyEnvIds);
  for (const env of environments) {
    // Same-anchor oscillation is prevented by clippedFallbackByEnv, so a fresh modern response can clear future-anchor legacy status immediately.
    const isFreshModern =
      env.error === null &&
      env.rejectedOversizedHourlyWindow !== true &&
      (env.hasFreshModernSummary === true ||
        (env.hasFreshModernSummary === undefined &&
          env.summary !== null &&
          (env.summary.projects !== undefined || env.summary.topSessions !== undefined)));
    if (isFreshModern) {
      nextLegacyIds.delete(env.environmentId);
    }
  }
  for (const id of detectedLegacyEnvironmentIds) {
    nextLegacyIds.add(id);
  }
  if (!sameEnvironmentIdSet(nextLegacyIds, knownLegacyEnvIds)) {
    setKnownLegacyEnvIds(nextLegacyIds);
  }

  const todayClippedForLegacy = period === "today" && windowPair.currentClipped;
  const previousClippedForLegacy = period === "today" && windowPair.previousClipped;
  const mtdCoarseForLegacy = period === "mtd" && eligibleHasLegacyServer;
  const scopeMatchesCurrent =
    hasEligibleAnswer &&
    shown !== null &&
    !isStaleScope &&
    !isPending &&
    isSameUsageWindow(shown.window, currentInput);
  // Pre-dashboard servers ignore exact MTD cutoffs and cap hourly queries at 24h, so suppress unaligned comparisons.
  const canCompare =
    !showingLimits &&
    showComparison &&
    scopeMatchesCurrent &&
    !mtdCoarseForLegacy &&
    !todayClippedForLegacy &&
    !previousClippedForLegacy;
  const comparisonInput: UsageSummaryInput | null = canCompare
    ? {
        ...windowPair.previous,
        ...(projectFilter === null ? {} : { projectFilter }),
        ...(visibleProviders === undefined ? {} : { providers: visibleProviders }),
      }
    : null;
  const comparison = useUsageComparison(
    comparisonInput,
    selectedEnvironmentIds,
    effectiveHiddenProviders,
    answeredEnvironmentIds,
  );

  const merged = shown?.merged ?? answeredUsage;
  const shownWindow = shown?.window ?? currentInput;
  const shownHourly = shownWindow.resolution === "hour";
  const refreshingUsage = isRefreshing && !showingLimits;
  const showingKept = isStaleScope;
  const canReadDiagnostics = selectedEnvironments.some(
    (environment) => environment.canReadDiagnostics,
  );
  const connectedEnvironmentIds = new Set(
    selectedEnvironments
      .filter((environment) => environment.isConnected)
      .map((environment) => environment.environmentId),
  );

  const mirrorLegacyPreferences = (next: {
    readonly view: "overview" | "limits";
    readonly metric: "cost" | "tokens";
    readonly period: UsagePeriodPreset;
    readonly hiddenProviders: readonly UsageProviderKind[];
  }) => {
    const previous = readUsagePagePreferences();
    saveUsagePagePreferences({
      ...previous,
      metric: next.view === "limits" ? "limits" : next.metric,
      windowDays: toLegacyWindowDays(next.period),
      hiddenProviders: next.hiddenProviders,
    });
  };

  const handleViewChange = (nextView: "overview" | "limits") => {
    if (nextView === "limits") setLimitsNow(Date.now());
    setView(nextView);
    mirrorLegacyPreferences({
      view: nextView,
      metric,
      period,
      hiddenProviders: persistedHiddenProviders,
    });
  };

  const handleMetricChange = (nextMetric: "cost" | "tokens") => {
    setMetric(nextMetric);
    mirrorLegacyPreferences({
      view,
      metric: nextMetric,
      period,
      hiddenProviders: persistedHiddenProviders,
    });
  };

  const handlePeriodChange = (nextPeriod: UsagePeriodPreset) => {
    setLockedPeriod(null);
    setWindowAnchorNow(new Date());
    setPeriod(nextPeriod);
    mirrorLegacyPreferences({
      view,
      metric,
      period: nextPeriod,
      hiddenProviders: persistedHiddenProviders,
    });
  };

  const handleHiddenProvidersChange = (nextHidden: readonly UsageProviderKind[]) => {
    setSoloProvider(null);
    setHiddenProviders(nextHidden);
    mirrorLegacyPreferences({
      view,
      metric,
      period,
      hiddenProviders: nextHidden,
    });
  };

  const refreshLimits = (automatic = false) =>
    settlePromise(() =>
      Promise.all(
        Array.from(presentations, ([environmentId, presentation]) => {
          if (selectedEnvironmentIds !== null && !selectedEnvironmentIds.has(environmentId)) return;
          if (presentation.connection.phase === "connected" && presentation.serverConfig !== null) {
            return refreshUsageLimits(
              environmentId,
              () => refreshProviders({ environmentId, input: {} }),
              automatic,
            );
          }
        }),
      ),
    ).then((result) => {
      setLimitsNow(Date.now());
      if (!AsyncResult.isSuccess(result)) throw Cause.squash(result.cause);
    });

  const onUsageKeyDown = useEffectEvent((event: KeyboardEvent) => {
    if (
      event.defaultPrevented ||
      event.repeat ||
      event.isComposing ||
      isCommandPaletteOpen() ||
      isModelPickerOpen()
    ) {
      return;
    }
    const command = resolveUsageShortcut(event, keybindings);
    if (command === "usage.open") {
      event.preventDefault();
      event.stopPropagation();
      modalActionsRef.current?.close();
      return;
    }
    const metricOption = METRIC_OPTIONS.find((option) => option.command === command);
    const periodOption = WINDOW_OPTIONS.find((option) => option.command === command);
    if (!metricOption && !periodOption) return;

    event.preventDefault();
    event.stopPropagation();
    if (metricOption) {
      if (metricOption.value === "limits") {
        handleViewChange("limits");
      } else {
        handleViewChange("overview");
        handleMetricChange(metricOption.value);
      }
    }
    if (periodOption && !showingLimits) {
      const mapped: UsagePeriodPreset =
        periodOption.days === 1
          ? "24h"
          : periodOption.days === 7
            ? "7d"
            : periodOption.days === 30
              ? "30d"
              : "90d";
      handlePeriodChange(mapped);
    }
  });

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- window capture keydown listener for usage shortcuts
  useEffect(() => {
    globalThis.window.addEventListener("keydown", onUsageKeyDown, true);
    return () => globalThis.window.removeEventListener("keydown", onUsageKeyDown, true);
  }, []);

  const connectedLimitsEnvironments = [...presentations]
    .filter(
      ([environmentId, presentation]) =>
        presentation.connection.phase === "connected" &&
        presentation.serverConfig !== null &&
        (selectedEnvironmentIds === null || selectedEnvironmentIds.has(environmentId)),
    )
    .map(([environmentId]) => environmentId)
    .sort()
    .join(",");

  const autoRefreshLimits = useEffectEvent(() => {
    void refreshLimits(true);
  });

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- refreshes provider limits when Limits view or Quota Strip mounts with connected environments
  useEffect(() => {
    if ((showingLimits || showQuotaStrip) && connectedLimitsEnvironments) {
      autoRefreshLimits();
    }
  }, [showingLimits, showQuotaStrip, connectedLimitsEnvironments]);

  const handleRefresh = () => {
    if (refreshingRef.current) return;
    if (showingLimits) {
      refreshingRef.current = true;
      setIsRefreshing(true);
      void refreshLimits().finally(() => {
        refreshingRef.current = false;
        setIsRefreshing(false);
      });
      return;
    }
    // Refresh starts a new anchor, so drop same-anchor pins and consult only still-known legacy hosts.
    const { now: nextNow, input: nextInput } = createFreshUsageWindow(
      period,
      projectFilter,
      visibleProviders,
      projectFilter === null && selectedHasKnownLegacy,
    );
    setWindowAnchorNow(nextNow);
    refreshingRef.current = true;
    setIsRefreshing(true);
    void refresh(nextInput).finally(() => {
      refreshingRef.current = false;
      setIsRefreshing(false);
    });
  };

  const days = enumerateDays(shownWindow.sinceDay, shownWindow.untilDay);
  const hours =
    shownWindow.sinceTime === undefined || shownWindow.untilTime === undefined
      ? []
      : enumerateHourStarts(shownWindow.sinceTime, shownWindow.untilTime);

  const windowLabel =
    shownHourly && shownWindow.sinceTime !== undefined && shownWindow.untilTime !== undefined
      ? gt("{start} to {end}", {
          start: formatDateTimeShort(shownWindow.sinceTime, shownWindow.timeZone, hour12, locale),
          end: formatDateTimeShort(shownWindow.untilTime, shownWindow.timeZone, hour12, locale),
        })
      : gt("{start} to {end}", {
          start: formatDayShort(shownWindow.sinceDay, locale),
          end: formatDayShort(shownWindow.untilDay, locale),
        });

  const lockedPeriodLabel =
    lockedPeriod === null
      ? null
      : shownHourly
        ? formatHourShort(lockedPeriod, shownWindow.timeZone, hour12, locale)
        : formatDayShort(lockedPeriod, locale);

  const activeProjectEntry =
    projectSelection === null
      ? null
      : (merged.projects.find((entry) => entry.projectKey === projectSelection.projectKey) ??
        projectSelection);

  const limitPresentations = filterPresentationsForLimits(
    presentationsWithProviders,
    selectedEnvironmentIds,
    effectiveHiddenProviders,
  );

  const showChatGptSharing =
    !effectiveHiddenProviders.has("codex") &&
    [...presentationsWithProviders].some(
      ([id, presentation]) =>
        (selectedEnvironmentIds === null || selectedEnvironmentIds.has(id)) &&
        (presentation.serverConfig?.providers ?? []).some(usesChatGptSharing),
    );

  const exportBoundsNote: UsageExportBoundsNote | undefined = mtdCoarseForLegacy
    ? "coarseCalendarDaysForLegacyServer"
    : todayClippedForLegacy
      ? "clipped24hForLegacyServer"
      : undefined;

  const resolveExportWindow = (): UsageSummaryInput => {
    if (!mtdCoarseForLegacy) return shownWindow;
    const { sinceTime: _sinceTime, untilTime: _untilTime, ...coarse } = shownWindow;
    return coarse;
  };

  const handleExportCsv = () => {
    if (!scopeMatchesCurrent) return;
    const csv = serializeUsageExportCsv({
      merged,
      window: resolveExportWindow(),
      breakdownTab,
      ...(exportBoundsNote === undefined ? {} : { boundsNote: exportBoundsNote }),
    });
    triggerFileDownload(`t3lab-usage-${period}-${breakdownTab}.csv`, csv, "text/csv;charset=utf-8");
  };

  const handleExportJson = () => {
    if (!scopeMatchesCurrent) return;
    const json = serializeUsageExportJson({
      merged,
      window: resolveExportWindow(),
      comparison: comparison.merged,
      ...(exportBoundsNote === undefined ? {} : { boundsNote: exportBoundsNote }),
    });
    triggerFileDownload(`t3lab-usage-${period}.json`, json, "application/json;charset=utf-8");
  };

  const handleOpenThread = (environmentId: EnvironmentId, threadId: string) => {
    void navigate({
      to: "/$environmentId/$threadId",
      params: buildThreadRouteParams(scopeThreadRef(environmentId, threadId as ThreadId)),
    });
  };

  const loading = usageLoading(
    showingKept,
    selectedEnvironments,
    refreshingUsage,
    effectiveHiddenProviders,
  );
  const loadingPartial = loading.partial === true;
  const loadingProviders = new Set(
    PROVIDER_ORDER.filter((provider) => loading.everyProvider || loading.providers.has(provider)),
  );
  const providersWithData = new Set(providersWithUsage(merged.providers));
  const activeProviders = [...PROVIDER_ORDER].filter(
    (provider) => providersWithData.has(provider) || loading.providers.has(provider),
  );
  const chartLoadingProviders = new Set(
    activeProviders.filter((provider) => loadingProviders.has(provider)),
  );
  const rankedProviders = rankProvidersByMetric(activeProviders, merged.providers, metric);

  const kpis = deriveUsageKpis(merged, shownHourly ? "hour" : "day");
  const streak = shownHourly
    ? null
    : computeUsageStreak(merged.daily, shownWindow.untilDay, shownWindow.sinceDay);
  const primaryDelta =
    canCompare && comparison.merged !== null
      ? computeUsageDelta(
          metric === "cost" ? merged.costUsd : merged.totalTokens,
          metric === "cost" ? comparison.merged.costUsd : comparison.merged.totalTokens,
        )
      : null;
  const budgetStatus =
    scopeMatchesCurrent && !todayClippedForLegacy
      ? deriveSoftBudgetStatus({
          preset: period,
          totalCostUsd: merged.costUsd,
          reportedCostUsd: merged.providerReportedCostUsd,
          dailyBudgetUsd,
          monthlyBudgetUsd,
          budgetScope,
          showBudget,
        })
      : null;

  const sourceMessages = usageSourceMessages(
    selectedEnvironments.flatMap(
      (environment) =>
        environment.summary?.sources.filter(
          (source) => !effectiveHiddenProviders.has(source.fingerprint.provider),
        ) ?? [],
    ),
    m,
  );

  const modelDialogEnvironments = filterUsageEnvironmentsForScope(
    selectedEnvironments,
    effectiveHiddenProviders,
    projectFilter,
  ).eligible;

  return (
    <AppRouteModal label={gt("Usage")} actionsRef={modalActionsRef}>
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <UsageTopbar
          view={view}
          onViewChange={handleViewChange}
          metric={metric}
          onMetricChange={handleMetricChange}
          period={period}
          onPeriodChange={handlePeriodChange}
          windowLabel={windowLabel}
          environments={environments}
          selectedEnvironments={selectedEnvironments}
          selectedEnvironmentIds={selectedEnvironmentIds}
          onEnvironmentSelectionChange={setSelectedEnvironmentIds}
          hiddenProviders={effectiveHiddenProviders}
          onHiddenProvidersChange={handleHiddenProvidersChange}
          soloProvider={soloProvider}
          onClearSoloProvider={() => setSoloProvider(null)}
          projectFilter={projectFilter}
          projectFilterLabel={
            activeProjectEntry?.unattributed
              ? gt("Unattributed")
              : (activeProjectEntry?.label ?? null)
          }
          onClearProjectFilter={() => setProjectSelection(null)}
          lockedPeriodLabel={lockedPeriodLabel}
          onClearLockedPeriod={() => setLockedPeriod(null)}
          isRefreshing={isRefreshing}
          refreshingUsage={refreshingUsage}
          isPartial={isPartial}
          canReadDiagnostics={canReadDiagnostics}
          duplicateSources={merged.duplicateSources}
          contractMismatches={merged.contractMismatches}
          onRefresh={handleRefresh}
          onOpenModelPrices={() => setPriceDialog({})}
          onExportCsv={handleExportCsv}
          onExportJson={handleExportJson}
          exportDisabled={!scopeMatchesCurrent}
          onOpenBudgetDialog={() => setBudgetDialogOpen(true)}
        />

        <ScrollArea className="min-h-0 flex-1" observeContent>
          <div className="mx-auto flex w-full max-w-none flex-col gap-5 px-5 pt-5 pb-12 sm:px-6">
            {selectedEnvironments.length === 0 ? (
              <p className="py-12 text-center text-sm text-muted-foreground">
                {environments.length === 0
                  ? showingLimits
                    ? gt("Connect an environment to see limits.")
                    : gt("Connect an environment to see usage.")
                  : showingLimits
                    ? gt("Select an environment to see limits.")
                    : gt("Select an environment to see usage.")}
              </p>
            ) : showingLimits ? (
              <UsageLimitsEnhanced
                presentations={limitPresentations}
                identityPresentations={presentationsWithProviders}
                selectedEnvironmentIds={selectedEnvironmentIds}
                hiddenProviders={effectiveHiddenProviders}
                refreshTickNow={limitsNow}
              />
            ) : (
              <div aria-busy={loadingPartial} className="flex flex-col gap-5">
                {/* Render live subscription quotas independently of transcript scanning or diagnostics access. */}
                {showQuotaStrip ? (
                  <UsageQuotaStrip
                    presentations={limitPresentations}
                    onOpenLimits={() => handleViewChange("limits")}
                  />
                ) : null}

                {shown === null && isPending ? (
                  <UsageDashboardSkeleton />
                ) : !canReadDiagnostics ? (
                  <div className="space-y-2 py-12 text-center text-sm text-muted-foreground">
                    {selectedEnvironments.map((environment) => (
                      <p key={environment.environmentId}>
                        {selectedEnvironments.length > 1
                          ? gt("{environment}: {error}", {
                              environment: environment.label,
                              error: environment.error,
                            })
                          : environment.error}
                      </p>
                    ))}
                  </div>
                ) : !hasEligibleAnswer && !isStaleScope ? (
                  <div
                    data-testid="usage-scope-unavailable"
                    className="flex flex-col items-center gap-3 rounded-xl border border-border/70 bg-card/65 px-5 py-10 text-center text-sm text-muted-foreground"
                  >
                    {excludedLegacyEnvironments.length > 0 ? (
                      <p
                        data-testid="usage-excluded-legacy-notice"
                        className="max-w-xl rounded-lg border border-warning/35 bg-warning/10 px-3 py-2 text-xs text-warning-foreground"
                      >
                        {gt(
                          "Project filter excludes environments on older servers: {environments}",
                          {
                            environments: excludedLegacyEnvironments
                              .map((env) => env.label)
                              .join(", "),
                          },
                        )}
                      </p>
                    ) : null}
                    {selectedEnvironments
                      .filter((environment) => environment.error !== null)
                      .map((environment) => (
                        <p key={environment.environmentId}>
                          {selectedEnvironments.length > 1
                            ? gt("{environment}: {error}", {
                                environment: environment.label,
                                error: environment.error,
                              })
                            : environment.error}
                        </p>
                      ))}
                    {merged.contractMismatches.map((mismatch) => {
                      const envLabel =
                        selectedEnvironments.find(
                          (entry) => entry.environmentId === mismatch.environmentId,
                        )?.label ?? mismatch.environmentId;
                      return (
                        <p key={mismatch.environmentId}>
                          {formatUsageContractMismatch(envLabel, mismatch, m)}
                        </p>
                      );
                    })}
                    {excludedLegacyEnvironments.length === 0 &&
                    merged.contractMismatches.length === 0 &&
                    selectedEnvironments.every((environment) => environment.error === null) ? (
                      <p>
                        <T>Usage data is unavailable for the selected scope.</T>
                      </p>
                    ) : null}
                    {projectFilter !== null ? (
                      <Button variant="outline" size="xs" onClick={() => setProjectSelection(null)}>
                        <T>Show all projects</T>
                      </Button>
                    ) : null}
                  </div>
                ) : (
                  <>
                    {excludedLegacyEnvironments.length > 0 ? (
                      <p
                        data-testid="usage-excluded-legacy-notice"
                        className="rounded-lg border border-warning/35 bg-warning/10 px-3 py-2 text-xs text-warning-foreground"
                      >
                        {gt(
                          "Project filter excludes environments on older servers: {environments}",
                          {
                            environments: excludedLegacyEnvironments
                              .map((env) => env.label)
                              .join(", "),
                          },
                        )}
                      </p>
                    ) : null}

                    {(merged.partialProjectAttribution || merged.partialSessionAttribution) &&
                    excludedLegacyEnvironments.length === 0 ? (
                      <p
                        data-testid="usage-partial-attribution-notice"
                        className="text-xs text-muted-foreground"
                      >
                        <T>
                          Some connected environments are on older servers and do not contribute to
                          project or top session breakdowns yet.
                        </T>
                      </p>
                    ) : null}

                    {todayClippedForLegacy ? (
                      <p
                        data-testid="usage-legacy-clipped-today-notice"
                        className="rounded-lg border border-warning/35 bg-warning/10 px-3 py-2 text-xs text-warning-foreground"
                      >
                        <T>
                          Older servers limit hourly views to 24 hours, so the earliest part of
                          today is omitted and daily budget and period comparison are paused.
                        </T>
                      </p>
                    ) : previousClippedForLegacy ? (
                      <p
                        data-testid="usage-legacy-clipped-yesterday-notice"
                        className="text-xs text-muted-foreground"
                      >
                        <T>
                          Period comparison is paused because yesterday spanned 25 hours and an
                          older server limits hourly views to 24 hours.
                        </T>
                      </p>
                    ) : null}

                    {mtdCoarseForLegacy || comparison.coarseLegacySuppressed === true ? (
                      <p
                        data-testid="usage-legacy-coarse-mtd-notice"
                        className="text-xs text-muted-foreground"
                      >
                        <T>
                          Period comparison is paused for Month because an older server uses
                          full-day boundaries.
                        </T>
                      </p>
                    ) : null}

                    {sourceMessages.map((message) => (
                      <p key={message} className="text-xs text-muted-foreground">
                        {message}
                      </p>
                    ))}

                    <UsageKpiCards
                      kpis={kpis}
                      metric={metric}
                      resolution={shownHourly ? "hour" : "day"}
                      loading={loadingPartial}
                      showComparison={canCompare}
                      primaryDelta={primaryDelta}
                      budgetStatus={budgetStatus}
                      streak={streak}
                      onOpenModelPrices={() => setPriceDialog({})}
                      onOpenBudgetDialog={() => setBudgetDialogOpen(true)}
                    />

                    <section className="grid gap-5 lg:grid-cols-[minmax(0,19rem)_minmax(0,1fr)]">
                      <div
                        data-testid="usage-provider-ranking"
                        className="flex min-w-0 flex-col gap-3 rounded-xl border border-border/70 bg-card/65 p-4"
                      >
                        <div className="flex items-center justify-between gap-2">
                          <h2 className="text-sm font-medium text-foreground">
                            <T>Providers</T>
                          </h2>
                          <span className="text-2xs text-muted-foreground">
                            <T>Click to filter</T>
                          </span>
                        </div>

                        {showChatGptSharing ? (
                          <div className="flex items-center justify-between gap-2 rounded-lg bg-muted/40 px-2.5 py-1.5 text-xs text-muted-foreground">
                            <span>
                              <T>ChatGPT shared usage</T>
                            </span>
                            <ChatGptUsageButton size="xs" />
                          </div>
                        ) : null}

                        {rankedProviders.length === 0 ? (
                          <p className="py-6 text-center text-xs text-muted-foreground">
                            <T>No provider activity in this window.</T>
                          </p>
                        ) : (
                          <div className="flex max-h-[19rem] flex-col gap-1 overflow-y-auto pr-0.5">
                            {rankedProviders.map((provider) => {
                              const totals = merged.providers.find(
                                (entry) => entry.provider === provider,
                              );
                              const share =
                                metric === "cost"
                                  ? (totals?.costShare ?? 0)
                                  : (totals?.tokenShare ?? 0);
                              const providerSessions = totals?.sessions ?? 0;
                              const providerLoading = loadingProviders.has(provider);
                              const awaitingData =
                                providerLoading && !providersWithData.has(provider);
                              const isSolo = soloProvider === provider;
                              const presentation = PROVIDER_PRESENTATION[provider];
                              return (
                                <button
                                  key={provider}
                                  type="button"
                                  data-testid={`usage-provider-row-${provider}`}
                                  aria-pressed={isSolo}
                                  onClick={() =>
                                    setSoloProvider((current) =>
                                      current === provider ? null : provider,
                                    )
                                  }
                                  className={cn(
                                    "flex cursor-pointer flex-col gap-1 rounded-lg px-2 py-1.5 text-left transition-colors outline-none hover:bg-muted/55 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
                                    isSolo && "bg-info/12 ring-1 ring-inset ring-info/40",
                                  )}
                                >
                                  <div className="flex items-baseline justify-between gap-3">
                                    <span className="flex min-w-0 items-center gap-2 text-sm text-foreground">
                                      <span
                                        aria-hidden
                                        className="size-2 shrink-0 rounded-full"
                                        style={{ backgroundColor: presentation.color }}
                                      />
                                      <ProviderInstanceIcon
                                        driverKind={presentation.driverKind}
                                        displayName={presentation.label}
                                        iconClassName="size-4"
                                      />
                                      <span className="truncate font-medium">
                                        {presentation.label}
                                      </span>
                                    </span>
                                    <span
                                      className={cn(
                                        "shrink-0 text-sm font-medium text-foreground tabular-nums transition-opacity",
                                        providerLoading && "opacity-40 delay-150",
                                      )}
                                    >
                                      {awaitingData
                                        ? "-"
                                        : metric === "cost"
                                          ? formatUsd(totals?.costUsd ?? 0, locale)
                                          : formatTokens(totals?.totalTokens ?? 0)}
                                    </span>
                                  </div>
                                  <div className="h-1 w-full overflow-hidden rounded-full bg-muted/65">
                                    <div
                                      className="h-full rounded-full"
                                      style={{
                                        width: `${Math.max(share > 0 ? 2 : 0, Math.min(100, share * 100))}%`,
                                        backgroundColor: presentation.color,
                                      }}
                                    />
                                  </div>
                                  <div
                                    className={cn(
                                      "flex items-center justify-between gap-2 text-2xs text-muted-foreground tabular-nums",
                                      awaitingData && "invisible",
                                    )}
                                  >
                                    <span>
                                      {metric === "cost"
                                        ? gt("{share} · {tokens} tok", {
                                            share: formatPercent(share),
                                            tokens: formatTokens(totals?.totalTokens ?? 0),
                                          })
                                        : gt("{share} · {cost}", {
                                            share: formatPercent(share),
                                            cost: formatUsd(totals?.costUsd ?? 0, locale),
                                          })}
                                    </span>
                                    <span>
                                      {gt(
                                        "{count, plural, one {{formatted} session} other {{formatted} sessions}}",
                                        {
                                          count: providerSessions,
                                          formatted: formatCount(providerSessions, locale),
                                        },
                                      )}
                                    </span>
                                  </div>
                                </button>
                              );
                            })}
                          </div>
                        )}
                      </div>

                      <UsageTrendChart
                        providers={activeProviders}
                        loadingProviders={chartLoadingProviders}
                        days={days}
                        daily={merged.daily}
                        hours={hours}
                        hourly={merged.hourly}
                        metric={metric}
                        chartMode={chartMode}
                        onChartModeChange={setChartMode}
                        lockedPeriod={lockedPeriod}
                        onToggleLockedPeriod={(target) =>
                          setLockedPeriod((current) => (current === target ? null : target))
                        }
                        referenceTime={shownWindow.untilTime}
                        resolution={shownHourly ? "hour" : "day"}
                        timeZone={shownWindow.timeZone}
                        hour12={hour12}
                      />
                    </section>

                    {showShareBars ? (
                      <UsageShareBars merged={merged} metric={metric} loading={loadingPartial} />
                    ) : null}

                    <UsageBreakdownSection
                      merged={merged}
                      activeProviders={activeProviders}
                      loadingProviders={loadingProviders}
                      loadingPartial={loadingPartial}
                      metric={metric}
                      shownHourly={shownHourly}
                      timeZone={shownWindow.timeZone}
                      hour12={hour12}
                      breakdownTab={breakdownTab}
                      onBreakdownTabChange={setBreakdownTab}
                      activeProjectKey={projectFilter?.projectKey ?? null}
                      lockedPeriod={lockedPeriod}
                      onToggleLockedPeriod={(target) =>
                        setLockedPeriod((current) => (current === target ? null : target))
                      }
                      onSelectModel={selectUsageModel}
                      onSetModelPrice={(model) => setPriceDialog({ model })}
                      onSelectProject={(selection) =>
                        setProjectSelection((current) =>
                          current?.projectKey === selection.projectKey ? null : selection,
                        )
                      }
                      onOpenThread={handleOpenThread}
                      onInspectSession={setInspectedSession}
                      connectedEnvironmentIds={connectedEnvironmentIds}
                    />
                  </>
                )}
              </div>
            )}
          </div>
        </ScrollArea>
      </div>

      {showingLimits ? null : (
        <UsageModelDialogHost
          models={merged.models}
          projects={merged.projects}
          environments={modelDialogEnvironments}
          metric={metric}
          chartWindow={{
            days,
            hours,
            resolution: shownHourly ? "hour" : "day",
            timeZone: shownWindow.timeZone,
            referenceTime: shownWindow.untilTime,
            hour12,
          }}
          onSetPrice={(model) => setPriceDialog({ model })}
        />
      )}

      {priceDialog ? (
        <UsagePriceOverrides
          usage={environments}
          initialSelectedEnvironmentIds={selectedEnvironmentIds}
          initialModel={priceDialog.model}
          onOpenChange={(open) => {
            if (!open) setPriceDialog(null);
          }}
        />
      ) : null}

      {budgetDialogOpen ? <UsageBudgetDialog open onOpenChange={setBudgetDialogOpen} /> : null}

      {inspectedSession !== null ? (
        <UsageSessionDialog
          session={inspectedSession}
          timeZone={shownWindow.timeZone}
          hour12={hour12}
          isHostConnected={connectedEnvironmentIds.has(inspectedSession.environmentId)}
          onClose={() => setInspectedSession(null)}
        />
      ) : null}
    </AppRouteModal>
  );
}

function UsageDashboardSkeleton() {
  return (
    <div className="flex flex-col gap-5">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {[0, 1, 2, 3].map((slot) => (
          <div
            key={slot}
            className="flex flex-col gap-2.5 rounded-xl border border-border/70 bg-card/65 p-3.5"
          >
            <Skeleton className="h-3.5 w-24" />
            <Skeleton className="h-7 w-28" />
            <Skeleton className="h-3.5 w-40" />
          </div>
        ))}
      </div>
      <div className="grid gap-5 lg:grid-cols-[minmax(0,19rem)_minmax(0,1fr)]">
        <Skeleton shape="card" className="h-72" />
        <Skeleton shape="card" className="h-72" />
      </div>
      <Skeleton shape="card" className="h-56" />
    </div>
  );
}
