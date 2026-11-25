import type { EnvironmentId, UsageProviderKind } from "@t3tools/contracts";
import { Link } from "@tanstack/react-router";
import { Settings2Icon } from "lucide-react";
import { T, useGT } from "gt-react";

import { UsageLimitsSection } from "~/components/usage/UsageLimits";
import { useNowMinute } from "~/hooks/useNowMinute";

function resolveLimitsNow(nowMinute: string, refreshTickNow: number): number {
  const parsedMinute = Date.parse(`${nowMinute}:00Z`);
  return Math.max(refreshTickNow, Number.isFinite(parsedMinute) ? parsedMinute : 0);
}

/**
 * Isolated minute-clock wrapper around the enhanced Limits view so countdowns update quietly
 * every minute without forcing full-page repaints when viewing Overview.
 */
export function UsageLimitsEnhanced({
  selectedEnvironmentIds,
  hiddenProviders,
  refreshTickNow,
}: {
  readonly selectedEnvironmentIds: ReadonlySet<EnvironmentId> | null;
  readonly hiddenProviders: ReadonlySet<UsageProviderKind>;
  readonly refreshTickNow: number;
}) {
  const gt = useGT();
  const nowMinute = useNowMinute();
  const now = resolveLimitsNow(nowMinute, refreshTickNow);

  return (
    <div data-testid="usage-limits-enhanced" className="flex flex-col gap-5">
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-border/70 bg-card/65 px-4 py-3">
        <div className="flex flex-col gap-0.5">
          <h2 className="text-sm font-medium text-foreground">
            <T>Subscription quota pools</T>
          </h2>
          <p className="text-xs text-muted-foreground">
            <T>
              Live remaining capacity, reset schedules, pace guides, and reset credit redemptions.
            </T>
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

      <UsageLimitsSection
        selectedEnvironmentIds={selectedEnvironmentIds}
        hiddenProviders={hiddenProviders}
        now={now}
      />
    </div>
  );
}
