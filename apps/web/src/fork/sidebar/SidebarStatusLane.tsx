import { AlarmClockIcon, CircleXIcon, LoaderCircleIcon, SquarePenIcon } from "lucide-react";
import { T, useGT } from "gt-react";

import { cn } from "~/lib/utils";
import { observeVisibleAnimation } from "~/lib/visibleAnimation";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";
import type { StatusLaneKind } from "./sidebarPresentation.logic";

export function SidebarStatusLane(props: {
  readonly kind: StatusLaneKind;
  readonly threadId: string;
  readonly className?: string;
}) {
  const gt = useGT();
  const { kind, threadId, className } = props;

  return (
    <span
      data-slot="sidebar-status-lane"
      data-status-lane={kind}
      className={cn(
        "inline-flex w-4.5 shrink-0 items-center justify-center self-center",
        className,
      )}
    >
      {kind === "working" ? (
        <LoaderCircleIcon
          aria-hidden
          ref={observeVisibleAnimation}
          className="size-3 text-info-foreground motion-safe:visible-animate-spin"
        />
      ) : kind === "failed" ? (
        <CircleXIcon aria-hidden className="size-3 text-error-foreground" />
      ) : kind === "approval" ? (
        <span aria-hidden className="size-1.5 rounded-full bg-warning" />
      ) : kind === "input" ? (
        <span aria-hidden className="size-1.5 rounded-full bg-info" />
      ) : kind === "request" ? (
        <span aria-hidden className="size-1.5 rounded-full bg-guest-foreground" />
      ) : kind === "woke" ? (
        <AlarmClockIcon aria-hidden className="size-3 text-warning-foreground" />
      ) : kind === "unread-done" ? (
        <span aria-hidden className="size-1.5 rounded-full bg-success" />
      ) : kind === "draft" ? (
        <Tooltip>
          <TooltipTrigger
            render={
              <span
                role="img"
                aria-label={gt("Unsent draft")}
                data-testid={`sidebar-draft-indicator-${threadId}`}
                className="inline-flex shrink-0 items-center"
              />
            }
          >
            <SquarePenIcon aria-hidden className="size-3 shrink-0 text-warning-foreground" />
          </TooltipTrigger>
          <TooltipPopup side="top">
            <T>Unsent draft</T>
          </TooltipPopup>
        </Tooltip>
      ) : null}
    </span>
  );
}
