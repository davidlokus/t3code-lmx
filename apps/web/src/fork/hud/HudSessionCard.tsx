import { secondTick } from "@t3tools/client-runtime/clock";
import { useSyncExternalStore } from "react";
import { T, useGT, useLocale, useMessages } from "gt-react";

import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";
import { formatHudCompactDuration, type HudSessionMetrics } from "./hudMetrics.logic";

function formatCurrency(amount: number, currency: string, locale: string, fractionDigits: number) {
  const code = currency.trim().toUpperCase();
  if (/^[A-Z]{3}$/.test(code)) {
    try {
      return new Intl.NumberFormat(locale, {
        style: "currency",
        currency: code,
        minimumFractionDigits: fractionDigits,
        maximumFractionDigits: fractionDigits,
      }).format(amount);
    } catch {
      return `${code} ${amount.toFixed(fractionDigits)}`;
    }
  }
  return `${amount.toFixed(fractionDigits)} ${currency.trim()}`;
}

function formatCostAmount(cost: NonNullable<HudSessionMetrics["cost"]>, locale: string): string {
  if (cost.amount > 0 && cost.amount < 0.0001) {
    return `<${formatCurrency(0.0001, cost.currency, locale, 4)}`;
  }
  const fractionDigits = cost.amount > 0 && cost.amount < 0.01 ? 4 : 2;
  return formatCurrency(cost.amount, cost.currency, locale, fractionDigits);
}

function formatSpeed(tokensPerSecond: number | null): string {
  if (tokensPerSecond === null) return "–";
  if (tokensPerSecond > 0 && tokensPerSecond < 0.1) return "<0.1 tok/s";
  return `${tokensPerSecond.toFixed(1)} tok/s`;
}

function formatRuntimeModeLabel(
  runtimeMode: string | null,
  gt: ReturnType<typeof useGT>,
): string | null {
  switch (runtimeMode) {
    case "full-access":
      return gt("Full", { $context: "runtime access mode" });
    case "auto":
      return gt("Auto", { $context: "runtime access mode" });
    case "auto-accept-edits":
      return gt("Auto-edit", { $context: "runtime access mode" });
    case "approval-required":
      return gt("Approval", { $context: "runtime access mode" });
    default:
      return null;
  }
}

/** Isolated second-clock leaf mounted only while a run is actively executing. */
function HudLiveSessionDuration(props: {
  readonly completedDurationMs: number;
  readonly activeRunStartedAtMs: number;
  readonly earliestRunStartedAtMs: number | null;
}) {
  const gt = useGT();
  const m = useMessages();
  const nowMs = useSyncExternalStore(
    secondTick.subscribe,
    secondTick.getSnapshot,
    secondTick.getSnapshot,
  );
  const activeMs = props.completedDurationMs + Math.max(0, nowMs - props.activeRunStartedAtMs);
  const spanMs =
    props.earliestRunStartedAtMs !== null
      ? Math.max(0, nowMs - props.earliestRunStartedAtMs)
      : null;

  return (
    <>
      <span className="truncate text-xs font-semibold text-foreground tabular-nums">
        {formatHudCompactDuration(activeMs, m)}
      </span>
      <span className="truncate text-3xs text-muted-foreground tabular-nums">
        {spanMs !== null
          ? gt("Span {duration}", { duration: formatHudCompactDuration(spanMs, m) })
          : "–"}
      </span>
    </>
  );
}

export function HudSessionCard(props: { readonly metrics: HudSessionMetrics }) {
  const gt = useGT();
  const locale = useLocale();
  const m = useMessages();
  const { metrics } = props;

  const speedValue = formatSpeed(metrics.tokensPerSecond);
  const ttftValue = metrics.ttftMs !== null ? formatHudCompactDuration(metrics.ttftMs, m) : "–";
  const activeValue =
    metrics.activeDurationMs !== null ? formatHudCompactDuration(metrics.activeDurationMs, m) : "–";
  const spanLabel =
    metrics.wallClockSpanMs !== null
      ? gt("Span {duration}", { duration: formatHudCompactDuration(metrics.wallClockSpanMs, m) })
      : null;

  const billingValue =
    metrics.billingMode === "cost" && metrics.cost !== null
      ? formatCostAmount(metrics.cost, locale)
      : metrics.billingMode === "subscription"
        ? gt("Subscription")
        : "–";

  const modelValue = metrics.servedModel ?? metrics.requestedModel ?? "–";
  const modeBits: string[] = [];
  if (metrics.thinkingEffort) {
    modeBits.push(
      metrics.thinkingEffort === "enabled"
        ? gt("Thinking", { $context: "thinking enabled tag" })
        : metrics.thinkingEffort,
    );
  }
  if (metrics.interactionMode === "plan") {
    modeBits.push(gt("Plan", { $context: "interaction mode" }));
  }
  const runtimeLabel = formatRuntimeModeLabel(metrics.runtimeMode, gt);
  if (runtimeLabel !== null) modeBits.push(runtimeLabel);
  const modeSubtext = modeBits.join(" · ");

  return (
    <section
      aria-label={gt("Session KPIs")}
      data-testid="hud-session-card"
      className="flex flex-col gap-2 rounded-xl border border-border/65 bg-card/65 p-2.5"
    >
      <div className="flex items-center justify-between gap-2">
        <span className="text-2xs font-semibold tracking-wide text-muted-foreground">
          <T context="HUD card title">Session</T>
        </span>
        {metrics.turnCount > 0 ? (
          <span
            data-testid="hud-session-turns"
            className="text-3xs text-muted-foreground tabular-nums"
          >
            {gt("{count, plural, one {{count} turn} other {{count} turns}}", {
              count: metrics.turnCount,
            })}
          </span>
        ) : null}
      </div>

      <div className="grid grid-cols-2 gap-1.5">
        <div
          data-testid="hud-kpi-speed"
          className="flex min-w-0 flex-col gap-0.5 rounded-lg bg-muted/45 px-2 py-1.5"
        >
          <span className="text-3xs text-muted-foreground">
            <T context="session throughput label">Speed</T>
          </span>
          <span className="truncate text-xs font-semibold text-foreground tabular-nums">
            {speedValue}
          </span>
          <span className="truncate text-3xs text-muted-foreground tabular-nums">
            TTFT {ttftValue}
          </span>
        </div>

        <div
          data-testid="hud-kpi-duration"
          className="flex min-w-0 flex-col gap-0.5 rounded-lg bg-muted/45 px-2 py-1.5"
        >
          <span className="text-3xs text-muted-foreground">
            <T context="session active time label">Active</T>
          </span>
          {metrics.activeRunStartedAtMs !== null ? (
            <HudLiveSessionDuration
              completedDurationMs={metrics.completedDurationMs}
              activeRunStartedAtMs={metrics.activeRunStartedAtMs}
              earliestRunStartedAtMs={metrics.earliestRunStartedAtMs}
            />
          ) : (
            <>
              <span className="truncate text-xs font-semibold text-foreground tabular-nums">
                {activeValue}
              </span>
              <span className="truncate text-3xs text-muted-foreground tabular-nums">
                {spanLabel ?? "–"}
              </span>
            </>
          )}
        </div>

        <div
          data-testid="hud-kpi-billing"
          className="flex min-w-0 flex-col gap-0.5 rounded-lg bg-muted/45 px-2 py-1.5"
        >
          <span className="text-3xs text-muted-foreground">
            <T context="session cost label">Cost</T>
          </span>
          <span className="truncate text-xs font-semibold text-foreground tabular-nums">
            {billingValue}
          </span>
          <span className="truncate text-3xs text-muted-foreground">
            {metrics.billingMode === "subscription"
              ? gt("Quota plan")
              : metrics.billingMode === "cost"
                ? gt("Reported")
                : "–"}
          </span>
        </div>

        <div
          data-testid="hud-kpi-model"
          className="flex min-w-0 flex-col gap-0.5 rounded-lg bg-muted/45 px-2 py-1.5"
        >
          <span className="text-3xs text-muted-foreground">
            <T context="session model label">Model</T>
          </span>
          {metrics.modelDelta ? (
            <Tooltip>
              <TooltipTrigger
                render={
                  <span
                    tabIndex={0}
                    data-testid="hud-kpi-model-delta"
                    className="flex min-w-0 items-center gap-0.5 truncate text-xs font-semibold text-warning-foreground outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring"
                  />
                }
              >
                <span aria-hidden>→</span>
                <span className="truncate">{metrics.modelDelta.to}</span>
              </TooltipTrigger>
              <TooltipPopup side="left" sideOffset={12}>
                {gt("Requested {from}, served by {to}", {
                  from: metrics.modelDelta.from,
                  to: metrics.modelDelta.to,
                })}
              </TooltipPopup>
            </Tooltip>
          ) : (
            <span className="truncate text-xs font-semibold text-foreground">{modelValue}</span>
          )}
          <span className="truncate text-3xs text-muted-foreground">{modeSubtext || "–"}</span>
        </div>
      </div>
    </section>
  );
}
