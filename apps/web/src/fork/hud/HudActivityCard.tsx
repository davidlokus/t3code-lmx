import { secondTick } from "@t3tools/client-runtime/clock";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentId, OrchestrationV2RemoteTaskChild, ThreadId } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { BotIcon, ChevronRightIcon, WrenchIcon } from "lucide-react";
import { useSyncExternalStore } from "react";
import { T, useGT, useMessages } from "gt-react";

import { useSideThreadTrigger } from "~/hooks/useSideThreadTrigger";
import { openSideThread } from "~/lib/sideChatPane";
import { cn } from "~/lib/utils";
import { useRightPanelStore } from "~/rightPanelStore";
import { useLinkedThreadOpener } from "~/state/linkedThreadView";
import { buildThreadRouteParams } from "~/threadRoutes";
import {
  formatHudCompactDuration,
  type HudActivityMetrics,
  type HudSubagentEntry,
  type HudSubagentStatus,
  type HudToolEntry,
} from "./hudMetrics.logic";

const SUBAGENT_DOT_CLASS: Record<HudSubagentStatus, string> = {
  running: "bg-info",
  waiting: "bg-warning",
  completed: "bg-success",
  failed: "bg-error",
  cancelled: "bg-muted-foreground/60",
};

function toolDisplayName(name: string, gt: ReturnType<typeof useGT>): string {
  switch (name.toLowerCase()) {
    case "command_execution":
    case "bash":
    case "shell":
      return gt("Shell", { $context: "HUD tool activity chip" });
    case "file_change":
    case "edit":
    case "multiedit":
      return gt("Edit", { $context: "HUD tool activity chip" });
    case "read":
      return gt("Read", { $context: "HUD tool activity chip" });
    case "write":
      return gt("Write", { $context: "HUD tool activity chip" });
    case "file_search":
    case "grep":
      return gt("Search", { $context: "HUD tool activity chip" });
    case "find":
    case "glob":
      return gt("Find", { $context: "HUD tool activity chip" });
    case "web_search":
      return gt("Web", { $context: "HUD tool activity chip" });
    case "fetch":
    case "webfetch":
    case "web_fetch":
      return gt("Fetch", { $context: "HUD tool activity chip" });
    case "todo":
    case "todowrite":
    case "todo_write":
      return gt("Todo", { $context: "HUD tool activity chip" });
    case "task":
    case "agent":
      return gt("Task", { $context: "HUD tool activity chip" });
    case "dynamic_tool":
      return gt("Tool", { $context: "HUD tool activity chip" });
    default:
      return name;
  }
}

function subagentStatusLabel(status: HudSubagentStatus, gt: ReturnType<typeof useGT>): string {
  switch (status) {
    case "running":
      return gt("Running", { $context: "HUD subagent status" });
    case "waiting":
      return gt("Waiting", { $context: "HUD subagent status" });
    case "completed":
      return gt("Completed", { $context: "HUD subagent status" });
    case "failed":
      return gt("Failed", { $context: "HUD subagent status" });
    case "cancelled":
      return gt("Cancelled", { $context: "HUD subagent status" });
  }
}

function HudLiveSubagentDuration(props: { readonly startedAtMs: number }) {
  const m = useMessages();
  const nowMs = useSyncExternalStore(
    secondTick.subscribe,
    secondTick.getSnapshot,
    secondTick.getSnapshot,
  );
  return (
    <span className="shrink-0 text-3xs text-muted-foreground tabular-nums">
      {formatHudCompactDuration(Math.max(0, nowMs - props.startedAtMs), m)}
    </span>
  );
}

function SubagentRowContent(props: {
  readonly agent: HudSubagentEntry;
  readonly interactive: boolean;
}) {
  const gt = useGT();
  const m = useMessages();
  const { agent, interactive } = props;
  const statusText = subagentStatusLabel(agent.status, gt);
  return (
    <>
      <span
        aria-hidden
        className={cn("size-1.5 shrink-0 rounded-full", SUBAGENT_DOT_CLASS[agent.status])}
      />
      <span className="sr-only">{statusText},</span>
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="truncate font-medium text-foreground/90">{agent.title}</span>
        {agent.model ? (
          <span
            data-testid="hud-subagent-model"
            className="truncate text-3xs text-muted-foreground"
          >
            {agent.model}
          </span>
        ) : null}
      </span>
      {agent.isActive && agent.startedAtMs !== null ? (
        <HudLiveSubagentDuration startedAtMs={agent.startedAtMs} />
      ) : agent.durationMs !== null ? (
        <span className="shrink-0 text-3xs text-muted-foreground tabular-nums">
          {formatHudCompactDuration(agent.durationMs, m)}
        </span>
      ) : null}
      {interactive ? (
        <ChevronRightIcon aria-hidden className="size-3 shrink-0 text-muted-foreground/70" />
      ) : null}
    </>
  );
}

const HUD_SUBAGENT_BUTTON_CLASS =
  "flex w-full cursor-pointer items-center gap-1.5 rounded-lg px-1.5 py-1 text-left text-2xs outline-none transition-colors hover:bg-accent/60 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring";

function HudRemoteSubagentRow(props: {
  readonly agent: HudSubagentEntry;
  readonly remoteChild: OrchestrationV2RemoteTaskChild;
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
}) {
  const panelRef = scopeThreadRef(props.environmentId, props.threadId);
  const trigger = useSideThreadTrigger();
  const opener = useLinkedThreadOpener(panelRef, props.remoteChild, props.agent.title);
  if (!opener) {
    return (
      <div
        data-testid="hud-subagent-row"
        className="flex items-center gap-1.5 rounded-lg px-1.5 py-1 text-2xs"
      >
        <SubagentRowContent agent={props.agent} interactive={false} />
      </div>
    );
  }
  return (
    <button
      type="button"
      data-testid="hud-subagent-row"
      {...trigger((intent) => opener.open(intent))}
      className={HUD_SUBAGENT_BUTTON_CLASS}
    >
      <SubagentRowContent agent={props.agent} interactive />
    </button>
  );
}

function HudLocalSubagentRow(props: {
  readonly agent: HudSubagentEntry;
  readonly childThreadId: ThreadId;
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
}) {
  const navigate = useNavigate();
  const trigger = useSideThreadTrigger();
  const panelRef = scopeThreadRef(props.environmentId, props.threadId);
  const targetRef = scopeThreadRef(props.environmentId, props.childThreadId);
  return (
    <button
      type="button"
      data-testid="hud-subagent-row"
      {...trigger((intent) => {
        openSideThread({
          threadRef: targetRef,
          panelRef,
          intent,
          navigate: (routeRef) =>
            void navigate({
              to: "/$environmentId/$threadId",
              params: buildThreadRouteParams(routeRef),
            }),
        });
      })}
      className={HUD_SUBAGENT_BUTTON_CLASS}
    >
      <SubagentRowContent agent={props.agent} interactive />
    </button>
  );
}

function toolChipClass(tool: HudToolEntry): string {
  switch (tool.status) {
    case "running":
      return "border-info/25 bg-info/12 text-info-foreground";
    case "failed":
      return "border-error/30 bg-error/15 text-error-foreground";
    case "partial_failure":
      return "border-warning/30 bg-warning/15 text-warning-foreground";
    case "completed":
      return "border-border/65 bg-muted/45 text-foreground/85";
  }
}

export function HudActivityCard(props: {
  readonly metrics: HudActivityMetrics;
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
}) {
  const gt = useGT();
  const { metrics } = props;
  if (metrics.isEmpty) return null;

  return (
    <section
      aria-label={gt("Thread activity")}
      data-testid="hud-activity-card"
      className="flex flex-col gap-2 rounded-xl border border-border/65 bg-card/65 p-2.5"
    >
      <div className="flex items-center justify-between gap-2">
        <span className="text-2xs font-semibold tracking-wide text-muted-foreground">
          <T context="HUD card title">Activity</T>
        </span>
        <div className="flex shrink-0 items-center gap-2 text-3xs text-muted-foreground tabular-nums">
          {metrics.totalSubagentCount > 0 ? (
            <span className="inline-flex items-center gap-0.5">
              <BotIcon aria-hidden className="size-3" />
              <span>{metrics.totalSubagentCount}</span>
            </span>
          ) : null}
          {metrics.totalToolCalls > 0 ? (
            <span className="inline-flex items-center gap-0.5">
              <WrenchIcon aria-hidden className="size-3" />
              <span>{metrics.totalToolCalls}</span>
            </span>
          ) : null}
        </div>
      </div>

      {metrics.subagents.length > 0 ? (
        <div className="flex flex-col gap-0.5" data-testid="hud-subagents-list">
          {metrics.subagents.map((agent) =>
            agent.childThreadId !== null ? (
              <HudLocalSubagentRow
                key={agent.id}
                agent={agent}
                childThreadId={agent.childThreadId}
                environmentId={props.environmentId}
                threadId={props.threadId}
              />
            ) : agent.remoteChild !== null ? (
              <HudRemoteSubagentRow
                key={agent.id}
                agent={agent}
                remoteChild={agent.remoteChild}
                environmentId={props.environmentId}
                threadId={props.threadId}
              />
            ) : agent.origin !== "app_owned" ? (
              <button
                key={agent.id}
                type="button"
                data-testid="hud-subagent-row"
                className={HUD_SUBAGENT_BUTTON_CLASS}
                onClick={() =>
                  useRightPanelStore
                    .getState()
                    .openSubagent(
                      scopeThreadRef(props.environmentId, props.threadId),
                      agent.id,
                      agent.title,
                    )
                }
              >
                <SubagentRowContent agent={agent} interactive />
              </button>
            ) : (
              <div
                key={agent.id}
                data-testid="hud-subagent-row"
                className="flex items-center gap-1.5 rounded-lg px-1.5 py-1 text-2xs"
              >
                <SubagentRowContent agent={agent} interactive={false} />
              </div>
            ),
          )}
          {metrics.overflowSubagentCount > 0 ? (
            <span className="px-1.5 text-3xs text-muted-foreground tabular-nums">
              +{metrics.overflowSubagentCount}
            </span>
          ) : null}
        </div>
      ) : null}

      {metrics.tools.length > 0 ? (
        <div className="flex flex-wrap items-center gap-1" data-testid="hud-tools-list">
          {metrics.tools.map((tool) => (
            <span
              key={tool.name}
              data-testid="hud-tool-chip"
              data-tool-status={tool.status}
              className={cn(
                "inline-flex max-w-full items-center gap-1 rounded-md border px-1.5 py-0.5 text-3xs font-medium tabular-nums",
                toolChipClass(tool),
              )}
            >
              {tool.status === "running" ? (
                <span aria-hidden className="size-1.5 shrink-0 rounded-full bg-info" />
              ) : null}
              <span className="truncate">{toolDisplayName(tool.name, gt)}</span>
              {tool.totalCount > 1 ? <span>×{tool.totalCount}</span> : null}
              {tool.failedCount > 0 ? (
                <span
                  data-testid="hud-tool-failure-badge"
                  className="font-semibold text-error-foreground"
                >
                  !{tool.failedCount}
                </span>
              ) : null}
            </span>
          ))}
          {metrics.overflowToolCount > 0 ? (
            <span className="rounded-md bg-muted/50 px-1.5 py-0.5 text-3xs text-muted-foreground tabular-nums">
              +{metrics.overflowToolCount}
            </span>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
