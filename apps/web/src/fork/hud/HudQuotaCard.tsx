import type { ServerProviderUsageWindow } from "@t3tools/contracts";
import {
  type LimitPace,
  type LimitPoolWindow,
  paceOf,
  paceRemainingPercent,
  remainingPercent,
} from "@t3tools/shared/usageLimits";
import { formatDuration, limitsNotice } from "@t3tools/shared/usageLimitsCopy";
import { Link } from "@tanstack/react-router";
import { ArrowUpRightIcon } from "lucide-react";
import { msg, T, useGT, useMessages } from "gt-react";
import type { ReactNode } from "react";

import {
  nextPoolReset,
  poolSources,
  type ThreadDetailsLimits,
} from "~/components/chat/ThreadDetailsUsage.logic";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";
import { usePrimarySettings } from "~/hooks/useSettings";
import { cn } from "~/lib/utils";
import { formatUpcomingTimestamp } from "~/timestampFormat";

const PACE_LABEL: Record<LimitPace, string> = {
  ahead: msg("Ahead of pace"),
  on: msg("On pace"),
  under: msg("Under pace"),
};

type QuotaTone = "error" | "warning" | "normal";

function quotaTone(left: number): QuotaTone {
  if (left <= 10) return "error";
  if (left <= 20) return "warning";
  return "normal";
}

function QuotaWindowRow(props: {
  readonly label: string;
  readonly remaining: number;
  readonly resetCountdown: string | null;
  readonly tick: number | null;
  readonly tooltip: ReactNode;
}) {
  const gt = useGT();
  const tone = quotaTone(props.remaining);
  const clamped = Math.max(0, Math.min(100, props.remaining));
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Link
            to="/usage"
            data-testid="hud-quota-row"
            aria-label={
              props.resetCountdown
                ? gt("{label}: {left}% left, resets in {duration}", {
                    label: props.label,
                    left: props.remaining,
                    duration: props.resetCountdown,
                  })
                : gt("{label}: {left}% left", { label: props.label, left: props.remaining })
            }
            className="group flex flex-col gap-1 rounded-lg px-1.5 py-1 outline-none transition-colors hover:bg-accent/60 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
          />
        }
      >
        <div className="flex items-baseline justify-between gap-2 text-2xs">
          <span className="min-w-0 truncate font-medium text-foreground/85 group-hover:text-foreground">
            {props.label}
          </span>
          <div className="flex shrink-0 items-baseline gap-1.5 tabular-nums">
            {props.resetCountdown ? (
              <span data-testid="hud-quota-countdown" className="text-3xs text-muted-foreground">
                {props.resetCountdown}
              </span>
            ) : null}
            <span
              className={cn(
                "font-semibold",
                tone === "error"
                  ? "text-error-foreground"
                  : tone === "warning"
                    ? "text-warning-foreground"
                    : "text-foreground",
              )}
            >
              {props.remaining}%
            </span>
          </div>
        </div>
        <span className="relative h-1 w-full rounded-full bg-muted/80">
          {clamped > 0 ? (
            <span
              className={cn(
                "absolute inset-y-0 left-0 rounded-full",
                tone === "error" ? "bg-error" : tone === "warning" ? "bg-warning" : "bg-success",
              )}
              style={{ width: `max(${clamped}%, 4px)` }}
            />
          ) : null}
          {props.tick !== null ? (
            <span
              aria-hidden
              className="absolute -top-0.5 h-2 w-px -translate-x-1/2 bg-foreground/75"
              style={{ left: `clamp(0.5px, ${props.tick}%, calc(100% - 0.5px))` }}
            />
          ) : null}
        </span>
      </TooltipTrigger>
      <TooltipPopup side="left" sideOffset={14}>
        <div className="flex flex-col gap-0.5">
          {props.tooltip}
          <span className="text-muted-foreground">{gt("Open usage")}</span>
        </div>
      </TooltipPopup>
    </Tooltip>
  );
}

function InstanceWindowRow(props: {
  readonly window: ServerProviderUsageWindow;
  readonly now: number;
}) {
  const gt = useGT();
  const m = useMessages();
  const timestampFormat = usePrimarySettings((settings) => settings.timestampFormat);
  const { window, now } = props;
  const left = remainingPercent(window);
  const pace = paceOf(window, now);
  const timeLeft = paceRemainingPercent(window, now);
  const resetsAt = window.resetsAt ? Date.parse(window.resetsAt) : Number.NaN;
  const countdown =
    window.resetsAt && Number.isFinite(resetsAt) && resetsAt > now
      ? formatDuration(resetsAt - now, m)
      : null;

  return (
    <QuotaWindowRow
      label={window.label}
      remaining={left}
      resetCountdown={countdown}
      tick={timeLeft}
      tooltip={
        <>
          <span className="text-foreground">
            {gt("{label}: {left}% left", { label: window.label, left })}
          </span>
          {pace && timeLeft !== null ? (
            <span className="text-muted-foreground">
              {m(PACE_LABEL[pace])} · {gt("{timeLeft}% of the window left", { timeLeft })}
            </span>
          ) : null}
          {window.resetsAt && countdown !== null ? (
            <span className="text-muted-foreground">
              {gt("Resets in {duration} · {time}", {
                duration: countdown,
                time: formatUpcomingTimestamp(window.resetsAt, timestampFormat, now, undefined, m),
              })}
            </span>
          ) : null}
        </>
      }
    />
  );
}

export function hasUsableHudQuotaLimits(
  limits: ThreadDetailsLimits | null,
): limits is ThreadDetailsLimits {
  if (limits === null) return false;
  if (limits.kind === "pool") return limits.windows.length > 0;
  return limitsNotice(limits.limits) === null && limits.limits.windows.length > 0;
}

function poolRemainingTickPercent(window: LimitPoolWindow, now: number): number | null {
  let weightedSum = 0;
  let totalWeight = 0;
  for (const member of window.members) {
    const remaining = paceRemainingPercent(member.window, now);
    if (remaining === null) continue;
    const weight = member.refillPercent > 0 ? member.refillPercent : 1;
    weightedSum += remaining * weight;
    totalWeight += weight;
  }
  return totalWeight > 0 ? Math.round(weightedSum / totalWeight) : null;
}

function PoolWindowRow(props: { readonly window: LimitPoolWindow; readonly now: number }) {
  const gt = useGT();
  const m = useMessages();
  const timestampFormat = usePrimarySettings((settings) => settings.timestampFormat);
  const { window, now } = props;
  const left = window.remainingPercent;
  const accounts = window.members.length;
  const from = poolSources(window);
  const sourceLabels = [...from.hubs, ...(from.signedIn ? [gt("Signed-in accounts")] : [])];
  const next = nextPoolReset(window, now);
  const resetsAt = next?.member.window.resetsAt;
  const countdown = next && resetsAt ? formatDuration(next.at - now, m) : null;
  const reset =
    next && resetsAt && countdown !== null
      ? {
          duration: countdown,
          time: formatUpcomingTimestamp(resetsAt, timestampFormat, now, undefined, m),
        }
      : null;

  return (
    <QuotaWindowRow
      label={window.label}
      remaining={left}
      resetCountdown={countdown}
      tick={poolRemainingTickPercent(window, now)}
      tooltip={
        <>
          <span className="text-foreground">
            {accounts > 1
              ? gt("{label}: {left}% left across {accounts} accounts", {
                  label: window.label,
                  left,
                  accounts,
                })
              : gt("{label}: {left}% left", { label: window.label, left })}
          </span>
          {window.pace ? (
            <span className="text-muted-foreground">{m(PACE_LABEL[window.pace])}</span>
          ) : null}
          {next && reset ? (
            <span className="text-muted-foreground">
              {accounts > 1
                ? gt("+{percent}% in {duration} · {time}", {
                    percent: next.restoresPercent,
                    ...reset,
                  })
                : gt("Resets in {duration} · {time}", reset)}
            </span>
          ) : null}
          {sourceLabels.length > 0 ? (
            <span className="text-muted-foreground">
              {gt("From {sources}", { sources: sourceLabels.join(", ") })}
            </span>
          ) : null}
        </>
      }
    />
  );
}

export function HudQuotaCard(props: {
  readonly limits: ThreadDetailsLimits;
  readonly now: number;
}) {
  const gt = useGT();
  const { limits, now } = props;

  if (!hasUsableHudQuotaLimits(limits)) return null;

  return (
    <section
      aria-label={gt("Usage limits")}
      data-testid="hud-quota-card"
      className="flex flex-col gap-1.5 rounded-xl border border-border/65 bg-card/65 p-2.5"
    >
      <div className="flex items-center justify-between gap-2">
        <span className="text-2xs font-semibold tracking-wide text-muted-foreground">
          <T context="HUD card title">Quota</T>
        </span>
        <Link
          to="/usage"
          aria-label={gt("Open usage")}
          className="inline-flex items-center gap-0.5 rounded px-1 py-0.5 text-3xs text-muted-foreground outline-none transition-colors hover:text-foreground focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring"
        >
          <span>
            <T context="usage page link label">Usage</T>
          </span>
          <ArrowUpRightIcon aria-hidden className="size-3" />
        </Link>
      </div>

      <div className="flex flex-col gap-0.5">
        {limits.kind === "pool"
          ? limits.windows.map((window) => (
              <PoolWindowRow key={window.id} window={window} now={now} />
            ))
          : limits.limits.windows.map((window) => (
              <InstanceWindowRow key={window.id} window={window} now={now} />
            ))}
      </div>
    </section>
  );
}
