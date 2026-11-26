import { paceRemainingPercent } from "@t3tools/shared/usageLimits";
import { formatResetsIn } from "@t3tools/shared/usageLimitsCopy";
import type { NormalizedLimitAccount } from "@t3tools/shared/usageLimitsIntelligence";
import { T, useGT, useLocale, useMessages } from "gt-react";
import { AlertTriangleIcon, CalendarCogIcon, TicketIcon, WalletIcon } from "lucide-react";

import { RedactedSensitiveText } from "~/components/settings/RedactedSensitiveText";
import { Button } from "~/components/ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";
import { usePrimarySettings } from "~/hooks/useSettings";
import { cn } from "~/lib/utils";
import { formatUpcomingOrBareUtcDate } from "~/timestampFormat";
import {
  BurnPaceTag,
  LimitSourceIcon,
  RestrainedQuotaBar,
  useSourceKindLabel,
} from "./UsageLimitPrimitives";
import {
  accountRiskTier,
  dedupeWindowScopeLabel,
  effectiveWindowTone,
  formatBalanceAmount,
  formatWindowAmounts,
  resolveAccountHeaderMeta,
  restrainedCardSurfaceClass,
  restrainedTextClass,
  sortAccountsByRisk,
} from "./usageLimitsPresentation";
import type { UsageQuotaDisplayMode, UsageResetTimeMode } from "./usageOptionsStore";

export function UsageLimitsMatrixView({
  accounts,
  now,
  quotaDisplayMode,
  resetTimeMode,
  onEditOverride,
}: {
  readonly accounts: readonly NormalizedLimitAccount[];
  readonly now: number;
  readonly quotaDisplayMode: UsageQuotaDisplayMode;
  readonly resetTimeMode: UsageResetTimeMode;
  readonly onEditOverride: (account: NormalizedLimitAccount) => void;
}) {
  const gt = useGT();
  const locale = useLocale();
  const m = useMessages();
  const sourceKindLabel = useSourceKindLabel();
  const timestampFormat = usePrimarySettings((settings) => settings.timestampFormat);

  if (accounts.length === 0) {
    return (
      <div
        data-testid="usage-limits-matrix-empty"
        className="rounded-xl border border-border/55 bg-card/45 px-5 py-10 text-center text-sm text-muted-foreground"
      >
        <T>No provider on the selected environments reports subscription limits.</T>
      </div>
    );
  }

  const orderedAccounts = sortAccountsByRisk(accounts);

  return (
    <div
      data-testid="usage-limits-matrix"
      className="grid grid-cols-1 items-start gap-3 md:grid-cols-2 xl:grid-cols-3"
    >
      {orderedAccounts.map((account) => {
        const riskTier = accountRiskTier(account);
        const rawSourceBadge = sourceKindLabel(account.sourceKind);
        const meta = resolveAccountHeaderMeta(account, rawSourceBadge);
        const resolvedSourceBadge =
          meta.sourceBadgeKind !== null ? sourceKindLabel(meta.sourceBadgeKind) : null;
        const balances = account.limits.balances ?? [];
        const credits = account.limits.resetCredits?.availableCount ?? 0;
        const renewalActionLabel = account.manualOverride
          ? gt("Edit details")
          : gt("Track renewal");
        const hasSubtitle =
          Boolean(account.email) ||
          Boolean(meta.whereText) ||
          Boolean(resolvedSourceBadge) ||
          credits > 0;

        return (
          <section
            key={account.key}
            data-testid="usage-matrix-account-card"
            data-risk-tier={riskTier}
            className={cn(
              "flex min-w-0 flex-col overflow-hidden rounded-xl border transition-colors",
              restrainedCardSurfaceClass(riskTier),
            )}
          >
            <div className="flex items-start justify-between gap-2 px-3.5 pt-3 pb-2.5">
              <div className="flex min-w-0 items-start gap-2.5">
                <div className="mt-0.5">
                  <LimitSourceIcon
                    driver={account.driver}
                    sourceKind={account.sourceKind}
                    label={meta.displayLabel}
                    accentColor={account.accentColor}
                    size="sm"
                  />
                </div>
                <div className="flex min-w-0 flex-col gap-0.5">
                  <div className="flex flex-wrap items-center gap-1.5">
                    <h3 className="truncate text-sm font-medium text-foreground">
                      {meta.displayLabel}
                    </h3>
                    {meta.planBadge ? (
                      <span
                        data-testid="usage-limit-plan-badge"
                        className="rounded bg-muted/80 px-1.5 py-0.5 text-3xs font-medium text-muted-foreground"
                      >
                        {meta.planBadge}
                      </span>
                    ) : null}
                  </div>
                  {hasSubtitle ? (
                    <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-2xs text-muted-foreground/85">
                      {account.email ? (
                        <RedactedSensitiveText
                          value={account.email}
                          ariaLabel={gt("Toggle account email visibility")}
                          revealTooltip={gt("Click to reveal email")}
                          hideTooltip={gt("Click to hide email")}
                        />
                      ) : null}
                      {meta.whereText ? <span className="truncate">{meta.whereText}</span> : null}
                      {resolvedSourceBadge ? (
                        <span className="truncate text-muted-foreground">
                          {resolvedSourceBadge}
                        </span>
                      ) : null}
                      {credits > 0 ? (
                        <span className="inline-flex items-center gap-0.5 font-medium text-foreground/80 tabular-nums">
                          <TicketIcon className="size-3 text-muted-foreground" aria-hidden />
                          {gt("{count} reset credits", { count: credits })}
                        </span>
                      ) : null}
                    </div>
                  ) : null}
                </div>
              </div>

              <Tooltip>
                <TooltipTrigger
                  render={
                    <Button
                      variant={account.manualOverride ? "secondary" : "ghost-muted"}
                      size="icon-xs"
                      aria-label={renewalActionLabel}
                      data-testid="usage-matrix-edit-override"
                      onClick={() => onEditOverride(account)}
                    />
                  }
                >
                  <CalendarCogIcon className="size-3.5" aria-hidden />
                </TooltipTrigger>
                <TooltipPopup side="top">{renewalActionLabel}</TooltipPopup>
              </Tooltip>
            </div>

            {account.limits.serviceNotice ? (
              <div
                className={cn(
                  "mx-3.5 mb-2 flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-2xs",
                  account.limits.serviceNotice.severity === "critical"
                    ? "bg-error/12 text-error-foreground"
                    : account.limits.serviceNotice.severity === "warning"
                      ? "bg-warning/12 text-warning-foreground"
                      : "bg-info/10 text-info-foreground",
                )}
              >
                <AlertTriangleIcon className="size-3 shrink-0" aria-hidden />
                <span className="break-words">{account.limits.serviceNotice.message}</span>
              </div>
            ) : null}

            {account.limits.unavailable?.reason === "probeFailed" ? (
              <div className="mx-3.5 mb-2 flex items-center gap-1.5 rounded-md bg-warning/12 px-2.5 py-1.5 text-2xs text-warning-foreground">
                <AlertTriangleIcon className="size-3 shrink-0" aria-hidden />
                <span className="break-words">
                  {account.limits.unavailable.message ?? gt("Could not read limits.")}
                </span>
              </div>
            ) : null}

            {account.windows.length > 0 ? (
              <div className="flex flex-col divide-y divide-border/40 border-t border-border/45 px-3.5">
                {account.windows.map((window) => {
                  const remainingRounded = Math.round(
                    Math.max(0, Math.min(100, window.remainingPercent)),
                  );
                  const usedRounded = Math.round(Math.max(0, Math.min(100, window.usedPercent)));
                  const displayedPercent =
                    quotaDisplayMode === "used" ? usedRounded : remainingRounded;
                  const tone = effectiveWindowTone(window);
                  const remainingPaceTick = paceRemainingPercent(window, now);
                  const tickPercent =
                    remainingPaceTick === null
                      ? null
                      : quotaDisplayMode === "used"
                        ? 100 - remainingPaceTick
                        : remainingPaceTick;
                  const countdown = formatResetsIn(window, now, m) || null;
                  const exactTime =
                    window.resetsAt && window.resetsAtMs !== null
                      ? formatUpcomingOrBareUtcDate(
                          window.resetsAt,
                          timestampFormat,
                          now,
                          locale,
                          m,
                        )
                      : null;
                  const primaryReset =
                    resetTimeMode === "exact"
                      ? exactTime
                        ? gt("Resets {time}", { time: exactTime })
                        : countdown
                      : (countdown ??
                        (exactTime ? gt("Resets {time}", { time: exactTime }) : null));
                  const amountsLabel = formatWindowAmounts(window, quotaDisplayMode, locale);
                  const scopeLabel = dedupeWindowScopeLabel(window.scopeLabel, {
                    displayLabel: meta.displayLabel,
                    plan: account.plan,
                    windowLabel: window.label,
                  });

                  return (
                    <div
                      key={window.id}
                      data-testid="usage-matrix-window-cell"
                      data-tone={tone}
                      className="flex min-w-0 flex-col gap-1.5 py-2.5"
                    >
                      <div className="flex items-baseline justify-between gap-2">
                        <div className="flex min-w-0 items-baseline gap-1.5">
                          <span className="truncate text-xs font-medium text-foreground/90">
                            {window.label}
                          </span>
                          {scopeLabel ? (
                            <span className="truncate text-3xs text-muted-foreground">
                              {scopeLabel}
                            </span>
                          ) : null}
                        </div>
                        <span
                          data-testid="usage-matrix-window-percent"
                          className={cn(
                            "shrink-0 text-xs font-semibold tabular-nums",
                            restrainedTextClass(tone),
                          )}
                        >
                          {quotaDisplayMode === "used"
                            ? gt("{percent}% used", { percent: displayedPercent })
                            : gt("{percent}% left", { percent: displayedPercent })}
                        </span>
                      </div>

                      <RestrainedQuotaBar
                        percent={displayedPercent}
                        tone={tone}
                        tickPercent={tickPercent}
                        height="xs"
                      />

                      <div className="flex flex-wrap items-center justify-between gap-x-2 gap-y-1 text-2xs text-muted-foreground/85 tabular-nums">
                        <span data-testid="usage-matrix-window-reset" className="truncate">
                          {primaryReset ?? gt("No reset schedule")}
                        </span>
                        <div className="flex items-center gap-1.5">
                          {amountsLabel ? (
                            <span className="text-muted-foreground">{amountsLabel}</span>
                          ) : null}
                          <BurnPaceTag
                            pace={window.pace}
                            remainingPercent={remainingRounded}
                            now={now}
                          />
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            ) : null}

            {balances.length > 0 ? (
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 border-t border-border/45 bg-muted/20 px-3.5 py-2">
                {balances.map((balance) => (
                  <span
                    key={balance.id}
                    data-testid="usage-matrix-balance-pill"
                    className="inline-flex items-center gap-1 text-2xs text-foreground tabular-nums"
                  >
                    <WalletIcon className="size-3 text-muted-foreground" aria-hidden />
                    <span className="text-muted-foreground">{balance.label}</span>
                    <span className="font-medium">{formatBalanceAmount(balance, locale)}</span>
                  </span>
                ))}
              </div>
            ) : null}
          </section>
        );
      })}
    </div>
  );
}
