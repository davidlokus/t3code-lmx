import { formatDuration, formatResetsIn } from "@t3tools/shared/usageLimitsCopy";
import type {
  ResetTimelineEntry,
  ResetTimelineGroup,
} from "@t3tools/shared/usageLimitsIntelligence";
import { msg, T, useGT, useLocale, useMessages } from "gt-react";
import { ClockIcon } from "lucide-react";

import { usePrimarySettings } from "~/hooks/useSettings";
import { cn } from "~/lib/utils";
import { formatUpcomingOrBareUtcDate } from "~/timestampFormat";
import { LimitSourceIcon, RestrainedQuotaBar } from "./UsageLimitPrimitives";
import {
  accountDisplayLabel,
  effectiveWindowTone,
  restrainedTextClass,
} from "./usageLimitsPresentation";
import type { UsageQuotaDisplayMode, UsageResetTimeMode } from "./usageOptionsStore";

const GROUP_ORDER: readonly ResetTimelineGroup[] = ["next24h", "next7d", "later", "unscheduled"];

const GROUP_TITLES: Record<ResetTimelineGroup, string> = {
  next24h: msg("Next 24 hours"),
  next7d: msg("Next 7 days"),
  later: msg("Later"),
  unscheduled: msg("No reset schedule"),
};

export function UsageLimitsResetsView({
  resets,
  now,
  quotaDisplayMode,
  resetTimeMode,
}: {
  readonly resets: readonly ResetTimelineEntry[];
  readonly now: number;
  readonly quotaDisplayMode: UsageQuotaDisplayMode;
  readonly resetTimeMode: UsageResetTimeMode;
}) {
  const gt = useGT();
  const locale = useLocale();
  const m = useMessages();
  const timestampFormat = usePrimarySettings((settings) => settings.timestampFormat);

  if (resets.length === 0) {
    return (
      <div
        data-testid="usage-limits-resets-empty"
        className="rounded-xl border border-border/55 bg-card/45 px-5 py-10 text-center text-sm text-muted-foreground"
      >
        <T>No quota reset windows reported on the selected environments.</T>
      </div>
    );
  }

  return (
    <div data-testid="usage-limits-resets" className="flex flex-col gap-5">
      {GROUP_ORDER.map((group) => {
        const items = resets.filter((entry) => entry.group === group);
        if (items.length === 0) return null;
        return (
          <section
            key={group}
            data-testid={`usage-resets-group-${group}`}
            className="flex flex-col gap-2"
          >
            <div className="flex items-center justify-between gap-2 px-0.5">
              <h3 className="text-xs font-medium text-muted-foreground">
                {m(GROUP_TITLES[group])}
              </h3>
              <span className="text-2xs text-muted-foreground tabular-nums">
                {gt("{count, plural, one {{count} window} other {{count} windows}}", {
                  count: items.length,
                })}
              </span>
            </div>

            <div className="flex flex-col divide-y divide-border/45 overflow-hidden rounded-xl border border-border/55 bg-card/45">
              {items.map((entry) => {
                const { account, window } = entry;
                const label = accountDisplayLabel(account);
                const remainingRounded = Math.round(
                  Math.max(0, Math.min(100, window.remainingPercent)),
                );
                const usedRounded = Math.round(Math.max(0, Math.min(100, window.usedPercent)));
                const displayedPercent =
                  quotaDisplayMode === "used" ? usedRounded : remainingRounded;
                const tone = effectiveWindowTone(window);
                const countdown = formatResetsIn(window, now, m, "in") || null;
                const exactTime =
                  window.resetsAt && window.resetsAtMs !== null
                    ? formatUpcomingOrBareUtcDate(window.resetsAt, timestampFormat, now, locale, m)
                    : null;
                const primaryTime =
                  resetTimeMode === "exact" ? (exactTime ?? countdown) : (countdown ?? exactTime);
                const secondaryTime =
                  resetTimeMode === "exact"
                    ? countdown !== primaryTime
                      ? countdown
                      : null
                    : exactTime !== primaryTime
                      ? exactTime
                      : null;
                const pace = window.pace;
                const exhaustEta =
                  pace?.status === "will-exhaust" && pace.projectedExhaustionMs !== null
                    ? formatDuration(Math.max(0, pace.projectedExhaustionMs - now), m)
                    : null;

                return (
                  <div
                    key={`${account.key}:${window.id}`}
                    data-testid="usage-reset-row"
                    className="grid grid-cols-1 items-center gap-3 px-4 py-2.5 sm:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)_auto]"
                  >
                    <div className="flex min-w-0 items-center gap-2.5">
                      <LimitSourceIcon
                        driver={account.driver}
                        sourceKind={account.sourceKind}
                        label={label}
                        accentColor={account.accentColor}
                        size="sm"
                      />
                      <div className="flex min-w-0 flex-col gap-0.5">
                        <div className="flex flex-wrap items-center gap-1.5">
                          <span className="truncate text-sm font-medium text-foreground">
                            {label}
                          </span>
                          <span className="truncate text-xs text-muted-foreground">
                            {window.label}
                          </span>
                          {account.plan ? (
                            <span className="rounded bg-muted/80 px-1.5 py-0.5 text-3xs text-muted-foreground">
                              {account.plan}
                            </span>
                          ) : null}
                        </div>
                        {pace?.status === "exhausted" ? (
                          <span className="text-2xs font-medium text-error-foreground">
                            <T>Window exhausted until reset</T>
                          </span>
                        ) : exhaustEta ? (
                          <span className="text-2xs font-medium text-warning-foreground tabular-nums">
                            {gt("Projected to exhaust in {eta} before reset", { eta: exhaustEta })}
                          </span>
                        ) : null}
                      </div>
                    </div>

                    <div className="flex min-w-0 flex-col gap-1.5">
                      <div className="flex items-baseline justify-between gap-2 text-xs tabular-nums">
                        <span className={cn("font-semibold", restrainedTextClass(tone))}>
                          {quotaDisplayMode === "used"
                            ? gt("{percent}% used", { percent: displayedPercent })
                            : gt("{percent}% left", { percent: displayedPercent })}
                        </span>
                        {usedRounded > 0 ? (
                          <span className="text-2xs text-muted-foreground">
                            {gt("↻ +{percent}%", { percent: usedRounded })}
                          </span>
                        ) : null}
                      </div>
                      <RestrainedQuotaBar percent={displayedPercent} tone={tone} height="xs" />
                    </div>

                    <div className="flex items-center gap-1.5 text-xs tabular-nums sm:flex-col sm:items-end sm:gap-0.5">
                      <span
                        data-testid="usage-reset-row-time"
                        className="inline-flex items-center gap-1 font-medium text-foreground"
                      >
                        <ClockIcon className="size-3 text-muted-foreground" aria-hidden />
                        <span>{primaryTime ?? gt("Unscheduled")}</span>
                      </span>
                      {secondaryTime ? (
                        <span className="text-2xs text-muted-foreground">{secondaryTime}</span>
                      ) : null}
                    </div>
                  </div>
                );
              })}
            </div>
          </section>
        );
      })}
    </div>
  );
}
