import {
  CHATGPT_USAGE_URL,
  paceRemainingPercent,
  type LimitPresentations,
} from "@t3tools/shared/usageLimits";
import {
  collectExternalUsageLinks,
  collectLimitNotices,
  formatDuration,
  formatResetsIn,
  resetCreditChoices,
} from "@t3tools/shared/usageLimitsCopy";
import type { NormalizedLimitAccount } from "@t3tools/shared/usageLimitsIntelligence";
import { T, useGT, useLocale, useMessages } from "gt-react";
import {
  AlertTriangleIcon,
  CalendarCogIcon,
  ChevronRightIcon,
  ExternalLinkIcon,
  FlameIcon,
  TicketIcon,
  WalletIcon,
} from "lucide-react";
import { useState } from "react";

import { OpenAI } from "~/components/Icons";
import { RedactedSensitiveText } from "~/components/settings/RedactedSensitiveText";
import { Alert, AlertTitle } from "~/components/ui/alert";
import { Button } from "~/components/ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";
import { ResetCreditDialog, useResetCredit } from "~/components/usage/UsageLimits";
import { usePrimarySettings } from "~/hooks/useSettings";
import { cn } from "~/lib/utils";
import { ensureLocalApi } from "~/localApi";
import { formatUpcomingOrBareUtcDate } from "~/timestampFormat";
import {
  BurnPaceTag,
  LimitSourceIcon,
  RestrainedQuotaBar,
  useSourceKindLabel,
} from "./UsageLimitPrimitives";
import {
  dedupeWindowScopeLabel,
  effectiveWindowTone,
  formatBalanceAmount,
  formatWindowAmounts,
  groupAccountsByPlatformPool,
  resolveAccountHeaderMeta,
  restrainedTextClass,
  sortAccountsByRisk,
  type PlatformPoolGroup,
} from "./usageLimitsPresentation";
import type { UsageQuotaDisplayMode, UsageResetTimeMode } from "./usageOptionsStore";

function AccountRedeemControl({
  account,
  redeemAt,
  now,
}: {
  readonly account: NormalizedLimitAccount;
  readonly redeemAt: NonNullable<NormalizedLimitAccount["redeem"]>;
  readonly now: number;
}) {
  const redeem = useResetCredit(redeemAt.environmentId);
  const gt = useGT();
  const m = useMessages();
  const credits = account.limits.resetCredits;
  if (!credits || (credits.availableCount === 0 && !redeem.status)) return null;
  const choices = resetCreditChoices(credits, redeemAt.input, now, true, m);
  if (choices.length === 0 && !redeem.status) return null;

  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {choices.map((choice) =>
        choice.availableCount > 0 ? (
          <Button
            key={choice.key}
            size="xs"
            variant="outline"
            disabled={redeem.busy || !redeem.canManageProviders}
            onClick={() => redeem.confirm(choice)}
          >
            <TicketIcon className="size-3" aria-hidden />
            <span>{redeem.busy ? gt("Using…") : choice.actionLabel}</span>
          </Button>
        ) : null,
      )}
      {redeem.status ? (
        <span role="status" className="text-2xs text-foreground">
          {redeem.status}
        </span>
      ) : null}
      <ResetCreditDialog
        open={redeem.confirming}
        onOpenChange={redeem.setConfirming}
        choice={redeem.choice}
        onConfirm={() => void redeem.redeem()}
        disabled={!redeem.canManageProviders}
      />
    </div>
  );
}

function PlatformAccountSubRow({
  account,
  now,
  quotaDisplayMode,
  resetTimeMode,
  onEditOverride,
}: {
  readonly account: NormalizedLimitAccount;
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
  const rawSourceBadge = sourceKindLabel(account.sourceKind);
  const meta = resolveAccountHeaderMeta(account, rawSourceBadge);
  const resolvedSourceBadge =
    meta.sourceBadgeKind !== null ? sourceKindLabel(meta.sourceBadgeKind) : null;
  const balances = account.limits.balances ?? [];
  const renewalActionLabel = account.manualOverride ? gt("Edit details") : gt("Track renewal");

  return (
    <div
      data-testid="usage-pool-account-subrow"
      className="grid grid-cols-1 items-start gap-x-4 gap-y-2 bg-muted/20 px-4 py-2.5 lg:grid-cols-[minmax(12rem,1.05fr)_minmax(0,2fr)_auto]"
    >
      <div className="flex min-w-0 flex-col gap-0.5 ps-5">
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="truncate text-xs font-medium text-foreground">{meta.displayLabel}</span>
          {meta.planBadge ? (
            <span className="rounded bg-muted px-1.5 py-0.5 text-3xs text-muted-foreground">
              {meta.planBadge}
            </span>
          ) : null}
        </div>
        <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-2xs text-muted-foreground">
          {account.email ? (
            <RedactedSensitiveText
              value={account.email}
              ariaLabel={gt("Toggle account email visibility")}
              revealTooltip={gt("Click to reveal email")}
              hideTooltip={gt("Click to hide email")}
            />
          ) : null}
          {meta.whereText ? <span className="truncate">{meta.whereText}</span> : null}
          {resolvedSourceBadge ? <span className="truncate">{resolvedSourceBadge}</span> : null}
        </div>
      </div>

      <div className="flex min-w-0 flex-col gap-2">
        {account.windows.map((window) => {
          const remainingRounded = Math.round(Math.max(0, Math.min(100, window.remainingPercent)));
          const usedRounded = Math.round(Math.max(0, Math.min(100, window.usedPercent)));
          const displayedPercent = quotaDisplayMode === "used" ? usedRounded : remainingRounded;
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
              ? formatUpcomingOrBareUtcDate(window.resetsAt, timestampFormat, now, locale, m)
              : null;
          const resetLabel =
            resetTimeMode === "exact"
              ? exactTime
                ? gt("Resets {time}", { time: exactTime })
                : countdown
              : (countdown ?? (exactTime ? gt("Resets {time}", { time: exactTime }) : null));
          const amountsLabel = formatWindowAmounts(window, quotaDisplayMode, locale);
          const scopeLabel = dedupeWindowScopeLabel(window.scopeLabel, {
            displayLabel: meta.displayLabel,
            plan: account.plan,
            windowLabel: window.label,
          });

          return (
            <div
              key={window.id}
              className="grid grid-cols-1 items-center gap-x-3 gap-y-1 sm:grid-cols-[minmax(6.5rem,0.9fr)_minmax(5rem,1fr)_minmax(7.5rem,auto)]"
            >
              <div className="flex min-w-0 items-baseline justify-between gap-2 text-2xs">
                <span className="truncate text-muted-foreground">
                  {window.label}
                  {scopeLabel ? ` (${scopeLabel})` : ""}
                </span>
                <span
                  className={cn("shrink-0 font-semibold tabular-nums", restrainedTextClass(tone))}
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

              <div className="flex flex-wrap items-center justify-end gap-1.5 text-2xs text-muted-foreground tabular-nums">
                {amountsLabel ? <span>{amountsLabel}</span> : null}
                {resetLabel ? <span>{resetLabel}</span> : null}
                <BurnPaceTag
                  pace={window.pace}
                  remainingPercent={remainingRounded}
                  now={now}
                  compact
                />
              </div>
            </div>
          );
        })}

        {balances.length > 0 ? (
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-2xs tabular-nums">
            {balances.map((balance) => (
              <span key={balance.id} className="inline-flex items-center gap-1 text-foreground">
                <WalletIcon className="size-3 text-muted-foreground" aria-hidden />
                <span className="text-muted-foreground">{balance.label}</span>
                <span className="font-medium">{formatBalanceAmount(balance, locale)}</span>
              </span>
            ))}
          </div>
        ) : null}

        {account.limits.serviceNotice ? (
          <div className="flex items-center gap-1.5 text-2xs text-warning-foreground">
            <AlertTriangleIcon className="size-3 shrink-0" aria-hidden />
            <span className="break-words">{account.limits.serviceNotice.message}</span>
          </div>
        ) : null}

        {account.limits.unavailable?.reason === "probeFailed" ? (
          <div className="flex items-center gap-1.5 text-2xs text-warning-foreground">
            <AlertTriangleIcon className="size-3 shrink-0" aria-hidden />
            <span className="break-words">
              {account.limits.unavailable.message ?? gt("Could not read limits.")}
            </span>
          </div>
        ) : null}
      </div>

      <div className="flex items-center justify-end gap-1.5">
        {account.redeem ? (
          <AccountRedeemControl account={account} redeemAt={account.redeem} now={now} />
        ) : null}
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                variant={account.manualOverride ? "secondary" : "ghost-muted"}
                size="icon-xs"
                aria-label={renewalActionLabel}
                onClick={() => onEditOverride(account)}
              />
            }
          >
            <CalendarCogIcon className="size-3.5" aria-hidden />
          </TooltipTrigger>
          <TooltipPopup side="top">{renewalActionLabel}</TooltipPopup>
        </Tooltip>
      </div>
    </div>
  );
}

function PlatformPoolRow({
  group,
  expanded,
  onToggleExpand,
  now,
  quotaDisplayMode,
  resetTimeMode,
  onEditOverride,
}: {
  readonly group: PlatformPoolGroup;
  readonly expanded: boolean;
  readonly onToggleExpand: () => void;
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

  const isMultiAccount = group.accounts.length > 1;
  const singleAccount = !isMultiAccount ? group.accounts[0]! : null;
  const singleMeta = singleAccount
    ? resolveAccountHeaderMeta(singleAccount, sourceKindLabel(singleAccount.sourceKind))
    : null;
  const rowTitle = singleMeta ? singleMeta.displayLabel : group.label;
  const rowPlans = singleMeta ? (singleMeta.planBadge ? [singleMeta.planBadge] : []) : group.plans;
  const orderedMembers = isMultiAccount ? sortAccountsByRisk(group.accounts) : group.accounts;
  const renewalLabel = singleAccount?.manualOverride ? gt("Edit details") : gt("Track renewal");

  return (
    <div data-testid="usage-pool-group" className="flex flex-col">
      <div className="grid grid-cols-1 items-center gap-x-4 gap-y-2.5 px-4 py-3 transition-colors hover:bg-muted/20 lg:grid-cols-[minmax(12rem,1.05fr)_minmax(0,2fr)_auto]">
        <div className="flex min-w-0 items-center gap-2.5">
          {isMultiAccount ? (
            <button
              type="button"
              data-testid="usage-pool-expand-btn"
              aria-expanded={expanded}
              aria-label={
                expanded
                  ? gt("Collapse {platform} accounts", { platform: rowTitle })
                  : gt("Expand {platform} accounts", { platform: rowTitle })
              }
              onClick={onToggleExpand}
              className="inline-flex size-5 shrink-0 cursor-pointer items-center justify-center rounded text-muted-foreground transition-colors outline-none hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
            >
              <ChevronRightIcon
                className={cn("size-3.5 transition-transform", expanded && "rotate-90")}
                aria-hidden
              />
            </button>
          ) : (
            <span className="size-5 shrink-0" aria-hidden />
          )}

          <LimitSourceIcon
            driver={group.driver}
            sourceKind={group.sourceKind}
            label={rowTitle}
            accentColor={group.accentColor}
            size="sm"
          />

          <div className="flex min-w-0 flex-col gap-0.5">
            <div className="flex flex-wrap items-center gap-1.5">
              {isMultiAccount ? (
                <button
                  type="button"
                  onClick={onToggleExpand}
                  className="cursor-pointer truncate text-left text-sm font-medium text-foreground outline-none hover:underline focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
                >
                  {rowTitle}
                </button>
              ) : (
                <span className="truncate text-sm font-medium text-foreground">{rowTitle}</span>
              )}
              {isMultiAccount ? (
                <span className="rounded bg-muted/85 px-1.5 py-0.5 text-3xs font-medium text-muted-foreground tabular-nums">
                  {gt("×{count}", { count: group.accounts.length })}
                </span>
              ) : null}
              {rowPlans.map((plan) => (
                <span
                  key={plan}
                  data-testid="usage-limit-plan-badge"
                  className="rounded bg-muted/75 px-1.5 py-0.5 text-3xs font-medium text-muted-foreground"
                >
                  {plan}
                </span>
              ))}
              {group.riskTier >= 2 ? (
                <span
                  aria-hidden
                  className={cn(
                    "size-1.5 shrink-0 rounded-full",
                    group.riskTier === 3 ? "bg-error" : "bg-warning",
                  )}
                />
              ) : null}
            </div>

            {singleAccount ? (
              <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-2xs text-muted-foreground/85">
                {singleAccount.email ? (
                  <RedactedSensitiveText
                    value={singleAccount.email}
                    ariaLabel={gt("Toggle account email visibility")}
                    revealTooltip={gt("Click to reveal email")}
                    hideTooltip={gt("Click to hide email")}
                  />
                ) : null}
                {singleMeta?.whereText ? (
                  <span className="truncate">{singleMeta.whereText}</span>
                ) : null}
                {group.totalResetCredits > 0 ? (
                  <span className="inline-flex items-center gap-0.5 text-foreground/80 tabular-nums">
                    <TicketIcon className="size-3 text-muted-foreground" aria-hidden />
                    {gt("{count} reset credits", { count: group.totalResetCredits })}
                  </span>
                ) : null}
              </div>
            ) : group.totalResetCredits > 0 ? (
              <span className="inline-flex items-center gap-1 text-2xs text-muted-foreground tabular-nums">
                <TicketIcon className="size-3" aria-hidden />
                {gt("{count} reset credits", { count: group.totalResetCredits })}
              </span>
            ) : null}
          </div>
        </div>

        <div className="flex min-w-0 flex-col gap-2">
          {group.windows.map((window) => {
            const displayedPercent =
              quotaDisplayMode === "used" ? window.usedPercent : window.remainingPercent;
            const resetWindow = window.soonestResetWindow;
            const countdown = resetWindow ? formatResetsIn(resetWindow, now, m) || null : null;
            const exactTime =
              resetWindow?.resetsAt && resetWindow.resetsAtMs !== null
                ? formatUpcomingOrBareUtcDate(resetWindow.resetsAt, timestampFormat, now, locale, m)
                : null;
            const resetInfo =
              resetTimeMode === "exact"
                ? exactTime
                  ? gt("Resets {time}", { time: exactTime })
                  : null
                : (countdown ?? (exactTime ? gt("Resets {time}", { time: exactTime }) : null));
            const singleMemberWindow =
              window.members.length === 1 ? window.members[0]!.window : null;
            const remainingPaceTick = singleMemberWindow
              ? paceRemainingPercent(singleMemberWindow, now)
              : null;
            const tickPercent =
              remainingPaceTick === null
                ? null
                : quotaDisplayMode === "used"
                  ? 100 - remainingPaceTick
                  : remainingPaceTick;
            const amountsLabel = singleMemberWindow
              ? formatWindowAmounts(singleMemberWindow, quotaDisplayMode, locale)
              : null;

            return (
              <div
                key={window.key}
                data-testid="usage-limit-window-card"
                data-tone={window.tone}
                className="grid grid-cols-1 items-center gap-x-3 gap-y-1 sm:grid-cols-[minmax(8.5rem,0.95fr)_minmax(6rem,1fr)_minmax(8rem,auto)]"
              >
                <div className="flex min-w-0 items-baseline justify-between gap-2 text-xs">
                  <span className="truncate text-muted-foreground">{window.label}</span>
                  <span
                    className={cn(
                      "inline-flex shrink-0 items-center gap-1 font-semibold tabular-nums",
                      restrainedTextClass(window.tone),
                    )}
                  >
                    {window.hasFastBurn ? (
                      <FlameIcon className="size-3 text-warning-foreground" aria-hidden />
                    ) : null}
                    <span>
                      {quotaDisplayMode === "used"
                        ? gt("{percent}% used", { percent: displayedPercent })
                        : gt("{percent}% left", { percent: displayedPercent })}
                    </span>
                  </span>
                </div>

                <RestrainedQuotaBar
                  percent={displayedPercent}
                  tone={window.tone}
                  tickPercent={tickPercent}
                  height="xs"
                />

                <div className="flex flex-wrap items-center justify-end gap-x-2 gap-y-0.5 text-2xs text-muted-foreground tabular-nums">
                  {amountsLabel ? <span>{amountsLabel}</span> : null}
                  {resetInfo ? (
                    <span data-testid="usage-limit-reset-info" className="truncate">
                      {resetInfo}
                    </span>
                  ) : null}
                  {window.nextRefillPercent !== null && window.nextRefillAtMs !== null ? (
                    <span className="font-medium text-foreground/85">
                      {gt("↻ +{percent}% in {duration}", {
                        percent: window.nextRefillPercent,
                        duration: formatDuration(Math.max(0, window.nextRefillAtMs - now), m),
                      })}
                    </span>
                  ) : null}
                </div>
              </div>
            );
          })}

          {group.windows.length === 0 && group.balances.length > 0 ? (
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs tabular-nums">
              {group.balances.map(({ account, balance }) => (
                <span
                  key={`${account.key}:${balance.id}`}
                  className="inline-flex items-center gap-1 text-foreground"
                >
                  <WalletIcon className="size-3 text-muted-foreground" aria-hidden />
                  <span className="text-muted-foreground">{balance.label}</span>
                  <span className="font-medium">{formatBalanceAmount(balance, locale)}</span>
                </span>
              ))}
            </div>
          ) : null}

          {singleAccount &&
          group.windows.length > 0 &&
          (singleAccount.limits.balances?.length ?? 0) > 0 ? (
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-2xs tabular-nums">
              {(singleAccount.limits.balances ?? []).map((balance) => (
                <span key={balance.id} className="inline-flex items-center gap-1 text-foreground">
                  <WalletIcon className="size-3 text-muted-foreground" aria-hidden />
                  <span className="text-muted-foreground">{balance.label}</span>
                  <span className="font-medium">{formatBalanceAmount(balance, locale)}</span>
                </span>
              ))}
            </div>
          ) : null}

          {singleAccount?.limits.serviceNotice ? (
            <div className="flex items-center gap-1.5 text-2xs text-warning-foreground">
              <AlertTriangleIcon className="size-3 shrink-0" aria-hidden />
              <span className="break-words">{singleAccount.limits.serviceNotice.message}</span>
            </div>
          ) : null}

          {singleAccount?.limits.unavailable?.reason === "probeFailed" ? (
            <div className="flex items-center gap-1.5 text-2xs text-warning-foreground">
              <AlertTriangleIcon className="size-3 shrink-0" aria-hidden />
              <span className="break-words">
                {singleAccount.limits.unavailable.message ?? gt("Could not read limits.")}
              </span>
            </div>
          ) : null}
        </div>

        <div className="flex items-center justify-end gap-1.5">
          {singleAccount?.redeem ? (
            <AccountRedeemControl
              account={singleAccount}
              redeemAt={singleAccount.redeem}
              now={now}
            />
          ) : null}
          {singleAccount ? (
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    variant={singleAccount.manualOverride ? "secondary" : "ghost-muted"}
                    size="icon-xs"
                    aria-label={renewalLabel}
                    onClick={() => onEditOverride(singleAccount)}
                  />
                }
              >
                <CalendarCogIcon className="size-3.5" aria-hidden />
              </TooltipTrigger>
              <TooltipPopup side="top">{renewalLabel}</TooltipPopup>
            </Tooltip>
          ) : (
            <Button variant="ghost-muted" size="xs" onClick={onToggleExpand}>
              {expanded ? <T>Hide</T> : <T>Accounts</T>}
            </Button>
          )}
        </div>
      </div>

      {isMultiAccount && expanded ? (
        <div className="flex flex-col divide-y divide-border/40 border-t border-border/45">
          {orderedMembers.map((account) => (
            <PlatformAccountSubRow
              key={account.key}
              account={account}
              now={now}
              quotaDisplayMode={quotaDisplayMode}
              resetTimeMode={resetTimeMode}
              onEditOverride={onEditOverride}
            />
          ))}
        </div>
      ) : null}
    </div>
  );
}

export function UsageLimitsPoolTableView({
  accounts,
  presentations,
  now,
  quotaDisplayMode,
  resetTimeMode,
  onEditOverride,
}: {
  readonly accounts: readonly NormalizedLimitAccount[];
  readonly presentations: LimitPresentations;
  readonly now: number;
  readonly quotaDisplayMode: UsageQuotaDisplayMode;
  readonly resetTimeMode: UsageResetTimeMode;
  readonly onEditOverride: (account: NormalizedLimitAccount) => void;
}) {
  const gt = useGT();
  const m = useMessages();
  const sourceKindLabel = useSourceKindLabel();
  const [expandedGroups, setExpandedGroups] = useState<ReadonlySet<string>>(() => new Set());

  const sourceLabels: Partial<Record<NormalizedLimitAccount["sourceKind"], string | undefined>> = {
    openrouter: sourceKindLabel("openrouter") ?? undefined,
    copilot: sourceKindLabel("copilot") ?? undefined,
    ollama: sourceKindLabel("ollama") ?? undefined,
    openaiApi: sourceKindLabel("openaiApi") ?? undefined,
    kimi: sourceKindLabel("kimi") ?? undefined,
    zai: sourceKindLabel("zai") ?? undefined,
    claudeSwap: sourceKindLabel("claudeSwap") ?? undefined,
  };

  const groups = groupAccountsByPlatformPool(accounts, now, sourceLabels);
  const externalLinks = collectExternalUsageLinks(presentations, m);
  const notices = collectLimitNotices(presentations, m);

  if (groups.length === 0 && externalLinks.length === 0 && notices.length === 0) {
    return (
      <div
        data-testid="usage-limits-pool-empty"
        className="rounded-xl border border-border/55 bg-card/45 px-5 py-10 text-center text-sm text-muted-foreground"
      >
        <T>No provider on the selected environments reports subscription limits.</T>
      </div>
    );
  }

  const toggleGroup = (key: string) => {
    setExpandedGroups((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  return (
    <div data-testid="usage-limits-pool-table" className="flex flex-col gap-4">
      {groups.length > 0 ? (
        <div className="overflow-hidden rounded-xl border border-border/55 bg-card/45">
          <div className="hidden grid-cols-[minmax(12rem,1.05fr)_minmax(0,2fr)_auto] items-center gap-x-4 border-b border-border/55 bg-muted/25 px-4 py-2 text-3xs font-medium tracking-wider text-muted-foreground uppercase lg:grid">
            <span className="ps-7">
              <T>Platform</T>
            </span>
            <span>
              <T>Quota windows</T>
            </span>
            <span className="text-right">
              <T>Actions</T>
            </span>
          </div>

          <div className="flex flex-col divide-y divide-border/45">
            {groups.map((group) => (
              <PlatformPoolRow
                key={group.key}
                group={group}
                expanded={expandedGroups.has(group.key)}
                onToggleExpand={() => toggleGroup(group.key)}
                now={now}
                quotaDisplayMode={quotaDisplayMode}
                resetTimeMode={resetTimeMode}
                onEditOverride={onEditOverride}
              />
            ))}
          </div>
        </div>
      ) : null}

      {externalLinks.map((link) => (
        <section
          key={link.url}
          className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-border/55 bg-card/45 px-4 py-3"
        >
          <div className="flex min-w-0 flex-1 items-center gap-3">
            {link.url === CHATGPT_USAGE_URL ? (
              <OpenAI className="size-4 shrink-0 text-foreground/85" aria-hidden="true" />
            ) : null}
            <div className="min-w-0 space-y-0.5">
              <h3 className="text-sm font-medium text-foreground">{link.label}</h3>
              <p className="text-xs break-words text-muted-foreground">
                {link.accounts.join(", ")}
              </p>
              {link.url === CHATGPT_USAGE_URL ? (
                <p className="text-2xs text-muted-foreground">
                  <T>View usage in ChatGPT with your connected account.</T>
                </p>
              ) : link.message ? (
                <p className="max-w-xl text-2xs text-muted-foreground">{link.message}</p>
              ) : null}
            </div>
          </div>
          <Button
            variant="ghost-muted"
            size="xs"
            onClick={() => void ensureLocalApi().shell.openExternal(link.url)}
          >
            <span>{gt("Manage usage")}</span>
            <ExternalLinkIcon className="size-3.5" aria-hidden="true" />
          </Button>
        </section>
      ))}

      {notices.length > 0 ? (
        <Alert variant="warning" controlAlignment="first-line">
          <AlertTriangleIcon />
          {notices.map((notice) => (
            <AlertTitle key={notice} className="break-words">
              {notice}
            </AlertTitle>
          ))}
        </Alert>
      ) : null}
    </div>
  );
}
