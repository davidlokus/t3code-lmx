import { secondTick } from "@t3tools/client-runtime/clock";
import { Minimize2Icon } from "lucide-react";
import { useSyncExternalStore } from "react";
import { T, useGT, useLocale, useMessages, Var } from "gt-react";

import { Button } from "~/components/ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";
import { formatContextWindowTokens } from "~/lib/contextWindow";
import { cn } from "~/lib/utils";
import {
  derivePromptCacheCountdown,
  formatHudCompactDuration,
  type HudContextBucketKey,
  type HudContextMetrics,
  type HudContextTurnBreakdownItem,
} from "./hudMetrics.logic";

export interface ThreadHudCompactContext {
  readonly onCompact: () => void;
  readonly disabled: boolean;
  readonly disabledReason: string | null;
}

const BUCKET_BAR_CLASS: Record<HudContextBucketKey, string> = {
  systemBase: "bg-guest",
  tools: "bg-warning",
  assistant: "bg-success",
  user: "bg-info",
};

const BUCKET_DOT_CLASS: Record<HudContextBucketKey, string> = {
  systemBase: "bg-guest",
  tools: "bg-warning",
  assistant: "bg-success",
  user: "bg-info",
};

function HudPromptCacheCountdown(props: { readonly expiresAtMs: number }) {
  const gt = useGT();
  const m = useMessages();
  const expiresAtMs = props.expiresAtMs;
  const subscribe = (listener: () => void) => {
    if (secondTick.getSnapshot() >= expiresAtMs) return () => {};
    let unsubscribe: (() => void) | undefined;
    unsubscribe = secondTick.subscribe(() => {
      listener();
      if (secondTick.getSnapshot() >= expiresAtMs) {
        unsubscribe?.();
        unsubscribe = undefined;
      }
    });
    return () => {
      unsubscribe?.();
      unsubscribe = undefined;
    };
  };
  const nowMs = useSyncExternalStore(subscribe, secondTick.getSnapshot, secondTick.getSnapshot);
  const countdown = derivePromptCacheCountdown(expiresAtMs, nowMs);
  if (countdown.state === "unknown") return null;
  if (countdown.state === "cold") {
    return (
      <span
        data-testid="hud-prompt-cache-status"
        data-cache-state="cold"
        className="inline-flex items-center rounded bg-muted px-1.5 py-0.5 text-3xs font-medium text-muted-foreground"
      >
        <T context="prompt cache status">Cold</T>
      </span>
    );
  }
  const remainingLabel =
    countdown.remainingMs !== null ? formatHudCompactDuration(countdown.remainingMs, m) : "";
  return (
    <span
      data-testid="hud-prompt-cache-status"
      data-cache-state="warm"
      className="inline-flex items-center gap-1 rounded bg-success/12 px-1.5 py-0.5 text-3xs font-medium text-success-foreground tabular-nums"
      aria-label={gt("Prompt cache warm, expires in {duration}", { duration: remainingLabel })}
    >
      <span aria-hidden className="size-1.5 rounded-full bg-success" />
      <span>{remainingLabel}</span>
    </span>
  );
}

function breakdownLabel(
  key: HudContextTurnBreakdownItem["key"],
  gt: ReturnType<typeof useGT>,
): string {
  switch (key) {
    case "input":
      return gt("In", { $context: "token count label: input" });
    case "cachedInput":
      return gt("Cache", { $context: "token count label: cached input" });
    case "output":
      return gt("Out", { $context: "token count label: output" });
    case "reasoning":
      return gt("Think", { $context: "token count label: reasoning" });
  }
}

export function HudContextCard(props: {
  readonly metrics: HudContextMetrics;
  readonly compactContext?: ThreadHudCompactContext | undefined;
}) {
  const gt = useGT();
  const locale = useLocale();
  const { metrics, compactContext } = props;
  const usedLabel = formatContextWindowTokens(metrics.usedTokens);
  const maxLabel = metrics.maxTokens !== null ? formatContextWindowTokens(metrics.maxTokens) : null;
  const percentLabel =
    metrics.usedPercentage !== null ? `${Math.round(metrics.usedPercentage)}%` : null;

  const bucketLabel = (key: HudContextBucketKey): string => {
    switch (key) {
      case "systemBase":
        return metrics.hasCompaction ? gt("Compaction base") : gt("System base");
      case "tools":
        return gt("Tools");
      case "assistant":
        return gt("Assistant");
      case "user":
        return gt("User");
    }
  };

  const formatRate = (rate: number | null) => (rate === null ? "–" : `${Math.round(rate)}%`);
  const showCacheRow =
    metrics.lastTurnCacheHitRate !== null ||
    metrics.cumulativeCacheHitRate !== null ||
    metrics.promptCacheExpiresAtMs !== null;

  const compactButton = compactContext ? (
    <Button
      size="xs"
      variant="outline"
      disabled={compactContext.disabled}
      onClick={compactContext.onCompact}
      data-testid="hud-compact-button"
    >
      <Minimize2Icon aria-hidden />
      <span>
        <T context="context compaction action">Compact</T>
      </span>
    </Button>
  ) : null;

  return (
    <section
      aria-label={gt("Context lens")}
      data-testid="hud-context-card"
      className="flex flex-col gap-2 rounded-xl border border-border/65 bg-card/65 p-2.5"
    >
      <div className="flex items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-1.5">
          <span className="text-2xs font-semibold tracking-wide text-muted-foreground">
            <T context="HUD card title">Context</T>
          </span>
          {metrics.over200k ? (
            <span
              data-testid="hud-context-over-200k"
              className="rounded bg-warning/15 px-1 py-0.5 text-3xs font-semibold text-warning-foreground tabular-nums"
            >
              !200k+
            </span>
          ) : null}
        </div>
        <div className="flex shrink-0 items-baseline gap-1.5 tabular-nums">
          {percentLabel !== null ? (
            <span
              data-testid="hud-context-percent"
              data-tone={metrics.usageTone}
              className={cn(
                "text-xs font-semibold",
                metrics.usageTone === "error"
                  ? "text-error-foreground"
                  : metrics.usageTone === "warning"
                    ? "text-warning-foreground"
                    : "text-success-foreground",
              )}
            >
              {percentLabel}
            </span>
          ) : null}
          <span className="text-3xs text-muted-foreground">
            {maxLabel !== null ? `${usedLabel} / ${maxLabel}` : usedLabel}
          </span>
        </div>
      </div>

      <div
        role="img"
        aria-label={
          percentLabel !== null && maxLabel !== null
            ? gt("Context window {percent} used, {used} of {max} tokens", {
                percent: percentLabel,
                used: usedLabel,
                max: maxLabel,
              })
            : gt("Context window {used} tokens used", { used: usedLabel })
        }
        className="relative flex h-1.5 w-full overflow-hidden rounded-full bg-muted/80"
      >
        {metrics.buckets.map((bucket) =>
          bucket.tokens > 0 && bucket.percentOfContext > 0 ? (
            <span
              key={bucket.key}
              data-bucket={bucket.key}
              className={cn("h-full shrink-0", BUCKET_BAR_CLASS[bucket.key])}
              style={{ width: `${Math.min(100, bucket.percentOfContext)}%` }}
            />
          ) : null,
        )}
        {metrics.autoCompactTickPercent !== null ? (
          <span
            aria-hidden
            data-testid="hud-autocompact-tick"
            className="pointer-events-none absolute inset-y-0 w-0.5 -translate-x-1/2 bg-foreground/80"
            style={{
              left: `clamp(1px, ${metrics.autoCompactTickPercent}%, calc(100% - 1px))`,
            }}
          />
        ) : null}
      </div>

      <div className="grid grid-cols-2 gap-x-2 gap-y-1 text-3xs">
        {metrics.buckets.map((bucket) => (
          <Tooltip key={bucket.key}>
            <TooltipTrigger
              render={
                <div
                  tabIndex={0}
                  data-testid={`hud-context-bucket-${bucket.key}`}
                  className="flex min-w-0 items-center justify-between gap-1 rounded px-0.5 outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring"
                />
              }
            >
              <span className="flex min-w-0 items-center gap-1 text-muted-foreground">
                <span
                  aria-hidden
                  className={cn("size-1.5 shrink-0 rounded-full", BUCKET_DOT_CLASS[bucket.key])}
                />
                <span className="truncate">{bucketLabel(bucket.key)}</span>
              </span>
              <span className="shrink-0 font-medium text-foreground/85 tabular-nums">
                ≈ {formatContextWindowTokens(bucket.tokens)}
              </span>
            </TooltipTrigger>
            <TooltipPopup side="left" sideOffset={12}>
              <span>
                {gt("{label}: approximately {tokens} tokens ({percent}% of used)", {
                  label: bucketLabel(bucket.key),
                  tokens: bucket.tokens.toLocaleString(locale),
                  percent: Math.round(bucket.percentOfUsed),
                })}
              </span>
            </TooltipPopup>
          </Tooltip>
        ))}
      </div>

      {showCacheRow ? (
        <div
          data-testid="hud-prompt-cache-row"
          className="flex items-center justify-between gap-2 border-t border-border/50 pt-1.5 text-3xs"
        >
          <div className="flex min-w-0 items-center gap-1.5 text-muted-foreground">
            <span className="shrink-0">
              <T context="prompt cache hit rate label">Cache</T>
            </span>
            <span
              data-testid="hud-cache-hit-rate"
              className="truncate font-medium text-foreground/85 tabular-nums"
            >
              {metrics.lastTurnCacheHitRate !== null || metrics.cumulativeCacheHitRate !== null
                ? metrics.cacheSampleTurnCount > 1
                  ? `${formatRate(metrics.lastTurnCacheHitRate)} / ${formatRate(metrics.cumulativeCacheHitRate)}`
                  : formatRate(metrics.lastTurnCacheHitRate ?? metrics.cumulativeCacheHitRate)
                : "–"}
            </span>
          </div>
          {metrics.promptCacheExpiresAtMs !== null ? (
            <HudPromptCacheCountdown expiresAtMs={metrics.promptCacheExpiresAtMs} />
          ) : null}
        </div>
      ) : null}

      {metrics.lastTurnBreakdown.length > 0 ? (
        <div
          data-testid="hud-last-turn-breakdown"
          className="flex flex-wrap items-center gap-x-2 gap-y-1 text-3xs text-muted-foreground tabular-nums"
        >
          {metrics.lastTurnBreakdown.map((item) => (
            <span key={item.key} className="inline-flex items-center gap-0.5">
              <span>{breakdownLabel(item.key, gt)}</span>
              <span className="font-medium text-foreground/80">
                {formatContextWindowTokens(item.tokens)}
              </span>
            </span>
          ))}
        </div>
      ) : null}

      {compactButton ? (
        <div className="flex items-center justify-between gap-2 border-t border-border/50 pt-1.5">
          {metrics.autoCompactThreshold !== null ? (
            <span className="truncate text-3xs text-muted-foreground tabular-nums">
              <T>
                Auto <Var>{formatContextWindowTokens(metrics.autoCompactThreshold)}</Var>
              </T>
            </span>
          ) : (
            <span />
          )}
          {compactContext?.disabled && compactContext.disabledReason ? (
            <Tooltip>
              <TooltipTrigger render={<span tabIndex={0} className="inline-flex" />}>
                {compactButton}
              </TooltipTrigger>
              <TooltipPopup side="left" sideOffset={12}>
                {compactContext.disabledReason}
              </TooltipPopup>
            </Tooltip>
          ) : (
            compactButton
          )}
        </div>
      ) : null}
    </section>
  );
}
