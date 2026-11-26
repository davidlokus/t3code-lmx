import { useAtomValue } from "@effect/atom-react";
import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import { formatSubagentDisplayTitle } from "@t3tools/client-runtime/state/subagent-display";
import {
  isOrchestrationV2WorkActive,
  type OrchestrationV2Subagent,
  type ScopedThreadRef,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { msg, T, useGT, useMessages } from "gt-react";
import { BotIcon, CheckIcon, ChevronDownIcon, CopyIcon } from "lucide-react";
import { useState } from "react";

import ChatMarkdown from "~/components/ChatMarkdown";
import { EnvironmentSubagentAvatar, SubagentElapsed } from "~/components/chat/V2LifecycleRow";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "~/components/ui/collapsible";
import { ScrollArea } from "~/components/ui/scroll-area";
import { toastManager } from "~/components/ui/toast";
import { useCopyToClipboard } from "~/hooks/useCopyToClipboard";
import type { SubagentSurface } from "~/rightPanelStore";
import { useProject } from "~/state/entities";
import { environmentThreadDetails } from "~/state/threads";

const STATUS = {
  pending: { label: msg("Queued", { $context: "subagent status" }), variant: "info" },
  running: { label: msg("Running", { $context: "subagent status" }), variant: "info" },
  waiting: { label: msg("Waiting", { $context: "subagent status" }), variant: "warning" },
  idle: { label: msg("Idle · resumable", { $context: "subagent status" }), variant: "secondary" },
  completed: { label: msg("Completed", { $context: "subagent status" }), variant: "success" },
  failed: { label: msg("Failed", { $context: "subagent status" }), variant: "error" },
  cancelled: { label: msg("Stopped", { $context: "subagent status" }), variant: "secondary" },
  interrupted: { label: msg("Stopped", { $context: "subagent status" }), variant: "secondary" },
} as const satisfies Record<OrchestrationV2Subagent["status"], object>;

function CopyOutput({ result }: { result: string }) {
  const gt = useGT();
  const { copyToClipboard, isCopied } = useCopyToClipboard({
    onError: () => toastManager.add({ type: "error", title: gt("Could not copy") }),
  });
  return (
    <Button size="xs" variant="ghost-muted" onClick={() => copyToClipboard(result)}>
      {isCopied ? <CheckIcon aria-hidden /> : <CopyIcon aria-hidden />}
      <span aria-live="polite">{isCopied ? gt("Copied") : gt("Copy output")}</span>
    </Button>
  );
}

function TaskPrompt({ prompt, hasResult }: { prompt: string; hasResult: boolean }) {
  const [choice, setChoice] = useState<{ hasResult: boolean; open: boolean } | null>(null);
  const open = choice?.hasResult === hasResult ? choice.open : !hasResult;
  return (
    <Collapsible open={open} onOpenChange={(next) => setChoice({ hasResult, open: next })}>
      <div className="rounded-lg border border-border/70 bg-muted/25">
        <CollapsibleTrigger
          render={
            <button
              type="button"
              className="group/task flex w-full items-center justify-between gap-2 rounded-lg px-3 py-2.5 text-left text-xs font-semibold text-foreground transition-colors hover:bg-accent/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
            />
          }
        >
          <T context="subagent inspector section">Task</T>
          <ChevronDownIcon
            aria-hidden
            className="size-3.5 shrink-0 text-muted-foreground group-aria-expanded/task:rotate-180"
          />
        </CollapsibleTrigger>
        <CollapsiblePanel animate={false}>
          <p className="px-3 pb-3 text-sm leading-relaxed wrap-anywhere whitespace-pre-wrap text-foreground/85">
            {prompt}
          </p>
        </CollapsiblePanel>
        {!open && (
          <div className="px-3 pb-3" aria-hidden>
            <p className="line-clamp-2 text-xs leading-relaxed wrap-anywhere whitespace-pre-wrap text-muted-foreground">
              {prompt}
            </p>
          </div>
        )}
      </div>
    </Collapsible>
  );
}

export function NativeSubagentInspectorPane({
  parentRef,
  panelRef = parentRef,
  surface,
  cwd,
  workspaceMutationId,
}: {
  parentRef: ScopedThreadRef;
  panelRef?: ScopedThreadRef;
  surface: SubagentSurface;
  cwd: string | undefined;
  workspaceMutationId?: string | null | undefined;
}) {
  const m = useMessages();
  const detailAtom = environmentThreadDetails.threadAtom(parentRef);
  const agent = useAtomValue(detailAtom, (thread) =>
    thread?.projection.subagents.find(
      (candidate) =>
        candidate.id === surface.subagentId &&
        candidate.origin === "provider_native" &&
        candidate.childThreadId === null &&
        candidate.remoteChild === undefined,
    ),
  );
  const hosted = panelRef.threadId !== parentRef.threadId;
  const ownerProjectId = useAtomValue(detailAtom, (thread) =>
    hosted ? thread?.projection.thread.projectId : undefined,
  );
  const ownerWorktree = useAtomValue(detailAtom, (thread) =>
    hosted ? thread?.projection.thread.worktreePath : undefined,
  );
  const ownerProject = useProject(
    ownerProjectId ? scopeProjectRef(parentRef.environmentId, ownerProjectId) : null,
  );
  const markdownCwd = hosted ? (ownerWorktree ?? ownerProject?.workspaceRoot) : cwd;
  const title = formatSubagentDisplayTitle(agent?.title?.trim() || surface.title);
  const result = agent?.result?.trim() ? agent.result : null;
  const active = agent !== undefined && isOrchestrationV2WorkActive(agent.status);
  const status = agent === undefined ? null : STATUS[agent.status];
  const prompt = agent?.prompt.trim();
  const progress = active ? agent?.progress?.trim() : undefined;

  return (
    <article className="flex h-full min-h-0 min-w-0 flex-col bg-background" aria-label={title}>
      <header className="flex shrink-0 flex-col gap-2.5 border-b border-border/70 px-4 py-3">
        <div className="flex min-w-0 items-center gap-2.5">
          {agent ? (
            <EnvironmentSubagentAvatar
              driver={agent.driver}
              environmentId={parentRef.environmentId}
              providerInstanceId={agent.providerInstanceId}
              status={agent.status}
            />
          ) : (
            <span className="grid size-6 shrink-0 place-items-center rounded-full border border-border/70 bg-muted">
              <BotIcon aria-hidden className="size-3.5 text-muted-foreground" />
            </span>
          )}
          <h2 className="min-w-0 flex-1 text-sm font-semibold wrap-anywhere">{title}</h2>
          {result !== null && <CopyOutput result={result} />}
        </div>
        {agent && status && (
          <div className="flex min-w-0 flex-wrap items-center gap-1.5 pl-8.5">
            <Badge size="sm" variant={status.variant}>
              {m(status.label)}
            </Badge>
            {agent.model?.trim() && (
              <div className="min-w-0 max-w-full">
                <Badge size="sm" variant="secondary">
                  <span className="min-w-0 max-w-44 truncate">{agent.model}</span>
                </Badge>
              </div>
            )}
            <span className="text-xs text-muted-foreground tabular-nums">
              <SubagentElapsed
                agent={{
                  status: agent.status,
                  startedAt: agent.startedAt === null ? null : DateTime.formatIso(agent.startedAt),
                  completedAt:
                    agent.completedAt === null ? null : DateTime.formatIso(agent.completedAt),
                }}
              />
            </span>
          </div>
        )}
      </header>
      <div className="min-h-0 flex-1">
        <ScrollArea observeContent>
          <div className="mx-auto flex w-full max-w-3xl min-w-0 flex-col gap-5 px-4 pt-4 pb-6">
            {agent === undefined ? (
              <p className="rounded-lg border border-dashed border-border/70 px-3 py-4 text-sm text-muted-foreground">
                <T>This subagent is unavailable.</T>
              </p>
            ) : (
              <>
                {prompt && <TaskPrompt prompt={prompt} hasResult={result !== null} />}
                {progress && (
                  <section className="rounded-lg border border-info/20 bg-info/5 px-3 py-2.5">
                    <h3 className="mb-1 text-xs font-semibold text-info-foreground">
                      <T context="subagent inspector section">Progress</T>
                    </h3>
                    <p className="text-sm leading-relaxed wrap-anywhere whitespace-pre-wrap text-foreground/85">
                      {progress}
                    </p>
                  </section>
                )}
                <section className="min-w-0">
                  <h3 className="mb-2 text-xs font-semibold text-foreground">
                    <T context="subagent inspector section">Result</T>
                  </h3>
                  {result !== null ? (
                    <ChatMarkdown
                      text={result}
                      cwd={markdownCwd}
                      environmentId={parentRef.environmentId}
                      threadRef={panelRef}
                      workspaceMutationId={workspaceMutationId}
                      headingLevelOffset={3}
                    />
                  ) : (
                    <p className="rounded-lg border border-dashed border-border/70 px-3 py-4 text-sm text-muted-foreground">
                      {active ? (
                        <T>Waiting for the subagent to return a result.</T>
                      ) : (
                        <T>This subagent returned no text output.</T>
                      )}
                    </p>
                  )}
                </section>
              </>
            )}
          </div>
        </ScrollArea>
      </div>
    </article>
  );
}
