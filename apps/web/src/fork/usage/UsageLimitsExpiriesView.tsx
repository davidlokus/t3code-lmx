import { formatDuration } from "@t3tools/shared/usageLimitsCopy";
import type { ExpiryItem, NormalizedLimitAccount } from "@t3tools/shared/usageLimitsIntelligence";
import { T, useGT, useLocale, useMessages } from "gt-react";
import { CalendarCogIcon, CalendarIcon, TicketIcon, WalletIcon } from "lucide-react";

import { RedactedSensitiveText } from "~/components/settings/RedactedSensitiveText";
import { Button } from "~/components/ui/button";
import { cn } from "~/lib/utils";
import { LimitSourceIcon, useSourceKindLabel } from "./UsageLimitPrimitives";
import { resolveAccountHeaderMeta } from "./usageLimitsPresentation";

const TWO_DAYS_MS = 2 * 24 * 60 * 60 * 1_000;
const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1_000;

function formatCurrencyAmount(amount: number, currency: string, locale: string): string {
  try {
    return new Intl.NumberFormat(locale, {
      style: "currency",
      currency,
      maximumFractionDigits: 2,
    }).format(amount);
  } catch {
    return `${amount.toFixed(2)} ${currency}`;
  }
}

const DATE_ONLY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

function isDateOnlyExpiry(item: ExpiryItem): boolean {
  const raw =
    item.kind === "subscription"
      ? item.source === "manual"
        ? item.account.manualOverride?.expiresAt
        : item.account.limits.subscriptionExpiresAt
      : item.kind === "balance"
        ? item.balance.expiresAt
        : undefined;
  return raw !== undefined && DATE_ONLY_PATTERN.test(raw.trim());
}

function formatCalendarDate(ms: number, locale: string, utc: boolean): string {
  try {
    return new Intl.DateTimeFormat(locale, {
      year: "numeric",
      month: "short",
      day: "numeric",
      ...(utc ? { timeZone: "UTC" } : {}),
    }).format(new Date(ms));
  } catch {
    return new Date(ms).toISOString().slice(0, 10);
  }
}

export function UsageLimitsExpiriesView({
  expiries,
  accountsWithoutExpiry,
  monthlySpendByCurrency,
  now,
  onEditOverride,
}: {
  readonly expiries: readonly ExpiryItem[];
  readonly accountsWithoutExpiry: readonly NormalizedLimitAccount[];
  readonly monthlySpendByCurrency: Readonly<Record<string, number>>;
  readonly now: number;
  readonly onEditOverride: (account: NormalizedLimitAccount) => void;
}) {
  const gt = useGT();
  const locale = useLocale();
  const m = useMessages();
  const sourceKindLabel = useSourceKindLabel();

  const currencyEntries = Object.entries(monthlySpendByCurrency).sort(([left], [right]) =>
    left.localeCompare(right),
  );

  return (
    <div data-testid="usage-limits-expiries" className="flex flex-col gap-5">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <div className="flex flex-col gap-1 rounded-xl border border-border/55 bg-card/45 px-4 py-3">
          <span className="text-xs font-medium text-muted-foreground">
            <T>Tracked expiries</T>
          </span>
          <span className="text-xl font-semibold text-foreground tabular-nums">
            {expiries.length}
          </span>
          <span className="text-2xs text-muted-foreground">
            <T>Subscriptions, banked reset credits, and expiring prepaid balances.</T>
          </span>
        </div>

        <div
          data-testid="usage-expiries-monthly-spend"
          className="flex flex-col gap-1 rounded-xl border border-border/55 bg-card/45 px-4 py-3"
        >
          <span className="text-xs font-medium text-muted-foreground">
            <T>Tracked monthly subscriptions</T>
          </span>
          <span className="text-xl font-semibold text-foreground tabular-nums">
            {currencyEntries.length > 0
              ? currencyEntries
                  .map(([currency, amount]) =>
                    gt("{amount}/mo", { amount: formatCurrencyAmount(amount, currency, locale) }),
                  )
                  .join(" / ")
              : "-"}
          </span>
          <span className="text-2xs text-muted-foreground">
            <T>Summed from local subscription overrides you record below.</T>
          </span>
        </div>
      </div>

      {expiries.length > 0 ? (
        <section className="flex flex-col gap-2">
          <h3 className="px-0.5 text-xs font-medium text-muted-foreground">
            <T>Upcoming renewals & expiries</T>
          </h3>
          <div className="flex flex-col divide-y divide-border/45 overflow-hidden rounded-xl border border-border/55 bg-card/45">
            {expiries.map((item) => {
              const meta = resolveAccountHeaderMeta(
                item.account,
                sourceKindLabel(item.account.sourceKind),
              );
              const remainingMs = item.expiresAtMs - now;
              const isExpired = remainingMs <= 0;
              const toneClass =
                isExpired || remainingMs <= TWO_DAYS_MS
                  ? "text-error-foreground"
                  : remainingMs <= SEVEN_DAYS_MS
                    ? "text-warning-foreground"
                    : "text-foreground";
              const Icon =
                item.kind === "reset-credit"
                  ? TicketIcon
                  : item.kind === "balance"
                    ? WalletIcon
                    : CalendarIcon;
              const override = item.account.manualOverride;
              const monthlyLabel =
                item.kind === "subscription" &&
                override?.monthlyCost !== undefined &&
                override.monthlyCost > 0 &&
                override.currency
                  ? gt("{amount}/mo", {
                      amount: formatCurrencyAmount(override.monthlyCost, override.currency, locale),
                    })
                  : null;

              return (
                <div
                  key={item.key}
                  data-testid="usage-expiry-row"
                  data-kind={item.kind}
                  data-source={item.source}
                  className="flex flex-wrap items-center justify-between gap-3 px-4 py-2.5"
                >
                  <div className="flex min-w-0 items-center gap-2.5">
                    <span className="inline-flex size-5 shrink-0 items-center justify-center rounded bg-muted/80 text-muted-foreground">
                      <Icon className="size-3" aria-hidden />
                    </span>
                    <div className="flex min-w-0 flex-col gap-0.5">
                      <div className="flex flex-wrap items-center gap-1.5">
                        <span className="truncate text-sm font-medium text-foreground">
                          {meta.displayLabel}
                        </span>
                        {item.label ? (
                          <span className="rounded bg-muted/80 px-1.5 py-0.5 text-3xs text-muted-foreground">
                            {item.label}
                          </span>
                        ) : null}
                        <span className="rounded bg-muted/60 px-1.5 py-0.5 text-3xs text-muted-foreground">
                          {item.kind === "subscription" ? (
                            <T>Subscription</T>
                          ) : item.kind === "reset-credit" ? (
                            <T>Reset credit</T>
                          ) : (
                            <T>Balance</T>
                          )}
                        </span>
                        <span className="rounded bg-muted/80 px-1.5 py-0.5 text-3xs font-medium text-foreground/80">
                          {item.source === "manual" ? <T>Manual</T> : <T>Provider</T>}
                        </span>
                      </div>
                      <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5 text-2xs text-muted-foreground tabular-nums">
                        <span>
                          {formatCalendarDate(item.expiresAtMs, locale, isDateOnlyExpiry(item))}
                        </span>
                        {monthlyLabel ? <span>{monthlyLabel}</span> : null}
                        {item.account.email ? (
                          <RedactedSensitiveText
                            value={item.account.email}
                            ariaLabel={gt("Toggle account email visibility")}
                            revealTooltip={gt("Click to reveal email")}
                            hideTooltip={gt("Click to hide email")}
                          />
                        ) : null}
                        {meta.whereText ? <span className="truncate">{meta.whereText}</span> : null}
                        {item.kind === "subscription" && override?.notes ? (
                          <span className="truncate">{override.notes}</span>
                        ) : null}
                        {item.kind === "balance" ? (
                          <span>
                            {item.balance.remaining} {item.balance.unit}
                          </span>
                        ) : null}
                      </div>
                    </div>
                  </div>

                  <div className="flex items-center gap-2.5">
                    <span className={cn("text-xs font-medium tabular-nums", toneClass)}>
                      {isExpired
                        ? gt("Expired")
                        : gt("in {duration}", { duration: formatDuration(remainingMs, m) })}
                    </span>
                    {item.kind === "subscription" ? (
                      <Button
                        variant="ghost-muted"
                        size="xs"
                        data-testid="usage-expiry-edit-btn"
                        onClick={() => onEditOverride(item.account)}
                      >
                        <T>Edit</T>
                      </Button>
                    ) : null}
                  </div>
                </div>
              );
            })}
          </div>
        </section>
      ) : null}

      {accountsWithoutExpiry.length > 0 ? (
        <section className="flex flex-col gap-2">
          <h3 className="px-0.5 text-xs font-medium text-muted-foreground">
            <T>Accounts without renewal date</T>
          </h3>
          <div className="flex flex-col divide-y divide-border/45 overflow-hidden rounded-xl border border-border/55 bg-card/45">
            {accountsWithoutExpiry.map((account) => {
              const meta = resolveAccountHeaderMeta(account, sourceKindLabel(account.sourceKind));
              return (
                <div
                  key={account.key}
                  data-testid="usage-no-expiry-account-row"
                  className="flex flex-wrap items-center justify-between gap-3 px-4 py-2.5"
                >
                  <div className="flex min-w-0 items-center gap-2.5">
                    <LimitSourceIcon
                      driver={account.driver}
                      sourceKind={account.sourceKind}
                      label={meta.displayLabel}
                      accentColor={account.accentColor}
                      size="sm"
                    />
                    <div className="flex min-w-0 flex-col gap-0.5">
                      <div className="flex flex-wrap items-center gap-1.5">
                        <span className="truncate text-sm font-medium text-foreground">
                          {meta.displayLabel}
                        </span>
                        {meta.planBadge ? (
                          <span className="rounded bg-muted/80 px-1.5 py-0.5 text-3xs text-muted-foreground">
                            {meta.planBadge}
                          </span>
                        ) : null}
                      </div>
                      {account.email || meta.whereText ? (
                        <div className="flex flex-wrap items-center gap-x-2.5 gap-y-0.5 text-2xs text-muted-foreground">
                          {account.email ? (
                            <RedactedSensitiveText
                              value={account.email}
                              ariaLabel={gt("Toggle account email visibility")}
                              revealTooltip={gt("Click to reveal email")}
                              hideTooltip={gt("Click to hide email")}
                            />
                          ) : null}
                          {meta.whereText ? (
                            <span className="truncate">{meta.whereText}</span>
                          ) : null}
                        </div>
                      ) : null}
                    </div>
                  </div>
                  <Button
                    variant="ghost-muted"
                    size="xs"
                    data-testid="usage-set-expiry-btn"
                    onClick={() => onEditOverride(account)}
                  >
                    <CalendarCogIcon className="size-3.5" aria-hidden />
                    <span>
                      <T>Set renewal</T>
                    </span>
                  </Button>
                </div>
              );
            })}
          </div>
        </section>
      ) : null}

      {expiries.length === 0 && accountsWithoutExpiry.length === 0 ? (
        <div
          data-testid="usage-limits-expiries-empty"
          className="rounded-xl border border-border/55 bg-card/45 px-5 py-10 text-center text-sm text-muted-foreground"
        >
          <T>No subscription accounts found on the selected environments.</T>
        </div>
      ) : null}
    </div>
  );
}
