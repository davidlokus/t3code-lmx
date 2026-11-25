import {
  USAGE_CONTRACT_VERSION,
  type EnvironmentId,
  type UsageProjectFilter,
  type UsageProviderKind,
} from "@t3tools/contracts";
import {
  updatingProvidersLabel,
  usageEnvironmentProgress,
} from "@t3tools/client-runtime/state/usage-progress";
import { formatUsageContractMismatch } from "@t3tools/shared/usageFormatCopy";
import { isCompatibleUsageContractVersion, type MergedUsage } from "@t3tools/shared/usageMerge";
import {
  ChevronDownIcon,
  CircleAlertIcon,
  DownloadIcon,
  RotateCcwIcon,
  SlidersHorizontalIcon,
  TagIcon,
  XIcon,
} from "lucide-react";
import { msg, T, useGT, useMessages } from "gt-react";

import { AppRouteModalClose } from "~/components/AppRouteModal";
import { ProviderInstanceIcon } from "~/components/chat/ProviderInstanceIcon";
import { Button, InlineButton } from "~/components/ui/button";
import {
  Menu,
  MenuCheckboxItem,
  MenuGroup,
  MenuGroupLabel,
  MenuItem,
  MenuPopup,
  MenuSeparator,
  MenuTrigger,
} from "~/components/ui/menu";
import { RefreshIcon } from "~/components/ui/refresh-icon";
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "~/components/ui/select";
import { Toggle, ToggleGroup } from "~/components/ui/toggle-group";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";
import {
  WorkspaceBreadcrumb,
  WorkspaceBreadcrumbItem,
  WorkspaceBreadcrumbSeparator,
  WorkspaceBreadcrumbText,
} from "~/components/WorkspaceBreadcrumb";
import { PROVIDER_ORDER, PROVIDER_PRESENTATION } from "~/components/usage/usageProviders";
import { cn } from "~/lib/utils";
import type { EnvironmentUsageStatus } from "~/state/usage";
import {
  isDefaultUsageUiOptions,
  type UsageDashboardView,
  type UsagePeriodPreset,
  useUsageOptionsStore,
} from "./usageOptionsStore";

const PERIOD_OPTIONS = [
  { value: "today", label: msg("Today") },
  { value: "24h", label: msg("24h") },
  { value: "7d", label: msg("7d") },
  { value: "mtd", label: msg("Month") },
  { value: "30d", label: msg("30d") },
  { value: "90d", label: msg("90d") },
] as const satisfies readonly { value: UsagePeriodPreset; label: string }[];

const providerLabel = (provider: UsageProviderKind) => PROVIDER_PRESENTATION[provider].label;

function UsageCoverageNotice({
  environments,
  duplicateSources,
  contractMismatches,
}: {
  readonly environments: readonly EnvironmentUsageStatus[];
  readonly duplicateSources: readonly string[];
  readonly contractMismatches: MergedUsage["contractMismatches"];
}) {
  const gt = useGT();
  const m = useMessages();
  const failed = environments.filter((environment) => environment.error !== null);
  const mismatchByEnvironment = new Map(
    contractMismatches.map((mismatch) => [mismatch.environmentId, mismatch]),
  );
  const incompatible = environments.flatMap((environment) => {
    const mismatch = mismatchByEnvironment.get(environment.environmentId);
    return mismatch === undefined ? [] : [{ environment, mismatch }];
  });
  if (failed.length === 0 && incompatible.length === 0 && duplicateSources.length === 0) {
    return null;
  }

  return (
    <div className="flex flex-col gap-1 border-t border-border px-2 py-2 text-xs text-muted-foreground">
      {failed.map((environment) => (
        <span key={environment.label}>
          {gt("{environment}: {error}", {
            environment: environment.label,
            error: environment.error,
          })}
        </span>
      ))}
      {incompatible.map(({ environment, mismatch }) => (
        <span key={environment.environmentId}>
          {formatUsageContractMismatch(environment.label, mismatch, m)}
        </span>
      ))}
      {duplicateSources.length > 0 ? (
        <span>
          {gt("Counted once across environments sharing a transcript directory: {sources}", {
            sources: duplicateSources.join(", "),
          })}
        </span>
      ) : null}
    </div>
  );
}

function EnvironmentFilterMenu({
  environments,
  selectedEnvironments,
  selectedEnvironmentIds,
  onSelectionChange,
  showUsageStatus,
  refreshing,
  isPartial,
  duplicateSources,
  contractMismatches,
}: {
  readonly environments: readonly EnvironmentUsageStatus[];
  readonly selectedEnvironments: readonly EnvironmentUsageStatus[];
  readonly selectedEnvironmentIds: ReadonlySet<EnvironmentId> | null;
  readonly onSelectionChange: (ids: ReadonlySet<EnvironmentId> | null) => void;
  readonly showUsageStatus: boolean;
  readonly refreshing: boolean;
  readonly isPartial: boolean;
  readonly duplicateSources: readonly string[];
  readonly contractMismatches: MergedUsage["contractMismatches"];
}) {
  const gt = useGT();
  const m = useMessages();
  const allSelected = selectedEnvironmentIds === null;
  const label = allSelected
    ? gt("All environments")
    : selectedEnvironments.length === 1
      ? selectedEnvironments[0]!.label
      : gt("{count, plural, one {{count} environments} other {{count} environments}}", {
          count: selectedEnvironments.length,
        });
  const hasIssue =
    selectedEnvironments.some((environment) => environment.error !== null) ||
    contractMismatches.length > 0;

  return (
    <Menu>
      <MenuTrigger render={<InlineButton />} className="group/usage-environment min-w-0 max-w-full">
        <WorkspaceBreadcrumbText>{label}</WorkspaceBreadcrumbText>
        <span className="flex size-3.5 shrink-0 items-center justify-center text-muted-foreground">
          {showUsageStatus && hasIssue ? (
            <CircleAlertIcon
              className="size-3.5 text-warning-foreground"
              aria-label={gt("Some environments could not report usage")}
            />
          ) : (
            <ChevronDownIcon
              className="size-3.5 opacity-60 transition-opacity group-hover/usage-environment:opacity-100 group-focus-visible/usage-environment:opacity-100 group-data-popup-open/usage-environment:opacity-100"
              aria-hidden
            />
          )}
        </span>
      </MenuTrigger>
      <MenuPopup align="start">
        <MenuCheckboxItem
          checked={allSelected}
          closeOnClick={false}
          onCheckedChange={(checked) => onSelectionChange(checked ? null : new Set())}
        >
          <T>All environments</T>
        </MenuCheckboxItem>
        <MenuSeparator />
        {environments.map((environment) => {
          const checked =
            selectedEnvironmentIds === null ||
            selectedEnvironmentIds.has(environment.environmentId);
          const progress = usageEnvironmentProgress(environment, refreshing);
          const status =
            environment.error !== null
              ? gt("Unavailable")
              : environment.summary !== null &&
                  !isCompatibleUsageContractVersion(
                    environment.summary.contractVersion,
                    USAGE_CONTRACT_VERSION,
                  )
                ? gt("Update required")
                : !environment.isConnected
                  ? gt("Connecting…")
                  : progress.phase === "loading"
                    ? gt("Scanning…")
                    : progress.phase === "stale"
                      ? gt("Refreshing…")
                      : progress.phase === "partway"
                        ? updatingProvidersLabel(progress.providers, providerLabel, m)
                        : gt("Ready", { $context: "environment usage status" });
          return (
            <MenuCheckboxItem
              key={environment.environmentId}
              checked={checked}
              closeOnClick={false}
              onCheckedChange={(nextChecked) => {
                const next = new Set(selectedEnvironments.map((entry) => entry.environmentId));
                if (nextChecked) next.add(environment.environmentId);
                else next.delete(environment.environmentId);
                onSelectionChange(next.size === environments.length ? null : next);
              }}
            >
              <span className="flex min-w-0 items-center gap-3">
                <span className="min-w-0 flex-1 truncate">{environment.label}</span>
                {showUsageStatus ? (
                  <span
                    className={cn(
                      "shrink-0 text-xs text-muted-foreground",
                      environment.error !== null && "text-destructive",
                    )}
                  >
                    {status}
                  </span>
                ) : null}
              </span>
            </MenuCheckboxItem>
          );
        })}
        {environments.length === 0 ? (
          <p className="px-2 py-2 text-xs text-muted-foreground">
            <T>No environments connected.</T>
          </p>
        ) : null}
        {showUsageStatus && isPartial ? (
          <p className="px-2 py-2 text-xs text-muted-foreground">
            <T>Totals are partial while selected environments scan.</T>
          </p>
        ) : null}
        {showUsageStatus ? (
          <UsageCoverageNotice
            environments={selectedEnvironments}
            duplicateSources={duplicateSources}
            contractMismatches={contractMismatches}
          />
        ) : null}
      </MenuPopup>
    </Menu>
  );
}

function ProviderFilterMenu({
  hiddenProviders,
  onChange,
}: {
  readonly hiddenProviders: ReadonlySet<UsageProviderKind>;
  readonly onChange: (hiddenProviders: readonly UsageProviderKind[]) => void;
}) {
  const gt = useGT();
  const visible = PROVIDER_ORDER.filter((provider) => !hiddenProviders.has(provider));
  const label =
    visible.length === PROVIDER_ORDER.length
      ? gt("All providers")
      : visible.length === 0
        ? gt("No providers")
        : visible.length === 1
          ? PROVIDER_PRESENTATION[visible[0]!].label
          : gt("{count, plural, one {{count} providers} other {{count} providers}}", {
              count: visible.length,
            });

  return (
    <Menu>
      <MenuTrigger render={<InlineButton />} className="group/usage-provider min-w-0 max-w-full">
        <span className="min-w-0 truncate">{label}</span>
        <ChevronDownIcon
          className="size-3.5 shrink-0 text-muted-foreground opacity-60 transition-opacity group-hover/usage-provider:opacity-100 group-focus-visible/usage-provider:opacity-100 group-data-popup-open/usage-provider:opacity-100"
          aria-hidden
        />
      </MenuTrigger>
      <MenuPopup align="start">
        <MenuCheckboxItem
          checked={hiddenProviders.size === 0}
          closeOnClick={false}
          onCheckedChange={(checked) => onChange(checked ? [] : PROVIDER_ORDER)}
        >
          <T>All providers</T>
        </MenuCheckboxItem>
        <MenuSeparator />
        {PROVIDER_ORDER.map((provider) => {
          const presentation = PROVIDER_PRESENTATION[provider];
          return (
            <MenuCheckboxItem
              key={provider}
              checked={!hiddenProviders.has(provider)}
              closeOnClick={false}
              onCheckedChange={(checked) =>
                onChange(
                  PROVIDER_ORDER.filter((entry) =>
                    entry === provider ? !checked : hiddenProviders.has(entry),
                  ),
                )
              }
            >
              <span className="flex min-w-0 items-center gap-2">
                <ProviderInstanceIcon
                  driverKind={presentation.driverKind}
                  displayName={presentation.label}
                  iconClassName="size-3.5"
                />
                <span className="truncate">{presentation.label}</span>
              </span>
            </MenuCheckboxItem>
          );
        })}
      </MenuPopup>
    </Menu>
  );
}

function UsageDisplayOptionsMenu({
  onOpenBudgetDialog,
}: {
  readonly onOpenBudgetDialog: () => void;
}) {
  const gt = useGT();
  const options = useUsageOptionsStore();
  const isDefault = isDefaultUsageUiOptions(options);
  const label = gt("Usage display & budget options");

  return (
    <Menu>
      <Tooltip>
        <TooltipTrigger
          render={
            <MenuTrigger
              render={
                <Button
                  size="icon-sm"
                  variant="ghost"
                  aria-label={label}
                  data-testid="usage-options-trigger"
                />
              }
            />
          }
        >
          <SlidersHorizontalIcon className="size-4" aria-hidden />
        </TooltipTrigger>
        <TooltipPopup side="bottom">{label}</TooltipPopup>
      </Tooltip>
      <MenuPopup align="end" side="bottom" sideOffset={6}>
        <MenuGroup>
          <MenuGroupLabel>
            <T>Dashboard display</T>
          </MenuGroupLabel>
          <MenuCheckboxItem
            variant="switch"
            checked={options.showQuotaStrip}
            closeOnClick={false}
            onCheckedChange={() => options.toggleOption("showQuotaStrip")}
          >
            <T>Subscription quota strip</T>
          </MenuCheckboxItem>
          <MenuCheckboxItem
            variant="switch"
            checked={options.showComparison}
            closeOnClick={false}
            onCheckedChange={() => options.toggleOption("showComparison")}
          >
            <T>Period comparison delta</T>
          </MenuCheckboxItem>
          <MenuCheckboxItem
            variant="switch"
            checked={options.showShareBars}
            closeOnClick={false}
            onCheckedChange={() => options.toggleOption("showShareBars")}
          >
            <T>Structure share bars</T>
          </MenuCheckboxItem>
          <MenuCheckboxItem
            variant="switch"
            checked={options.showBudget}
            closeOnClick={false}
            onCheckedChange={() => options.toggleOption("showBudget")}
          >
            <T>Soft budget bar</T>
          </MenuCheckboxItem>
        </MenuGroup>
        <MenuSeparator />
        <MenuItem data-testid="usage-configure-budget-item" onClick={onOpenBudgetDialog}>
          <T>Configure soft budget…</T>
        </MenuItem>
        <MenuSeparator />
        <MenuItem
          disabled={isDefault}
          closeOnClick={false}
          data-testid="usage-options-reset"
          onClick={options.resetUsageUiOptions}
        >
          <RotateCcwIcon aria-hidden />
          <T>Reset defaults</T>
        </MenuItem>
      </MenuPopup>
    </Menu>
  );
}

export function UsageTopbar({
  view,
  onViewChange,
  metric,
  onMetricChange,
  period,
  onPeriodChange,
  windowLabel,
  environments,
  selectedEnvironments,
  selectedEnvironmentIds,
  onEnvironmentSelectionChange,
  hiddenProviders,
  onHiddenProvidersChange,
  soloProvider,
  onClearSoloProvider,
  projectFilter,
  projectFilterLabel,
  onClearProjectFilter,
  lockedPeriodLabel,
  onClearLockedPeriod,
  isRefreshing,
  refreshingUsage,
  isPartial,
  canReadDiagnostics,
  duplicateSources,
  contractMismatches,
  onRefresh,
  onOpenModelPrices,
  onExportCsv,
  onExportJson,
  exportDisabled = false,
  onOpenBudgetDialog,
}: {
  readonly view: UsageDashboardView;
  readonly onViewChange: (view: UsageDashboardView) => void;
  readonly metric: "cost" | "tokens";
  readonly onMetricChange: (metric: "cost" | "tokens") => void;
  readonly period: UsagePeriodPreset;
  readonly onPeriodChange: (period: UsagePeriodPreset) => void;
  readonly windowLabel: string;
  readonly environments: readonly EnvironmentUsageStatus[];
  readonly selectedEnvironments: readonly EnvironmentUsageStatus[];
  readonly selectedEnvironmentIds: ReadonlySet<EnvironmentId> | null;
  readonly onEnvironmentSelectionChange: (ids: ReadonlySet<EnvironmentId> | null) => void;
  readonly hiddenProviders: ReadonlySet<UsageProviderKind>;
  readonly onHiddenProvidersChange: (hidden: readonly UsageProviderKind[]) => void;
  readonly soloProvider: UsageProviderKind | null;
  readonly onClearSoloProvider: () => void;
  readonly projectFilter: UsageProjectFilter | null;
  readonly projectFilterLabel: string | null;
  readonly onClearProjectFilter: () => void;
  readonly lockedPeriodLabel: string | null;
  readonly onClearLockedPeriod: () => void;
  readonly isRefreshing: boolean;
  readonly refreshingUsage: boolean;
  readonly isPartial: boolean;
  readonly canReadDiagnostics: boolean;
  readonly duplicateSources: readonly string[];
  readonly contractMismatches: MergedUsage["contractMismatches"];
  readonly onRefresh: () => void;
  readonly onOpenModelPrices: () => void;
  readonly onExportCsv: () => void;
  readonly onExportJson: () => void;
  readonly exportDisabled?: boolean;
  readonly onOpenBudgetDialog: () => void;
}) {
  const gt = useGT();
  const m = useMessages();
  const showingLimits = view === "limits";
  const periodLabel = PERIOD_OPTIONS.find((option) => option.value === period)?.label;
  const hasFilterChips =
    soloProvider !== null || projectFilter !== null || lockedPeriodLabel !== null;

  return (
    <div className="shrink-0 border-b">
      <header className="@container/usage-header flex min-h-12 flex-wrap items-center gap-x-2 gap-y-1.5 ps-4 pe-2 py-1.5 sm:ps-5 @4xl/usage-header:flex-nowrap @4xl/usage-header:py-0">
        <div className="flex min-w-0 flex-1 items-center gap-2">
          <WorkspaceBreadcrumb ariaLabel={gt("Usage breadcrumb")} className="min-w-0">
            <WorkspaceBreadcrumbItem>
              <h1>
                <T>Usage</T>
              </h1>
            </WorkspaceBreadcrumbItem>
            <WorkspaceBreadcrumbSeparator />
            <WorkspaceBreadcrumbItem className="min-w-10 shrink">
              <EnvironmentFilterMenu
                environments={environments}
                selectedEnvironments={selectedEnvironments}
                selectedEnvironmentIds={selectedEnvironmentIds}
                onSelectionChange={onEnvironmentSelectionChange}
                showUsageStatus={!showingLimits}
                refreshing={refreshingUsage}
                isPartial={isPartial}
                duplicateSources={duplicateSources}
                contractMismatches={contractMismatches}
              />
            </WorkspaceBreadcrumbItem>
            <WorkspaceBreadcrumbSeparator />
            <WorkspaceBreadcrumbItem current className="min-w-10">
              <ProviderFilterMenu
                hiddenProviders={hiddenProviders}
                onChange={onHiddenProvidersChange}
              />
            </WorkspaceBreadcrumbItem>
          </WorkspaceBreadcrumb>

          {!showingLimits ? (
            <span className="hidden min-w-0 truncate text-xs text-muted-foreground @7xl/usage-header:block">
              {windowLabel}
            </span>
          ) : null}
        </div>

        <div className="flex @4xl/usage-header:hidden">
          <AppRouteModalClose />
        </div>

        <div className="flex w-full min-w-0 flex-wrap items-center gap-1.5 @4xl/usage-header:ms-auto @4xl/usage-header:w-auto @4xl/usage-header:shrink-0 @4xl/usage-header:flex-nowrap">
          {!showingLimits ? (
            <>
              <div className="hidden @6xl/usage-header:flex">
                <ToggleGroup
                  aria-label={gt("Usage period")}
                  variant="segmented"
                  value={[period]}
                  onValueChange={(next) => {
                    const value = next[0] as UsagePeriodPreset | undefined;
                    if (value && PERIOD_OPTIONS.some((option) => option.value === value)) {
                      onPeriodChange(value);
                    }
                  }}
                >
                  {PERIOD_OPTIONS.map((option) => (
                    <Toggle
                      key={option.value}
                      value={option.value}
                      data-testid={`usage-period-${option.value}`}
                    >
                      {m(option.label)}
                    </Toggle>
                  ))}
                </ToggleGroup>
              </div>
              <div className="flex @6xl/usage-header:hidden">
                <Select
                  value={period}
                  onValueChange={(value) => {
                    if (PERIOD_OPTIONS.some((option) => option.value === value)) {
                      onPeriodChange(value as UsagePeriodPreset);
                    }
                  }}
                >
                  <SelectTrigger
                    aria-label={gt("Usage period")}
                    size="compact"
                    variant="ghost"
                    className="w-auto min-w-0"
                  >
                    <SelectValue>{periodLabel ? m(periodLabel) : period}</SelectValue>
                  </SelectTrigger>
                  <SelectPopup align="end" alignItemWithTrigger={false}>
                    {PERIOD_OPTIONS.map((option) => (
                      <SelectItem key={option.value} value={option.value}>
                        {m(option.label)}
                      </SelectItem>
                    ))}
                  </SelectPopup>
                </Select>
              </div>

              <ToggleGroup
                aria-label={gt("Usage metric")}
                variant="segmented"
                value={[metric]}
                onValueChange={(next) => {
                  const value = next[0];
                  if (value === "cost" || value === "tokens") onMetricChange(value);
                }}
              >
                <Toggle value="cost" data-testid="usage-metric-cost">
                  <T>Cost</T>
                </Toggle>
                <Toggle value="tokens" data-testid="usage-metric-tokens">
                  <T>Tokens</T>
                </Toggle>
              </ToggleGroup>
            </>
          ) : null}

          <ToggleGroup
            aria-label={gt("Usage view")}
            variant="segmented"
            value={[view]}
            onValueChange={(next) => {
              const value = next[0];
              if (value === "overview" || value === "limits") onViewChange(value);
            }}
          >
            <Toggle value="overview" data-testid="usage-view-overview">
              <T>Overview</T>
            </Toggle>
            <Toggle value="limits" data-testid="usage-view-limits">
              <T>Limits</T>
            </Toggle>
          </ToggleGroup>

          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  size="icon-sm"
                  variant="ghost"
                  aria-label={gt("Model prices")}
                  data-testid="usage-topbar-prices"
                  onClick={onOpenModelPrices}
                />
              }
            >
              <TagIcon className="size-4" aria-hidden />
            </TooltipTrigger>
            <TooltipPopup side="bottom">
              <T>Model prices</T>
            </TooltipPopup>
          </Tooltip>

          {!showingLimits ? (
            <Menu>
              <Tooltip>
                <TooltipTrigger
                  render={
                    <MenuTrigger
                      render={
                        <Button
                          size="icon-sm"
                          variant="ghost"
                          disabled={exportDisabled}
                          aria-label={gt("Export usage")}
                          data-testid="usage-export-trigger"
                        />
                      }
                    />
                  }
                >
                  <DownloadIcon className="size-4" aria-hidden />
                </TooltipTrigger>
                <TooltipPopup side="bottom">
                  <T>Export CSV / JSON</T>
                </TooltipPopup>
              </Tooltip>
              <MenuPopup align="end" side="bottom" sideOffset={6}>
                <MenuItem data-testid="usage-export-csv" onClick={onExportCsv}>
                  <T>Export CSV</T>
                </MenuItem>
                <MenuItem data-testid="usage-export-json" onClick={onExportJson}>
                  <T>Export JSON</T>
                </MenuItem>
              </MenuPopup>
            </Menu>
          ) : null}

          <UsageDisplayOptionsMenu onOpenBudgetDialog={onOpenBudgetDialog} />

          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  onClick={onRefresh}
                  aria-label={showingLimits ? gt("Refresh limits") : gt("Refresh usage")}
                  aria-busy={isRefreshing}
                  disabled={isRefreshing || (!showingLimits && !canReadDiagnostics)}
                  size="icon-sm"
                  variant="ghost"
                />
              }
            >
              <RefreshIcon size="sm" refreshing={isRefreshing} />
            </TooltipTrigger>
            <TooltipPopup side="bottom">
              {showingLimits ? <T>Refresh limits</T> : <T>Refresh usage</T>}
            </TooltipPopup>
          </Tooltip>
        </div>
        <div className="hidden @4xl/usage-header:flex">
          <AppRouteModalClose />
        </div>
      </header>

      {!showingLimits && hasFilterChips ? (
        <div
          data-testid="usage-active-filters"
          className="flex flex-wrap items-center gap-1.5 border-t border-border/60 bg-muted/25 px-5 py-1.5 text-xs"
        >
          <span className="text-muted-foreground">
            <T>Active filters:</T>
          </span>
          {soloProvider !== null ? (
            <button
              type="button"
              data-testid="usage-filter-chip-provider"
              onClick={onClearSoloProvider}
              className="inline-flex cursor-pointer items-center gap-1 rounded-full bg-info/12 px-2 py-0.5 font-medium text-info-foreground transition-colors outline-none hover:bg-info/20 focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring"
            >
              <span>
                {gt("Provider: {name}", { name: PROVIDER_PRESENTATION[soloProvider].label })}
              </span>
              <XIcon className="size-3" aria-hidden />
            </button>
          ) : null}
          {projectFilter !== null ? (
            <button
              type="button"
              data-testid="usage-filter-chip-project"
              onClick={onClearProjectFilter}
              className="inline-flex cursor-pointer items-center gap-1 rounded-full bg-info/12 px-2 py-0.5 font-medium text-info-foreground transition-colors outline-none hover:bg-info/20 focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring"
            >
              <span>
                {gt("Project: {name}", {
                  name: projectFilterLabel ?? projectFilter.projectKey,
                })}
              </span>
              <XIcon className="size-3" aria-hidden />
            </button>
          ) : null}
          {lockedPeriodLabel !== null ? (
            <button
              type="button"
              data-testid="usage-filter-chip-period"
              onClick={onClearLockedPeriod}
              className="inline-flex cursor-pointer items-center gap-1 rounded-full bg-info/12 px-2 py-0.5 font-medium text-info-foreground transition-colors outline-none hover:bg-info/20 focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring"
            >
              <span>{gt("Bucket: {period}", { period: lockedPeriodLabel })}</span>
              <XIcon className="size-3" aria-hidden />
            </button>
          ) : null}
          <button
            type="button"
            onClick={() => {
              onClearSoloProvider();
              onClearProjectFilter();
              onClearLockedPeriod();
            }}
            className="ms-auto cursor-pointer text-muted-foreground transition-colors outline-none hover:text-foreground focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring"
          >
            <T>Clear all</T>
          </button>
        </div>
      ) : null}
    </div>
  );
}
