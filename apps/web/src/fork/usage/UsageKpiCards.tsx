import { formatCount, formatPercent, formatTokens, formatUsd } from "@t3tools/shared/usageFormat";
import { T, useGT, useLocale } from "gt-react";
import { FlameIcon } from "lucide-react";

import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";
import { cn } from "~/lib/utils";
import type {
  UsageBudgetStatus,
  UsageDelta,
  UsageKpiSnapshot,
  UsageRiskTone,
  UsageStreakSnapshot,
} from "./usageDashboard.logic";

function deltaPillClass(delta: UsageDelta): string {
  if (delta.direction === "down") return "bg-success/12 text-success-foreground";
  if (delta.direction === "up" && delta.percentChange !== null && delta.percentChange > 20) {
    return "bg-warning/15 text-warning-foreground";
  }
  return "bg-muted text-muted-foreground";
}

function formatDeltaText(delta: UsageDelta): string {
  if (delta.percentChange === null) return "-";
  const rounded =
    Math.abs(delta.percentChange) >= 100
      ? Math.round(delta.percentChange)
      : Number(delta.percentChange.toFixed(1));
  if (rounded === 0) return "0%";
  return `${rounded > 0 ? "+" : ""}${rounded}%`;
}

function budgetToneBarClass(tone: UsageRiskTone): string {
  switch (tone) {
    case "error":
      return "bg-error";
    case "warning":
      return "bg-warning";
    case "normal":
      return "bg-success";
  }
}

function budgetToneTextClass(tone: UsageRiskTone): string {
  switch (tone) {
    case "error":
      return "text-error-foreground";
    case "warning":
      return "text-warning-foreground";
    case "normal":
      return "text-success-foreground";
  }
}

export function UsageKpiCards({
  kpis,
  metric,
  resolution,
  loading,
  showComparison,
  primaryDelta,
  budgetStatus,
  streak = null,
  onOpenModelPrices,
  onOpenBudgetDialog,
}: {
  readonly kpis: UsageKpiSnapshot;
  readonly metric: "cost" | "tokens";
  readonly resolution: "day" | "hour";
  readonly loading: boolean;
  readonly showComparison: boolean;
  readonly primaryDelta: UsageDelta | null;
  readonly budgetStatus: UsageBudgetStatus | null;
  readonly streak?: UsageStreakSnapshot | null;
  readonly onOpenModelPrices: () => void;
  readonly onOpenBudgetDialog: () => void;
}) {
  const gt = useGT();
  const locale = useLocale();
  const figureDim = cn("transition-opacity", loading && "opacity-40 delay-150");

  const primaryValue =
    metric === "cost" ? formatUsd(kpis.costUsd, locale) : formatTokens(kpis.totalTokens);
  const previousFormatted =
    primaryDelta === null
      ? null
      : metric === "cost"
        ? formatUsd(primaryDelta.previous, locale)
        : formatTokens(primaryDelta.previous);

  const burnPrimary =
    metric === "cost"
      ? kpis.burnPerActivePeriodCostUsd !== null
        ? formatUsd(kpis.burnPerActivePeriodCostUsd, locale)
        : "-"
      : kpis.burnPerActivePeriodTokens !== null
        ? formatTokens(kpis.burnPerActivePeriodTokens)
        : "-";

  const costSourceLabel =
    kpis.providerReportedShare > 0 && kpis.modelPricedShare > 0
      ? gt("Reported {reported} · Est. {estimated}", {
          reported: formatPercent(kpis.providerReportedShare, 0),
          estimated: formatPercent(kpis.modelPricedShare, 0),
        })
      : kpis.providerReportedShare > 0
        ? gt("Provider reported")
        : kpis.modelPricedShare > 0
          ? gt("API estimate")
          : kpis.unpricedShare > 0
            ? gt("Unpriced")
            : gt("API estimate");

  return (
    <section
      aria-label={gt("Usage key metrics")}
      data-testid="usage-kpi-cards"
      className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4"
    >
      <div
        data-testid="usage-kpi-primary"
        className="flex min-w-0 flex-col justify-between gap-2 rounded-xl border border-border/70 bg-card/65 p-3.5"
      >
        <div className="flex items-center justify-between gap-2">
          <span className="text-xs font-medium text-muted-foreground">
            {metric === "cost" ? <T>Total cost</T> : <T>Processed tokens</T>}
          </span>
          {showComparison && primaryDelta !== null ? (
            <Tooltip>
              <TooltipTrigger
                render={
                  <span
                    tabIndex={0}
                    data-testid="usage-kpi-delta"
                    className={cn(
                      "inline-flex shrink-0 items-center rounded-full px-1.5 py-0.5 text-2xs font-medium tabular-nums outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring",
                      deltaPillClass(primaryDelta),
                    )}
                  />
                }
              >
                {formatDeltaText(primaryDelta)}
              </TooltipTrigger>
              <TooltipPopup side="top">
                {primaryDelta.percentChange === null
                  ? gt("No baseline usage in previous period")
                  : gt("Previous period: {value}", { value: previousFormatted ?? "-" })}
              </TooltipPopup>
            </Tooltip>
          ) : null}
        </div>

        <p
          className={cn(
            "text-2xl font-semibold tracking-tight text-foreground tabular-nums",
            figureDim,
          )}
        >
          {primaryValue}
        </p>

        <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-2xs text-muted-foreground">
          {metric === "cost" ? (
            <>
              <span data-testid="usage-cost-source">{costSourceLabel}</span>
              {kpis.unpricedShare > 0 ? (
                <button
                  type="button"
                  data-testid="usage-unpriced-action"
                  onClick={onOpenModelPrices}
                  className="cursor-pointer rounded bg-warning/15 px-1.5 py-0.5 font-medium text-warning-foreground transition-colors outline-none hover:bg-warning/25 focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring"
                >
                  {gt("{share} records unpriced · Set price", {
                    share: formatPercent(kpis.unpricedShare, 0),
                  })}
                </button>
              ) : null}
            </>
          ) : (
            <span className="tabular-nums">
              {gt("Est. {cost}", { cost: formatUsd(kpis.costUsd, locale) })}
            </span>
          )}
        </div>

        {budgetStatus !== null ? (
          <div
            data-testid="usage-soft-budget"
            data-tone={budgetStatus.tone}
            className="mt-1 flex flex-col gap-1 border-t border-border/60 pt-2"
          >
            <div className="flex items-center justify-between gap-2 text-2xs">
              <button
                type="button"
                onClick={onOpenBudgetDialog}
                className="cursor-pointer truncate text-muted-foreground transition-colors outline-none hover:text-foreground focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring"
              >
                {budgetStatus.periodKind === "daily" ? <T>Daily budget</T> : <T>Monthly budget</T>}
                {budgetStatus.scope === "reportedOnly" ? ` · ${gt("Reported")}` : ""}
              </button>
              <span
                className={cn(
                  "shrink-0 font-medium tabular-nums",
                  budgetToneTextClass(budgetStatus.tone),
                )}
              >
                {formatUsd(budgetStatus.spentUsd, locale)} /{" "}
                {formatUsd(budgetStatus.limitUsd, locale)} ({formatPercent(budgetStatus.ratio, 0)})
              </span>
            </div>
            <div className="relative h-1.5 w-full overflow-hidden rounded-full bg-muted">
              <div
                className={cn("h-full rounded-full", budgetToneBarClass(budgetStatus.tone))}
                style={{ width: `${Math.min(100, Math.max(0, budgetStatus.ratio * 100))}%` }}
              />
            </div>
          </div>
        ) : null}
      </div>

      <div
        data-testid="usage-kpi-burn"
        className="flex min-w-0 flex-col justify-between gap-2 rounded-xl border border-border/70 bg-card/65 p-3.5"
      >
        <div className="flex items-center justify-between gap-2">
          <span className="text-xs font-medium text-muted-foreground">
            {resolution === "hour" ? <T>Avg per active hour</T> : <T>Avg per active day</T>}
          </span>
          {resolution === "day" && streak !== null && streak.currentDays > 0 ? (
            <Tooltip>
              <TooltipTrigger
                render={
                  <span
                    tabIndex={0}
                    data-testid="usage-kpi-streak"
                    className="inline-flex shrink-0 items-center gap-1 rounded-full bg-info/12 px-1.5 py-0.5 text-2xs font-medium text-info-foreground tabular-nums outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring"
                  />
                }
              >
                <FlameIcon className="size-3" aria-hidden />
                <span>
                  {streak.reachesWindowStart
                    ? gt("{days}+d streak", { days: streak.currentDays })
                    : gt("{days}d streak", { days: streak.currentDays })}
                </span>
              </TooltipTrigger>
              <TooltipPopup side="top">
                <div className="flex flex-col gap-0.5 text-xs">
                  <span>
                    {streak.reachesWindowStart
                      ? gt("Streak reaches the start of this window ({days}+ days)", {
                          days: streak.currentDays,
                        })
                      : gt("Current streak: {days} consecutive days", {
                          days: streak.currentDays,
                        })}
                  </span>
                  <span className="text-muted-foreground">
                    {gt("Longest in window: {longest}d · Active days: {active}", {
                      longest: streak.longestDays,
                      active: streak.activeDays,
                    })}
                  </span>
                </div>
              </TooltipPopup>
            </Tooltip>
          ) : null}
        </div>
        <p
          className={cn(
            "text-2xl font-semibold tracking-tight text-foreground tabular-nums",
            figureDim,
          )}
        >
          {burnPrimary}
        </p>
        <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-2xs text-muted-foreground tabular-nums">
          <span>
            {kpis.costPerMillionTokens !== null
              ? gt("{rate}/1M tok", { rate: formatUsd(kpis.costPerMillionTokens, locale) })
              : "-"}
          </span>
          <span aria-hidden>·</span>
          <span>
            {gt("{count, plural, one {{formatted} session} other {{formatted} sessions}}", {
              count: kpis.sessions,
              formatted: formatCount(kpis.sessions, locale),
            })}
          </span>
        </div>
      </div>

      <div
        data-testid="usage-kpi-cache"
        className="flex min-w-0 flex-col justify-between gap-2 rounded-xl border border-border/70 bg-card/65 p-3.5"
      >
        <span className="text-xs font-medium text-muted-foreground">
          <T>Cache hit rate</T>
        </span>
        <p
          className={cn(
            "text-2xl font-semibold tracking-tight text-foreground tabular-nums",
            figureDim,
          )}
        >
          {kpis.cacheHitRate !== null ? formatPercent(kpis.cacheHitRate) : "-"}
        </p>
        <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-2xs text-muted-foreground tabular-nums">
          <span>
            {gt("Saved {amount}", { amount: formatUsd(kpis.cacheSavingsUsd, locale) })}
            {kpis.cacheSavingsUsd > 0 &&
            kpis.cacheSavingsMultiplier !== null &&
            kpis.cacheSavingsMultiplier > 1.05
              ? ` (${kpis.cacheSavingsMultiplier.toFixed(1)}×)`
              : ""}
          </span>
          <span aria-hidden>·</span>
          <span>
            {gt("R {read} · W {write}", {
              read: formatTokens(kpis.cachedInputTokens),
              write: formatTokens(kpis.cacheCreationTokens),
            })}
          </span>
        </div>
      </div>

      <div
        data-testid="usage-kpi-output"
        className="flex min-w-0 flex-col justify-between gap-2 rounded-xl border border-border/70 bg-card/65 p-3.5"
      >
        <span className="text-xs font-medium text-muted-foreground">
          <T>Output & reasoning</T>
        </span>
        <p
          className={cn(
            "text-2xl font-semibold tracking-tight text-foreground tabular-nums",
            figureDim,
          )}
        >
          {formatTokens(kpis.outputTokens)}
        </p>
        <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-2xs text-muted-foreground tabular-nums">
          {kpis.reasoningTokens > 0 ? (
            <span data-testid="usage-kpi-reasoning">
              {gt("Reasoning {tokens} ({share})", {
                tokens: formatTokens(kpis.reasoningTokens),
                share: kpis.reasoningShare !== null ? formatPercent(kpis.reasoningShare, 0) : "0%",
              })}
            </span>
          ) : (
            <span>
              <T>No reasoning breakdown</T>
            </span>
          )}
          {kpis.speedPremiumUsd > 0 ? (
            <>
              <span aria-hidden>·</span>
              <span className="text-warning-foreground">
                {gt("Speed +{amount}", { amount: formatUsd(kpis.speedPremiumUsd, locale) })}
              </span>
            </>
          ) : null}
        </div>
      </div>
    </section>
  );
}
