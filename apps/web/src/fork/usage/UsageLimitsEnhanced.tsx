import type { EnvironmentId, UsageProviderKind } from "@t3tools/contracts";
import type { LimitPresentations } from "@t3tools/shared/usageLimits";
import {
  collectLimitsIntelligence,
  type NormalizedLimitAccount,
} from "@t3tools/shared/usageLimitsIntelligence";
import { Link } from "@tanstack/react-router";
import { T, useGT } from "gt-react";
import { Settings2Icon } from "lucide-react";
import { useState } from "react";

import { providerClients } from "~/components/settings/providerDriverMeta";
import { Toggle, ToggleGroup } from "~/components/ui/toggle-group";
import { UsageLimitsSection } from "~/components/usage/UsageLimits";
import { useNowMinute } from "~/hooks/useNowMinute";
import { cn } from "~/lib/utils";
import { UsageLimitsAlertsView } from "./UsageLimitsAlertsView";
import { UsageLimitsExpiriesView } from "./UsageLimitsExpiriesView";
import { UsageLimitsMatrixView } from "./UsageLimitsMatrixView";
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

function accountDisplayLabel(account: NormalizedLimitAccount): string {
  if (account.displayName) return account.displayName;
  if (account.driver) return providerClients.get(account.driver)?.label ?? String(account.driver);
  return account.sourceLabel ?? account.key;
}

/**
 * Isolated minute-clock wrapper around the four-lens Limits view so countdowns update quietly
 * every minute without forcing full-page repaints when viewing Overview.
 */
export function UsageLimitsEnhanced({
  presentations,
  identityPresentations,
  selectedEnvironmentIds,
  hiddenProviders,
  refreshTickNow,
}: {
  readonly presentations: LimitPresentations;
  readonly identityPresentations: LimitPresentations;
  readonly selectedEnvironmentIds: ReadonlySet<EnvironmentId> | null;
  readonly hiddenProviders: ReadonlySet<UsageProviderKind>;
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

  const intelligence = collectLimitsIntelligence({
    presentations,
    identityPresentations,
    now,
    alertThresholdPercent,
    manualOverrides: manualSubscriptionOverrides,
  });

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

  return (
    <div data-testid="usage-limits-enhanced" className="flex flex-col gap-5">
      <div className="flex flex-col gap-3 rounded-xl border border-border/70 bg-card/65 px-4 py-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex flex-col gap-0.5">
            <h2 className="text-sm font-medium text-foreground">
              <T>Subscription quota intelligence</T>
            </h2>
            <p className="text-xs text-muted-foreground tabular-nums">
              {gt("{accounts} accounts · {windows} windows · {alerts} alerts", {
                accounts: intelligence.summary.accountCount,
                windows: intelligence.summary.windowCount,
                alerts: totalAlerts,
              })}
            </p>
          </div>
          <Link
            to="/settings/providers"
            hash="usage-providers"
            data-testid="usage-manage-hubs-link"
            aria-label={gt("Manage usage limit hubs")}
            className="inline-flex items-center gap-1.5 rounded-lg border border-border bg-background px-3 py-1.5 text-xs font-medium text-foreground transition-colors outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
          >
            <Settings2Icon className="size-3.5 text-muted-foreground" aria-hidden />
            <span>
              <T>Manage limit hubs</T>
            </span>
          </Link>
        </div>

        <div className="flex flex-wrap items-center justify-between gap-2 border-t border-border/60 pt-2.5">
          <ToggleGroup
            aria-label={gt("Limits lens")}
            variant="segmented"
            value={[limitsLens]}
            onValueChange={(next) => {
              const value = next[0] as UsageLimitsLens | undefined;
              if (
                value === "pools" ||
                value === "resets" ||
                value === "alerts" ||
                value === "expiries"
              ) {
                setLimitsLens(value);
              }
            }}
          >
            <Toggle value="pools" data-testid="usage-limits-lens-pools">
              <T>Pools</T>
            </Toggle>
            <Toggle value="resets" data-testid="usage-limits-lens-resets">
              <T>Resets</T>
            </Toggle>
            <Toggle value="alerts" data-testid="usage-limits-lens-alerts">
              <span className="inline-flex items-center gap-1.5">
                <span>
                  <T>Alerts</T>
                </span>
                {totalAlerts > 0 ? (
                  <span
                    data-testid="usage-limits-alerts-count"
                    className={cn(
                      "rounded-full px-1.5 py-0.5 text-2xs font-semibold tabular-nums",
                      alertBadgeTone,
                    )}
                  >
                    {totalAlerts}
                  </span>
                ) : null}
              </span>
            </Toggle>
            <Toggle value="expiries" data-testid="usage-limits-lens-expiries">
              <span className="inline-flex items-center gap-1.5">
                <span>
                  <T>Expiries</T>
                </span>
                {intelligence.expiries.length > 0 ? (
                  <span className="rounded-full bg-muted px-1.5 py-0.5 text-2xs font-semibold text-muted-foreground tabular-nums">
                    {intelligence.expiries.length}
                  </span>
                ) : null}
              </span>
            </Toggle>
          </ToggleGroup>

          <div className="flex flex-wrap items-center gap-1.5">
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
                <Toggle value="pool" data-testid="usage-limits-layout-pool">
                  <T>Pool</T>
                </Toggle>
                <Toggle value="matrix" data-testid="usage-limits-layout-matrix">
                  <T>Matrix</T>
                </Toggle>
              </ToggleGroup>
            ) : null}

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
          </div>
        </div>
      </div>

      {limitsLens === "pools" ? (
        limitsLayout === "matrix" ? (
          <UsageLimitsMatrixView
            accounts={intelligence.accounts}
            now={now}
            quotaDisplayMode={quotaDisplayMode}
            resetTimeMode={resetTimeMode}
            onEditOverride={(account) => setEditingAccountKey(account.key)}
          />
        ) : (
          <UsageLimitsSection
            selectedEnvironmentIds={selectedEnvironmentIds}
            hiddenProviders={hiddenProviders}
            now={now}
            quotaDisplayMode={quotaDisplayMode}
            resetTimeMode={resetTimeMode}
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
