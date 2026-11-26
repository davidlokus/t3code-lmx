import { formatDuration, formatResetsIn } from "@t3tools/shared/usageLimitsCopy";
import type {
  LimitAlertEntry,
  LimitAlertSeverity,
  NormalizedLimitAccount,
} from "@t3tools/shared/usageLimitsIntelligence";
import { T, useGT, useMessages } from "gt-react";
import {
  AlertOctagonIcon,
  AlertTriangleIcon,
  CalendarCogIcon,
  CheckCircle2Icon,
  InfoIcon,
} from "lucide-react";

import { Button } from "~/components/ui/button";
import { Toggle, ToggleGroup } from "~/components/ui/toggle-group";
import { cn } from "~/lib/utils";
import { accountDisplayLabel } from "./usageLimitsPresentation";
import type { UsageQuotaDisplayMode } from "./usageOptionsStore";

const THRESHOLD_PRESETS = [70, 80, 90] as const;

function severityStyles(severity: LimitAlertSeverity): {
  readonly badge: string;
  readonly accentBar: string;
  readonly icon: typeof AlertOctagonIcon;
} {
  switch (severity) {
    case "critical":
      return {
        badge: "bg-error/15 text-error-foreground",
        accentBar: "bg-error",
        icon: AlertOctagonIcon,
      };
    case "warning":
      return {
        badge: "bg-warning/12 text-warning-foreground",
        accentBar: "bg-warning",
        icon: AlertTriangleIcon,
      };
    case "info":
      return {
        badge: "bg-info/12 text-info-foreground",
        accentBar: "bg-info",
        icon: InfoIcon,
      };
  }
}

export function UsageLimitsAlertsView({
  alerts,
  now,
  alertThresholdPercent,
  onAlertThresholdChange,
  quotaDisplayMode,
  onEditOverride,
}: {
  readonly alerts: readonly LimitAlertEntry[];
  readonly now: number;
  readonly alertThresholdPercent: number;
  readonly onAlertThresholdChange: (percent: number) => void;
  readonly quotaDisplayMode: UsageQuotaDisplayMode;
  readonly onEditOverride: (account: NormalizedLimitAccount) => void;
}) {
  const gt = useGT();
  const m = useMessages();

  const renderAlertCopy = (
    alert: LimitAlertEntry,
  ): { readonly title: string; readonly detail: string } => {
    const subject = alert.account
      ? accountDisplayLabel(alert.account)
      : (alert.sourceLabel ?? gt("Usage limit source"));
    const windowLabel = alert.window?.label ?? "";
    const remainingRounded =
      alert.window !== undefined
        ? Math.round(Math.max(0, Math.min(100, alert.window.remainingPercent)))
        : 0;
    const usedRounded =
      alert.window !== undefined
        ? Math.round(Math.max(0, Math.min(100, alert.window.usedPercent)))
        : 0;
    const resetsIn = alert.window ? formatResetsIn(alert.window, now, m) : null;

    switch (alert.kind) {
      case "window-exhausted":
        return {
          title: gt("{subject}: {window} exhausted", { subject, window: windowLabel }),
          detail: resetsIn
            ? gt("100% used ({resetsIn}).", { resetsIn })
            : gt("100% of this quota window has been used."),
        };
      case "burn-exhaustion": {
        const eta =
          alert.window?.pace?.projectedExhaustionMs !== null &&
          alert.window?.pace?.projectedExhaustionMs !== undefined
            ? formatDuration(Math.max(0, alert.window.pace.projectedExhaustionMs - now), m)
            : null;
        const pct =
          quotaDisplayMode === "used"
            ? gt("{percent}% used", { percent: usedRounded })
            : gt("{percent}% left", { percent: remainingRounded });
        return {
          title: gt("{subject}: {window} burning fast", { subject, window: windowLabel }),
          detail: eta
            ? gt("{pct}, {ratio}× pace, projected to run out in {eta}.", {
                pct,
                ratio: alert.window?.pace?.paceRatio ?? "-",
                eta,
              })
            : gt("{pct}, projected to exhaust before the window resets.", { pct }),
        };
      }
      case "window-low": {
        const pct =
          quotaDisplayMode === "used"
            ? gt("{percent}% used", { percent: usedRounded })
            : gt("{percent}% left", { percent: remainingRounded });
        return {
          title: gt("{subject}: {window} running low", { subject, window: windowLabel }),
          detail: resetsIn
            ? gt("{pct} ({resetsIn}).", { pct, resetsIn })
            : gt("{pct} remaining in this window.", { pct }),
        };
      }
      case "subscription-expiring": {
        const remainingMs = alert.expiry ? alert.expiry.expiresAtMs - now : 0;
        return {
          title:
            remainingMs <= 0
              ? gt("{subject} subscription expired", { subject })
              : gt("{subject} subscription expiring soon", { subject }),
          detail:
            remainingMs <= 0
              ? gt("Renewal date has passed. Update subscription details or renew your plan.")
              : gt("Expires in {duration}.", { duration: formatDuration(remainingMs, m) }),
        };
      }
      case "credit-expiring": {
        const remainingMs = alert.expiry ? Math.max(0, alert.expiry.expiresAtMs - now) : 0;
        return {
          title: gt("{subject} reset credit expiring soon", { subject }),
          detail: alert.expiry?.label
            ? gt("{label} expires in {duration}.", {
                label: alert.expiry.label,
                duration: formatDuration(remainingMs, m),
              })
            : gt("Banked reset credit expires in {duration}.", {
                duration: formatDuration(remainingMs, m),
              }),
        };
      }
      case "balance-expiring": {
        const remainingMs = alert.expiry ? Math.max(0, alert.expiry.expiresAtMs - now) : 0;
        return {
          title: gt("{subject} balance expiring soon", { subject }),
          detail: gt("{label} expires in {duration}.", {
            label: alert.expiry?.label ?? gt("Credit balance"),
            duration: formatDuration(remainingMs, m),
          }),
        };
      }
      case "probe-failed":
        return {
          title: gt("{subject} limits unavailable", { subject }),
          detail: alert.message ?? gt("Could not read subscription limits."),
        };
      case "service-notice":
        return {
          title: gt("{subject} notice", { subject }),
          detail: alert.message ?? gt("Provider reported an account notice."),
        };
    }
  };

  return (
    <div data-testid="usage-limits-alerts" className="flex flex-col gap-3.5">
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-border/55 bg-card/45 px-4 py-2.5">
        <div className="flex flex-col gap-0.5">
          <span className="text-xs font-medium text-foreground">
            <T>Low-quota warning threshold</T>
          </span>
          <span className="text-2xs text-muted-foreground">
            {gt("Warn once a window reaches {used}% used ({left}% left).", {
              used: alertThresholdPercent,
              left: 100 - alertThresholdPercent,
            })}
          </span>
        </div>

        <ToggleGroup
          aria-label={gt("Alert threshold percentage")}
          variant="segmented"
          value={[String(alertThresholdPercent)]}
          onValueChange={(next) => {
            const parsed = Number(next[0]);
            if (Number.isFinite(parsed) && parsed >= 50 && parsed <= 95) {
              onAlertThresholdChange(parsed);
            }
          }}
        >
          {THRESHOLD_PRESETS.map((preset) => (
            <Toggle
              key={preset}
              value={String(preset)}
              data-testid={`usage-alert-threshold-${preset}`}
            >
              {gt("{percent}% used", { percent: preset })}
            </Toggle>
          ))}
        </ToggleGroup>
      </div>

      {alerts.length === 0 ? (
        <div
          data-testid="usage-limits-alerts-empty"
          className="flex flex-col items-center gap-1.5 rounded-xl border border-border/55 bg-card/45 px-5 py-10 text-center"
        >
          <CheckCircle2Icon className="size-5 text-muted-foreground" aria-hidden />
          <p className="text-sm font-medium text-foreground">
            <T>All limits look healthy</T>
          </p>
          <p className="text-xs text-muted-foreground">
            <T>No exhausted windows, fast-burn risks, probe errors, or imminent expiries.</T>
          </p>
        </div>
      ) : (
        <div className="flex flex-col divide-y divide-border/45 overflow-hidden rounded-xl border border-border/55 bg-card/45">
          {alerts.map((alert) => {
            const style = severityStyles(alert.severity);
            const Icon = style.icon;
            const copy = renderAlertCopy(alert);
            return (
              <div
                key={alert.key}
                data-testid="usage-alert-card"
                data-severity={alert.severity}
                data-kind={alert.kind}
                className="relative flex flex-wrap items-center justify-between gap-3 px-4 py-3 ps-5"
              >
                <span
                  aria-hidden
                  className={cn("absolute inset-y-2 left-1.5 w-0.5 rounded-full", style.accentBar)}
                />
                <div className="flex min-w-0 flex-1 items-start gap-2.5">
                  <span
                    className={cn(
                      "mt-0.5 inline-flex size-5 shrink-0 items-center justify-center rounded",
                      style.badge,
                    )}
                  >
                    <Icon className="size-3" aria-hidden />
                  </span>
                  <div className="flex min-w-0 flex-col gap-0.5">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-sm font-medium text-foreground">{copy.title}</span>
                      <span
                        className={cn(
                          "rounded px-1.5 py-0.5 text-3xs font-medium uppercase",
                          style.badge,
                        )}
                      >
                        {alert.severity === "critical" ? (
                          <T>Critical</T>
                        ) : alert.severity === "warning" ? (
                          <T>Warning</T>
                        ) : (
                          <T>Info</T>
                        )}
                      </span>
                    </div>
                    <p className="text-xs text-muted-foreground">{copy.detail}</p>
                  </div>
                </div>

                {alert.kind === "subscription-expiring" && alert.account ? (
                  <Button
                    variant="outline"
                    size="xs"
                    onClick={() => onEditOverride(alert.account!)}
                  >
                    <CalendarCogIcon className="size-3.5" aria-hidden />
                    <span>
                      <T>Edit renewal</T>
                    </span>
                  </Button>
                ) : null}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
