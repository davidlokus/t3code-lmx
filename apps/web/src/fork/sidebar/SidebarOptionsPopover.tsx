import {
  BellIcon,
  ChevronsDownUpIcon,
  ChevronsUpDownIcon,
  SlidersHorizontalIcon,
} from "lucide-react";
import { useRef } from "react";
import { T, useGT, Var } from "gt-react";

import { Button, InlineButton } from "~/components/ui/button";
import { Popover, PopoverPopup, PopoverTrigger } from "~/components/ui/popover";
import { Switch } from "~/components/ui/switch";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";
import { type SidebarDisplayBooleanOptionKey, useSidebarOptionsStore } from "./sidebarOptionsStore";
import type { CollapseAllAction } from "./sidebarPresentation.logic";

function SidebarOptionSwitchRow(props: {
  readonly optionKey: SidebarDisplayBooleanOptionKey;
  readonly label: string;
}) {
  const checked = useSidebarOptionsStore((state) => state[props.optionKey]);
  const setOption = useSidebarOptionsStore((state) => state.setOption);
  return (
    <label className="flex cursor-pointer items-center justify-between gap-3 rounded-md px-1.5 py-1.5 text-xs text-foreground transition-colors hover:bg-accent/60">
      <span className="min-w-0 truncate">{props.label}</span>
      <Switch
        size="sm"
        checked={checked}
        onCheckedChange={(nextChecked) => setOption(props.optionKey, nextChecked)}
      />
    </label>
  );
}

export function SidebarSectionToolbar(props: {
  readonly collapseAllAction: CollapseAllAction;
  readonly onToggleCollapseAll: () => void;
  readonly attentionCount: number;
  readonly onActivityOnlyChange?: (next: boolean) => void;
}) {
  const gt = useGT();
  const bellButtonRef = useRef<HTMLButtonElement>(null);
  const groupBy = useSidebarOptionsStore((state) => state.groupBy);
  const setGroupBy = useSidebarOptionsStore((state) => state.setGroupBy);
  const activityOnly = useSidebarOptionsStore((state) => state.activityOnly);
  const setActivityOnly = useSidebarOptionsStore((state) => state.setActivityOnly);
  const handleToggleActivityOnly = () => {
    const next = !activityOnly;
    setActivityOnly(next);
    props.onActivityOnlyChange?.(next);
  };
  const handleClearActivityOnly = () => {
    setActivityOnly(false);
    props.onActivityOnlyChange?.(false);
    bellButtonRef.current?.focus();
  };

  const collapseLabel =
    props.collapseAllAction === "expand-all"
      ? gt("Expand all projects")
      : gt("Collapse all projects");
  const attentionFilterLabel = gt("Show active and unread only");
  const displayOptionsLabel = gt("Sidebar display options");
  const CollapseIcon =
    props.collapseAllAction === "expand-all" ? ChevronsUpDownIcon : ChevronsDownUpIcon;

  return (
    <div className="flex flex-col gap-1 pt-1">
      <div className="flex items-center justify-between gap-1 px-1">
        <div className="flex min-w-0 items-center gap-1">
          <span className="truncate text-2xs font-semibold tracking-wide text-sidebar-muted-foreground/75">
            {groupBy === "project" ? (
              <T context="sidebar section heading">Projects</T>
            ) : (
              <T context="sidebar section heading">Threads</T>
            )}
          </span>
          {props.collapseAllAction !== null ? (
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    size="icon-micro"
                    variant="ghost-muted"
                    aria-label={collapseLabel}
                    onClick={props.onToggleCollapseAll}
                  />
                }
              >
                <CollapseIcon aria-hidden />
              </TooltipTrigger>
              <TooltipPopup side="top">{collapseLabel}</TooltipPopup>
            </Tooltip>
          ) : null}
        </div>
        <div className="flex shrink-0 items-center gap-0.5">
          <span className="relative inline-flex">
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    ref={bellButtonRef}
                    size="icon-xs"
                    variant={activityOnly ? "secondary" : "ghost-muted"}
                    aria-label={attentionFilterLabel}
                    aria-pressed={activityOnly}
                    data-testid="sidebar-attention-filter"
                    onClick={handleToggleActivityOnly}
                  />
                }
              >
                <BellIcon aria-hidden />
              </TooltipTrigger>
              <TooltipPopup side="top">{attentionFilterLabel}</TooltipPopup>
            </Tooltip>
            {props.attentionCount > 0 ? (
              <span
                aria-hidden
                className="pointer-events-none absolute -top-0.5 -right-0.5 flex h-3.5 min-w-3.5 items-center justify-center rounded-full bg-warning px-0.5 text-5xs font-bold leading-none text-white tabular-nums"
              >
                {props.attentionCount > 99 ? "99+" : props.attentionCount}
              </span>
            ) : null}
          </span>
          <Popover>
            <Tooltip>
              <TooltipTrigger
                render={
                  <PopoverTrigger
                    render={
                      <Button
                        size="icon-xs"
                        variant="ghost-muted"
                        aria-label={displayOptionsLabel}
                        data-testid="sidebar-display-options-trigger"
                      />
                    }
                  />
                }
              >
                <SlidersHorizontalIcon aria-hidden />
              </TooltipTrigger>
              <TooltipPopup side="top">{displayOptionsLabel}</TooltipPopup>
            </Tooltip>
            <PopoverPopup side="right" align="start" sideOffset={8} padding="compact" width="sm">
              <div className="flex flex-col gap-2">
                <div className="flex flex-col gap-1.5">
                  <div className="px-1.5 text-2xs font-semibold text-muted-foreground">
                    <T>Group by</T>
                  </div>
                  <div className="grid grid-cols-2 gap-1 rounded-md bg-muted/60 p-0.5">
                    <Button
                      size="xs"
                      variant={groupBy === "project" ? "secondary" : "ghost-muted"}
                      aria-pressed={groupBy === "project"}
                      onClick={() => setGroupBy("project")}
                    >
                      <T context="sidebar grouping option">Project</T>
                    </Button>
                    <Button
                      size="xs"
                      variant={groupBy === "status" ? "secondary" : "ghost-muted"}
                      aria-pressed={groupBy === "status"}
                      onClick={() => setGroupBy("status")}
                    >
                      <T context="sidebar grouping option">Status</T>
                    </Button>
                  </div>
                </div>
                <div className="h-px bg-border/60" />
                <div className="flex flex-col gap-0.5">
                  <div className="px-1.5 pb-0.5 text-2xs font-semibold text-muted-foreground">
                    <T>Display</T>
                  </div>
                  <SidebarOptionSwitchRow
                    optionKey="compactSingleLine"
                    label={gt("Compact single line")}
                  />
                  <SidebarOptionSwitchRow optionKey="dimWhenRead" label={gt("Dim read titles")} />
                  <SidebarOptionSwitchRow optionKey="showBranch" label={gt("Branch & worktree")} />
                  <SidebarOptionSwitchRow optionKey="showModel" label={gt("Agent & model name")} />
                  <SidebarOptionSwitchRow
                    optionKey="showModeBadge"
                    label={gt("Plan / Full mode")}
                  />
                </div>
              </div>
            </PopoverPopup>
          </Popover>
        </div>
      </div>
      {activityOnly ? (
        <div
          data-testid="sidebar-attention-banner"
          className="flex items-center justify-between gap-2 rounded-md bg-info/12 px-2 py-1 text-2xs font-medium text-info-foreground dark:bg-info/16"
        >
          <span className="min-w-0 truncate">
            <T>
              Active & unread only (<Var>{props.attentionCount}</Var>)
            </T>
          </span>
          <InlineButton onClick={handleClearActivityOnly}>
            <T>Show all</T>
          </InlineButton>
        </div>
      ) : null}
    </div>
  );
}
