import { UNATTRIBUTED_USAGE_PROJECT_KEY } from "@t3tools/contracts";
import {
  formatDateTimeShort,
  formatPercent,
  formatTokens,
  formatUsd,
} from "@t3tools/shared/usageFormat";
import type { MergedSessionTotals } from "@t3tools/shared/usageMerge";
import { CheckIcon, CopyIcon } from "lucide-react";
import { T, useGT, useLocale } from "gt-react";
import { useState } from "react";

import { ProviderInstanceIcon } from "~/components/chat/ProviderInstanceIcon";
import { Button } from "~/components/ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "~/components/ui/dialog";
import { PROVIDER_PRESENTATION } from "~/components/usage/usageProviders";
import { writeTextToClipboard } from "~/hooks/useCopyToClipboard";

export function UsageSessionDialog({
  session,
  timeZone,
  hour12,
  isHostConnected = false,
  onClose,
}: {
  readonly session: MergedSessionTotals;
  readonly timeZone: string;
  readonly hour12: boolean;
  readonly isHostConnected?: boolean;
  readonly onClose: () => void;
}) {
  const gt = useGT();
  const locale = useLocale();
  const [copied, setCopied] = useState(false);
  const presentation = PROVIDER_PRESENTATION[session.provider];
  const unpriced = session.records > 0 && session.unpricedRecords >= session.records;
  const inputTotal =
    session.totals.uncachedInputTokens +
    session.totals.cachedInputTokens +
    session.totals.cacheCreationTokens;
  const hitRate = inputTotal > 0 ? session.totals.cachedInputTokens / inputTotal : null;

  const copySessionId = () => {
    void writeTextToClipboard(session.sessionId)
      .then((copiedOk) => {
        if (!copiedOk) return;
        setCopied(true);
        globalThis.setTimeout(() => setCopied(false), 1500);
      })
      .catch(() => {});
  };

  const localizedProjectLabel =
    session.projectKey === UNATTRIBUTED_USAGE_PROJECT_KEY
      ? gt("Unattributed")
      : session.projectLabel;

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogPopup className="max-w-xl" data-testid="usage-session-dialog">
        <DialogHeader>
          <div className="flex items-center gap-2">
            <ProviderInstanceIcon
              driverKind={presentation.driverKind}
              displayName={presentation.label}
              iconClassName="size-5"
            />
            <DialogTitle>
              <span className="block truncate">{session.title ?? session.sessionId}</span>
            </DialogTitle>
          </div>
          <DialogDescription>
            {presentation.label} · {localizedProjectLabel}
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <div className="flex flex-col gap-5 text-sm">
            <dl className="grid grid-cols-2 gap-4 sm:grid-cols-4">
              <div className="flex flex-col gap-0.5">
                <dt className="text-xs text-muted-foreground">
                  <T>Cost</T>
                </dt>
                <dd className="text-lg font-semibold text-foreground tabular-nums">
                  {unpriced ? gt("Unpriced") : formatUsd(session.costUsd, locale)}
                </dd>
              </div>
              <div className="flex flex-col gap-0.5">
                <dt className="text-xs text-muted-foreground">
                  <T>Tokens</T>
                </dt>
                <dd className="text-lg font-semibold text-foreground tabular-nums">
                  {formatTokens(session.totalTokens)}
                </dd>
              </div>
              <div className="flex flex-col gap-0.5">
                <dt className="text-xs text-muted-foreground">
                  <T>Cache hit</T>
                </dt>
                <dd className="text-lg font-semibold text-foreground tabular-nums">
                  {hitRate === null ? "-" : formatPercent(hitRate)}
                </dd>
              </div>
              <div className="flex flex-col gap-0.5">
                <dt className="text-xs text-muted-foreground">
                  <T>Requests</T>
                </dt>
                <dd className="text-lg font-semibold text-foreground tabular-nums">
                  {session.records}
                </dd>
              </div>
            </dl>

            <div className="grid gap-2 rounded-lg border border-border/65 bg-muted/25 p-3 text-xs">
              <div className="flex items-baseline justify-between gap-3">
                <span className="text-muted-foreground">
                  <T>Session ID</T>
                </span>
                <span className="truncate font-mono text-foreground">{session.sessionId}</span>
              </div>
              {session.cwd ? (
                <div className="flex items-baseline justify-between gap-3">
                  <span className="text-muted-foreground">
                    <T>Directory</T>
                  </span>
                  <span className="truncate font-mono text-foreground">{session.cwd}</span>
                </div>
              ) : null}
              <div className="flex items-baseline justify-between gap-3">
                <span className="text-muted-foreground">
                  <T>Models</T>
                </span>
                <span className="truncate text-right text-foreground">
                  {session.models.join(", ") || session.primaryModel}
                </span>
              </div>
              <div className="flex items-baseline justify-between gap-3">
                <span className="text-muted-foreground">
                  <T>Last active</T>
                </span>
                <span className="text-foreground tabular-nums">
                  {formatDateTimeShort(
                    new Date(session.lastTimestampMs).toISOString(),
                    timeZone,
                    hour12,
                    locale,
                  )}
                </span>
              </div>
            </div>

            <dl className="grid grid-cols-2 gap-3 text-xs sm:grid-cols-5">
              <div>
                <dt className="text-muted-foreground">
                  <T>Input</T>
                </dt>
                <dd className="font-medium text-foreground tabular-nums">
                  {formatTokens(session.totals.uncachedInputTokens)}
                </dd>
              </div>
              <div>
                <dt className="text-muted-foreground">
                  <T>Cache read</T>
                </dt>
                <dd className="font-medium text-foreground tabular-nums">
                  {formatTokens(session.totals.cachedInputTokens)}
                </dd>
              </div>
              <div>
                <dt className="text-muted-foreground">
                  <T>Cache write</T>
                </dt>
                <dd className="font-medium text-foreground tabular-nums">
                  {formatTokens(session.totals.cacheCreationTokens)}
                </dd>
              </div>
              <div>
                <dt className="text-muted-foreground">
                  <T>Output</T>
                </dt>
                <dd className="font-medium text-foreground tabular-nums">
                  {formatTokens(session.totals.outputTokens)}
                </dd>
              </div>
              <div>
                <dt className="text-muted-foreground">
                  <T>Reasoning</T>
                </dt>
                <dd className="font-medium text-foreground tabular-nums">
                  {formatTokens(session.totals.reasoningTokens)}
                </dd>
              </div>
            </dl>
          </div>
        </DialogPanel>
        <DialogFooter variant="bare" className="items-center sm:justify-between">
          <span className="text-xs text-muted-foreground">
            {session.t3ThreadId !== undefined ? (
              isHostConnected ? (
                <T>Linked to a T3 thread</T>
              ) : (
                <T>Linked to a T3 thread on an offline environment</T>
              )
            ) : (
              <T>External CLI session (not linked to a T3 thread)</T>
            )}
          </span>
          <div className="flex items-center gap-2">
            <Button variant="outline" size="sm" onClick={copySessionId}>
              {copied ? (
                <CheckIcon className="size-3.5" aria-hidden />
              ) : (
                <CopyIcon className="size-3.5" aria-hidden />
              )}
              {copied ? <T>Copied ID</T> : <T>Copy session ID</T>}
            </Button>
            <Button size="sm" onClick={onClose}>
              <T>Close</T>
            </Button>
          </div>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
