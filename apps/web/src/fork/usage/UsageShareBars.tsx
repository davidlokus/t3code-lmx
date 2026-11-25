import { formatTokens, formatUsd } from "@t3tools/shared/usageFormat";
import type { CategoryCost, MergedUsage, SpeedCost } from "@t3tools/shared/usageMerge";
import { msg, useGT, useLocale } from "gt-react";

import { SpeedPremium } from "~/components/usage/UsageModelDialog";
import { UsageShareBar, type ShareSegment } from "~/components/usage/UsageShareBar";
import { cn } from "~/lib/utils";

const SEMANTIC_TYPE_COLORS = {
  input: "var(--info)",
  cacheRead: "var(--success)",
  cacheWrite: "var(--warning)",
  output: "var(--guest)",
  reasoning: "var(--update)",
  other: "var(--muted-foreground)",
} as const;

const SEMANTIC_SPEED_COLORS = {
  standard: "var(--info)",
  fast: "var(--warning)",
  ultrafast: "var(--error)",
} as const;

function semanticCostSegments(cost: CategoryCost): readonly ShareSegment[] {
  return [
    { label: msg("Input"), value: cost.input, color: SEMANTIC_TYPE_COLORS.input },
    { label: msg("Cache read"), value: cost.cacheRead, color: SEMANTIC_TYPE_COLORS.cacheRead },
    { label: msg("Cache write"), value: cost.cacheWrite, color: SEMANTIC_TYPE_COLORS.cacheWrite },
    { label: msg("Output"), value: cost.output, color: SEMANTIC_TYPE_COLORS.output },
    {
      label: msg("Other"),
      value: cost.unsplit >= 0.005 ? cost.unsplit : 0,
      color: SEMANTIC_TYPE_COLORS.other,
    },
  ];
}

// Partition inclusive outputTokens into direct output + reasoning so totalTokens is never double-counted.
function semanticTokenSegments(merged: MergedUsage): readonly ShareSegment[] {
  const reasoning = Math.min(merged.reasoningTokens, merged.outputTokens);
  const directOutput = Math.max(0, merged.outputTokens - reasoning);
  return [
    { label: msg("Input"), value: merged.uncachedInputTokens, color: SEMANTIC_TYPE_COLORS.input },
    {
      label: msg("Cache read"),
      value: merged.cachedInputTokens,
      color: SEMANTIC_TYPE_COLORS.cacheRead,
    },
    {
      label: msg("Cache write"),
      value: merged.cacheCreationTokens,
      color: SEMANTIC_TYPE_COLORS.cacheWrite,
    },
    { label: msg("Output"), value: directOutput, color: SEMANTIC_TYPE_COLORS.output },
    ...(reasoning > 0
      ? [{ label: msg("Reasoning"), value: reasoning, color: SEMANTIC_TYPE_COLORS.reasoning }]
      : []),
  ];
}

function semanticSpeedSegments(cost: SpeedCost): readonly ShareSegment[] {
  return [
    { label: msg("Standard"), value: cost.standard, color: SEMANTIC_SPEED_COLORS.standard },
    { label: msg("Fast"), value: cost.fast, color: SEMANTIC_SPEED_COLORS.fast },
    { label: msg("Ultrafast"), value: cost.ultrafast, color: SEMANTIC_SPEED_COLORS.ultrafast },
  ];
}

export function UsageShareBars({
  merged,
  metric,
  loading,
}: {
  readonly merged: MergedUsage;
  readonly metric: "cost" | "tokens";
  readonly loading: boolean;
}) {
  const gt = useGT();
  const locale = useLocale();
  if (merged.totalTokens <= 0) return null;

  const hasSpeedSplit = merged.speedCost.fast + merged.speedCost.ultrafast > 0;

  return (
    <section
      data-testid="usage-share-bars"
      className={cn(
        "grid gap-x-10 gap-y-6 rounded-xl border border-border/70 bg-card/65 p-4",
        metric === "cost" && hasSpeedSplit ? "lg:grid-cols-3" : "lg:grid-cols-2",
        "transition-opacity",
        loading && "opacity-40 delay-150",
      )}
    >
      {metric === "tokens" ? (
        <UsageShareBar
          label={gt("Tokens by type")}
          segments={semanticTokenSegments(merged)}
          format={formatTokens}
        />
      ) : (
        <>
          <UsageShareBar
            label={gt("Cost by type")}
            segments={semanticCostSegments(merged.categoryCost)}
            format={(value: number) => formatUsd(value, locale)}
          />
          <UsageShareBar
            label={gt("Tokens by type")}
            segments={semanticTokenSegments(merged)}
            format={formatTokens}
          />
          {hasSpeedSplit ? (
            <UsageShareBar
              label={gt("Cost by speed")}
              segments={semanticSpeedSegments(merged.speedCost)}
              format={(value: number) => formatUsd(value, locale)}
              aside={<SpeedPremium premiumUsd={merged.speedCost.premium} />}
            />
          ) : null}
        </>
      )}
    </section>
  );
}
