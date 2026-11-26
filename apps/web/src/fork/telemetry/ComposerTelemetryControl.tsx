import { useAtomValue } from "@effect/atom-react";
import { secondTick } from "@t3tools/client-runtime/clock";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  latestProviderTurnTokenUsage,
  type ContextWindowSnapshot,
} from "@t3tools/client-runtime/state/context-window";
import type { ThreadStructure } from "@t3tools/client-runtime/state/models";
import type {
  EnvironmentId,
  OrchestrationV2RemoteTaskChild,
  OrchestrationV2SubagentUsage,
  ScopedThreadRef,
  ThreadId,
} from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import {
  BotIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  EyeOffIcon,
  Minimize2Icon,
} from "lucide-react";
import { useRef, useState, useSyncExternalStore } from "react";
import { T, useGT, useLocale, useMessages } from "gt-react";

import { ComposerControl, type ComposerControlSize } from "~/components/chat/ComposerControl";
import { useComposerMenuProps } from "~/components/chat/composerEventScope";
import { useComposerMenuState } from "~/components/chat/useComposerMenuState";
import { Button } from "~/components/ui/button";
import { Popover, PopoverPopup, PopoverTrigger } from "~/components/ui/popover";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";
import type { ThreadHudCompactContext } from "~/fork/hud/HudContextCard";
import {
  deriveComposerContextBreakdown,
  derivePromptCacheCountdown,
  deriveSessionTelemetryMetrics,
  formatHudCompactDuration,
  type HudContextUsageTone,
  type HudSubagentEntry,
  type HudSubagentStatus,
} from "~/fork/hud/hudMetrics.logic";
import { useHudOptionsStore } from "~/fork/hud/hudOptionsStore";
import { useNowMinute } from "~/hooks/useNowMinute";
import { useSideThreadTrigger } from "~/hooks/useSideThreadTrigger";
import { formatContextWindowTokens } from "~/lib/contextWindow";
import { openSideThread } from "~/lib/sideChatPane";
import { cn } from "~/lib/utils";
import { useRightPanelStore } from "~/rightPanelStore";
import { appAtomRegistry } from "~/rpc/atomRegistry";
import { useQuietThreadProjection } from "~/state/entities";
import { useLinkedThreadOpener } from "~/state/linkedThreadView";
import { serverEnvironment } from "~/state/server";
import { environmentThreadDetails } from "~/state/threads";
import { buildThreadRouteParams } from "~/threadRoutes";

export interface ComposerTelemetryControlProps {
  readonly threadRef: ScopedThreadRef;
  readonly requestedModel: string | null | undefined;
  readonly contextWindow: ContextWindowSnapshot | null;
  readonly compactContext?: ThreadHudCompactContext | undefined;
  readonly size?: ComposerControlSize;
  readonly hidden?: boolean;
}

type TelemetryTab = "context" | "session";
type BreakdownBucketKey =
  | "messages"
  | "systemBase"
  | "tools"
  | "mcpTools"
  | "subagents"
  | "remaining";

const RING_RADIUS = 5.5;
const RING_CIRCUMFERENCE = 2 * Math.PI * RING_RADIUS;

const RING_TONE_CLASS: Record<HudContextUsageTone, string> = {
  normal: "text-info",
  warning: "text-warning",
  error: "text-error",
};

const BUCKET_BAR_CLASS: Record<Exclude<BreakdownBucketKey, "remaining">, string> = {
  messages: "bg-info",
  systemBase: "bg-warning",
  tools: "bg-success",
  mcpTools: "bg-update",
  subagents: "bg-primary",
};

const BUCKET_DOT_CLASS: Record<BreakdownBucketKey, string> = {
  messages: "bg-info",
  systemBase: "bg-warning",
  tools: "bg-success",
  mcpTools: "bg-update",
  subagents: "bg-primary",
  remaining: "bg-muted-foreground/30",
};

const SUBAGENT_DOT_CLASS: Record<HudSubagentStatus, string> = {
  running: "bg-info",
  waiting: "bg-warning",
  completed: "bg-success",
  failed: "bg-error",
  cancelled: "bg-muted-foreground/60",
};

const EMPTY_CHILD_PROJECTIONS: ReadonlyMap<ThreadId, ThreadStructure> = new Map();

function formatPercent(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return "–";
  if (value > 0 && value < 0.1) return "<0.1%";
  return `${value.toFixed(1)}%`;
}

function formatWholePercent(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return "–";
  return `${Math.round(value)}%`;
}

function formatSpeed(tokensPerSecond: number | null): string {
  if (tokensPerSecond === null || !Number.isFinite(tokensPerSecond)) return "–";
  if (tokensPerSecond > 0 && tokensPerSecond < 0.1) return "<0.1 tok/s";
  return `${tokensPerSecond.toFixed(1)} tok/s`;
}

function formatCurrency(amount: number, currency: string, locale: string): string {
  if (!Number.isFinite(amount) || amount < 0) return "–";
  if (amount > 0 && amount < 0.0001) {
    return `<${formatCurrency(0.0001, currency, locale)}`;
  }
  const fractionDigits = amount > 0 && amount < 0.01 ? 4 : 2;
  const code = currency.trim().toUpperCase();
  if (/^[A-Z]{3}$/.test(code)) {
    try {
      return new Intl.NumberFormat(locale, {
        style: "currency",
        currency: code,
        minimumFractionDigits: fractionDigits,
        maximumFractionDigits: fractionDigits,
      }).format(amount);
    } catch {
      return `${code} ${amount.toFixed(fractionDigits)}`;
    }
  }
  return `${amount.toFixed(fractionDigits)} ${currency.trim()}`;
}

function formatTokenCount(tokens: number | null | undefined): string {
  if (tokens == null || !Number.isFinite(tokens) || tokens < 0) return "–";
  return formatContextWindowTokens(tokens);
}

function useLoadedChildThreadProjections(
  environmentId: EnvironmentId,
  childThreadIds: ReadonlyArray<ThreadId>,
): ReadonlyMap<ThreadId, ThreadStructure> {
  const key = childThreadIds.join("\0");
  const cacheRef = useRef<{
    key: string;
    snapshot: ReadonlyMap<ThreadId, ThreadStructure>;
  }>({ key: "", snapshot: EMPTY_CHILD_PROJECTIONS });

  const ids = key === "" ? [] : (key.split("\0") as ThreadId[]);
  const subscribe = (listener: () => void) => {
    if (ids.length === 0) return () => {};
    const unsubscribes = ids.map((threadId) =>
      appAtomRegistry.subscribe(
        environmentThreadDetails.quietThreadAtom(scopeThreadRef(environmentId, threadId)),
        listener,
      ),
    );
    return () => {
      for (const unsubscribe of unsubscribes) unsubscribe();
    };
  };

  const getSnapshot = () => {
    if (ids.length === 0) return EMPTY_CHILD_PROJECTIONS;
    const prev = cacheRef.current.key === key ? cacheRef.current.snapshot : null;
    let changed = prev === null;
    const next = new Map<ThreadId, ThreadStructure>();
    for (const threadId of ids) {
      const loaded = appAtomRegistry.get(
        environmentThreadDetails.quietThreadAtom(scopeThreadRef(environmentId, threadId)),
      );
      if (loaded !== null) {
        next.set(threadId, loaded.projection);
        if (prev?.get(threadId) !== loaded.projection) changed = true;
      } else if (prev?.has(threadId)) {
        changed = true;
      }
    }
    if (!changed && prev !== null && prev.size === next.size) return prev;
    cacheRef.current = { key, snapshot: next };
    return next;
  };

  return useSyncExternalStore(subscribe, getSnapshot, () => EMPTY_CHILD_PROJECTIONS);
}

function TelemetryRingSvg(props: {
  readonly percent: number | null;
  readonly tone: HudContextUsageTone;
}) {
  const ratio = props.percent === null ? 0 : Math.max(0, Math.min(1, props.percent / 100));
  const offset = RING_CIRCUMFERENCE * (1 - ratio);
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 16 16"
      aria-hidden="true"
      className={cn("size-3.5 shrink-0", RING_TONE_CLASS[props.tone])}
      data-composer-control-icon
    >
      <circle
        cx="8"
        cy="8"
        r={RING_RADIUS}
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        className="opacity-20"
      />
      {ratio > 0 ? (
        <circle
          cx="8"
          cy="8"
          r={RING_RADIUS}
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeDasharray={RING_CIRCUMFERENCE}
          strokeDashoffset={offset}
          transform="rotate(-90 8 8)"
        />
      ) : null}
    </svg>
  );
}

function LiveSpeedValue(props: {
  readonly outputTokens: number;
  readonly startedAtMs: number;
  readonly fallback: number | null;
}) {
  const nowMs = useSyncExternalStore(
    secondTick.subscribe,
    secondTick.getSnapshot,
    secondTick.getSnapshot,
  );
  const elapsedMs = nowMs - props.startedAtMs;
  const rate =
    Number.isFinite(elapsedMs) && elapsedMs >= 500
      ? (props.outputTokens / elapsedMs) * 1_000
      : props.fallback;
  return <span className="font-medium text-foreground tabular-nums">{formatSpeed(rate)}</span>;
}

function LiveCacheCountdownValue(props: { readonly expiresAtMs: number }) {
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
  if (countdown.state === "cold") {
    return (
      <span className="font-medium text-muted-foreground">
        <T context="prompt cache status">Cold</T>
      </span>
    );
  }
  if (countdown.state === "warm" && countdown.remainingMs !== null) {
    return (
      <span className="inline-flex items-center gap-1 font-medium text-success-foreground tabular-nums">
        <span aria-hidden className="size-1.5 rounded-full bg-success" />
        <span>{formatHudCompactDuration(countdown.remainingMs, m)}</span>
      </span>
    );
  }
  return (
    <span className="font-medium text-muted-foreground">
      <T context="prompt cache status">Pending</T>
    </span>
  );
}

function LiveModelDurationValue(props: {
  readonly completedDurationMs: number;
  readonly activeRunStartedAtMs: number;
  readonly toolDurationMs: number;
}) {
  const m = useMessages();
  const nowMs = useSyncExternalStore(
    secondTick.subscribe,
    secondTick.getSnapshot,
    secondTick.getSnapshot,
  );
  const activeMs = props.completedDurationMs + Math.max(0, nowMs - props.activeRunStartedAtMs);
  const modelMs = Math.max(0, activeMs - props.toolDurationMs);
  return (
    <span className="font-medium text-foreground tabular-nums">
      {formatHudCompactDuration(modelMs, m)}
    </span>
  );
}

type TelemetrySubagentEntry = HudSubagentEntry & {
  readonly usage: OrchestrationV2SubagentUsage | null;
};

function SubagentContextCardBody(props: {
  readonly agent: TelemetrySubagentEntry;
  readonly interactive: boolean;
}) {
  const gt = useGT();
  const locale = useLocale();
  const m = useMessages();
  const { agent, interactive } = props;
  const usage = agent.usage;
  const contextTokens = usage?.contextTokens;
  const contextWindow = usage?.contextWindow;
  const contextPercent =
    contextTokens !== undefined && contextWindow !== undefined && contextWindow > 0
      ? Math.min(100, (contextTokens / contextWindow) * 100)
      : null;
  const totalTokens =
    usage?.totalTokens ??
    (usage?.inputTokens !== undefined && usage?.outputTokens !== undefined
      ? usage.inputTokens + usage.outputTokens
      : undefined);
  const cacheRate =
    usage?.inputTokens !== undefined &&
    usage.inputTokens > 0 &&
    usage.cachedInputTokens !== undefined
      ? (Math.min(usage.cachedInputTokens, usage.inputTokens) / usage.inputTokens) * 100
      : null;
  const speed =
    usage?.outputTokens !== undefined &&
    usage.outputTokens > 0 &&
    usage.durationMs !== undefined &&
    usage.durationMs >= 100
      ? (usage.outputTokens / usage.durationMs) * 1_000
      : null;

  const statBits: Array<{ readonly key: string; readonly label: string }> = [];
  if (totalTokens !== undefined) {
    statBits.push({
      key: "tokens",
      label: gt("Total {tokens}", { tokens: formatTokenCount(totalTokens) }),
    });
  }
  if (cacheRate !== null) {
    statBits.push({
      key: "cache",
      label: gt("Cache {percent}", { percent: formatPercent(cacheRate) }),
    });
  }
  if (speed !== null) {
    statBits.push({ key: "speed", label: formatSpeed(speed) });
  }
  if (usage?.costUsd !== undefined && usage.costUsd > 0) {
    statBits.push({ key: "cost", label: formatCurrency(usage.costUsd, "USD", locale) });
  }
  if (statBits.length < 3 && usage?.toolUses !== undefined && usage.toolUses > 0) {
    statBits.push({
      key: "tools",
      label: gt("{count, plural, one {{count} tool} other {{count} tools}}", {
        count: usage.toolUses,
      }),
    });
  }
  if (statBits.length === 0 && agent.durationMs !== null) {
    statBits.push({ key: "duration", label: formatHudCompactDuration(agent.durationMs, m) });
  }

  return (
    <div className="flex w-full min-w-0 flex-col gap-1">
      <div className="flex min-w-0 items-center gap-1.5">
        <span
          aria-hidden
          className={cn("size-1.5 shrink-0 rounded-full", SUBAGENT_DOT_CLASS[agent.status])}
        />
        <span className="min-w-0 flex-1 truncate text-xs font-medium text-foreground">
          {agent.title}
        </span>
        {agent.model ? (
          <span className="max-w-24 shrink-0 truncate rounded bg-muted px-1.5 py-0.5 text-3xs text-muted-foreground">
            {agent.model}
          </span>
        ) : null}
        {contextPercent !== null ? (
          <span className="shrink-0 text-xs font-semibold text-foreground tabular-nums">
            {formatPercent(contextPercent)}
          </span>
        ) : null}
        {interactive ? (
          <ChevronRightIcon aria-hidden className="size-3 shrink-0 text-muted-foreground/70" />
        ) : null}
      </div>

      {contextPercent !== null && contextTokens !== undefined && contextWindow !== undefined ? (
        <div className="flex items-center gap-2">
          <div className="h-1 flex-1 overflow-hidden rounded-full bg-muted">
            <div
              className="h-full rounded-full bg-info"
              style={{ width: `${Math.min(100, contextPercent)}%` }}
            />
          </div>
          <span className="shrink-0 text-3xs text-muted-foreground tabular-nums">
            {formatTokenCount(contextTokens)} / {formatTokenCount(contextWindow)}
          </span>
        </div>
      ) : null}

      {statBits.length > 0 ? (
        <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-3xs text-muted-foreground tabular-nums">
          {statBits.map((bit) => (
            <span key={bit.key}>{bit.label}</span>
          ))}
        </div>
      ) : null}
    </div>
  );
}

const SUBAGENT_CARD_BUTTON_CLASS =
  "flex w-full cursor-pointer rounded-lg px-2 py-1.5 text-left outline-none transition-colors hover:bg-accent/60 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring";

function LocalSubagentRow(props: {
  readonly agent: TelemetrySubagentEntry;
  readonly childThreadId: ThreadId;
  readonly threadRef: ScopedThreadRef;
  readonly onOpened: () => void;
}) {
  const navigate = useNavigate();
  const trigger = useSideThreadTrigger();
  const targetRef = scopeThreadRef(props.threadRef.environmentId, props.childThreadId);
  return (
    <button
      type="button"
      data-testid="composer-telemetry-subagent-row"
      {...trigger((intent) => {
        openSideThread({
          threadRef: targetRef,
          panelRef: props.threadRef,
          intent,
          navigate: (routeRef) =>
            void navigate({
              to: "/$environmentId/$threadId",
              params: buildThreadRouteParams(routeRef),
            }),
        });
        props.onOpened();
      })}
      className={SUBAGENT_CARD_BUTTON_CLASS}
    >
      <SubagentContextCardBody agent={props.agent} interactive />
    </button>
  );
}

function RemoteSubagentRow(props: {
  readonly agent: TelemetrySubagentEntry;
  readonly remoteChild: OrchestrationV2RemoteTaskChild;
  readonly threadRef: ScopedThreadRef;
  readonly onOpened: () => void;
}) {
  const trigger = useSideThreadTrigger();
  const opener = useLinkedThreadOpener(props.threadRef, props.remoteChild, props.agent.title);
  if (!opener) {
    return (
      <div data-testid="composer-telemetry-subagent-row" className="rounded-lg px-2 py-1.5">
        <SubagentContextCardBody agent={props.agent} interactive={false} />
      </div>
    );
  }
  return (
    <button
      type="button"
      data-testid="composer-telemetry-subagent-row"
      {...trigger((intent) => {
        opener.open(intent);
        props.onOpened();
      })}
      className={SUBAGENT_CARD_BUTTON_CLASS}
    >
      <SubagentContextCardBody agent={props.agent} interactive />
    </button>
  );
}

function StatRow(props: {
  readonly label: string;
  readonly value: React.ReactNode;
  readonly indented?: boolean;
  readonly testId?: string;
}) {
  return (
    <div
      data-testid={props.testId}
      className={cn(
        "flex items-center justify-between gap-3 py-0.5 text-xs",
        props.indented && "ps-3 text-muted-foreground",
      )}
    >
      <span className="min-w-0 truncate text-muted-foreground">{props.label}</span>
      <span className="shrink-0 font-medium text-foreground tabular-nums">{props.value}</span>
    </div>
  );
}

function ComposerTelemetryPopoverContent(props: {
  readonly threadRef: ScopedThreadRef;
  readonly projection: ThreadStructure | null;
  readonly requestedModel: string | null | undefined;
  readonly contextWindow: ContextWindowSnapshot | null;
  readonly compactContext?: ThreadHudCompactContext | undefined;
  readonly onClose: () => void;
  readonly onHideRing: () => void;
}) {
  const gt = useGT();
  const locale = useLocale();
  const m = useMessages();
  const nowMinute = useNowMinute();
  const [mountNowMs] = useState(() => Date.now());
  const parsedMinute = Date.parse(`${nowMinute}:00Z`);
  const nowMinuteMs = Number.isFinite(parsedMinute) ? parsedMinute : mountNowMs;
  const [activeTab, setActiveTab] = useState<TelemetryTab>("context");
  const [moreStatsExpanded, setMoreStatsExpanded] = useState(false);

  const serverSettings = useAtomValue(
    serverEnvironment.settingsValueAtom(props.threadRef.environmentId),
  );
  const localChildThreadIds: ThreadId[] = [];
  const seenChildIds = new Set<ThreadId>();
  for (const agent of props.projection?.subagents ?? []) {
    if (
      agent.childThreadId !== null &&
      agent.remoteChild === undefined &&
      !seenChildIds.has(agent.childThreadId)
    ) {
      seenChildIds.add(agent.childThreadId);
      localChildThreadIds.push(agent.childThreadId);
    }
  }
  const childThreadProjections = useLoadedChildThreadProjections(
    props.threadRef.environmentId,
    localChildThreadIds,
  );

  const liveTokenUsage = latestProviderTurnTokenUsage(
    props.projection?.providerTurns ?? [],
    props.projection,
  );
  const contextBreakdown = deriveComposerContextBreakdown({
    projection: props.projection,
    contextWindow: props.contextWindow,
    liveTokenUsage,
  });
  const session = deriveSessionTelemetryMetrics({
    projection: props.projection,
    contextWindow: props.contextWindow,
    liveTokenUsage,
    requestedModel: props.requestedModel,
    nowMs: nowMinuteMs,
    settings: serverSettings ?? undefined,
    childThreadProjections,
  });

  const bucketLabel = (key: BreakdownBucketKey): string => {
    switch (key) {
      case "messages":
        return gt("Messages", { $context: "context breakdown bucket" });
      case "systemBase":
        return contextBreakdown?.hasCompaction
          ? gt("Compaction base", { $context: "context breakdown bucket" })
          : gt("System base", { $context: "context breakdown bucket" });
      case "tools":
        return gt("Tools", { $context: "context breakdown bucket" });
      case "mcpTools":
        return gt("MCP tools", { $context: "context breakdown bucket" });
      case "subagents":
        return gt("Subagents", { $context: "context breakdown bucket" });
      case "remaining":
        return gt("Remaining space", { $context: "context breakdown bucket" });
    }
  };

  const visibleBuckets = (contextBreakdown?.buckets ?? []).filter((bucket) => {
    if (bucket.key === "remaining") return bucket.tokens !== null;
    if (bucket.key === "mcpTools" || bucket.key === "subagents") {
      return (bucket.tokens ?? 0) > 0;
    }
    return true;
  });

  let subagentCacheInput = 0;
  let subagentCacheRead = 0;
  for (const agent of session.subagents) {
    const input = agent.usage?.inputTokens;
    const cached = agent.usage?.cachedInputTokens;
    if (input !== undefined && input > 0 && cached !== undefined) {
      subagentCacheInput += input;
      subagentCacheRead += Math.min(cached, input);
    }
  }
  const subagentCacheHitRate =
    subagentCacheInput > 0 ? (subagentCacheRead / subagentCacheInput) * 100 : null;

  const mainTotalTokens =
    session.cumulativeTokens.total > 0 ? session.cumulativeTokens.total : null;
  const combinedTotalTokens =
    session.subagentSummary.totalTokens !== null && mainTotalTokens !== null
      ? mainTotalTokens + session.subagentSummary.totalTokens
      : null;

  const mainCostUsd =
    typeof session.cost.amount === "number" && session.cost.currency === "USD"
      ? session.cost.amount
      : null;
  const combinedCostUsd =
    mainCostUsd !== null && session.subagentSummary.costUsd !== null
      ? mainCostUsd + session.subagentSummary.costUsd
      : null;

  const isReferenceCost = session.cost.source === "reference" || session.cost.source === "override";

  const hideButton = (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            size="icon-xs"
            variant="ghost-muted"
            aria-label={gt("Hide composer telemetry ring")}
            data-testid="composer-telemetry-hide"
            onClick={() => {
              props.onHideRing();
              props.onClose();
            }}
          />
        }
      >
        <EyeOffIcon aria-hidden />
      </TooltipTrigger>
      <TooltipPopup side="top">{gt("Hide composer telemetry ring")}</TooltipPopup>
    </Tooltip>
  );

  return (
    <div
      data-testid="composer-telemetry-popover"
      className="flex max-h-[min(74vh,580px)] flex-col overflow-hidden"
    >
      <div className="flex items-center justify-between gap-2 border-b border-border/60 px-3 py-2">
        <div
          role="tablist"
          aria-label={gt("Telemetry view")}
          className="inline-flex rounded-lg bg-muted/65 p-0.5"
        >
          <button
            type="button"
            role="tab"
            aria-selected={activeTab === "context"}
            data-testid="composer-telemetry-tab-context"
            onClick={() => setActiveTab("context")}
            className={cn(
              "cursor-pointer rounded-md px-2 py-1 text-xs font-medium transition-colors outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
              activeTab === "context"
                ? "bg-background text-foreground shadow-2xs"
                : "text-muted-foreground hover:text-foreground",
            )}
          >
            <T context="composer telemetry tab">Context window</T>
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={activeTab === "session"}
            data-testid="composer-telemetry-tab-session"
            onClick={() => setActiveTab("session")}
            className={cn(
              "cursor-pointer rounded-md px-2 py-1 text-xs font-medium transition-colors outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
              activeTab === "session"
                ? "bg-background text-foreground shadow-2xs"
                : "text-muted-foreground hover:text-foreground",
            )}
          >
            <T context="composer telemetry tab">Session stats</T>
          </button>
        </div>
        {hideButton}
      </div>

      <div className="flex-1 overflow-y-auto px-3 py-2.5">
        {activeTab === "context" ? (
          <div data-testid="composer-telemetry-context-panel" className="flex flex-col gap-3">
            {contextBreakdown !== null ? (
              <>
                <div className="flex flex-col gap-1.5">
                  <div className="flex items-baseline justify-between gap-2">
                    <div className="flex items-center gap-1.5">
                      <span
                        data-testid="composer-telemetry-context-used"
                        className="text-sm font-semibold text-foreground tabular-nums"
                      >
                        {contextBreakdown.usedPercentage !== null
                          ? gt("Used {percent}", {
                              percent: formatPercent(contextBreakdown.usedPercentage),
                            })
                          : gt("Used {tokens}", {
                              tokens: formatTokenCount(contextBreakdown.usedTokens),
                            })}
                      </span>
                      {contextBreakdown.over200k ? (
                        <span className="rounded bg-warning/15 px-1 py-0.5 text-3xs font-semibold text-warning-foreground tabular-nums">
                          !200k+
                        </span>
                      ) : null}
                    </div>
                    <span className="text-xs text-muted-foreground tabular-nums">
                      {contextBreakdown.maxTokens !== null
                        ? `${formatTokenCount(contextBreakdown.usedTokens)} / ${formatTokenCount(contextBreakdown.maxTokens)}`
                        : formatTokenCount(contextBreakdown.usedTokens)}
                    </span>
                  </div>

                  <div
                    role="img"
                    aria-label={
                      contextBreakdown.maxTokens !== null &&
                      contextBreakdown.usedPercentage !== null
                        ? gt("Context window {percent} used, {used} of {max} tokens", {
                            percent: formatPercent(contextBreakdown.usedPercentage),
                            used: formatTokenCount(contextBreakdown.usedTokens),
                            max: formatTokenCount(contextBreakdown.maxTokens),
                          })
                        : gt("Context window {used} tokens used", {
                            used: formatTokenCount(contextBreakdown.usedTokens),
                          })
                    }
                    className="relative flex h-2 w-full overflow-hidden rounded-full bg-muted/80"
                  >
                    {contextBreakdown.buckets.map((bucket) =>
                      bucket.key !== "remaining" &&
                      (bucket.tokens ?? 0) > 0 &&
                      bucket.percentOfContext > 0 ? (
                        <span
                          key={bucket.key}
                          data-bucket={bucket.key}
                          className={cn("h-full shrink-0", BUCKET_BAR_CLASS[bucket.key])}
                          style={{ width: `${Math.min(100, bucket.percentOfContext)}%` }}
                        />
                      ) : null,
                    )}
                    {contextBreakdown.autoCompactTickPercent !== null ? (
                      <span
                        aria-hidden
                        className="pointer-events-none absolute inset-y-0 w-0.5 -translate-x-1/2 bg-foreground/80"
                        style={{
                          left: `clamp(1px, ${contextBreakdown.autoCompactTickPercent}%, calc(100% - 1px))`,
                        }}
                      />
                    ) : null}
                  </div>
                </div>

                <div className="flex flex-col gap-1" data-testid="composer-telemetry-buckets">
                  {visibleBuckets.map((bucket) => (
                    <div
                      key={bucket.key}
                      data-testid={`composer-telemetry-bucket-${bucket.key}`}
                      className="flex items-center justify-between gap-2 text-xs"
                    >
                      <span className="flex min-w-0 items-center gap-2 text-muted-foreground">
                        <span
                          aria-hidden
                          className={cn("size-2 shrink-0 rounded-xs", BUCKET_DOT_CLASS[bucket.key])}
                        />
                        <span className="truncate">{bucketLabel(bucket.key)}</span>
                      </span>
                      <span className="flex shrink-0 items-baseline gap-2.5 tabular-nums">
                        <span className="text-muted-foreground">
                          {bucket.key === "remaining"
                            ? formatTokenCount(bucket.tokens)
                            : `≈ ${formatTokenCount(bucket.tokens)}`}
                        </span>
                        <span className="w-11 text-right font-medium text-foreground">
                          {formatPercent(bucket.percentOfContext)}
                        </span>
                      </span>
                    </div>
                  ))}
                  <p className="pt-0.5 text-3xs text-muted-foreground/80">
                    <T context="context breakdown approximation note">
                      Breakdown estimated from visible thread items.
                    </T>
                  </p>
                </div>

                {contextBreakdown.cacheSplit !== null ? (
                  <div
                    data-testid="composer-telemetry-cache-split"
                    className="flex flex-col gap-1 border-t border-border/60 pt-2.5"
                  >
                    <div className="flex items-center justify-between gap-2 text-xs">
                      <span className="flex min-w-0 items-center gap-2 text-muted-foreground">
                        <span aria-hidden className="size-1.5 shrink-0 rounded-full bg-info" />
                        <span className="truncate">
                          <T context="context cache reuse label">Cached context</T>
                        </span>
                      </span>
                      <span className="flex shrink-0 items-baseline gap-2.5 tabular-nums">
                        <span className="text-muted-foreground">
                          {formatTokenCount(contextBreakdown.cacheSplit.cacheReuseTokens)}
                        </span>
                        <span className="w-11 text-right font-medium text-foreground">
                          {formatPercent(contextBreakdown.cacheSplit.cacheReusePercent)}
                        </span>
                      </span>
                    </div>
                    <div className="flex items-center justify-between gap-2 text-xs">
                      <span className="flex min-w-0 items-center gap-2 text-muted-foreground">
                        <span aria-hidden className="size-1.5 shrink-0 rounded-full bg-primary" />
                        <span className="truncate">
                          <T context="context new input label">New input this step</T>
                        </span>
                      </span>
                      <span className="flex shrink-0 items-baseline gap-2.5 tabular-nums">
                        <span className="text-muted-foreground">
                          {formatTokenCount(contextBreakdown.cacheSplit.newInputTokens)}
                        </span>
                        <span className="w-11 text-right font-medium text-foreground">
                          {formatPercent(contextBreakdown.cacheSplit.newInputPercent)}
                        </span>
                      </span>
                    </div>
                  </div>
                ) : null}
              </>
            ) : (
              <p className="text-xs text-muted-foreground">
                <T context="context window empty state">
                  Context window telemetry is not reported by this provider yet.
                </T>
              </p>
            )}

            {session.subagents.length > 0 ? (
              <div
                data-testid="composer-telemetry-subagents"
                className="flex flex-col gap-1.5 border-t border-border/60 pt-2.5"
              >
                <div className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
                  <BotIcon aria-hidden className="size-3.5 shrink-0" />
                  <span>
                    <T context="subagent contexts section title">Subagent contexts</T>
                  </span>
                  <span className="rounded-full bg-muted px-1.5 py-0.5 text-3xs font-semibold text-foreground tabular-nums">
                    {session.subagentSummary.total}
                  </span>
                </div>
                <div className="flex flex-col gap-1">
                  {session.subagents.map((agent) =>
                    agent.childThreadId !== null ? (
                      <LocalSubagentRow
                        key={agent.id}
                        agent={agent}
                        childThreadId={agent.childThreadId}
                        threadRef={props.threadRef}
                        onOpened={props.onClose}
                      />
                    ) : agent.remoteChild !== null ? (
                      <RemoteSubagentRow
                        key={agent.id}
                        agent={agent}
                        remoteChild={agent.remoteChild}
                        threadRef={props.threadRef}
                        onOpened={props.onClose}
                      />
                    ) : agent.origin !== "app_owned" ? (
                      <button
                        key={agent.id}
                        type="button"
                        data-testid="composer-telemetry-subagent-row"
                        className={SUBAGENT_CARD_BUTTON_CLASS}
                        onClick={() => {
                          useRightPanelStore
                            .getState()
                            .openSubagent(props.threadRef, agent.id, agent.title);
                          props.onClose();
                        }}
                      >
                        <SubagentContextCardBody agent={agent} interactive />
                      </button>
                    ) : (
                      <div
                        key={agent.id}
                        data-testid="composer-telemetry-subagent-row"
                        className="rounded-lg px-2 py-1.5"
                      >
                        <SubagentContextCardBody agent={agent} interactive={false} />
                      </div>
                    ),
                  )}
                </div>
              </div>
            ) : null}

            {props.compactContext ? (
              <div className="flex justify-end border-t border-border/60 pt-2">
                {props.compactContext.disabled && props.compactContext.disabledReason ? (
                  <Tooltip>
                    <TooltipTrigger
                      render={
                        <span className="inline-flex">
                          <Button
                            size="xs"
                            variant="outline"
                            disabled
                            data-testid="composer-telemetry-compact"
                          >
                            <Minimize2Icon aria-hidden />
                            <span>
                              <T context="context compaction action">Compact</T>
                            </span>
                          </Button>
                        </span>
                      }
                    />
                    <TooltipPopup side="top">{props.compactContext.disabledReason}</TooltipPopup>
                  </Tooltip>
                ) : (
                  <Button
                    size="xs"
                    variant="outline"
                    disabled={props.compactContext.disabled}
                    data-testid="composer-telemetry-compact"
                    onClick={() => {
                      props.compactContext?.onCompact();
                      props.onClose();
                    }}
                  >
                    <Minimize2Icon aria-hidden />
                    <span>
                      <T context="context compaction action">Compact</T>
                    </span>
                  </Button>
                )}
              </div>
            ) : null}
          </div>
        ) : (
          <div data-testid="composer-telemetry-session-panel" className="flex flex-col gap-2.5">
            <div className="flex flex-col gap-0.5">
              <StatRow
                testId="composer-telemetry-stat-turns"
                label={gt("Turns / steps")}
                value={`${session.turns} / ${session.steps}`}
              />
              <StatRow
                testId="composer-telemetry-stat-total-tokens"
                label={gt("Total tokens")}
                value={formatTokenCount(mainTotalTokens)}
              />
              <StatRow
                testId="composer-telemetry-stat-cost"
                label={isReferenceCost ? gt("API reference cost") : gt("Session cost")}
                value={
                  typeof session.cost.amount === "number" &&
                  typeof session.cost.currency === "string"
                    ? formatCurrency(session.cost.amount, session.cost.currency, locale)
                    : "–"
                }
              />
              <StatRow
                testId="composer-telemetry-stat-avg-speed"
                label={gt("Average speed")}
                value={formatSpeed(session.speed.average)}
              />
              <StatRow
                testId="composer-telemetry-stat-peak-speed"
                label={gt("Peak speed")}
                value={formatSpeed(session.speed.peak)}
              />
              <StatRow
                testId="composer-telemetry-stat-latest-speed"
                label={gt("Latest speed")}
                value={
                  session.speed.liveTurnOutputTokens !== null &&
                  session.speed.liveTurnStartedAtMs !== null ? (
                    <LiveSpeedValue
                      outputTokens={session.speed.liveTurnOutputTokens}
                      startedAtMs={session.speed.liveTurnStartedAtMs}
                      fallback={session.speed.latest}
                    />
                  ) : (
                    formatSpeed(session.speed.latest)
                  )
                }
              />
              <StatRow
                testId="composer-telemetry-stat-cache-hit"
                label={gt("Cache hit rate")}
                value={formatPercent(session.cache.hitRate)}
              />
              <StatRow
                testId="composer-telemetry-stat-cache-status"
                label={gt("Cache status")}
                value={
                  session.cache.expiresAtMs !== null ? (
                    <LiveCacheCountdownValue expiresAtMs={session.cache.expiresAtMs} />
                  ) : session.cache.state === "cold" ? (
                    <span className="text-muted-foreground">
                      <T context="prompt cache status">Cold</T>
                    </span>
                  ) : (
                    <span className="text-muted-foreground">
                      <T context="prompt cache status">Pending</T>
                    </span>
                  )
                }
              />
            </div>

            <div className="flex flex-col gap-0.5 border-t border-border/60 pt-2">
              <button
                type="button"
                aria-expanded={moreStatsExpanded}
                data-testid="composer-telemetry-more-stats-toggle"
                onClick={() => setMoreStatsExpanded((current) => !current)}
                className="flex w-full cursor-pointer items-center gap-1 rounded py-0.5 text-xs font-medium text-muted-foreground transition-colors outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
              >
                <span>
                  <T context="expandable session stats section">More stats</T>
                </span>
                {moreStatsExpanded ? (
                  <ChevronDownIcon aria-hidden className="size-3.5" />
                ) : (
                  <ChevronRightIcon aria-hidden className="size-3.5" />
                )}
              </button>
              {moreStatsExpanded ? (
                <div
                  data-testid="composer-telemetry-more-stats"
                  className="flex flex-col gap-0.5 pt-0.5"
                >
                  <StatRow
                    indented
                    testId="composer-telemetry-stat-input"
                    label={gt("Input", { $context: "uncached input token count" })}
                    value={formatTokenCount(session.cumulativeTokens.uncachedInput)}
                  />
                  <StatRow
                    indented
                    testId="composer-telemetry-stat-cache-read"
                    label={gt("Cache read")}
                    value={formatTokenCount(session.cumulativeTokens.cacheRead)}
                  />
                  {session.cumulativeTokens.cacheWrite > 0 ? (
                    <StatRow
                      indented
                      testId="composer-telemetry-stat-cache-write"
                      label={gt("Cache write")}
                      value={formatTokenCount(session.cumulativeTokens.cacheWrite)}
                    />
                  ) : null}
                  <StatRow
                    indented
                    testId="composer-telemetry-stat-output"
                    label={gt("Output", { $context: "output token count" })}
                    value={formatTokenCount(session.cumulativeTokens.output)}
                  />
                  {session.cumulativeTokens.reasoning > 0 ? (
                    <StatRow
                      indented
                      testId="composer-telemetry-stat-reasoning"
                      label={gt("Reasoning tokens")}
                      value={formatTokenCount(session.cumulativeTokens.reasoning)}
                    />
                  ) : null}
                  {session.counts.requests !== null ? (
                    <StatRow
                      indented
                      testId="composer-telemetry-stat-requests"
                      label={gt("Requests")}
                      value={session.counts.requests}
                    />
                  ) : null}
                  <StatRow
                    indented
                    testId="composer-telemetry-stat-errors"
                    label={gt("Errors")}
                    value={session.counts.errors}
                  />
                  <StatRow
                    indented
                    testId="composer-telemetry-stat-tools"
                    label={gt("Tool calls")}
                    value={session.counts.toolCalls}
                  />
                </div>
              ) : null}
            </div>

            <div className="flex flex-col gap-0.5 border-t border-border/60 pt-2">
              <StatRow
                testId="composer-telemetry-stat-model-time"
                label={gt("Model time")}
                value={
                  session.timing.activeRunStartedAtMs !== null ? (
                    <LiveModelDurationValue
                      completedDurationMs={session.timing.completedDurationMs}
                      activeRunStartedAtMs={session.timing.activeRunStartedAtMs}
                      toolDurationMs={session.timing.toolDurationMs}
                    />
                  ) : session.timing.modelDurationMs !== null ? (
                    formatHudCompactDuration(session.timing.modelDurationMs, m)
                  ) : (
                    "–"
                  )
                }
              />
              <StatRow
                testId="composer-telemetry-stat-tool-time"
                label={gt("Tool time")}
                value={formatHudCompactDuration(session.timing.toolDurationMs, m)}
              />
              <StatRow
                testId="composer-telemetry-stat-ttft"
                label={gt("First token latency")}
                value={
                  session.timing.ttftMs !== null
                    ? formatHudCompactDuration(session.timing.ttftMs, m)
                    : "–"
                }
              />
            </div>

            {session.subagentSummary.total > 0 ? (
              <div
                data-testid="composer-telemetry-subagent-summary"
                className="flex flex-col gap-0.5 border-t border-border/60 pt-2"
              >
                <div className="mb-1 flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
                  <BotIcon aria-hidden className="size-3.5 shrink-0" />
                  <span>
                    <T context="subagent summary section title">Subagent summary</T>
                  </span>
                  <span className="rounded-full bg-muted px-1.5 py-0.5 text-3xs font-semibold text-foreground tabular-nums">
                    {session.subagentSummary.total}
                  </span>
                </div>
                {session.subagentSummary.totalTokens !== null ? (
                  <StatRow
                    testId="composer-telemetry-subagent-tokens"
                    label={gt("Subagent tokens")}
                    value={formatTokenCount(session.subagentSummary.totalTokens)}
                  />
                ) : null}
                {combinedTotalTokens !== null ? (
                  <StatRow
                    testId="composer-telemetry-combined-tokens"
                    label={gt("Total with subagents")}
                    value={formatTokenCount(combinedTotalTokens)}
                  />
                ) : null}
                {session.subagentSummary.requests !== null ||
                session.subagentSummary.toolUses !== null ? (
                  <StatRow
                    testId="composer-telemetry-subagent-ops"
                    label={gt("Requests / tool calls")}
                    value={`${session.subagentSummary.requests ?? "–"} / ${session.subagentSummary.toolUses ?? "–"}`}
                  />
                ) : null}
                {subagentCacheHitRate !== null ? (
                  <StatRow
                    testId="composer-telemetry-subagent-cache"
                    label={gt("Subagent cache hit")}
                    value={formatWholePercent(subagentCacheHitRate)}
                  />
                ) : null}
                {session.subagentSummary.costUsd !== null ? (
                  <StatRow
                    testId="composer-telemetry-subagent-cost"
                    label={gt("Subagent cost")}
                    value={formatCurrency(session.subagentSummary.costUsd, "USD", locale)}
                  />
                ) : null}
                {combinedCostUsd !== null ? (
                  <StatRow
                    testId="composer-telemetry-combined-cost"
                    label={gt("Total cost with subagents")}
                    value={formatCurrency(combinedCostUsd, "USD", locale)}
                  />
                ) : null}
              </div>
            ) : null}
          </div>
        )}
      </div>
    </div>
  );
}

function ComposerTelemetryControlInner(props: ComposerTelemetryControlProps) {
  const gt = useGT();
  const composerFloatingLayerProps = useComposerMenuProps();
  const [open, setOpen] = useComposerMenuState(props.hidden);
  const projection = useQuietThreadProjection(props.threadRef)?.projection ?? null;
  const setCardVisible = useHudOptionsStore((state) => state.setCardVisible);

  const liveTokenUsage = latestProviderTurnTokenUsage(projection?.providerTurns ?? [], projection);
  const usedTokens = props.contextWindow?.usedTokens ?? liveTokenUsage?.usedTokens ?? null;
  const maxTokens = props.contextWindow?.maxTokens ?? liveTokenUsage?.maxTokens ?? null;
  const usedPercentage =
    usedTokens !== null && maxTokens !== null && maxTokens > 0
      ? Math.min(100, (usedTokens / maxTokens) * 100)
      : null;
  const usageTone: HudContextUsageTone =
    usedPercentage === null || usedPercentage < 65
      ? "normal"
      : usedPercentage < 85
        ? "warning"
        : "error";
  const deliveredTurnCount = (projection?.providerTurns ?? []).reduce(
    (count, turn) => (turn.promptDropped ? count : count + 1),
    0,
  );

  if (usedTokens === null && deliveredTurnCount === 0) return null;

  const compactLabel =
    usedPercentage !== null
      ? formatPercent(usedPercentage)
      : usedTokens !== null
        ? formatTokenCount(usedTokens)
        : gt("{count, plural, one {{count} turn} other {{count} turns}}", {
            count: deliveredTurnCount,
          });
  const ariaLabel =
    usedPercentage !== null
      ? gt("Context window {percent} used, open telemetry", {
          percent: formatPercent(usedPercentage),
        })
      : gt("Open context and session telemetry");

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <Tooltip>
        <TooltipTrigger
          render={
            <PopoverTrigger
              render={
                <ComposerControl
                  size={props.size ?? "sm"}
                  data-testid="composer-telemetry-trigger"
                  data-tone={usageTone}
                  aria-label={ariaLabel}
                  className="gap-1 px-1.5 text-xs tabular-nums data-popup-open:bg-accent data-popup-open:text-foreground"
                />
              }
            />
          }
        >
          <TelemetryRingSvg percent={usedPercentage} tone={usageTone} />
          <span data-composer-control-label>{compactLabel}</span>
        </TooltipTrigger>
        <TooltipPopup side="top">{gt("Context window & session stats")}</TooltipPopup>
      </Tooltip>
      <PopoverPopup
        side="top"
        align="end"
        sideOffset={8}
        width="md"
        padding="none"
        {...composerFloatingLayerProps}
      >
        {open ? (
          <ComposerTelemetryPopoverContent
            threadRef={props.threadRef}
            projection={projection}
            requestedModel={props.requestedModel}
            contextWindow={props.contextWindow}
            compactContext={props.compactContext}
            onClose={() => setOpen(false)}
            onHideRing={() => setCardVisible("showComposerRing", false)}
          />
        ) : null}
      </PopoverPopup>
    </Popover>
  );
}

export function ComposerTelemetryControl(props: ComposerTelemetryControlProps) {
  const showComposerRing = useHudOptionsStore((state) => state.showComposerRing);
  if (!showComposerRing) return null;
  return <ComposerTelemetryControlInner {...props} />;
}
