import {
  UNATTRIBUTED_USAGE_PROJECT_KEY,
  type EnvironmentId,
  type UsageProviderKind,
} from "@t3tools/contracts";
import {
  formatCount,
  formatDateTimeShort,
  formatDayShort,
  formatHourShort,
  formatPercent,
  formatTokens,
  formatUsd,
} from "@t3tools/shared/usageFormat";
import {
  isModelCostUnknown,
  type DailyTotals,
  type HourlyTotals,
  type MergedSessionTotals,
  type MergedUsage,
} from "@t3tools/shared/usageMerge";
import { ArrowDownIcon, ArrowUpIcon, ArrowUpRightIcon, FolderGit2Icon } from "lucide-react";
import { T, useGT, useLocale } from "gt-react";
import { useState } from "react";

import { ProviderInstanceIcon } from "~/components/chat/ProviderInstanceIcon";
import { Input } from "~/components/ui/input";
import { Toggle, ToggleGroup } from "~/components/ui/toggle-group";
import {
  cacheHitRate,
  costPerMillionTokens,
  modelShare,
  sortModelsByTokens,
} from "~/components/usage/usageBreakdown";
import { PROVIDER_PRESENTATION } from "~/components/usage/usageProviders";
import { cn } from "~/lib/utils";
import {
  sortAndFilterUsageModels,
  sortAndFilterUsageProjects,
  sortAndFilterUsageSessions,
  type UsageModelSortKey,
  type UsageProjectSortKey,
  type UsageSessionSortKey,
  type UsageSortDirection,
} from "./usageDashboard.logic";

export type UsageBreakdownTab = "model" | "project" | "session" | "time";

function ProviderMark({
  provider,
  className,
}: {
  readonly provider: UsageProviderKind;
  readonly className: string;
}) {
  const presentation = PROVIDER_PRESENTATION[provider];
  return (
    <ProviderInstanceIcon
      driverKind={presentation.driverKind}
      displayName={presentation.label}
      iconClassName={className}
    />
  );
}

function SortableHead({
  label,
  active,
  direction,
  align = "right",
  className,
  onClick,
}: {
  readonly label: string;
  readonly active: boolean;
  readonly direction: UsageSortDirection;
  readonly align?: "left" | "right";
  readonly className?: string;
  readonly onClick: () => void;
}) {
  return (
    <th
      className={cn("py-2 font-normal", align === "left" ? "text-left" : "text-right", className)}
    >
      <button
        type="button"
        onClick={onClick}
        className={cn(
          "inline-flex cursor-pointer items-center gap-1 transition-colors outline-none hover:text-foreground focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring",
          active && "font-medium text-foreground",
        )}
      >
        <span>{label}</span>
        {active ? (
          direction === "asc" ? (
            <ArrowUpIcon className="size-3" aria-hidden />
          ) : (
            <ArrowDownIcon className="size-3" aria-hidden />
          )
        ) : null}
      </button>
    </th>
  );
}

function shortSessionId(sessionId: string): string {
  return sessionId.length <= 14 ? sessionId : `${sessionId.slice(0, 8)}…${sessionId.slice(-4)}`;
}

export function UsageBreakdownSection({
  merged,
  activeProviders,
  loadingProviders,
  loadingPartial,
  metric,
  shownHourly,
  timeZone,
  hour12,
  breakdownTab,
  onBreakdownTabChange,
  activeProjectKey,
  lockedPeriod,
  onToggleLockedPeriod,
  onSelectModel,
  onSetModelPrice,
  onSelectProject,
  onOpenThread,
  onInspectSession,
  connectedEnvironmentIds,
}: {
  readonly merged: MergedUsage;
  readonly activeProviders: readonly UsageProviderKind[];
  readonly loadingProviders: ReadonlySet<UsageProviderKind>;
  readonly loadingPartial: boolean;
  readonly metric: "cost" | "tokens";
  readonly shownHourly: boolean;
  readonly timeZone: string;
  readonly hour12: boolean;
  readonly breakdownTab: UsageBreakdownTab;
  readonly onBreakdownTabChange: (tab: UsageBreakdownTab) => void;
  readonly activeProjectKey: string | null;
  readonly lockedPeriod: string | null;
  readonly onToggleLockedPeriod: (period: string) => void;
  readonly onSelectModel: (key: string) => void;
  readonly onSetModelPrice: (model: string) => void;
  readonly onSelectProject: (selection: {
    readonly projectKey: string;
    readonly label: string;
    readonly unattributed?: true;
  }) => void;
  readonly onOpenThread: (environmentId: EnvironmentId, threadId: string) => void;
  readonly onInspectSession: (session: MergedSessionTotals) => void;
  readonly connectedEnvironmentIds: ReadonlySet<EnvironmentId>;
}) {
  const gt = useGT();
  const locale = useLocale();
  const [query, setQuery] = useState("");
  const [userModelSort, setUserModelSort] = useState<{
    readonly key: UsageModelSortKey;
    readonly direction: UsageSortDirection;
  } | null>(null);
  const [userProjectSort, setUserProjectSort] = useState<{
    readonly key: UsageProjectSortKey;
    readonly direction: UsageSortDirection;
  } | null>(null);
  const [userSessionSort, setUserSessionSort] = useState<{
    readonly key: UsageSessionSortKey;
    readonly direction: UsageSortDirection;
  } | null>(null);

  const defaultSortKey = metric === "tokens" ? "tokens" : "cost";
  const modelSort = userModelSort ?? { key: defaultSortKey, direction: "desc" as const };
  const projectSort = userProjectSort ?? { key: defaultSortKey, direction: "desc" as const };
  const sessionSort = userSessionSort ?? { key: defaultSortKey, direction: "desc" as const };

  const figureClass = (loading: boolean) =>
    cn("transition-opacity", loading && "opacity-40 delay-150");

  const toggleModelSort = (key: UsageModelSortKey) =>
    setUserModelSort((prev) => {
      const current = prev ?? { key: defaultSortKey, direction: "desc" as const };
      return current.key === key
        ? { key, direction: current.direction === "desc" ? "asc" : "desc" }
        : { key, direction: key === "model" ? "asc" : "desc" };
    });

  const toggleProjectSort = (key: UsageProjectSortKey) =>
    setUserProjectSort((prev) => {
      const current = prev ?? { key: defaultSortKey, direction: "desc" as const };
      return current.key === key
        ? { key, direction: current.direction === "desc" ? "asc" : "desc" }
        : { key, direction: key === "label" ? "asc" : "desc" };
    });

  const toggleSessionSort = (key: UsageSessionSortKey) =>
    setUserSessionSort((prev) => {
      const current = prev ?? { key: defaultSortKey, direction: "desc" as const };
      return current.key === key
        ? { key, direction: current.direction === "desc" ? "asc" : "desc" }
        : { key, direction: key === "title" ? "asc" : "desc" };
    });

  const models =
    query.trim() === "" && modelSort.key === "tokens" && modelSort.direction === "desc"
      ? sortModelsByTokens(merged.models)
      : sortAndFilterUsageModels(merged.models, {
          query,
          sortKey: modelSort.key,
          direction: modelSort.direction,
          metric,
        });
  const modelPeak = models.reduce(
    (peak, entry) => Math.max(peak, metric === "tokens" ? entry.totalTokens : entry.costUsd),
    0,
  );

  const projects = sortAndFilterUsageProjects(merged.projects, {
    query,
    sortKey: projectSort.key,
    direction: projectSort.direction,
    metric,
  });
  const projectPeak = projects.reduce(
    (peak, entry) => Math.max(peak, metric === "tokens" ? entry.totalTokens : entry.costUsd),
    0,
  );

  const sessions = sortAndFilterUsageSessions(merged.topSessions, {
    query,
    sortKey: sessionSort.key,
    direction: sessionSort.direction,
  });

  const breakdownPeriods: readonly (DailyTotals | HourlyTotals)[] = (
    shownHourly ? merged.hourly : merged.daily
  ).toReversed();

  return (
    <section
      data-testid="usage-breakdown-section"
      className="flex flex-col gap-3 rounded-xl border border-border/70 bg-card/65 p-4"
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <h2 className="text-sm font-medium text-foreground">
            <T>Breakdown</T>
          </h2>
          <ToggleGroup
            aria-label={gt("Usage breakdown")}
            variant="segmented"
            value={[breakdownTab]}
            onValueChange={(next) => {
              const value = next[0] as UsageBreakdownTab | undefined;
              if (value) onBreakdownTabChange(value);
            }}
          >
            <Toggle value="model" data-testid="usage-breakdown-tab-model">
              <T>Model</T>
            </Toggle>
            <Toggle value="project" data-testid="usage-breakdown-tab-project">
              <T>Project</T>
            </Toggle>
            <Toggle value="session" data-testid="usage-breakdown-tab-session">
              <T>Top sessions</T>
            </Toggle>
            <Toggle value="time" data-testid="usage-breakdown-tab-time">
              {shownHourly ? <T>Hour</T> : <T>Day</T>}
            </Toggle>
          </ToggleGroup>
        </div>

        {breakdownTab !== "time" ? (
          <div className="w-full sm:w-56">
            <Input
              size="compact"
              value={query}
              placeholder={
                breakdownTab === "model"
                  ? gt("Filter models…")
                  : breakdownTab === "project"
                    ? gt("Filter projects…")
                    : gt("Filter sessions…")
              }
              aria-label={gt("Filter breakdown rows")}
              data-testid="usage-breakdown-search"
              onChange={(event) => setQuery(event.target.value)}
            />
          </div>
        ) : null}
      </div>

      {breakdownTab === "model" ? (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border text-right text-xs text-muted-foreground">
                <th className="py-2 pr-3 pl-2 text-left font-normal">#</th>
                <SortableHead
                  label={gt("Model")}
                  active={modelSort.key === "model"}
                  direction={modelSort.direction}
                  align="left"
                  onClick={() => toggleModelSort("model")}
                />
                <SortableHead
                  label={gt("Cost")}
                  active={modelSort.key === "cost"}
                  direction={modelSort.direction}
                  className="pl-5"
                  onClick={() => toggleModelSort("cost")}
                />
                <SortableHead
                  label={gt("Share", { $context: "column heading, percentage share" })}
                  active={modelSort.key === "share"}
                  direction={modelSort.direction}
                  className="hidden pl-5 sm:table-cell"
                  onClick={() => toggleModelSort("share")}
                />
                <SortableHead
                  label={gt("Tokens")}
                  active={modelSort.key === "tokens"}
                  direction={modelSort.direction}
                  className="pl-5"
                  onClick={() => toggleModelSort("tokens")}
                />
                <SortableHead
                  label={gt("Cache hit")}
                  active={modelSort.key === "cacheHit"}
                  direction={modelSort.direction}
                  className="hidden pl-5 md:table-cell"
                  onClick={() => toggleModelSort("cacheHit")}
                />
                <SortableHead
                  label={gt("$/1M")}
                  active={modelSort.key === "perMillion"}
                  direction={modelSort.direction}
                  className="hidden pr-2 pl-5 lg:table-cell"
                  onClick={() => toggleModelSort("perMillion")}
                />
              </tr>
            </thead>
            <tbody>
              {models.length === 0 ? (
                <tr>
                  <td colSpan={7} className="py-8 text-center text-muted-foreground">
                    <T>No matching model activity in this window.</T>
                  </td>
                </tr>
              ) : (
                models.map((model, index) => {
                  const key = `${model.provider}:${model.model}`;
                  const value = metric === "tokens" ? model.totalTokens : model.costUsd;
                  const hasBar = value > 0 && modelPeak > 0;
                  const share = modelShare(model, metric);
                  const hit = cacheHitRate(model);
                  const perMillion = costPerMillionTokens(model);
                  const costUnknown = isModelCostUnknown(model);
                  const rowFigures = figureClass(loadingProviders.has(model.provider));
                  return (
                    <tr
                      key={key}
                      data-testid="usage-model-row"
                      className="border-b border-border/50 text-right whitespace-nowrap text-muted-foreground tabular-nums transition-colors hover:bg-muted/45"
                    >
                      <td className="py-2.5 pr-3 pl-2 text-left text-xs">{index + 1}</td>
                      <td className="py-2.5 text-left whitespace-normal">
                        <button
                          type="button"
                          onClick={() => onSelectModel(key)}
                          className="flex cursor-pointer items-center gap-2 text-left font-medium text-foreground outline-none hover:underline focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring"
                        >
                          <ProviderMark provider={model.provider} className="size-3.5 shrink-0" />
                          <span>{model.model}</span>
                        </button>
                        {hasBar ? (
                          <div
                            aria-hidden
                            className={cn(
                              "mt-1.5 h-1 max-w-52 rounded-full bg-muted/60",
                              rowFigures,
                            )}
                          >
                            <div
                              className="h-full rounded-full"
                              style={{
                                width: `max(0.5rem, ${(value / modelPeak) * 100}%)`,
                                backgroundColor: PROVIDER_PRESENTATION[model.provider].color,
                              }}
                            />
                          </div>
                        ) : null}
                      </td>
                      <td className={cn("py-2.5 pl-5 text-foreground", rowFigures)}>
                        {costUnknown ? (
                          <button
                            type="button"
                            data-testid="usage-model-set-price"
                            onClick={() => onSetModelPrice(model.model)}
                            className="cursor-pointer rounded bg-warning/15 px-1.5 py-0.5 text-xs font-medium text-warning-foreground transition-colors outline-none hover:bg-warning/25 focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring"
                          >
                            <T>Set price</T>
                          </button>
                        ) : (
                          formatUsd(model.costUsd, locale)
                        )}
                      </td>
                      <td className={cn("hidden py-2.5 pl-5 sm:table-cell", rowFigures)}>
                        {share === null ? "-" : formatPercent(share)}
                      </td>
                      <td className={cn("py-2.5 pl-5", rowFigures)}>
                        {formatTokens(model.totalTokens)}
                      </td>
                      <td className={cn("hidden py-2.5 pl-5 md:table-cell", rowFigures)}>
                        {hit === null ? "-" : formatPercent(hit)}
                      </td>
                      <td className={cn("hidden py-2.5 pr-2 pl-5 lg:table-cell", rowFigures)}>
                        {perMillion === null ? "-" : formatUsd(perMillion, locale)}
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      ) : breakdownTab === "project" ? (
        !merged.hasProjectAttribution && merged.projects.length === 0 ? (
          <p
            data-testid="usage-projects-unsupported"
            className="py-8 text-center text-sm text-muted-foreground"
          >
            <T>
              Connected environments do not report project attribution yet. Update the server to see
              per-project usage.
            </T>
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border text-right text-xs text-muted-foreground">
                  <th className="py-2 pr-3 pl-2 text-left font-normal">#</th>
                  <SortableHead
                    label={gt("Project")}
                    active={projectSort.key === "label"}
                    direction={projectSort.direction}
                    align="left"
                    onClick={() => toggleProjectSort("label")}
                  />
                  <th className="hidden py-2 pl-5 text-left font-normal md:table-cell">
                    <T>Top model</T>
                  </th>
                  <SortableHead
                    label={gt("Cost")}
                    active={projectSort.key === "cost"}
                    direction={projectSort.direction}
                    className="pl-5"
                    onClick={() => toggleProjectSort("cost")}
                  />
                  <SortableHead
                    label={gt("Share", { $context: "column heading, percentage share" })}
                    active={projectSort.key === "share"}
                    direction={projectSort.direction}
                    className="hidden pl-5 sm:table-cell"
                    onClick={() => toggleProjectSort("share")}
                  />
                  <SortableHead
                    label={gt("Tokens")}
                    active={projectSort.key === "tokens"}
                    direction={projectSort.direction}
                    className="pl-5"
                    onClick={() => toggleProjectSort("tokens")}
                  />
                  <SortableHead
                    label={gt("Sessions")}
                    active={projectSort.key === "sessions"}
                    direction={projectSort.direction}
                    className="pr-2 pl-5"
                    onClick={() => toggleProjectSort("sessions")}
                  />
                </tr>
              </thead>
              <tbody>
                {projects.length === 0 ? (
                  <tr>
                    <td colSpan={7} className="py-8 text-center text-muted-foreground">
                      <T>No matching project activity in this window.</T>
                    </td>
                  </tr>
                ) : (
                  projects.map((project, index) => {
                    const value = metric === "tokens" ? project.totalTokens : project.costUsd;
                    const share = metric === "tokens" ? project.tokenShare : project.costShare;
                    const isSelected = activeProjectKey === project.projectKey;
                    const unpriced =
                      project.records > 0 && project.unpricedRecords >= project.records;
                    return (
                      <tr
                        key={project.projectKey}
                        data-testid="usage-project-row"
                        data-project-key={project.projectKey}
                        className={cn(
                          "border-b border-border/50 text-right whitespace-nowrap text-muted-foreground tabular-nums transition-colors hover:bg-muted/45",
                          isSelected && "bg-info/10",
                        )}
                      >
                        <td className="py-2.5 pr-3 pl-2 text-left text-xs">{index + 1}</td>
                        <td className="py-2.5 text-left whitespace-normal">
                          <button
                            type="button"
                            onClick={() =>
                              onSelectProject({
                                projectKey: project.projectKey,
                                label: project.label,
                                ...(project.unattributed ? { unattributed: true as const } : {}),
                              })
                            }
                            className="flex cursor-pointer flex-wrap items-center gap-1.5 text-left font-medium text-foreground outline-none hover:underline focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring"
                          >
                            <span>{project.unattributed ? gt("Unattributed") : project.label}</span>
                            {project.worktreeCount > 0 ? (
                              <span className="inline-flex items-center gap-0.5 rounded bg-muted px-1.5 py-0.5 text-2xs font-normal text-muted-foreground">
                                <FolderGit2Icon className="size-3" aria-hidden />
                                {gt(
                                  "{count, plural, one {{count} worktree} other {{count} worktrees}}",
                                  { count: project.worktreeCount },
                                )}
                              </span>
                            ) : null}
                            <span className="inline-flex items-center gap-1">
                              {project.providers.map((provider) => (
                                <ProviderMark
                                  key={provider}
                                  provider={provider}
                                  className="size-3"
                                />
                              ))}
                            </span>
                          </button>
                          {project.workspaceRoot ? (
                            <p className="mt-0.5 max-w-xs truncate text-2xs font-mono text-muted-foreground">
                              {project.workspaceRoot}
                            </p>
                          ) : null}
                          {value > 0 && projectPeak > 0 ? (
                            <div
                              aria-hidden
                              className="mt-1.5 h-1 max-w-52 rounded-full bg-muted/60"
                            >
                              <div
                                className="h-full rounded-full bg-info"
                                style={{ width: `max(0.5rem, ${(value / projectPeak) * 100}%)` }}
                              />
                            </div>
                          ) : null}
                        </td>
                        <td className="hidden max-w-44 truncate py-2.5 pl-5 text-left text-xs md:table-cell">
                          {project.topModel ?? "-"}
                        </td>
                        <td
                          className={cn("py-2.5 pl-5 text-foreground", figureClass(loadingPartial))}
                        >
                          {unpriced ? gt("Unpriced") : formatUsd(project.costUsd, locale)}
                        </td>
                        <td
                          className={cn(
                            "hidden py-2.5 pl-5 sm:table-cell",
                            figureClass(loadingPartial),
                          )}
                        >
                          {formatPercent(share)}
                        </td>
                        <td className={cn("py-2.5 pl-5", figureClass(loadingPartial))}>
                          {formatTokens(project.totalTokens)}
                        </td>
                        <td className={cn("py-2.5 pr-2 pl-5", figureClass(loadingPartial))}>
                          {formatCount(project.sessions, locale)}
                        </td>
                      </tr>
                    );
                  })
                )}
              </tbody>
            </table>
          </div>
        )
      ) : breakdownTab === "session" ? (
        !merged.hasSessionAttribution && merged.topSessions.length === 0 ? (
          <p
            data-testid="usage-sessions-unsupported"
            className="py-8 text-center text-sm text-muted-foreground"
          >
            <T>
              Connected environments do not report top sessions yet. Update the server to inspect
              top sessions.
            </T>
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border text-right text-xs text-muted-foreground">
                  <SortableHead
                    label={gt("Session")}
                    active={sessionSort.key === "title"}
                    direction={sessionSort.direction}
                    align="left"
                    className="pl-2"
                    onClick={() => toggleSessionSort("title")}
                  />
                  <th className="hidden py-2 pl-5 text-left font-normal md:table-cell">
                    <T>Model</T>
                  </th>
                  <SortableHead
                    label={gt("Cost")}
                    active={sessionSort.key === "cost"}
                    direction={sessionSort.direction}
                    className="pl-5"
                    onClick={() => toggleSessionSort("cost")}
                  />
                  <SortableHead
                    label={gt("Tokens")}
                    active={sessionSort.key === "tokens"}
                    direction={sessionSort.direction}
                    className="pl-5"
                    onClick={() => toggleSessionSort("tokens")}
                  />
                  <SortableHead
                    label={gt("Cache hit")}
                    active={sessionSort.key === "cacheHit"}
                    direction={sessionSort.direction}
                    className="hidden pl-5 sm:table-cell"
                    onClick={() => toggleSessionSort("cacheHit")}
                  />
                  <SortableHead
                    label={gt("Last active")}
                    active={sessionSort.key === "lastActive"}
                    direction={sessionSort.direction}
                    className="hidden pr-2 pl-5 lg:table-cell"
                    onClick={() => toggleSessionSort("lastActive")}
                  />
                </tr>
              </thead>
              <tbody>
                {sessions.length === 0 ? (
                  <tr>
                    <td colSpan={6} className="py-8 text-center text-muted-foreground">
                      <T>No matching sessions in this window.</T>
                    </td>
                  </tr>
                ) : (
                  sessions.map((session) => {
                    const unpriced =
                      session.records > 0 && session.unpricedRecords >= session.records;
                    const inputTotal =
                      session.totals.uncachedInputTokens +
                      session.totals.cachedInputTokens +
                      session.totals.cacheCreationTokens;
                    const hit =
                      inputTotal > 0 ? session.totals.cachedInputTokens / inputTotal : null;
                    const hasThread = session.t3ThreadId !== undefined;
                    const canJumpToThread =
                      hasThread && connectedEnvironmentIds.has(session.environmentId);
                    const sessionProjectLabel =
                      session.projectKey === UNATTRIBUTED_USAGE_PROJECT_KEY
                        ? gt("Unattributed")
                        : session.projectLabel;
                    return (
                      <tr
                        key={`${session.environmentId}:${session.provider}:${session.sessionId}`}
                        data-testid="usage-session-row"
                        className="border-b border-border/50 text-right whitespace-nowrap text-muted-foreground tabular-nums transition-colors hover:bg-muted/45"
                      >
                        <td className="max-w-md py-2.5 pl-2 text-left whitespace-normal">
                          <button
                            type="button"
                            onClick={() => {
                              if (canJumpToThread && session.t3ThreadId !== undefined) {
                                onOpenThread(session.environmentId, session.t3ThreadId);
                              } else {
                                onInspectSession(session);
                              }
                            }}
                            className="flex cursor-pointer items-center gap-2 text-left font-medium text-foreground outline-none hover:underline focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring"
                          >
                            <ProviderMark
                              provider={session.provider}
                              className="size-3.5 shrink-0"
                            />
                            <span className="truncate">
                              {session.title ?? shortSessionId(session.sessionId)}
                            </span>
                            {canJumpToThread ? (
                              <ArrowUpRightIcon
                                className="size-3.5 shrink-0 text-info-foreground"
                                aria-label={gt("Open T3 thread")}
                              />
                            ) : null}
                          </button>
                          <div className="mt-0.5 flex flex-wrap items-center gap-1.5 text-2xs text-muted-foreground">
                            <span>{sessionProjectLabel}</span>
                            {!hasThread ? (
                              <span className="rounded bg-muted px-1 py-0.5">
                                <T>External CLI</T>
                              </span>
                            ) : !canJumpToThread ? (
                              <span
                                data-testid="usage-session-host-offline"
                                className="rounded bg-warning/15 px-1 py-0.5 text-warning-foreground"
                              >
                                <T>Host offline</T>
                              </span>
                            ) : null}
                          </div>
                        </td>
                        <td className="hidden max-w-44 truncate py-2.5 pl-5 text-left text-xs md:table-cell">
                          {session.primaryModel}
                          {session.models.length > 1 ? ` +${session.models.length - 1}` : ""}
                        </td>
                        <td className="py-2.5 pl-5 text-foreground">
                          {unpriced ? gt("Unpriced") : formatUsd(session.costUsd, locale)}
                        </td>
                        <td className="py-2.5 pl-5">{formatTokens(session.totalTokens)}</td>
                        <td className="hidden py-2.5 pl-5 sm:table-cell">
                          {hit === null ? "-" : formatPercent(hit)}
                        </td>
                        <td className="hidden py-2.5 pr-2 pl-5 text-xs lg:table-cell">
                          {formatDateTimeShort(
                            new Date(session.lastTimestampMs).toISOString(),
                            timeZone,
                            hour12,
                            locale,
                          )}
                        </td>
                      </tr>
                    );
                  })
                )}
              </tbody>
            </table>
          </div>
        )
      ) : (
        <div
          className="overflow-x-auto outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
          role="region"
          aria-label={gt("Usage breakdown by time")}
          tabIndex={0}
        >
          <table className="w-full text-sm whitespace-nowrap" data-testid="usage-time-table">
            <thead>
              <tr className="border-b border-border text-left text-xs text-muted-foreground">
                <th className="py-2 pl-2 font-normal">{shownHourly ? gt("Hour") : gt("Day")}</th>
                {activeProviders.map((provider) => (
                  <th key={provider} className="py-2 pl-4 text-right font-normal">
                    {PROVIDER_PRESENTATION[provider].label}
                  </th>
                ))}
                <th className="py-2 pl-4 text-right font-normal">
                  <T>Total</T>
                </th>
                <th className="py-2 pr-2 pl-4 text-right font-normal">
                  {metric === "tokens" ? <T>Cost</T> : <T>Tokens</T>}
                </th>
              </tr>
            </thead>
            <tbody>
              {breakdownPeriods.length === 0 ? (
                <tr>
                  <td
                    colSpan={activeProviders.length + 3}
                    className="py-8 text-center text-muted-foreground"
                  >
                    <T>No activity in this window.</T>
                  </td>
                </tr>
              ) : (
                breakdownPeriods.map((period) => {
                  const periodKey = "hourStart" in period ? period.hourStart : period.day;
                  const isLocked = lockedPeriod === periodKey;
                  return (
                    <tr
                      key={periodKey}
                      data-testid="usage-time-row"
                      data-period={periodKey}
                      onClick={() => onToggleLockedPeriod(periodKey)}
                      className={cn(
                        "cursor-pointer border-b border-border/50 transition-colors hover:bg-muted/45",
                        isLocked && "bg-info/10",
                      )}
                    >
                      <td className="py-2 pl-2 font-medium text-foreground">
                        <button
                          type="button"
                          aria-pressed={isLocked}
                          onClick={(event) => {
                            event.stopPropagation();
                            onToggleLockedPeriod(periodKey);
                          }}
                          className="cursor-pointer rounded text-left font-medium text-foreground outline-none hover:underline focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
                        >
                          {"hourStart" in period
                            ? formatHourShort(period.hourStart, timeZone, hour12, locale)
                            : formatDayShort(period.day, locale)}
                        </button>
                      </td>
                      {activeProviders.map((provider) => {
                        const entry = period.byProvider.get(provider);
                        return (
                          <td
                            key={provider}
                            data-testid="usage-time-provider-cell"
                            className={cn(
                              "py-2 pl-4 text-right text-muted-foreground tabular-nums",
                              figureClass(loadingProviders.has(provider)),
                            )}
                          >
                            {metric === "tokens"
                              ? formatTokens(entry?.totalTokens ?? 0)
                              : formatUsd(entry?.costUsd ?? 0, locale)}
                          </td>
                        );
                      })}
                      <td
                        data-testid="usage-time-total-cell"
                        className={cn(
                          "py-2 pl-4 text-right font-medium text-foreground tabular-nums",
                          figureClass(loadingPartial),
                        )}
                      >
                        {metric === "tokens"
                          ? formatTokens(period.totalTokens)
                          : formatUsd(period.costUsd, locale)}
                      </td>
                      <td
                        data-testid="usage-time-secondary-cell"
                        className={cn(
                          "py-2 pr-2 pl-4 text-right text-muted-foreground tabular-nums",
                          figureClass(loadingPartial),
                        )}
                      >
                        {metric === "tokens"
                          ? formatUsd(period.costUsd, locale)
                          : formatTokens(period.totalTokens)}
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
