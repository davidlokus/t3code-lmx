import {
  collectLimitAccounts,
  collectLimitPools,
  displayLimitWindows,
  paceRemainingPercent,
  type LimitPool,
  type LimitPoolWindow,
  type LimitPresentations,
} from "@t3tools/shared/usageLimits";
import {
  cursorUsageWindowDetails,
  formatDuration,
  formatResetsIn,
} from "@t3tools/shared/usageLimitsCopy";
import { computeWindowBurnPace } from "@t3tools/shared/usageLimitsIntelligence";
import { ArrowUpRightIcon, FlameIcon } from "lucide-react";
import { T, useGT, useMessages } from "gt-react";
import { useState } from "react";

import { ProviderInstanceIcon } from "~/components/chat/ProviderInstanceIcon";
import { providerClients } from "~/components/settings/providerDriverMeta";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";
import { useNowMinute } from "~/hooks/useNowMinute";
import { usePrimarySettings } from "~/hooks/useSettings";
import { cn } from "~/lib/utils";
import { formatUpcomingTimestamp } from "~/timestampFormat";
import { quotaRiskTone } from "./usageDashboard.logic";
import { RestrainedQuotaBar } from "./UsageLimitPrimitives";
import { restrainedTextClass } from "./usageLimitsPresentation";
import {
  type UsageQuotaDisplayMode,
  type UsageResetTimeMode,
  useUsageOptionsStore,
} from "./usageOptionsStore";

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
  quotaDisplayMode,
  resetTimeMode,
  onOpenLimits,
}: {
  readonly pool: LimitPool;
  readonly window: LimitPoolWindow;
  readonly nowMs: number;
  readonly quotaDisplayMode: UsageQuotaDisplayMode;
  readonly resetTimeMode: UsageResetTimeMode;
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
  const displayedPercent =
    quotaDisplayMode === "used" ? window.usedPercent : window.remainingPercent;
  const rawTick = poolTickPercent(window, nowMs);
  const tick = rawTick === null ? null : quotaDisplayMode === "used" ? 100 - rawTick : rawTick;
  const nextReset = window.resets[0];
  const resetWindow = nextReset?.member.window ?? window.members[0]?.window;
  const countdown = resetWindow ? formatResetsIn(resetWindow, nowMs, m, "refill") : null;
  const resetTime = resetWindow?.resetsAt
    ? formatUpcomingTimestamp(resetWindow.resetsAt, timestampFormat, nowMs, undefined, m) || null
    : null;
  const primaryReset =
    resetTimeMode === "exact" ? (resetTime ?? countdown) : (countdown ?? resetTime);
  const soonestExhaustionMs = window.members.reduce<number | null>((soonest, member) => {
    const pace = computeWindowBurnPace(member.window, nowMs);
    if (pace?.status !== "will-exhaust" || pace.projectedExhaustionMs === null) return soonest;
    return soonest === null
      ? pace.projectedExhaustionMs
      : Math.min(soonest, pace.projectedExhaustionMs);
  }, null);
  const exhaustEta =
    soonestExhaustionMs !== null
      ? formatDuration(Math.max(0, soonestExhaustionMs - nowMs), m)
      : null;
  const effectiveTone = tone === "normal" && exhaustEta !== null ? "warning" : tone;

  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <button
            type="button"
            data-testid="usage-quota-strip-chip"
            data-tone={tone}
            onClick={onOpenLimits}
            className={cn(
              "group flex min-w-44 max-w-60 shrink-0 cursor-pointer flex-col gap-1.5 rounded-lg border px-3 py-2 text-left transition-colors outline-none hover:bg-accent/45 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
              effectiveTone === "error"
                ? "border-error/40 bg-card/75"
                : effectiveTone === "warning"
                  ? "border-warning/35 bg-card/70"
                  : "border-border/55 bg-card/45",
            )}
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
          <span className="flex shrink-0 items-center gap-1">
            {exhaustEta ? (
              <FlameIcon
                data-testid="usage-quota-strip-burn-icon"
                className="size-3 text-warning-foreground"
                aria-hidden
              />
            ) : null}
            <span className={cn("font-semibold tabular-nums", restrainedTextClass(effectiveTone))}>
              {displayedPercent}%
            </span>
          </span>
        </div>
        <RestrainedQuotaBar
          percent={displayedPercent}
          tone={effectiveTone}
          tickPercent={tick}
          height="xs"
        />
        <div className="flex items-center justify-between gap-2 text-2xs text-muted-foreground/85 tabular-nums">
          <span className="truncate">
            {primaryReset ?? gt("{count} accounts", { count: window.members.length })}
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
            {windowLabel !== providerLabel
              ? `${providerLabel} (${windowLabel}): `
              : `${providerLabel}: `}
            {quotaDisplayMode === "used"
              ? gt("{used}% used", { used: window.usedPercent })
              : gt("{left}% left", { left: window.remainingPercent })}
          </span>
          {exhaustEta ? (
            <span className="text-warning-foreground">
              {window.members.length > 1
                ? gt("Fast burn: an account is projected to exhaust in {eta}", { eta: exhaustEta })
                : gt("Fast burn: projected to exhaust in {eta}", { eta: exhaustEta })}
            </span>
          ) : null}
          {resetTime || countdown ? (
            <span className="text-muted-foreground">
              {resetTimeMode === "exact"
                ? resetTime
                  ? gt("Resets {time}", { time: resetTime })
                  : countdown
                : resetTime && countdown
                  ? gt("Resets {time} ({countdown})", { time: resetTime, countdown })
                  : resetTime
                    ? gt("Resets {time}", { time: resetTime })
                    : countdown}
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
  const quotaDisplayMode = useUsageOptionsStore((state) => state.quotaDisplayMode);
  const resetTimeMode = useUsageOptionsStore((state) => state.resetTimeMode);
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
            quotaDisplayMode={quotaDisplayMode}
            resetTimeMode={resetTimeMode}
            onOpenLimits={onOpenLimits}
          />
        ))}
      </div>
    </section>
  );
}
