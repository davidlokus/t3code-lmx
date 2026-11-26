import type { LimitPresentations } from "@t3tools/shared/usageLimits";
import { collectLimitsIntelligence } from "@t3tools/shared/usageLimitsIntelligence";
import { Link } from "@tanstack/react-router";
import { T, useGT } from "gt-react";
import { AlertTriangleIcon, LayoutGridIcon, ListIcon, Settings2Icon } from "lucide-react";
import { useState } from "react";

import { Toggle, ToggleGroup } from "~/components/ui/toggle-group";
import { useNowMinute } from "~/hooks/useNowMinute";
import { cn } from "~/lib/utils";
import { UsageLimitsAlertsView } from "./UsageLimitsAlertsView";
import { UsageLimitsExpiriesView } from "./UsageLimitsExpiriesView";
import { UsageLimitsMatrixView } from "./UsageLimitsMatrixView";
import { UsageLimitsPoolTableView } from "./UsageLimitsPoolTableView";
import { accountDisplayLabel, isAccountAtRisk } from "./usageLimitsPresentation";
import { UsageLimitsResetsView } from "./UsageLimitsResetsView";
import {
  type UsageLimitsLayout,
  type UsageLimitsLens,
  type UsageQuotaDisplayMode,
  type UsageResetTimeMode,
  useUsageOptionsStore,
} from "./usageOptionsStore";
import { UsageSubscriptionOverrideDialog } from "./UsageSubscriptionOverrideDialog";

function resolveLimitsNow(nowMinute: string, refreshTickNow: number): number {
  const parsedMinute = Date.parse(`${nowMinute}:00Z`);
  return Math.max(refreshTickNow, Number.isFinite(parsedMinute) ? parsedMinute : 0);
}

/**
 * Isolated minute-clock wrapper around the four-lens Limits view so countdowns update quietly
 * every minute without forcing full-page repaints when viewing Overview.
 */
export function UsageLimitsEnhanced({
  presentations,
  identityPresentations,
  refreshTickNow,
}: {
  readonly presentations: LimitPresentations;
  readonly identityPresentations: LimitPresentations;
  readonly refreshTickNow: number;
}) {
  const gt = useGT();
  const nowMinute = useNowMinute();
  const now = resolveLimitsNow(nowMinute, refreshTickNow);

  const limitsLens = useUsageOptionsStore((state) => state.limitsLens);
  const limitsLayout = useUsageOptionsStore((state) => state.limitsLayout);
  const quotaDisplayMode = useUsageOptionsStore((state) => state.quotaDisplayMode);
  const resetTimeMode = useUsageOptionsStore((state) => state.resetTimeMode);
  const alertThresholdPercent = useUsageOptionsStore((state) => state.alertThresholdPercent);
  const manualSubscriptionOverrides = useUsageOptionsStore(
    (state) => state.manualSubscriptionOverrides,
  );
  const setLimitsLens = useUsageOptionsStore((state) => state.setLimitsLens);
  const setLimitsLayout = useUsageOptionsStore((state) => state.setLimitsLayout);
  const setQuotaDisplayMode = useUsageOptionsStore((state) => state.setQuotaDisplayMode);
  const setResetTimeMode = useUsageOptionsStore((state) => state.setResetTimeMode);
  const setAlertThresholdPercent = useUsageOptionsStore((state) => state.setAlertThresholdPercent);
  const setManualSubscriptionOverride = useUsageOptionsStore(
    (state) => state.setManualSubscriptionOverride,
  );
  const clearManualSubscriptionOverride = useUsageOptionsStore(
    (state) => state.clearManualSubscriptionOverride,
  );

  const [editingAccountKey, setEditingAccountKey] = useState<string | null>(null);
  const [riskOnly, setRiskOnly] = useState(false);

  const intelligence = collectLimitsIntelligence({
    presentations,
    identityPresentations,
    now,
    alertThresholdPercent,
    manualOverrides: manualSubscriptionOverrides,
  });

  const atRiskAccounts = intelligence.accounts.filter(isAccountAtRisk);
  const effectiveRiskOnly = riskOnly && atRiskAccounts.length > 0;
  const visiblePoolAccounts = effectiveRiskOnly ? atRiskAccounts : intelligence.accounts;

  const editingAccount =
    editingAccountKey === null
      ? null
      : (intelligence.accounts.find((account) => account.key === editingAccountKey) ?? null);

  const totalAlerts =
    intelligence.summary.criticalAlertCount +
    intelligence.summary.warningAlertCount +
    intelligence.summary.infoAlertCount;
  const alertBadgeTone =
    intelligence.summary.criticalAlertCount > 0
      ? "bg-error/15 text-error-foreground"
      : intelligence.summary.warningAlertCount > 0
        ? "bg-warning/15 text-warning-foreground"
        : "bg-muted text-muted-foreground";

  const lenses: readonly {
    readonly value: UsageLimitsLens;
    readonly testId: string;
    readonly label: string;
    readonly badge?: number;
    readonly badgeTone?: string;
  }[] = [
    { value: "pools", testId: "usage-limits-lens-pools", label: gt("Pools") },
    { value: "resets", testId: "usage-limits-lens-resets", label: gt("Resets") },
    {
      value: "alerts",
      testId: "usage-limits-lens-alerts",
      label: gt("Alerts"),
      ...(totalAlerts > 0 ? { badge: totalAlerts, badgeTone: alertBadgeTone } : {}),
    },
    {
      value: "expiries",
      testId: "usage-limits-lens-expiries",
      label: gt("Expiries"),
      ...(intelligence.expiries.length > 0
        ? { badge: intelligence.expiries.length, badgeTone: "bg-muted text-muted-foreground" }
        : {}),
    },
  ];

  return (
    <div data-testid="usage-limits-enhanced" className="flex flex-col gap-4">
      <div className="flex flex-col gap-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
            <h2 className="text-sm font-semibold tracking-tight text-foreground">
              <T>Subscription quotas</T>
            </h2>
            <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1 text-xs text-muted-foreground tabular-nums">
              <span>
                {gt("{count, plural, one {{count} account} other {{count} accounts}}", {
                  count: intelligence.summary.accountCount,
                })}
              </span>
              <span aria-hidden className="h-3 w-px bg-border/70" />
              <span>
                {gt("{count, plural, one {{count} window} other {{count} windows}}", {
                  count: intelligence.summary.windowCount,
                })}
              </span>
              {totalAlerts > 0 ? (
                <>
                  <span aria-hidden className="h-3 w-px bg-border/70" />
                  <button
                    type="button"
                    onClick={() => setLimitsLens("alerts")}
                    className={cn(
                      "inline-flex cursor-pointer items-center gap-1 rounded px-1.5 py-0.5 text-2xs font-medium transition-opacity outline-none hover:opacity-85 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
                      alertBadgeTone,
                    )}
                  >
                    <AlertTriangleIcon className="size-3" aria-hidden />
                    <span>
                      {gt("{count, plural, one {{count} alert} other {{count} alerts}}", {
                        count: totalAlerts,
                      })}
                    </span>
                  </button>
                </>
              ) : null}
            </div>
          </div>

          <Link
            to="/settings/providers"
            hash="usage-providers"
            data-testid="usage-manage-hubs-link"
            aria-label={gt("Manage usage limit hubs")}
            className="inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-xs font-medium text-muted-foreground transition-colors outline-none hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
          >
            <Settings2Icon className="size-3.5" aria-hidden />
            <span>
              <T>Manage limit hubs</T>
            </span>
          </Link>
        </div>

        <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 border-b border-border/60 pb-1.5">
          <div role="tablist" aria-label={gt("Limits lens")} className="flex items-center gap-1">
            {lenses.map((lens) => {
              const active = limitsLens === lens.value;
              return (
                <button
                  key={lens.value}
                  type="button"
                  role="tab"
                  aria-selected={active}
                  data-testid={lens.testId}
                  onClick={() => setLimitsLens(lens.value)}
                  className={cn(
                    "relative inline-flex cursor-pointer items-center gap-1.5 rounded-md px-2.5 py-1.5 text-xs font-medium transition-colors outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
                    active
                      ? "text-foreground"
                      : "text-muted-foreground hover:bg-accent/50 hover:text-foreground",
                  )}
                >
                  <span>{lens.label}</span>
                  {lens.badge !== undefined ? (
                    <span
                      data-testid={
                        lens.value === "alerts" ? "usage-limits-alerts-count" : undefined
                      }
                      className={cn(
                        "rounded-full px-1.5 py-0.5 text-3xs leading-none font-semibold tabular-nums",
                        lens.badgeTone,
                      )}
                    >
                      {lens.badge}
                    </span>
                  ) : null}
                  {active ? (
                    <span
                      aria-hidden
                      className="absolute inset-x-2 -bottom-1.5 h-0.5 rounded-full bg-foreground"
                    />
                  ) : null}
                </button>
              );
            })}
          </div>

          <div className="flex flex-wrap items-center gap-2">
            {limitsLens === "pools" && atRiskAccounts.length > 0 ? (
              <button
                type="button"
                data-testid="usage-limits-risk-filter"
                aria-pressed={effectiveRiskOnly}
                onClick={() => setRiskOnly((prev) => !prev)}
                className={cn(
                  "inline-flex cursor-pointer items-center gap-1 rounded-md border px-2 py-1 text-2xs font-medium transition-colors outline-none tabular-nums focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
                  effectiveRiskOnly
                    ? "border-warning/40 bg-warning/15 text-warning-foreground"
                    : "border-border/60 bg-transparent text-muted-foreground hover:bg-accent/50 hover:text-foreground",
                )}
              >
                <span
                  aria-hidden
                  className={cn(
                    "size-1.5 rounded-full",
                    intelligence.summary.criticalAlertCount > 0 ? "bg-error" : "bg-warning",
                  )}
                />
                <span>{gt("At risk ({count})", { count: atRiskAccounts.length })}</span>
              </button>
            ) : null}

            {limitsLens === "pools" ? (
              <ToggleGroup
                aria-label={gt("Pools layout")}
                variant="segmented"
                value={[limitsLayout]}
                onValueChange={(next) => {
                  const value = next[0] as UsageLimitsLayout | undefined;
                  if (value === "pool" || value === "matrix") setLimitsLayout(value);
                }}
              >
                <Toggle value="matrix" data-testid="usage-limits-layout-matrix">
                  <LayoutGridIcon className="size-3.5" aria-hidden />
                  <span>
                    <T context="quota layout view">Cards</T>
                  </span>
                </Toggle>
                <Toggle value="pool" data-testid="usage-limits-layout-pool">
                  <ListIcon className="size-3.5" aria-hidden />
                  <span>
                    <T context="quota layout view">Table</T>
                  </span>
                </Toggle>
              </ToggleGroup>
            ) : null}

            {limitsLens === "pools" || limitsLens === "resets" || limitsLens === "alerts" ? (
              <ToggleGroup
                aria-label={gt("Quota display mode")}
                variant="segmented"
                value={[quotaDisplayMode]}
                onValueChange={(next) => {
                  const value = next[0] as UsageQuotaDisplayMode | undefined;
                  if (value === "remaining" || value === "used") setQuotaDisplayMode(value);
                }}
              >
                <Toggle value="remaining" data-testid="usage-quota-mode-remaining">
                  <T context="remaining usage percentage">Left</T>
                </Toggle>
                <Toggle value="used" data-testid="usage-quota-mode-used">
                  <T context="consumed usage percentage">Used</T>
                </Toggle>
              </ToggleGroup>
            ) : null}

            {limitsLens === "pools" || limitsLens === "resets" ? (
              <ToggleGroup
                aria-label={gt("Reset time format")}
                variant="segmented"
                value={[resetTimeMode]}
                onValueChange={(next) => {
                  const value = next[0] as UsageResetTimeMode | undefined;
                  if (value === "countdown" || value === "exact") setResetTimeMode(value);
                }}
              >
                <Toggle value="countdown" data-testid="usage-reset-mode-countdown">
                  <T>Countdown</T>
                </Toggle>
                <Toggle value="exact" data-testid="usage-reset-mode-exact">
                  <T>Exact</T>
                </Toggle>
              </ToggleGroup>
            ) : null}
          </div>
        </div>
      </div>

      {limitsLens === "pools" ? (
        limitsLayout === "matrix" ? (
          <UsageLimitsMatrixView
            accounts={visiblePoolAccounts}
            now={now}
            quotaDisplayMode={quotaDisplayMode}
            resetTimeMode={resetTimeMode}
            onEditOverride={(account) => setEditingAccountKey(account.key)}
          />
        ) : (
          <UsageLimitsPoolTableView
            accounts={visiblePoolAccounts}
            presentations={presentations}
            now={now}
            quotaDisplayMode={quotaDisplayMode}
            resetTimeMode={resetTimeMode}
            onEditOverride={(account) => setEditingAccountKey(account.key)}
          />
        )
      ) : limitsLens === "resets" ? (
        <UsageLimitsResetsView
          resets={intelligence.resets}
          now={now}
          quotaDisplayMode={quotaDisplayMode}
          resetTimeMode={resetTimeMode}
        />
      ) : limitsLens === "alerts" ? (
        <UsageLimitsAlertsView
          alerts={intelligence.alerts}
          now={now}
          alertThresholdPercent={alertThresholdPercent}
          onAlertThresholdChange={setAlertThresholdPercent}
          quotaDisplayMode={quotaDisplayMode}
          onEditOverride={(account) => setEditingAccountKey(account.key)}
        />
      ) : (
        <UsageLimitsExpiriesView
          expiries={intelligence.expiries}
          accountsWithoutExpiry={intelligence.accountsWithoutExpiry}
          monthlySpendByCurrency={intelligence.monthlySpendByCurrency}
          now={now}
          onEditOverride={(account) => setEditingAccountKey(account.key)}
        />
      )}

      {editingAccount !== null ? (
        <UsageSubscriptionOverrideDialog
          key={editingAccount.key}
          account={editingAccount}
          accountLabel={accountDisplayLabel(editingAccount)}
          onSave={setManualSubscriptionOverride}
          onClear={clearManualSubscriptionOverride}
          onClose={() => setEditingAccountKey(null)}
        />
      ) : null}
    </div>
  );
}
