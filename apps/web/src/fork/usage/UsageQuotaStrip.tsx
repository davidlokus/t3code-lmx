import {
  collectLimitAccounts,
  collectLimitPools,
  displayLimitWindows,
  paceRemainingPercent,
  type LimitPool,
  type LimitPoolWindow,
  type LimitPresentations,
} from "@t3tools/shared/usageLimits";
import { cursorUsageWindowDetails, formatResetsIn } from "@t3tools/shared/usageLimitsCopy";
import { ArrowUpRightIcon } from "lucide-react";
import { T, useGT, useMessages } from "gt-react";
import { useState } from "react";

import { ProviderInstanceIcon } from "~/components/chat/ProviderInstanceIcon";
import { providerClients } from "~/components/settings/providerDriverMeta";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";
import { useNowMinute } from "~/hooks/useNowMinute";
import { usePrimarySettings } from "~/hooks/useSettings";
import { cn } from "~/lib/utils";
import { formatUpcomingTimestamp } from "~/timestampFormat";
import { quotaRiskTone, type UsageRiskTone } from "./usageDashboard.logic";

function toneTextClass(tone: UsageRiskTone): string {
  switch (tone) {
    case "error":
      return "text-error-foreground";
    case "warning":
      return "text-warning-foreground";
    case "normal":
      return "text-success-foreground";
  }
}

function toneBarClass(tone: UsageRiskTone): string {
  switch (tone) {
    case "error":
      return "bg-error";
    case "warning":
      return "bg-warning";
    case "normal":
      return "bg-success";
  }
}

function poolTickPercent(window: LimitPoolWindow, nowMs: number): number | null {
  let weighted = 0;
  let totalWeight = 0;
  for (const member of window.members) {
    const remaining = paceRemainingPercent(member.window, nowMs);
    if (remaining === null) continue;
    const weight = member.refillPercent > 0 ? member.refillPercent : 1;
    weighted += remaining * weight;
    totalWeight += weight;
  }
  return totalWeight > 0 ? Math.round(weighted / totalWeight) : null;
}

function QuotaStripChip({
  pool,
  window,
  nowMs,
  onOpenLimits,
}: {
  readonly pool: LimitPool;
  readonly window: LimitPoolWindow;
  readonly nowMs: number;
  readonly onOpenLimits: () => void;
}) {
  const gt = useGT();
  const m = useMessages();
  const timestampFormat = usePrimarySettings((settings) => settings.timestampFormat);
  const providerLabel = providerClients.get(pool.driver)?.label ?? String(pool.driver);
  const cursorDetails =
    pool.driver === "cursor" ? cursorUsageWindowDetails(window.id, pool, m) : undefined;
  const windowLabel =
    cursorDetails?.label === null ? providerLabel : (cursorDetails?.label ?? window.label);
  const tone = quotaRiskTone(window.remainingPercent);
  const clamped = Math.max(0, Math.min(100, window.remainingPercent));
  const tick = poolTickPercent(window, nowMs);
  const nextReset = window.resets[0];
  const resetWindow = nextReset?.member.window ?? window.members[0]?.window;
  const countdown = resetWindow ? formatResetsIn(resetWindow, nowMs, m, "refill") : null;
  const resetTime = resetWindow?.resetsAt
    ? formatUpcomingTimestamp(resetWindow.resetsAt, timestampFormat, nowMs, undefined, m)
    : null;

  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <button
            type="button"
            data-testid="usage-quota-strip-chip"
            data-tone={tone}
            onClick={onOpenLimits}
            className="group flex min-w-44 max-w-64 shrink-0 cursor-pointer flex-col gap-1.5 rounded-lg border border-border/70 bg-card/70 px-3 py-2 text-left transition-colors outline-none hover:bg-accent/55 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
          />
        }
      >
        <div className="flex items-center justify-between gap-2 text-xs">
          <span className="flex min-w-0 items-center gap-1.5 font-medium text-foreground">
            <ProviderInstanceIcon
              driverKind={pool.driver}
              displayName={providerLabel}
              className="size-4 shrink-0"
              iconClassName="size-3.5 text-foreground/85"
            />
            <span className="truncate">{providerLabel}</span>
            {windowLabel !== providerLabel ? (
              <span className="truncate text-2xs font-normal text-muted-foreground">
                {windowLabel}
              </span>
            ) : null}
          </span>
          <span className={cn("shrink-0 font-semibold tabular-nums", toneTextClass(tone))}>
            {window.remainingPercent}%
          </span>
        </div>
        <div className="relative h-1.5 w-full rounded-full bg-muted">
          {clamped > 0 ? (
            <div
              className={cn("absolute inset-y-0 left-0 rounded-full", toneBarClass(tone))}
              style={{ width: `max(${clamped}%, 4px)` }}
            />
          ) : null}
          {tick !== null ? (
            <span
              aria-hidden
              className="absolute -top-0.5 h-2.5 w-0.5 -translate-x-1/2 rounded-full bg-foreground/80"
              style={{ left: `clamp(1px, ${tick}%, calc(100% - 1px))` }}
            />
          ) : null}
        </div>
        <div className="flex items-center justify-between gap-2 text-2xs text-muted-foreground tabular-nums">
          <span className="truncate">
            {countdown ?? gt("{count} accounts", { count: window.members.length })}
          </span>
          {window.members.length > 1 ? (
            <span className="shrink-0">
              {gt("{count} accts", { count: window.members.length })}
            </span>
          ) : null}
        </div>
      </TooltipTrigger>
      <TooltipPopup side="bottom">
        <div className="flex flex-col gap-0.5 text-xs">
          <span className="font-medium text-foreground">
            {providerLabel} · {windowLabel}: {gt("{left}% left", { left: window.remainingPercent })}
          </span>
          {resetTime ? (
            <span className="text-muted-foreground">
              {countdown
                ? gt("Resets {time} ({countdown})", { time: resetTime, countdown })
                : gt("Resets {time}", { time: resetTime })}
            </span>
          ) : null}
          <span className="text-muted-foreground">
            <T>Click to open detailed Limits view</T>
          </span>
        </div>
      </TooltipPopup>
    </Tooltip>
  );
}

/** Isolated minute-clock wrapper so Quota Strip countdowns refresh quietly once per minute. */
export function UsageQuotaStrip({
  presentations,
  onOpenLimits,
}: {
  readonly presentations: LimitPresentations;
  readonly onOpenLimits: () => void;
}) {
  const gt = useGT();
  const [mountNowMs] = useState(() => Date.now());
  const nowMinute = useNowMinute();
  const parsedMinute = Date.parse(`${nowMinute}:00Z`);
  const nowMs = Number.isFinite(parsedMinute) ? parsedMinute : mountNowMs;
  const pools = collectLimitPools(collectLimitAccounts(presentations), nowMs);
  const items = pools.flatMap((pool) =>
    displayLimitWindows(pool).map((window) => ({ pool, window })),
  );
  if (items.length === 0) return null;

  return (
    <section
      aria-label={gt("Subscription quota overview")}
      data-testid="usage-quota-strip"
      className="flex flex-col gap-2"
    >
      <div className="flex items-center justify-between gap-2">
        <h2 className="text-xs font-medium tracking-wide text-muted-foreground">
          <T>Active subscription quotas</T>
        </h2>
        <button
          type="button"
          onClick={onOpenLimits}
          className="inline-flex cursor-pointer items-center gap-1 rounded px-1.5 py-0.5 text-xs text-muted-foreground transition-colors outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
        >
          <span>
            <T>All limits</T>
          </span>
          <ArrowUpRightIcon className="size-3.5" aria-hidden />
        </button>
      </div>
      <div className="flex gap-2.5 overflow-x-auto pb-0.5">
        {items.map(({ pool, window }) => (
          <QuotaStripChip
            key={`${pool.driver}:${window.kind}:${window.id}`}
            pool={pool}
            window={window}
            nowMs={nowMs}
            onOpenLimits={onOpenLimits}
          />
        ))}
      </div>
    </section>
  );
}
