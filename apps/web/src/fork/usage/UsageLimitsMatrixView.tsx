import type { ServerProviderUsageBalance } from "@t3tools/contracts";
import { paceRemainingPercent } from "@t3tools/shared/usageLimits";
import { formatDuration, formatResetsIn } from "@t3tools/shared/usageLimitsCopy";
import type {
  NormalizedLimitAccount,
  NormalizedLimitWindow,
  WindowBurnPace,
} from "@t3tools/shared/usageLimitsIntelligence";
import { T, useGT, useLocale, useMessages } from "gt-react";
import {
  AlertTriangleIcon,
  CalendarCogIcon,
  GlobeIcon,
  TicketIcon,
  WalletIcon,
} from "lucide-react";

import { ProviderInstanceIcon } from "~/components/chat/ProviderInstanceIcon";
import { providerClients } from "~/components/settings/providerDriverMeta";
import { RedactedSensitiveText } from "~/components/settings/RedactedSensitiveText";
import { Button } from "~/components/ui/button";
import { usePrimarySettings } from "~/hooks/useSettings";
import { cn } from "~/lib/utils";
import { formatUpcomingTimestamp } from "~/timestampFormat";
import { quotaRiskTone, type UsageRiskTone } from "./usageDashboard.logic";
import type { UsageQuotaDisplayMode, UsageResetTimeMode } from "./usageOptionsStore";

function riskToneTextClass(tone: UsageRiskTone): string {
  switch (tone) {
    case "error":
      return "text-error-foreground";
    case "warning":
      return "text-warning-foreground";
    case "normal":
      return "text-success-foreground";
  }
}

function riskToneBarClass(tone: UsageRiskTone): string {
  switch (tone) {
    case "error":
      return "bg-error";
    case "warning":
      return "bg-warning";
    case "normal":
      return "bg-success";
  }
}

function formatAmountWithUnit(amount: number, unit: string, locale: string): string {
  if (/^[A-Z]{3}$/.test(unit)) {
    try {
      return new Intl.NumberFormat(locale, {
        style: "currency",
        currency: unit,
        maximumFractionDigits: 2,
      }).format(amount);
    } catch {
      return `${amount.toFixed(2)} ${unit}`;
    }
  }
  const formatted = new Intl.NumberFormat(locale, { maximumFractionDigits: 2 }).format(amount);
  return `${formatted} ${unit}`;
}

function formatWindowAmounts(
  window: NormalizedLimitWindow,
  quotaDisplayMode: UsageQuotaDisplayMode,
  locale: string,
): string | null {
  if (!window.unit) return null;
  if (window.usedAmount !== undefined && window.limitAmount !== undefined) {
    const shown =
      quotaDisplayMode === "used"
        ? window.usedAmount
        : (window.remainingAmount ?? Math.max(0, window.limitAmount - window.usedAmount));
    return `${formatAmountWithUnit(shown, window.unit, locale)} / ${formatAmountWithUnit(window.limitAmount, window.unit, locale)}`;
  }
  if (quotaDisplayMode === "remaining" && window.remainingAmount !== undefined) {
    return formatAmountWithUnit(window.remainingAmount, window.unit, locale);
  }
  if (quotaDisplayMode === "used" && window.usedAmount !== undefined) {
    return formatAmountWithUnit(window.usedAmount, window.unit, locale);
  }
  return null;
}

function formatBalanceAmount(balance: ServerProviderUsageBalance, locale: string): string {
  const remaining = formatAmountWithUnit(balance.remaining, balance.unit, locale);
  if (balance.limit !== undefined) {
    return `${remaining} / ${formatAmountWithUnit(balance.limit, balance.unit, locale)}`;
  }
  return remaining;
}

function accountDisplayLabel(account: NormalizedLimitAccount): string {
  if (account.displayName) return account.displayName;
  if (account.driver) return providerClients.get(account.driver)?.label ?? String(account.driver);
  return account.sourceLabel ?? account.key;
}

function BurnPaceBadge({
  pace,
  remainingPercent,
  now,
}: {
  readonly pace: WindowBurnPace | null;
  readonly remainingPercent: number;
  readonly now: number;
}) {
  const gt = useGT();
  const m = useMessages();
  if (!pace || pace.status === "insufficient-data") return null;

  if (pace.status === "exhausted") {
    return (
      <span
        data-testid="usage-matrix-pace-badge"
        data-pace="exhausted"
        className="inline-flex items-center rounded-full bg-error/15 px-1.5 py-0.5 text-2xs font-medium text-error-foreground tabular-nums"
      >
        <T>Exhausted</T>
      </span>
    );
  }

  if (pace.status === "will-exhaust") {
    const eta =
      pace.projectedExhaustionMs !== null
        ? formatDuration(Math.max(0, pace.projectedExhaustionMs - now), m)
        : null;
    const toneClass =
      remainingPercent <= 15
        ? "bg-error/15 text-error-foreground"
        : "bg-warning/15 text-warning-foreground";
    return (
      <span
        data-testid="usage-matrix-pace-badge"
        data-pace="will-exhaust"
        className={cn(
          "inline-flex items-center rounded-full px-1.5 py-0.5 text-2xs font-medium tabular-nums",
          toneClass,
        )}
      >
        {eta
          ? gt("{ratio}× · empty in {eta}", { ratio: pace.paceRatio ?? "-", eta })
          : gt("{ratio}× pace", { ratio: pace.paceRatio ?? "-" })}
      </span>
    );
  }

  if (pace.status === "ahead") {
    return (
      <span
        data-testid="usage-matrix-pace-badge"
        data-pace="ahead"
        className="inline-flex items-center rounded-full bg-warning/15 px-1.5 py-0.5 text-2xs font-medium text-warning-foreground tabular-nums"
      >
        {gt("{ratio}× pace", { ratio: pace.paceRatio ?? "-" })}
      </span>
    );
  }

  if (pace.status === "under-pace") {
    return (
      <span
        data-testid="usage-matrix-pace-badge"
        data-pace="under-pace"
        className="inline-flex items-center rounded-full bg-success/12 px-1.5 py-0.5 text-2xs font-medium text-success-foreground tabular-nums"
      >
        <T>Under pace</T>
      </span>
    );
  }

  return (
    <span
      data-testid="usage-matrix-pace-badge"
      data-pace="on-pace"
      className="inline-flex items-center rounded-full bg-muted px-1.5 py-0.5 text-2xs font-medium text-muted-foreground tabular-nums"
    >
      <T>On pace</T>
    </span>
  );
}

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
  const timestampFormat = usePrimarySettings((settings) => settings.timestampFormat);

  if (accounts.length === 0) {
    return (
      <div
        data-testid="usage-limits-matrix-empty"
        className="rounded-xl border border-border/70 bg-card/65 px-5 py-10 text-center text-sm text-muted-foreground"
      >
        <T>No provider on the selected environments reports subscription limits.</T>
      </div>
    );
  }

  return (
    <div data-testid="usage-limits-matrix" className="flex flex-col gap-4">
      {accounts.map((account) => {
        const label = accountDisplayLabel(account);
        const where =
          account.environments.length > 0
            ? account.environments.map((environment) => environment.label).join(", ")
            : account.sourceLabel;
        const balances = account.limits.balances ?? [];
        const credits = account.limits.resetCredits?.availableCount ?? 0;

        return (
          <section
            key={account.key}
            data-testid="usage-matrix-account-card"
            className="flex flex-col gap-3 rounded-xl border border-border/70 bg-card/65 p-4"
          >
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div className="flex min-w-0 items-center gap-2.5">
                {account.driver ? (
                  <ProviderInstanceIcon
                    driverKind={account.driver}
                    displayName={label}
                    accentColor={account.accentColor}
                    indicatorBackground="var(--card)"
                    className="size-6 shrink-0"
                    iconClassName="size-4 text-foreground/85"
                  />
                ) : (
                  <span className="inline-flex size-6 shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground">
                    <GlobeIcon className="size-3.5" aria-hidden />
                  </span>
                )}
                <div className="flex min-w-0 flex-col gap-0.5">
                  <div className="flex flex-wrap items-center gap-2">
                    <h3 className="truncate text-sm font-medium text-foreground">{label}</h3>
                    {account.plan ? (
                      <span className="rounded-md bg-muted px-1.5 py-0.5 text-2xs font-medium text-muted-foreground">
                        {account.plan}
                      </span>
                    ) : null}
                    {account.sourceKind === "http" ? (
                      <span className="rounded-md bg-info/12 px-1.5 py-0.5 text-2xs font-medium text-info-foreground">
                        <T>HTTP source</T>
                      </span>
                    ) : account.sourceKind === "omp" ? (
                      <span className="rounded-md bg-info/12 px-1.5 py-0.5 text-2xs font-medium text-info-foreground">
                        <T>OMP cache</T>
                      </span>
                    ) : account.sourceKind === "kimi" ? (
                      <span className="rounded-md bg-info/12 px-1.5 py-0.5 text-2xs font-medium text-info-foreground">
                        <T>Kimi Code</T>
                      </span>
                    ) : account.sourceKind === "zai" ? (
                      <span className="rounded-md bg-info/12 px-1.5 py-0.5 text-2xs font-medium text-info-foreground">
                        <T>Z.ai</T>
                      </span>
                    ) : null}
                    {credits > 0 ? (
                      <span className="inline-flex items-center gap-1 rounded-md bg-muted px-1.5 py-0.5 text-2xs font-medium text-foreground tabular-nums">
                        <TicketIcon className="size-3 text-muted-foreground" aria-hidden />
                        {gt("{count} reset credits", { count: credits })}
                      </span>
                    ) : null}
                  </div>
                  <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-muted-foreground">
                    {account.email ? (
                      <RedactedSensitiveText
                        value={account.email}
                        ariaLabel={gt("Toggle account email visibility")}
                        revealTooltip={gt("Click to reveal email")}
                        hideTooltip={gt("Click to hide email")}
                      />
                    ) : null}
                    {where ? <span className="truncate">{where}</span> : null}
                  </div>
                </div>
              </div>

              <Button
                variant="ghost"
                size="xs"
                data-testid="usage-matrix-edit-override"
                onClick={() => onEditOverride(account)}
              >
                <CalendarCogIcon className="size-3.5" aria-hidden />
                <span>{account.manualOverride ? <T>Edit details</T> : <T>Track renewal</T>}</span>
              </Button>
            </div>

            {account.limits.serviceNotice ? (
              <div
                className={cn(
                  "flex items-center gap-2 rounded-lg px-3 py-2 text-xs",
                  account.limits.serviceNotice.severity === "critical"
                    ? "bg-error/15 text-error-foreground"
                    : account.limits.serviceNotice.severity === "warning"
                      ? "bg-warning/15 text-warning-foreground"
                      : "bg-info/12 text-info-foreground",
                )}
              >
                <AlertTriangleIcon className="size-3.5 shrink-0" aria-hidden />
                <span className="break-words">{account.limits.serviceNotice.message}</span>
              </div>
            ) : null}

            {account.limits.unavailable?.reason === "probeFailed" ? (
              <div className="flex items-center gap-2 rounded-lg bg-warning/15 px-3 py-2 text-xs text-warning-foreground">
                <AlertTriangleIcon className="size-3.5 shrink-0" aria-hidden />
                <span className="break-words">
                  {account.limits.unavailable.message ?? gt("Could not read limits.")}
                </span>
              </div>
            ) : null}

            {account.windows.length > 0 ? (
              <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2 lg:grid-cols-3">
                {account.windows.map((window) => {
                  const remainingRounded = Math.round(
                    Math.max(0, Math.min(100, window.remainingPercent)),
                  );
                  const usedRounded = Math.round(Math.max(0, Math.min(100, window.usedPercent)));
                  const displayedPercent =
                    quotaDisplayMode === "used" ? usedRounded : remainingRounded;
                  const tone = quotaRiskTone(remainingRounded);
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
                      ? formatUpcomingTimestamp(
                          window.resetsAt,
                          timestampFormat,
                          now,
                          undefined,
                          m,
                        ) || null
                      : null;
                  const primaryReset =
                    resetTimeMode === "exact"
                      ? exactTime
                        ? gt("Resets {time}", { time: exactTime })
                        : countdown
                      : (countdown ??
                        (exactTime ? gt("Resets {time}", { time: exactTime }) : null));
                  const amountsLabel = formatWindowAmounts(window, quotaDisplayMode, locale);

                  return (
                    <div
                      key={window.id}
                      data-testid="usage-matrix-window-cell"
                      data-tone={tone}
                      className="flex min-w-0 flex-col gap-2 rounded-lg border border-border/60 bg-background/60 p-3"
                    >
                      <div className="flex items-start justify-between gap-2">
                        <div className="flex min-w-0 flex-col gap-0.5">
                          <span className="truncate text-xs font-medium text-foreground">
                            {window.label}
                          </span>
                          {window.scopeLabel ? (
                            <span className="truncate text-2xs text-muted-foreground">
                              {window.scopeLabel}
                            </span>
                          ) : null}
                        </div>
                        <span
                          data-testid="usage-matrix-window-percent"
                          className={cn(
                            "shrink-0 text-sm font-semibold tabular-nums",
                            riskToneTextClass(tone),
                          )}
                        >
                          {quotaDisplayMode === "used"
                            ? gt("{percent}% used", { percent: displayedPercent })
                            : gt("{percent}% left", { percent: displayedPercent })}
                        </span>
                      </div>

                      <div className="relative h-1.5 w-full rounded-full bg-muted">
                        {displayedPercent > 0 ? (
                          <div
                            className={cn(
                              "absolute inset-y-0 left-0 rounded-full",
                              riskToneBarClass(tone),
                            )}
                            style={{ width: `max(${displayedPercent}%, 4px)` }}
                          />
                        ) : null}
                        {tickPercent !== null ? (
                          <span
                            aria-hidden
                            className="absolute -top-0.5 h-2.5 w-0.5 -translate-x-1/2 rounded-full bg-foreground/80"
                            style={{ left: `clamp(1px, ${tickPercent}%, calc(100% - 1px))` }}
                          />
                        ) : null}
                      </div>

                      <div className="flex flex-wrap items-center justify-between gap-1.5 text-2xs text-muted-foreground tabular-nums">
                        <span data-testid="usage-matrix-window-reset" className="truncate">
                          {primaryReset ?? gt("No reset schedule")}
                        </span>
                        <BurnPaceBadge
                          pace={window.pace}
                          remainingPercent={remainingRounded}
                          now={now}
                        />
                      </div>

                      {amountsLabel ? (
                        <span className="text-2xs text-muted-foreground tabular-nums">
                          {amountsLabel}
                        </span>
                      ) : null}
                    </div>
                  );
                })}
              </div>
            ) : null}

            {balances.length > 0 ? (
              <div className="flex flex-wrap items-center gap-2 border-t border-border/60 pt-2.5">
                {balances.map((balance) => (
                  <span
                    key={balance.id}
                    data-testid="usage-matrix-balance-pill"
                    className="inline-flex items-center gap-1.5 rounded-md bg-muted/70 px-2 py-1 text-2xs text-foreground tabular-nums"
                  >
                    <WalletIcon className="size-3 text-muted-foreground" aria-hidden />
                    <span className="text-muted-foreground">{balance.label}:</span>
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
