import { latestProviderTurnTokenUsage } from "@t3tools/client-runtime/state/context-window";
import type { EnvironmentId, ScopedThreadRef, ThreadId } from "@t3tools/contracts";
import { forkIdentity } from "@t3tools/shared/forkIdentity";
import { RotateCcwIcon, SlidersHorizontalIcon } from "lucide-react";
import { T, useGT } from "gt-react";

import type { ThreadDetailsUsageInput } from "~/components/chat/ThreadDetailsUsage";
import { resolveThreadDetailsLimits } from "~/components/chat/ThreadDetailsUsage.logic";
import { Button } from "~/components/ui/button";
import {
  Menu,
  MenuCheckboxItem,
  MenuGroup,
  MenuGroupLabel,
  MenuItem,
  MenuPopup,
  MenuSeparator,
  MenuTrigger,
} from "~/components/ui/menu";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";
import { useNowMinute } from "~/hooks/useNowMinute";
import { cn } from "~/lib/utils";
import { selectThreadPanelOpen, useRightPanelStore } from "~/rightPanelStore";
import { useQuietThreadProjection, useQuietThreadShell, useThreadError } from "~/state/entities";
import { HudActivityCard } from "./HudActivityCard";
import { HudContextCard, type ThreadHudCompactContext } from "./HudContextCard";
import { hasUsableHudQuotaLimits, HudQuotaCard } from "./HudQuotaCard";
import { HudSessionCard } from "./HudSessionCard";
import { HudSystemCard } from "./HudSystemCard";
import {
  deriveHudActivityMetrics,
  deriveHudContextMetrics,
  deriveHudHeaderSummary,
  deriveHudSessionMetrics,
  resolveOmpThreadHudLimits,
  type HudThreadStatusKind,
} from "./hudMetrics.logic";
import {
  type HudCardVisibilityKey,
  isDefaultHudUiOptions,
  useHudOptionsStore,
} from "./hudOptionsStore";

export type { ThreadHudCompactContext };

const EMPTY_USAGE_SOURCES: ThreadDetailsUsageInput["sources"] = [];

const STATUS_BADGE_CLASS: Record<HudThreadStatusKind, string> = {
  running: "bg-info/12 text-info-foreground",
  approval: "bg-warning/15 text-warning-foreground",
  input: "bg-warning/15 text-warning-foreground",
  error: "bg-error/15 text-error-foreground",
  waiting: "bg-warning/15 text-warning-foreground",
  idle: "bg-muted/70 text-muted-foreground",
};

const STATUS_DOT_CLASS: Record<HudThreadStatusKind, string> = {
  running: "bg-info",
  approval: "bg-warning",
  input: "bg-warning",
  error: "bg-error",
  waiting: "bg-warning",
  idle: "bg-muted-foreground/60",
};

function statusLabel(kind: HudThreadStatusKind, gt: ReturnType<typeof useGT>): string {
  switch (kind) {
    case "running":
      return gt("Running", { $context: "HUD thread status badge" });
    case "approval":
      return gt("Approval", { $context: "HUD thread status badge" });
    case "input":
      return gt("Input", { $context: "HUD thread status badge" });
    case "error":
      return gt("Error", { $context: "HUD thread status badge" });
    case "waiting":
      return gt("Waiting", { $context: "HUD thread status badge" });
    case "idle":
      return gt("Idle", { $context: "HUD thread status badge" });
  }
}

function resolveProviderLabel(usage: Partial<ThreadDetailsUsageInput> | undefined): string {
  const instanceId = usage?.providerInstanceId ?? null;
  if (!instanceId) return "";
  const provider = usage?.providers?.find((entry) => entry.instanceId === instanceId);
  return provider?.displayName ?? provider?.driver ?? instanceId;
}

function HudOptionSwitchRow(props: {
  readonly optionKey: HudCardVisibilityKey;
  readonly label: string;
}) {
  const checked = useHudOptionsStore((state) => state[props.optionKey]);
  const setCardVisible = useHudOptionsStore((state) => state.setCardVisible);
  return (
    <MenuCheckboxItem
      variant="switch"
      checked={checked}
      closeOnClick={false}
      onCheckedChange={(nextChecked) => setCardVisible(props.optionKey, nextChecked)}
    >
      {props.label}
    </MenuCheckboxItem>
  );
}

function HudOptionsMenu() {
  const gt = useGT();
  const showContext = useHudOptionsStore((state) => state.showContext);
  const showSession = useHudOptionsStore((state) => state.showSession);
  const showQuota = useHudOptionsStore((state) => state.showQuota);
  const showActivity = useHudOptionsStore((state) => state.showActivity);
  const showSystem = useHudOptionsStore((state) => state.showSystem);
  const systemExpanded = useHudOptionsStore((state) => state.systemExpanded);
  const resetHudOptions = useHudOptionsStore((state) => state.resetHudOptions);
  const isDefault = isDefaultHudUiOptions({
    showContext,
    showSession,
    showQuota,
    showActivity,
    showSystem,
    systemExpanded,
  });
  const optionsLabel = gt("HUD display options");

  return (
    <Menu>
      <Tooltip>
        <TooltipTrigger
          render={
            <MenuTrigger
              render={
                <Button
                  size="icon-xs"
                  variant="ghost-muted"
                  aria-label={optionsLabel}
                  data-testid="hud-options-trigger"
                />
              }
            />
          }
        >
          <SlidersHorizontalIcon aria-hidden />
        </TooltipTrigger>
        <TooltipPopup side="left" sideOffset={10}>
          {optionsLabel}
        </TooltipPopup>
      </Tooltip>
      <MenuPopup data-thread-hud-menu side="bottom" align="end" sideOffset={6}>
        <MenuGroup>
          <MenuGroupLabel>
            <T context="HUD options popover title">T3 Lab HUD</T>
          </MenuGroupLabel>
          <HudOptionSwitchRow optionKey="showContext" label={gt("Context lens")} />
          <HudOptionSwitchRow optionKey="showSession" label={gt("Session KPIs")} />
          <HudOptionSwitchRow optionKey="showQuota" label={gt("Quota limits")} />
          <HudOptionSwitchRow optionKey="showActivity" label={gt("Activity")} />
          <HudOptionSwitchRow optionKey="showSystem" label={gt("System resources")} />
        </MenuGroup>
        <MenuSeparator />
        <MenuItem
          disabled={isDefault}
          closeOnClick={false}
          data-testid="hud-options-reset"
          onClick={resetHudOptions}
        >
          <RotateCcwIcon aria-hidden />
          <span>
            <T context="reset HUD options button">Reset</T>
          </span>
        </MenuItem>
      </MenuPopup>
    </Menu>
  );
}

export function useHudLegacySuppression(
  usage: Partial<ThreadDetailsUsageInput> | undefined,
  threadRef: ScopedThreadRef | null = null,
): {
  readonly suppressLegacyContext: boolean;
  readonly suppressLegacyUsage: boolean;
} {
  const showContext = useHudOptionsStore((state) => state.showContext);
  const showQuota = useHudOptionsStore((state) => state.showQuota);
  const threadStructure = useQuietThreadProjection(threadRef);
  const projection = threadStructure?.projection ?? null;
  const nowMinute = useNowMinute();
  const nowMs = Date.parse(`${nowMinute}:00Z`);
  const providers = usage?.providers ?? [];
  const sources = usage?.sources ?? EMPTY_USAGE_SOURCES;
  const providerInstanceId = usage?.providerInstanceId ?? null;
  const provider = providers.find((entry) => entry.instanceId === providerInstanceId);
  const requestedModel = usage?.model ?? projection?.thread.modelSelection.model ?? null;
  const servedModel =
    provider?.driver === "omp"
      ? deriveHudHeaderSummary({
          runtimeStatus: null,
          hasPendingApproval: false,
          hasPendingUserInput: false,
          lastError: null,
          providerLabel: "",
          requestedModel,
          projection,
        }).servedModel
      : null;
  const resolvedLimits =
    showQuota && providers.length > 0
      ? provider?.driver === "omp"
        ? resolveOmpThreadHudLimits({
            provider,
            model: servedModel,
            fallbackModel: requestedModel,
            providers,
            sources,
            nowMs,
          })
        : resolveThreadDetailsLimits(providerInstanceId, requestedModel, providers, sources, nowMs)
      : null;
  return {
    suppressLegacyContext: showContext && usage?.contextWindow != null,
    suppressLegacyUsage: showQuota && hasUsableHudQuotaLimits(resolvedLimits),
  };
}

export function ThreadHudHeader(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly usage: Partial<ThreadDetailsUsageInput> | undefined;
}) {
  const gt = useGT();
  const threadRef = { environmentId: props.environmentId, threadId: props.threadId };
  const threadStructure = useQuietThreadProjection(threadRef);
  const shell = useQuietThreadShell(threadRef);
  const threadError = useThreadError(threadRef);
  const projection = threadStructure?.projection ?? null;
  const latestRunStatus = projection?.runs.at(-1)?.status ?? null;

  const hasPendingApproval =
    shell?.hasPendingApprovals === true ||
    (projection?.runtimeRequests.some(
      (request) =>
        request.status === "pending" &&
        request.kind !== "user_input" &&
        request.kind !== "dynamic_tool_call",
    ) ??
      false);
  const hasPendingUserInput =
    shell?.hasPendingUserInput === true ||
    (projection?.runtimeRequests.some(
      (request) => request.status === "pending" && request.kind === "user_input",
    ) ??
      false);

  const summary = deriveHudHeaderSummary({
    runtimeStatus: shell?.runtime?.status ?? latestRunStatus,
    hasPendingApproval,
    hasPendingUserInput,
    lastError: threadError ?? shell?.runtime?.lastError ?? null,
    providerLabel: resolveProviderLabel(props.usage),
    requestedModel: props.usage?.model ?? projection?.thread.modelSelection.model ?? null,
    projection,
  });

  const identityText = [summary.providerLabel, summary.modelDisplay].filter(Boolean).join(" · ");

  return (
    <div
      data-thread-hud-panel
      data-testid="hud-header"
      className="flex items-center justify-between gap-1.5 border-b border-border/65 px-2.5 py-2"
    >
      <div className="flex min-w-0 items-center gap-1.5">
        <span
          data-testid="hud-status-badge"
          data-status={summary.statusKind}
          className={cn(
            "inline-flex shrink-0 items-center gap-1 rounded-full px-1.5 py-0.5 text-3xs font-semibold",
            STATUS_BADGE_CLASS[summary.statusKind],
          )}
        >
          <span
            aria-hidden
            className={cn("size-1.5 rounded-full", STATUS_DOT_CLASS[summary.statusKind])}
          />
          <span>{statusLabel(summary.statusKind, gt)}</span>
        </span>
        {identityText ? (
          summary.modelSwitched && summary.requestedModel && summary.servedModel ? (
            <Tooltip>
              <TooltipTrigger
                render={
                  <span
                    tabIndex={0}
                    data-testid="hud-header-identity"
                    className="min-w-0 truncate text-2xs font-medium text-warning-foreground outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring"
                  />
                }
              >
                {identityText}
              </TooltipTrigger>
              <TooltipPopup side="left" sideOffset={12}>
                {gt("Requested {from}, served by {to}", {
                  from: summary.requestedModel,
                  to: summary.servedModel,
                })}
              </TooltipPopup>
            </Tooltip>
          ) : (
            <span
              data-testid="hud-header-identity"
              className="min-w-0 truncate text-2xs font-medium text-foreground/85"
            >
              {identityText}
            </span>
          )
        ) : (
          <span className="truncate text-2xs font-semibold text-muted-foreground">
            {forkIdentity.baseName}
          </span>
        )}
      </div>
      <div className="shrink-0">
        <HudOptionsMenu />
      </div>
    </div>
  );
}

export function ThreadHudSections(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly usage: Partial<ThreadDetailsUsageInput> | undefined;
  readonly compactContext?: ThreadHudCompactContext | undefined;
  readonly panelOpen?: boolean | undefined;
}) {
  const threadRef = { environmentId: props.environmentId, threadId: props.threadId };
  const showContext = useHudOptionsStore((state) => state.showContext);
  const showSession = useHudOptionsStore((state) => state.showSession);
  const showQuota = useHudOptionsStore((state) => state.showQuota);
  const showActivity = useHudOptionsStore((state) => state.showActivity);
  const showSystem = useHudOptionsStore((state) => state.showSystem);

  const inlineOpen = useRightPanelStore((state) =>
    selectThreadPanelOpen(state.threadPanelVisibilityByThreadKey, threadRef, "inline"),
  );
  const popoverOpen = useRightPanelStore((state) =>
    selectThreadPanelOpen(state.threadPanelVisibilityByThreadKey, threadRef, "popover"),
  );
  const panelOpen = props.panelOpen ?? (inlineOpen || popoverOpen);

  const threadStructure = useQuietThreadProjection(threadRef);
  const projection = threadStructure?.projection ?? null;
  const nowMinute = useNowMinute();
  const nowMs = Date.parse(`${nowMinute}:00Z`);

  const providers = props.usage?.providers ?? [];
  const sources = props.usage?.sources ?? EMPTY_USAGE_SOURCES;
  const contextWindow = props.usage?.contextWindow ?? null;
  const requestedModel = props.usage?.model ?? projection?.thread.modelSelection.model ?? null;

  const activeProviderThread =
    projection?.providerThreads.find(
      (providerThread) => providerThread.id === projection.thread.activeProviderThreadId,
    ) ?? null;
  const liveTokenUsage = projection
    ? latestProviderTurnTokenUsage(projection.providerTurns, projection, activeProviderThread)
    : null;

  const providerInstanceId = props.usage?.providerInstanceId ?? null;
  const provider = providers.find((entry) => entry.instanceId === providerInstanceId);
  const servedModel =
    provider?.driver === "omp"
      ? deriveHudHeaderSummary({
          runtimeStatus: null,
          hasPendingApproval: false,
          hasPendingUserInput: false,
          lastError: null,
          providerLabel: "",
          requestedModel,
          projection,
        }).servedModel
      : null;

  const resolvedLimits =
    providers.length > 0 && (showQuota || showSession)
      ? provider?.driver === "omp"
        ? resolveOmpThreadHudLimits({
            provider,
            model: servedModel,
            fallbackModel: requestedModel,
            providers,
            sources,
            nowMs,
          })
        : resolveThreadDetailsLimits(providerInstanceId, requestedModel, providers, sources, nowMs)
      : null;
  const usableLimits = hasUsableHudQuotaLimits(resolvedLimits) ? resolvedLimits : null;

  const contextMetrics = showContext
    ? deriveHudContextMetrics({
        contextWindow,
        liveTokenUsage,
        projection,
        requestedModel,
        nowMs,
      })
    : null;

  const shouldShowSession =
    showSession && (projection !== null || contextWindow !== null || requestedModel !== null);
  const sessionMetrics = shouldShowSession
    ? deriveHudSessionMetrics({
        contextWindow,
        projection,
        requestedModel,
        hasQuotaLimits: usableLimits !== null,
        nowMs,
      })
    : null;

  const activityMetrics = showActivity
    ? deriveHudActivityMetrics({
        projection,
        nowMs,
      })
    : null;

  const hasAnyCard =
    contextMetrics !== null ||
    sessionMetrics !== null ||
    (showQuota && usableLimits !== null) ||
    (activityMetrics !== null && !activityMetrics.isEmpty) ||
    (showSystem && panelOpen);

  if (!hasAnyCard) return null;

  return (
    <div
      data-thread-hud-panel
      data-testid="hud-sections"
      className="flex flex-col gap-2 border-t border-border/65 px-2 py-2.5"
    >
      {contextMetrics !== null ? (
        <HudContextCard metrics={contextMetrics} compactContext={props.compactContext} />
      ) : null}

      {sessionMetrics !== null ? <HudSessionCard metrics={sessionMetrics} /> : null}

      {showQuota && usableLimits !== null ? (
        <HudQuotaCard limits={usableLimits} now={nowMs} />
      ) : null}

      {activityMetrics !== null && !activityMetrics.isEmpty ? (
        <HudActivityCard
          metrics={activityMetrics}
          environmentId={props.environmentId}
          threadId={props.threadId}
        />
      ) : null}

      {showSystem ? (
        <HudSystemCard
          environmentId={props.environmentId}
          threadId={props.threadId}
          panelOpen={panelOpen}
          contextWindow={contextWindow}
          projection={projection}
        />
      ) : null}
    </div>
  );
}
