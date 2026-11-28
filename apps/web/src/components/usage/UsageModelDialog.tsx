import { T, useGT, useLocale, Var } from "gt-react";
import { formatPercent, formatTokens, formatUsd } from "@t3tools/shared/usageFormat";
import {
  isModelCostUnknown,
  type MergedProjectTotals,
  type ModelTotals,
} from "@t3tools/shared/usageMerge";

import { mergeAnsweredUsage, type EnvironmentUsageStatus } from "../../state/usage";
import { ProviderInstanceIcon } from "../chat/ProviderInstanceIcon";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { UsageProviderChart, type UsageChartMetric } from "./UsageProviderChart";
import { UsageShareBar } from "./UsageShareBar";
import {
  cacheHitRate,
  costPerMillionTokens,
  costTypeSegments,
  speedCostSegments,
  tokenTypeSegments,
} from "./usageBreakdown";
import { PROVIDER_PRESENTATION } from "./usageProviders";

export interface UsageChartWindow {
  readonly days: readonly string[];
  readonly hours: readonly string[];
  readonly resolution: "day" | "hour";
  readonly timeZone: string;
  readonly referenceTime: string | undefined;
  readonly hour12: boolean;
}

export function UsageModelDialog({
  model,
  projects,
  environments,
  metric,
  chartWindow,
  onSetPrice,
  onClose,
}: {
  readonly model: ModelTotals;
  // fork: Optional project breakdown so the dialog displays which projects drove this model.
  readonly projects?: readonly MergedProjectTotals[] | undefined;
  readonly environments: readonly EnvironmentUsageStatus[];
  readonly metric: UsageChartMetric;
  readonly chartWindow: UsageChartWindow;
  readonly onSetPrice: () => void;
  readonly onClose: () => void;
}) {
  const gt = useGT();
  const locale = useLocale();
  const usage = mergeAnsweredUsage(
    environments,
    (bucket) => bucket.provider === model.provider && bucket.model === model.model,
  );
  const providers = [model.provider];
  const presentation = PROVIDER_PRESENTATION[model.provider];
  const costUnknown = isModelCostUnknown(model);
  const hitRate = cacheHitRate(model);
  const perMillion = costPerMillionTokens(model);
  // fork: Surface reasoning tokens alongside core model metrics when reported by the provider.
  const reasoningStat =
    model.tokens.reasoningTokens > 0
      ? {
          label: gt("Reasoning"),
          value:
            model.tokens.outputTokens > 0
              ? gt("{tokens} ({share})", {
                  tokens: formatTokens(model.tokens.reasoningTokens),
                  share: formatPercent(model.tokens.reasoningTokens / model.tokens.outputTokens, 0),
                })
              : formatTokens(model.tokens.reasoningTokens),
        }
      : null;
  const stats = [
    { label: gt("Cost"), value: costUnknown ? gt("Unpriced") : formatUsd(model.costUsd, locale) },
    { label: gt("Tokens"), value: formatTokens(model.totalTokens) },
    perMillion === null
      ? null
      : { label: gt("Per 1M tokens"), value: formatUsd(perMillion, locale) },
    hitRate === null ? null : { label: gt("Cache hit"), value: formatPercent(hitRate) },
    reasoningStat,
  ].filter((stat) => stat !== null);

  // fork: Derive per-project distribution for this model and normalize against the model's full total (not top-8 sum).
  const allProjectShares = (projects ?? [])
    .flatMap((project) => {
      const matched = project.modelContributions.filter(
        (entry) => entry.provider === model.provider && entry.model === model.model,
      );
      if (matched.length === 0) return [];
      const costUsd = matched.reduce((sum, entry) => sum + entry.costUsd, 0);
      const totalTokens = matched.reduce((sum, entry) => sum + entry.totalTokens, 0);
      return [
        {
          projectKey: project.projectKey,
          label: project.unattributed ? gt("Unattributed") : project.label,
          costUsd,
          totalTokens,
        },
      ];
    })
    .toSorted((left, right) =>
      metric === "tokens" || costUnknown
        ? right.totalTokens - left.totalTokens || right.costUsd - left.costUsd
        : right.costUsd - left.costUsd || right.totalTokens - left.totalTokens,
    );
  const projectShares = allProjectShares.slice(0, 8);
  const matchedTotalValue = allProjectShares.reduce(
    (sum, entry) => sum + (metric === "tokens" || costUnknown ? entry.totalTokens : entry.costUsd),
    0,
  );
  const fullModelValue = metric === "tokens" || costUnknown ? model.totalTokens : model.costUsd;
  const projectTotalValue = Math.max(fullModelValue, matchedTotalValue);

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogPopup className="max-w-3xl">
        <DialogHeader>
          <div className="flex items-center gap-2">
            <ProviderInstanceIcon
              driverKind={presentation.driverKind}
              displayName={presentation.label}
              iconClassName="size-5"
            />
            <DialogTitle>{model.model}</DialogTitle>
          </div>
          <DialogDescription>
            {presentation.label}
            {costUnknown
              ? ""
              : ` · ${gt("{share} of cost", { share: formatPercent(model.costShare) })}`}
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <div className="flex flex-col gap-8">
            <dl
              className={
                stats.length >= 5
                  ? "grid grid-cols-2 gap-x-6 gap-y-4 sm:grid-cols-5"
                  : "grid grid-cols-2 gap-x-6 gap-y-4 sm:grid-cols-4"
              }
            >
              {stats.map((stat) => (
                <div key={stat.label} className="flex min-w-0 flex-col gap-0.5">
                  <dt className="text-xs text-muted-foreground">{stat.label}</dt>
                  <dd className="text-2xl font-semibold text-foreground">{stat.value}</dd>
                </div>
              ))}
            </dl>

            {/* Unpriced cost is unknown, not zero, so its trend shows tokens. */}
            <UsageProviderChart
              providers={providers}
              days={chartWindow.days}
              daily={usage.daily}
              hours={chartWindow.hours}
              hourly={usage.hourly}
              metric={costUnknown ? "tokens" : metric}
              referenceTime={chartWindow.referenceTime}
              resolution={chartWindow.resolution}
              timeZone={chartWindow.timeZone}
              hour12={chartWindow.hour12}
            />

            <div className="grid gap-x-10 gap-y-8 sm:grid-cols-2">
              {costUnknown ? null : (
                <UsageShareBar
                  label={gt("Cost by type")}
                  segments={costTypeSegments(usage.categoryCost)}
                  format={(value: number) => formatUsd(value, locale)}
                />
              )}
              <UsageShareBar
                label={gt("Tokens by type")}
                segments={tokenTypeSegments(model.tokens)}
                format={formatTokens}
              />
              {usage.speedCost.fast + usage.speedCost.ultrafast > 0 ? (
                <UsageShareBar
                  label={gt("Cost by speed")}
                  segments={speedCostSegments(usage.speedCost)}
                  format={(value: number) => formatUsd(value, locale)}
                  aside={<SpeedPremium premiumUsd={usage.speedCost.premium} />}
                />
              ) : null}
            </div>

            {projectShares.length > 0 ? (
              <section data-testid="usage-model-projects" className="flex flex-col gap-2.5">
                <h3 className="text-sm font-medium text-foreground">
                  <T>Projects using this model</T>
                </h3>
                <ul className="flex flex-col gap-2">
                  {projectShares.map((entry) => {
                    const value =
                      metric === "tokens" || costUnknown ? entry.totalTokens : entry.costUsd;
                    const ratio = projectTotalValue > 0 ? value / projectTotalValue : 0;
                    return (
                      <li key={entry.projectKey} className="flex flex-col gap-1 text-xs">
                        <div className="flex items-baseline justify-between gap-3">
                          <span className="truncate font-medium text-foreground">
                            {entry.label}
                          </span>
                          <span className="shrink-0 text-muted-foreground tabular-nums">
                            {metric === "tokens" || costUnknown
                              ? formatTokens(entry.totalTokens)
                              : formatUsd(entry.costUsd, locale)}{" "}
                            · {formatPercent(ratio, 0)}
                          </span>
                        </div>
                        <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
                          <div
                            className="h-full rounded-full bg-info"
                            style={{ width: `${Math.max(ratio > 0 ? 3 : 0, ratio * 100)}%` }}
                          />
                        </div>
                      </li>
                    );
                  })}
                </ul>
              </section>
            ) : null}
          </div>
        </DialogPanel>
        {model.unpricedTokens > 0 ? (
          <DialogFooter variant="bare" className="items-center sm:justify-between">
            <span className="text-xs text-muted-foreground sm:flex-1">
              {gt("{tokens} tokens have no known price", {
                tokens: formatTokens(model.unpricedTokens),
              })}
            </span>
            <Button onClick={onSetPrice}>
              <T>Set price</T>
            </Button>
          </DialogFooter>
        ) : null}
      </DialogPopup>
    </Dialog>
  );
}

export function SpeedPremium({ premiumUsd }: { readonly premiumUsd: number }) {
  const locale = useLocale();
  return (
    <span className="text-xs text-muted-foreground">
      <T>
        Premium{" "}
        <span className="text-foreground tabular-nums">
          <Var>{formatUsd(premiumUsd, locale)}</Var>
        </span>
      </T>
    </span>
  );
}
