import type { UsageProviderKind } from "@t3tools/contracts";
import {
  formatDayShort,
  formatHourShort,
  formatTokens,
  formatUsd,
} from "@t3tools/shared/usageFormat";
import { formatRelativeHourShort } from "@t3tools/shared/usageFormatCopy";
import type { DailyTotals, HourlyTotals } from "@t3tools/shared/usageMerge";
import { T, useGT, useLocale, useMessages } from "gt-react";
import { useLayoutEffect, useRef, useState } from "react";

import { ProviderInstanceIcon } from "~/components/chat/ProviderInstanceIcon";
import { Toggle, ToggleGroup } from "~/components/ui/toggle-group";
import {
  buildPeriodColumns,
  type DayColumn,
  type UsageChartMetric,
} from "~/components/usage/UsageProviderChart";
import { PROVIDER_ORDER, PROVIDER_PRESENTATION } from "~/components/usage/usageProviders";
import { observeResize } from "~/lib/observeResize";
import { cn } from "~/lib/utils";
import type { UsageChartMode } from "./usageOptionsStore";

const VIEW_WIDTH = 960;
const VIEW_HEIGHT = 250;
const PLOT_TOP = 10;
const TICK_COUNT = 4;
const NONE_LOADING: ReadonlySet<UsageProviderKind> = new Set();

interface Point {
  readonly x: number;
  readonly y: number;
}

function niceScale(peak: number, count: number): { max: number; ticks: readonly number[] } {
  if (peak <= 0) return { max: 0, ticks: [0] };
  const rawStep = peak / count;
  const magnitude = 10 ** Math.floor(Math.log10(rawStep));
  const normalized = rawStep / magnitude;
  const step = (normalized > 5 ? 10 : normalized > 2 ? 5 : normalized > 1 ? 2 : 1) * magnitude;
  const max = Math.ceil(peak / step) * step;
  const ticks: number[] = [];
  for (let value = 0; value <= max + step * 1e-6; value += step) ticks.push(value);
  return { max, ticks };
}

function valueToY(value: number, max: number): number {
  return max === 0 ? VIEW_HEIGHT : VIEW_HEIGHT - (value / max) * (VIEW_HEIGHT - PLOT_TOP);
}

function smoothLinePath(points: readonly Point[]): string {
  if (points.length === 0) return "";
  if (points.length === 1) {
    const only = points[0]!;
    return `M${only.x.toFixed(2)},${only.y.toFixed(2)}`;
  }
  const slopes: number[] = [];
  for (let i = 0; i < points.length - 1; i += 1) {
    const dx = points[i + 1]!.x - points[i]!.x;
    const dy = points[i + 1]!.y - points[i]!.y;
    slopes.push(dx === 0 ? 0 : dy / dx);
  }
  const tangents = Array.from({ length: points.length }, () => 0);
  tangents[0] = slopes[0] ?? 0;
  tangents[points.length - 1] = slopes[points.length - 2] ?? 0;
  for (let i = 1; i < points.length - 1; i += 1) {
    const prev = slopes[i - 1] ?? 0;
    const next = slopes[i] ?? 0;
    tangents[i] = prev * next <= 0 ? 0 : (prev + next) / 2;
  }
  for (let i = 0; i < points.length - 1; i += 1) {
    const slope = slopes[i] ?? 0;
    if (slope === 0) {
      tangents[i] = 0;
      tangents[i + 1] = 0;
      continue;
    }
    const a = (tangents[i] ?? 0) / slope;
    const b = (tangents[i + 1] ?? 0) / slope;
    const mag = a * a + b * b;
    if (mag > 9) {
      const scale = 3 / Math.sqrt(mag);
      tangents[i] = scale * a * slope;
      tangents[i + 1] = scale * b * slope;
    }
  }
  let path = `M${points[0]!.x.toFixed(2)},${points[0]!.y.toFixed(2)}`;
  for (let i = 0; i < points.length - 1; i += 1) {
    const from = points[i]!;
    const to = points[i + 1]!;
    const dx = to.x - from.x;
    const c1x = from.x + dx / 3;
    const c1y = from.y + ((tangents[i] ?? 0) * dx) / 3;
    const c2x = to.x - dx / 3;
    const c2y = to.y - ((tangents[i + 1] ?? 0) * dx) / 3;
    path += ` C${c1x.toFixed(2)},${c1y.toFixed(2)} ${c2x.toFixed(2)},${c2y.toFixed(2)} ${to.x.toFixed(2)},${to.y.toFixed(2)}`;
  }
  return path;
}

function xAxisIndices(length: number): readonly number[] {
  if (length === 0) return [];
  if (length <= 6) return Array.from({ length }, (_, index) => index);
  const count = 6;
  const indices: number[] = [];
  for (let slot = 0; slot < count; slot += 1) {
    const index = Math.round((slot * (length - 1)) / (count - 1));
    if (indices.at(-1) !== index) indices.push(index);
  }
  return indices;
}

function TrendTooltip({
  tooltipRef,
  label,
  column,
  providers,
  loadingProviders,
  format,
}: {
  readonly tooltipRef: React.Ref<HTMLDivElement>;
  readonly label: string;
  readonly column: DayColumn | undefined;
  readonly providers: readonly UsageProviderKind[];
  readonly loadingProviders: ReadonlySet<UsageProviderKind>;
  readonly format: (value: number) => string;
}) {
  const partial = providers.some((provider) => loadingProviders.has(provider));
  const nonZeroProviders = providers.filter(
    (provider) => (column?.bands.find((band) => band.provider === provider)?.value ?? 0) > 0,
  );
  const shownProviders = nonZeroProviders.length > 0 ? nonZeroProviders : providers;

  return (
    <div
      ref={tooltipRef}
      className="surface-glass pointer-events-none absolute z-10 min-w-40 max-w-full rounded-xl border border-border/50 px-2.5 py-2 text-xs shadow-lg"
      style={{
        left: "var(--usage-tooltip-left, 0px)",
        top: "var(--usage-tooltip-top, 0px)",
      }}
    >
      <div className="mb-1 font-medium text-foreground">{label}</div>
      {shownProviders.map((provider) => {
        const { label: providerLabel, driverKind, color } = PROVIDER_PRESENTATION[provider];
        return (
          <div key={provider} className="flex items-center justify-between gap-3 py-0.5">
            <span className="flex items-center gap-1.5 text-muted-foreground">
              <span
                aria-hidden
                className="size-2 shrink-0 rounded-xs"
                style={{ backgroundColor: color }}
              />
              <ProviderInstanceIcon
                driverKind={driverKind}
                displayName={providerLabel}
                iconClassName="size-3"
              />
              {providerLabel}
            </span>
            <span
              className={cn(
                "tabular-nums",
                loadingProviders.has(provider) ? "text-muted-foreground" : "text-foreground",
              )}
            >
              {format(column?.bands.find((band) => band.provider === provider)?.value ?? 0)}
            </span>
          </div>
        );
      })}
      <div className="mt-1 flex items-center justify-between gap-3 border-t border-border pt-1 font-medium">
        <span className="text-muted-foreground">
          <T>Total</T>
        </span>
        <span className={cn("tabular-nums", partial ? "text-muted-foreground" : "text-foreground")}>
          {format(column?.total ?? 0)}
        </span>
      </div>
    </div>
  );
}

export function UsageTrendChart({
  providers,
  loadingProviders = NONE_LOADING,
  days,
  daily,
  hours,
  hourly,
  metric,
  chartMode,
  onChartModeChange,
  lockedPeriod,
  onToggleLockedPeriod,
  referenceTime,
  resolution,
  timeZone,
  hour12,
}: {
  readonly providers: readonly UsageProviderKind[];
  readonly loadingProviders?: ReadonlySet<UsageProviderKind>;
  readonly days: readonly string[];
  readonly daily: readonly DailyTotals[];
  readonly hours: readonly string[];
  readonly hourly: readonly HourlyTotals[];
  readonly metric: UsageChartMetric;
  readonly chartMode: UsageChartMode;
  readonly onChartModeChange: (mode: UsageChartMode) => void;
  readonly lockedPeriod: string | null;
  readonly onToggleLockedPeriod: (period: string) => void;
  readonly referenceTime: string | undefined;
  readonly resolution: "day" | "hour";
  readonly timeZone: string;
  readonly hour12: boolean;
}) {
  const gt = useGT();
  const locale = useLocale();
  const m = useMessages();
  const [hoverIndex, setHoverIndex] = useState<number | null>(null);
  const plotRef = useRef<HTMLDivElement | null>(null);
  const tooltipRef = useRef<HTMLDivElement | null>(null);
  const hoverPositionRef = useRef<{ x: number; y: number } | null>(null);

  const periods = resolution === "hour" ? hours : days;
  const totals: readonly (DailyTotals | HourlyTotals)[] = resolution === "hour" ? hourly : daily;
  const byPeriod = new Map(
    totals.map((entry) => ["hourStart" in entry ? entry.hourStart : entry.day, entry]),
  );
  const columns = buildPeriodColumns(periods, byPeriod, metric);

  const activeSet = new Set(providers);
  const visibleColumns = columns.map((column) => {
    const bands = column.bands.filter((band) => activeSet.has(band.provider));
    return {
      bands,
      total: bands.reduce((sum, band) => sum + band.value, 0),
    };
  });

  const peak =
    chartMode === "stacked-bar"
      ? visibleColumns.reduce((max, column) => Math.max(max, column.total), 0)
      : visibleColumns.reduce(
          (max, column) => column.bands.reduce((inner, band) => Math.max(inner, band.value), max),
          0,
        );
  const scale =
    peak === 0 && loadingProviders.size > 0
      ? { max: TICK_COUNT, ticks: [0, 1, 2, 3, 4], labeled: false }
      : { ...niceScale(peak, TICK_COUNT), labeled: true };

  const format = metric === "tokens" ? formatTokens : (value: number) => formatUsd(value, locale);
  const formatPeriod = (period: string) =>
    resolution === "hour"
      ? formatHourShort(period, timeZone, hour12, locale)
      : formatDayShort(period, locale);
  const formatTooltipPeriod = (period: string) =>
    resolution === "hour" && referenceTime !== undefined
      ? formatRelativeHourShort(period, referenceTime, timeZone, hour12, m, locale)
      : formatPeriod(period);

  const slotWidth = periods.length > 0 ? VIEW_WIDTH / periods.length : VIEW_WIDTH;
  const barWidth = Math.max(4, Math.min(40, slotWidth * 0.68));
  const lineStepX = periods.length < 2 ? 0 : VIEW_WIDTH / (periods.length - 1);

  const providerLinePaths = providers.map((provider) => {
    const slot = PROVIDER_ORDER.indexOf(provider);
    const points = columns.map((column, index) => ({
      x: periods.length < 2 ? VIEW_WIDTH / 2 : index * lineStepX,
      y: valueToY(column.bands[slot]?.value ?? 0, scale.max),
    }));
    const line = smoothLinePath(points);
    const area =
      line === "" || periods.length < 2
        ? ""
        : `${line} L${VIEW_WIDTH},${VIEW_HEIGHT} L0,${VIEW_HEIGHT} Z`;
    return { provider, loading: loadingProviders.has(provider), line, area };
  });

  const positionTooltip = () => {
    const plot = plotRef.current;
    const tooltip = tooltipRef.current;
    const hoverPosition = hoverPositionRef.current;
    if (plot === null || tooltip === null || hoverPosition === null) return;
    const gap = 12;
    const tooltipWidth = tooltip.offsetWidth;
    const tooltipHeight = tooltip.offsetHeight;
    const plotWidth = plot.clientWidth;
    const plotHeight = plot.clientHeight;
    const preferredLeft =
      hoverPosition.x + gap + tooltipWidth <= plotWidth
        ? hoverPosition.x + gap
        : hoverPosition.x - gap - tooltipWidth;
    const preferredTop =
      hoverPosition.y + gap + tooltipHeight <= plotHeight
        ? hoverPosition.y + gap
        : hoverPosition.y - gap - tooltipHeight;
    const left = Math.min(Math.max(0, preferredLeft), Math.max(0, plotWidth - tooltipWidth));
    const top = Math.min(Math.max(0, preferredTop), Math.max(0, plotHeight - tooltipHeight));
    plot.style.setProperty("--usage-tooltip-left", `${left}px`);
    plot.style.setProperty("--usage-tooltip-top", `${top}px`);
  };

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- updates hover tooltip CSS variables before paint and on ResizeObserver
  useLayoutEffect(() => {
    if (hoverIndex === null) return;
    positionTooltip();
    const plot = plotRef.current;
    const tooltip = tooltipRef.current;
    if (plot === null || tooltip === null) return;
    return observeResize([plot, tooltip], positionTooltip);
  }, [hoverIndex, positionTooltip]);

  const indexFromClientX = (clientX: number, bounds: DOMRect): number => {
    if (periods.length === 0 || bounds.width <= 0) return 0;
    const localX = Math.min(bounds.width, Math.max(0, clientX - bounds.left));
    if (chartMode === "stacked-bar") {
      return Math.min(
        periods.length - 1,
        Math.max(0, Math.floor((localX / bounds.width) * periods.length)),
      );
    }
    return Math.min(
      periods.length - 1,
      Math.max(0, Math.round((localX / bounds.width) * Math.max(1, periods.length - 1))),
    );
  };

  const handleMove = (event: React.MouseEvent<HTMLDivElement>) => {
    const plot = plotRef.current;
    if (plot === null || periods.length === 0) return;
    const bounds = plot.getBoundingClientRect();
    if (bounds.width === 0) return;
    const localX = Math.min(bounds.width, Math.max(0, event.clientX - bounds.left));
    const localY = Math.min(bounds.height, Math.max(0, event.clientY - bounds.top));
    hoverPositionRef.current = { x: localX, y: localY };
    positionTooltip();
    setHoverIndex(indexFromClientX(event.clientX, bounds));
  };

  const handlePlotClick = (event: React.MouseEvent<HTMLDivElement>) => {
    const plot = plotRef.current;
    if (plot === null || periods.length === 0) return;
    const index = indexFromClientX(event.clientX, plot.getBoundingClientRect());
    const period = periods[index];
    if (period !== undefined) onToggleLockedPeriod(period);
  };

  const handlePlotKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (periods.length === 0) return;
    if (event.key === "ArrowRight") {
      event.preventDefault();
      setHoverIndex((prev) => (prev === null ? 0 : Math.min(periods.length - 1, prev + 1)));
      return;
    }
    if (event.key === "ArrowLeft") {
      event.preventDefault();
      setHoverIndex((prev) => (prev === null ? periods.length - 1 : Math.max(0, prev - 1)));
      return;
    }
    if (event.key === "Enter" || event.key === " ") {
      const targetIndex =
        hoverIndex ?? (lockedPeriod !== null ? periods.indexOf(lockedPeriod) : periods.length - 1);
      const target = periods[targetIndex];
      if (target !== undefined) {
        event.preventDefault();
        onToggleLockedPeriod(target);
      }
      return;
    }
    if (event.key === "Escape" && lockedPeriod !== null) {
      event.preventDefault();
      onToggleLockedPeriod(lockedPeriod);
    }
  };

  const hoveredPeriod = hoverIndex === null ? undefined : periods[hoverIndex];
  const axisTicks = xAxisIndices(periods.length);

  return (
    <div
      data-testid="usage-trend-chart"
      data-chart-mode={chartMode}
      className="flex min-w-0 flex-col gap-3 rounded-xl border border-border/70 bg-card/65 p-4"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <h2 className="text-sm font-medium text-foreground">
            {resolution === "hour"
              ? metric === "tokens"
                ? gt("Hourly processed tokens")
                : gt("Hourly cost")
              : metric === "tokens"
                ? gt("Daily processed tokens")
                : gt("Daily cost")}
          </h2>
          {lockedPeriod !== null ? (
            <button
              type="button"
              data-testid="usage-locked-period-chip"
              onClick={() => onToggleLockedPeriod(lockedPeriod)}
              className="cursor-pointer rounded-full bg-info/12 px-2 py-0.5 text-2xs font-medium text-info-foreground transition-colors outline-none hover:bg-info/20 focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring"
            >
              {gt("Pinned: {period} ×", { period: formatTooltipPeriod(lockedPeriod) })}
            </button>
          ) : null}
        </div>
        <ToggleGroup
          aria-label={gt("Chart style")}
          variant="segmented"
          value={[chartMode]}
          onValueChange={(next) => {
            const value = next[0];
            if (value === "stacked-bar" || value === "line") onChartModeChange(value);
          }}
        >
          <Toggle value="stacked-bar" data-testid="usage-chart-mode-bar">
            <T>Stacked bars</T>
          </Toggle>
          <Toggle value="line" data-testid="usage-chart-mode-line">
            <T>Lines</T>
          </Toggle>
        </ToggleGroup>
      </div>

      <div className="flex min-h-0 flex-1 flex-col gap-1.5">
        <div className="flex min-h-56 flex-1 gap-2">
          <div aria-hidden className="relative w-14 shrink-0">
            {scale.labeled
              ? scale.ticks.map((tick) => (
                  <span
                    key={tick}
                    className="absolute right-0 -translate-y-1/2 text-3xs text-muted-foreground tabular-nums"
                    style={{ top: `${(valueToY(tick, scale.max) / VIEW_HEIGHT) * 100}%` }}
                  >
                    {tick === 0 ? "0" : format(tick)}
                  </span>
                ))
              : null}
          </div>

          <div
            ref={plotRef}
            role="group"
            tabIndex={0}
            aria-label={gt("Usage trend chart; use arrow keys and Enter to pin a bucket")}
            className="relative min-h-56 flex-1 cursor-pointer rounded-md outline-none select-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
            onMouseMove={handleMove}
            onMouseLeave={() => {
              hoverPositionRef.current = null;
              setHoverIndex(null);
            }}
            onClick={handlePlotClick}
            onKeyDown={handlePlotKeyDown}
          >
            <svg
              className="h-full w-full"
              viewBox={`0 0 ${VIEW_WIDTH} ${VIEW_HEIGHT}`}
              preserveAspectRatio="none"
              aria-hidden
            >
              {scale.ticks.map((tick) => {
                const y = valueToY(tick, scale.max);
                return (
                  <line
                    key={tick}
                    x1={0}
                    x2={VIEW_WIDTH}
                    y1={y}
                    y2={y}
                    stroke="currentColor"
                    strokeWidth={1}
                    className="text-border"
                    vectorEffect="non-scaling-stroke"
                  />
                );
              })}

              {chartMode === "stacked-bar" ? (
                visibleColumns.map((column, index) => {
                  const period = periods[index] ?? String(index);
                  const x = index * slotWidth + (slotWidth - barWidth) / 2;
                  const isLocked = lockedPeriod === period;
                  const dimmed = lockedPeriod !== null && !isLocked;
                  let running = 0;
                  return (
                    <g
                      key={period}
                      data-testid="usage-chart-bar-group"
                      data-period={period}
                      opacity={dimmed ? 0.38 : 1}
                    >
                      {hoverIndex === index ? (
                        <rect
                          x={index * slotWidth}
                          y={PLOT_TOP}
                          width={slotWidth}
                          height={VIEW_HEIGHT - PLOT_TOP}
                          fill="var(--muted)"
                          fillOpacity={0.35}
                        />
                      ) : null}
                      {column.bands.map((band) => {
                        if (band.value <= 0 || scale.max <= 0) return null;
                        const yBottom = valueToY(running, scale.max);
                        running += band.value;
                        const yTop = valueToY(running, scale.max);
                        const height = Math.max(1.5, yBottom - yTop);
                        return (
                          <rect
                            key={band.provider}
                            x={x}
                            y={yTop}
                            width={barWidth}
                            height={height}
                            fill={PROVIDER_PRESENTATION[band.provider].color}
                            opacity={loadingProviders.has(band.provider) ? 0.45 : 0.9}
                          />
                        );
                      })}
                      {isLocked && column.total > 0 && scale.max > 0 ? (
                        <rect
                          x={x - 1}
                          y={valueToY(column.total, scale.max) - 1}
                          width={barWidth + 2}
                          height={Math.max(2, VIEW_HEIGHT - valueToY(column.total, scale.max) + 1)}
                          fill="none"
                          stroke="var(--foreground)"
                          strokeWidth={1.5}
                          vectorEffect="non-scaling-stroke"
                        />
                      ) : null}
                    </g>
                  );
                })
              ) : (
                <>
                  {providerLinePaths.map(({ provider, loading, area }) =>
                    area ? (
                      <path
                        key={`area:${provider}`}
                        d={area}
                        className={cn("transition-opacity", loading && "opacity-40 delay-150")}
                        fill={PROVIDER_PRESENTATION[provider].color}
                        fillOpacity={0.09}
                      />
                    ) : null,
                  )}
                  {providerLinePaths.map(({ provider, loading, line }) =>
                    line ? (
                      <path
                        key={`line:${provider}`}
                        d={line}
                        className={cn("transition-opacity", loading && "opacity-40 delay-150")}
                        fill="none"
                        stroke={PROVIDER_PRESENTATION[provider].color}
                        strokeWidth={2}
                        vectorEffect="non-scaling-stroke"
                      />
                    ) : null,
                  )}
                  {lockedPeriod !== null && periods.includes(lockedPeriod) ? (
                    <line
                      x1={periods.indexOf(lockedPeriod) * lineStepX}
                      x2={periods.indexOf(lockedPeriod) * lineStepX}
                      y1={PLOT_TOP}
                      y2={VIEW_HEIGHT}
                      stroke="var(--foreground)"
                      strokeWidth={1.5}
                      strokeDasharray="4 3"
                      vectorEffect="non-scaling-stroke"
                    />
                  ) : null}
                  {hoverIndex !== null ? (
                    <line
                      x1={periods.length < 2 ? VIEW_WIDTH / 2 : hoverIndex * lineStepX}
                      x2={periods.length < 2 ? VIEW_WIDTH / 2 : hoverIndex * lineStepX}
                      y1={PLOT_TOP}
                      y2={VIEW_HEIGHT}
                      stroke="currentColor"
                      strokeWidth={1}
                      className="text-muted-foreground"
                      vectorEffect="non-scaling-stroke"
                    />
                  ) : null}
                </>
              )}
            </svg>

            {hoverIndex !== null && hoveredPeriod !== undefined ? (
              <TrendTooltip
                tooltipRef={tooltipRef}
                label={formatTooltipPeriod(hoveredPeriod)}
                column={visibleColumns[hoverIndex]}
                providers={providers}
                loadingProviders={loadingProviders}
                format={format}
              />
            ) : null}
          </div>
        </div>

        <div
          aria-hidden
          className="flex justify-between pl-16 text-3xs text-muted-foreground uppercase"
        >
          {axisTicks.map((index) => (
            <span key={index}>{periods[index] ? formatPeriod(periods[index]!) : ""}</span>
          ))}
        </div>

        <div className="sr-only">
          <table>
            <caption>
              {resolution === "hour"
                ? metric === "tokens"
                  ? gt("Hourly processed tokens by provider")
                  : gt("Hourly cost by provider")
                : metric === "tokens"
                  ? gt("Daily processed tokens by provider")
                  : gt("Daily cost by provider")}
            </caption>
            <thead>
              <tr>
                <th scope="col">{resolution === "hour" ? gt("Hour") : gt("Day")}</th>
                {providers.map((provider) => (
                  <th key={provider} scope="col">
                    {PROVIDER_PRESENTATION[provider].label}
                  </th>
                ))}
                <th scope="col">
                  <T>Total</T>
                </th>
              </tr>
            </thead>
            <tbody>
              {periods.map((period, index) => {
                const column = visibleColumns[index];
                return (
                  <tr key={period}>
                    <th scope="row">{formatTooltipPeriod(period)}</th>
                    {providers.map((provider) => (
                      <td key={provider}>
                        {format(
                          column?.bands.find((band) => band.provider === provider)?.value ?? 0,
                        )}
                      </td>
                    ))}
                    <td>{format(column?.total ?? 0)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
