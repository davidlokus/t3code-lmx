import type { EnvironmentMachineKind } from "@t3tools/contracts";
import { AlarmClockIcon, FolderGit2Icon, GitBranchIcon } from "lucide-react";
import type { MouseEvent as ReactMouseEvent, ReactNode } from "react";
import { T, useGT } from "gt-react";

import { formatDiffCount } from "@t3tools/client-runtime/diff-count";
import { cn } from "~/lib/utils";
import { EnvironmentMachineIcon } from "~/components/EnvironmentMachineIcon";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";
import type { RightSignalPresentation, SidebarModeBadgeKind } from "./sidebarPresentation.logic";

export function formatCompactWorktreeLabel(worktreePath: string | null | undefined): string | null {
  const trimmed = worktreePath?.trim();
  if (!trimmed) return null;
  const normalized = trimmed.replace(/[\\/]+$/, "");
  const segments = normalized.split(/[\\/]/).filter(Boolean);
  return segments[segments.length - 1] ?? normalized;
}

export function SidebarCompactHostPill(props: {
  readonly label: string;
  readonly machineKind: EnvironmentMachineKind;
  readonly className?: string;
}) {
  return (
    <span
      data-slot="sidebar-host-pill"
      className={cn(
        "inline-flex max-w-20 shrink-0 items-center gap-0.5 truncate rounded-sm bg-muted/70 px-1 py-px text-2xs text-muted-foreground",
        props.className,
      )}
    >
      <EnvironmentMachineIcon aria-hidden kind={props.machineKind} className="size-2.5 shrink-0" />
      <span className="truncate">{props.label}</span>
    </span>
  );
}

export function SidebarRowMetaContent(props: {
  readonly environmentLabel: string | null;
  readonly environmentMachine: EnvironmentMachineKind;
  readonly visibleBranch: string | null;
  readonly isWorktree: boolean;
  readonly branchMismatch: boolean;
  readonly modeBadges: ReadonlyArray<SidebarModeBadgeKind>;
  readonly terminalStatusIcon: ReactNode;
  readonly prBadge: ReactNode;
  readonly issueBadge: ReactNode;
  readonly diff: { readonly insertions: number; readonly deletions: number } | null;
  readonly providerStack: ReactNode;
  readonly showModel: boolean;
  readonly compactModelName: string | null;
}) {
  return (
    <div
      data-slot="sidebar-row-meta"
      className="mt-0.5 flex min-w-0 items-center gap-1 text-secondary-label text-xs"
    >
      <div className="flex min-w-0 flex-1 items-center gap-1 overflow-hidden">
        {props.environmentLabel !== null ? (
          <SidebarCompactHostPill
            label={props.environmentLabel}
            machineKind={props.environmentMachine}
          />
        ) : null}
        {props.visibleBranch !== null ? (
          <span
            className={cn(
              "inline-flex min-w-0 items-center gap-0.5 text-2xs",
              props.branchMismatch ? "text-warning-foreground" : "text-muted-foreground/85",
            )}
          >
            {props.isWorktree ? (
              <FolderGit2Icon
                aria-hidden
                className={cn(
                  "size-2.5 shrink-0",
                  props.branchMismatch ? "text-warning-foreground" : "text-success-foreground",
                )}
              />
            ) : (
              <GitBranchIcon
                aria-hidden
                className={cn(
                  "size-2.5 shrink-0",
                  props.branchMismatch ? "text-warning-foreground" : "text-icon-muted",
                )}
              />
            )}
            <span className="truncate font-mono">{props.visibleBranch}</span>
          </span>
        ) : null}
        {props.modeBadges.map((badge) => (
          <span
            key={badge}
            data-mode-badge={badge}
            className={cn(
              "inline-flex shrink-0 items-center rounded-sm px-1 py-px text-3xs font-medium leading-none",
              badge === "plan"
                ? "bg-info/12 text-info-foreground dark:bg-info/16"
                : "bg-warning/15 text-warning-foreground",
            )}
          >
            {badge === "plan" ? (
              <T context="thread interaction mode">Plan</T>
            ) : (
              <T context="thread runtime mode">Full</T>
            )}
          </span>
        ))}
        {props.terminalStatusIcon}
        {props.prBadge}
        {props.issueBadge}
        {props.diff ? (
          <span className="shrink-0 font-mono">
            <span className="text-diff-addition-foreground">
              +{formatDiffCount(props.diff.insertions)}
            </span>{" "}
            <span className="text-diff-deletion-foreground">
              −{formatDiffCount(props.diff.deletions)}
            </span>
          </span>
        ) : null}
      </div>
      <span className="pointer-events-none ml-auto inline-flex shrink-0 items-center gap-1">
        <span aria-hidden className="inline-flex shrink-0 items-center">
          {props.providerStack}
        </span>
        {props.showModel && props.compactModelName !== null ? (
          <span className="max-w-20 truncate font-mono text-2xs text-muted-foreground/80">
            {props.compactModelName}
          </span>
        ) : null}
      </span>
    </div>
  );
}

export function SidebarRightSignal(props: {
  readonly rightSignal: RightSignalPresentation;
  readonly snoozeWakeLabelText: string | null;
  readonly isUnsnoozeRow: boolean;
  readonly statusLabel: string | null;
  readonly workingDuration: ReactNode;
  readonly relativeTime: ReactNode;
  readonly onAcknowledgeWoke: (event: ReactMouseEvent) => void;
}) {
  const gt = useGT();
  if (props.isUnsnoozeRow && props.snoozeWakeLabelText !== null) {
    return (
      <span className="inline-flex items-center gap-1 text-xs text-info-foreground tabular-nums">
        <AlarmClockIcon aria-hidden className="size-3" />
        {props.snoozeWakeLabelText}
      </span>
    );
  }
  if (props.rightSignal.kind === "woke") {
    return (
      <Tooltip>
        <TooltipTrigger
          render={
            <button
              type="button"
              aria-label={gt("Dismiss Woke notification")}
              onClick={props.onAcknowledgeWoke}
              className="inline-flex cursor-pointer items-center gap-1 rounded-sm text-xs font-medium text-warning-foreground outline-none hover:underline focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
            >
              <AlarmClockIcon aria-hidden className="size-3" />
              <span role="status">
                <T context="thread status: woke from snooze">Woke</T>
              </span>
            </button>
          }
        />
        <TooltipPopup side="top">
          <T>Dismiss Woke notification</T>
        </TooltipPopup>
      </Tooltip>
    );
  }
  if (props.rightSignal.kind === "loud-pill" && props.statusLabel !== null) {
    const toneClassName =
      props.rightSignal.tone === "approval" || props.rightSignal.tone === "limited"
        ? "bg-warning/15 text-warning-foreground"
        : props.rightSignal.tone === "input"
          ? "bg-info/15 text-info-foreground"
          : props.rightSignal.tone === "request"
            ? "bg-guest-surface text-guest-foreground"
            : "bg-error/15 text-error-foreground";
    return (
      <span
        data-right-signal="loud-pill"
        className={cn(
          "inline-flex items-center rounded-full px-1.5 py-0.5 text-2xs font-medium leading-none",
          toneClassName,
        )}
      >
        {props.statusLabel}
      </span>
    );
  }
  if (props.rightSignal.kind === "working-duration") {
    return (
      <span
        data-right-signal="working-duration"
        className="min-w-[2.7em] text-right text-xs font-medium text-info-foreground tabular-nums"
      >
        {props.workingDuration ?? props.statusLabel ?? gt("Setting up")}
      </span>
    );
  }
  return (
    <span
      data-right-signal="quiet-time"
      className={cn(
        "min-w-[2.7em] text-right text-xs tabular-nums",
        props.rightSignal.kind === "quiet-time" && props.rightSignal.emphasized
          ? "font-medium text-foreground/80"
          : "text-muted-foreground/75",
      )}
    >
      {props.relativeTime}
    </span>
  );
}
