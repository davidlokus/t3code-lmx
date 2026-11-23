import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { ContextWindowSnapshot } from "@t3tools/client-runtime/state/context-window";
import type { ThreadStructure } from "@t3tools/client-runtime/state/models";
import {
  AuthPreviewOperateScope,
  type DiscoveredLocalServer,
  type EnvironmentId,
  type ThreadId,
} from "@t3tools/contracts";
import { ChevronDownIcon, ChevronRightIcon, CpuIcon, GlobeIcon } from "lucide-react";
import { T, useGT, useLocale } from "gt-react";

import { openDiscoveredPort } from "~/components/preview/openDiscoveredPort";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";
import { formatContextWindowTokens } from "~/lib/contextWindow";
import { formatBytes } from "~/lib/formatBytes";
import { useResourceTelemetry } from "~/lib/resourceTelemetryState";
import { useThreadDiscoveredPorts } from "~/portDiscoveryState";
import { previewEnvironment } from "~/state/preview";
import { useEnvironmentScope } from "~/state/session";
import { useAtomCommand } from "~/state/use-atom-command";
import { deriveHudSystemMetrics, type HudSystemCategoryKey } from "./hudMetrics.logic";
import { useHudOptionsStore } from "./hudOptionsStore";

function categoryLabel(key: HudSystemCategoryKey, gt: ReturnType<typeof useGT>): string {
  switch (key) {
    case "provider":
      return gt("Provider", { $context: "system process category" });
    case "terminal":
      return gt("Terminal", { $context: "system process category" });
    case "server":
      return gt("Server", { $context: "system process category" });
    case "desktop":
      return gt("Desktop", { $context: "system process category" });
    case "other":
      return gt("Other", { $context: "system process category" });
  }
}

function HudSystemPorts(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
}) {
  const gt = useGT();
  const ports = useThreadDiscoveredPorts({
    environmentId: props.environmentId,
    threadId: props.threadId,
  });
  const canOpen = useEnvironmentScope(props.environmentId, AuthPreviewOperateScope);
  const openPreview = useAtomCommand(previewEnvironment.open, { reportFailure: false });
  if (ports.length === 0) return null;

  const threadRef = scopeThreadRef(props.environmentId, props.threadId);
  const handleOpen = (port: DiscoveredLocalServer) => {
    if (!canOpen) return;
    void openDiscoveredPort({ threadRef, port, openPreview });
  };

  return (
    <div
      className="flex flex-col gap-1 border-t border-border/50 pt-1.5"
      data-testid="hud-system-ports"
    >
      <span className="text-3xs text-muted-foreground">
        <T context="detected local ports heading">Local ports</T>
      </span>
      <div className="flex flex-wrap gap-1">
        {ports.map((port) =>
          canOpen ? (
            <button
              key={`${port.pid ?? "p"}:${port.port}`}
              type="button"
              onClick={() => handleOpen(port)}
              className="inline-flex cursor-pointer items-center gap-1 rounded-md border border-border/65 bg-muted/45 px-1.5 py-0.5 text-3xs font-medium text-foreground/85 tabular-nums outline-none transition-colors hover:bg-accent/60 hover:text-foreground focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring"
            >
              <GlobeIcon aria-hidden className="size-3 text-info-foreground" />
              <span>:{port.port}</span>
            </button>
          ) : (
            <span
              key={`${port.pid ?? "p"}:${port.port}`}
              aria-label={gt("Port {port}", { port: port.port })}
              className="inline-flex items-center gap-1 rounded-md border border-border/65 bg-muted/45 px-1.5 py-0.5 text-3xs font-medium text-muted-foreground tabular-nums"
            >
              <GlobeIcon aria-hidden className="size-3" />
              <span>:{port.port}</span>
            </span>
          ),
        )}
      </div>
    </div>
  );
}

/** Mounted ONLY when the details panel is open and System card is enabled, so closing unsubscribes telemetry. */
function HudSystemTelemetryContent(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly contextWindow: ContextWindowSnapshot | null;
  readonly projection: Pick<ThreadStructure, "providerTurns"> | null;
}) {
  const gt = useGT();
  const locale = useLocale();
  const expanded = useHudOptionsStore((state) => state.systemExpanded);
  const toggleSystemExpanded = useHudOptionsStore((state) => state.toggleSystemExpanded);
  const telemetry = useResourceTelemetry(props.environmentId);
  const metrics = deriveHudSystemMetrics({
    snapshot: telemetry.data,
    contextWindow: props.contextWindow,
    projection: props.projection,
  });

  const summaryText =
    metrics.available && metrics.cpuPercent !== null && metrics.rssBytes !== null
      ? `${metrics.cpuPercent.toFixed(0)}% · ${formatBytes(metrics.rssBytes)}${metrics.processCount !== null ? ` · ${metrics.processCount}p` : ""}`
      : "–";

  const ChevronIcon = expanded ? ChevronDownIcon : ChevronRightIcon;

  return (
    <section
      aria-label={gt("System resources")}
      data-testid="hud-system-card"
      className="flex flex-col rounded-xl border border-border/65 bg-card/65 p-2"
    >
      <button
        type="button"
        aria-expanded={expanded}
        data-testid="hud-system-toggle"
        onClick={toggleSystemExpanded}
        className="flex w-full cursor-pointer items-center justify-between gap-2 rounded-lg px-0.5 py-0.5 text-left outline-none transition-colors hover:bg-accent/50 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
      >
        <span className="flex min-w-0 items-center gap-1.5">
          <ChevronIcon aria-hidden className="size-3 shrink-0 text-muted-foreground" />
          <CpuIcon aria-hidden className="size-3 shrink-0 text-muted-foreground" />
          <span className="truncate text-2xs font-semibold tracking-wide text-muted-foreground">
            <T context="HUD card title">System</T>
          </span>
        </span>
        <span
          data-testid="hud-system-summary"
          className="shrink-0 text-3xs font-medium text-foreground/85 tabular-nums"
        >
          {summaryText}
        </span>
      </button>

      {expanded ? (
        <div
          data-testid="hud-system-details"
          className="mt-2 flex flex-col gap-1.5 border-t border-border/50 pt-2 text-3xs"
        >
          {metrics.categories.length > 0 ? (
            <div className="flex flex-col gap-1">
              {metrics.categories.map((category) => (
                <div
                  key={category.key}
                  data-testid={`hud-system-category-${category.key}`}
                  className="flex items-center justify-between gap-2 text-foreground/85 tabular-nums"
                >
                  <span className="min-w-0 truncate text-muted-foreground">
                    {categoryLabel(category.key, gt)} ({category.processCount})
                  </span>
                  <span className="shrink-0 font-medium">
                    {category.cpuPercent.toFixed(0)}% · {formatBytes(category.rssBytes)}
                  </span>
                </div>
              ))}
            </div>
          ) : (
            <span className="text-muted-foreground">
              {telemetry.isPending
                ? gt("Waiting for telemetry…")
                : gt("Process telemetry unavailable")}
            </span>
          )}

          <HudSystemPorts environmentId={props.environmentId} threadId={props.threadId} />

          {metrics.totalProcessedTokens !== null ? (
            <div
              data-testid="hud-system-total-tokens"
              className="flex items-center justify-between gap-2 border-t border-border/50 pt-1.5 tabular-nums"
            >
              <span className="text-muted-foreground">
                <T context="cumulative processed tokens label">Total processed</T>
              </span>
              <Tooltip>
                <TooltipTrigger
                  render={
                    <span
                      tabIndex={0}
                      className="font-medium text-foreground/85 outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring"
                    />
                  }
                >
                  Σ {formatContextWindowTokens(metrics.totalProcessedTokens)}
                </TooltipTrigger>
                <TooltipPopup side="left" sideOffset={12}>
                  {gt("{tokens} total tokens processed", {
                    tokens: metrics.totalProcessedTokens.toLocaleString(locale),
                  })}
                </TooltipPopup>
              </Tooltip>
            </div>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}

export function HudSystemCard(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly panelOpen: boolean;
  readonly contextWindow: ContextWindowSnapshot | null;
  readonly projection: Pick<ThreadStructure, "providerTurns"> | null;
}) {
  if (!props.panelOpen) return null;
  return (
    <HudSystemTelemetryContent
      environmentId={props.environmentId}
      threadId={props.threadId}
      contextWindow={props.contextWindow}
      projection={props.projection}
    />
  );
}
