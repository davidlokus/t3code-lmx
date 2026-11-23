import {
  type EnvironmentMachineKind,
  ProviderDriverKind,
  type ProviderInteractionMode,
  type RuntimeMode,
} from "@t3tools/contracts";
import type { SidebarThreadStatus } from "../../components/Sidebar.logic";
import type { EnvironmentPresence } from "../../sidebarProjectGrouping";

export interface ProjectHostInput {
  readonly projectKey: string;
  readonly displayName: string;
  readonly environmentId: string;
  readonly environmentPresence: EnvironmentPresence;
  readonly memberEnvironmentIds: readonly string[];
  readonly environmentLabel: string | null;
  readonly remoteEnvironmentLabels: readonly string[];
  readonly machineKind: EnvironmentMachineKind;
}

export interface ProjectHeaderHostContext {
  readonly label: string;
  readonly machineKind: EnvironmentMachineKind;
  readonly reason: "collision" | "remote-only";
}

export function formatCompactHostLabel(label: string | null | undefined): string | null {
  return label?.trim().replace(/\s+\(\d+\)$/, "") || null;
}

export function resolveProjectHeaderHostContextMap(input: {
  readonly groups: ReadonlyArray<ProjectHostInput>;
  readonly primaryEnvironmentId: string | null;
  readonly connectedEnvironmentCount: number;
}): ReadonlyMap<string, ProjectHeaderHostContext> {
  const { groups, connectedEnvironmentCount } = input;
  const contexts = new Map<string, ProjectHeaderHostContext>();
  const firstEnvironmentId = groups[0]?.environmentId;
  if (
    connectedEnvironmentCount <= 1 &&
    !groups.some((group) => group.environmentId !== firstEnvironmentId)
  ) {
    return contexts;
  }

  // Null marks a display name represented by more than one environment.
  const environmentByName = new Map<string, string | null>();
  for (const group of groups) {
    const name = group.displayName.trim().toLowerCase();
    const environmentId = environmentByName.get(name);
    if (environmentId === undefined) {
      environmentByName.set(name, group.environmentId);
    } else if (environmentId !== null && environmentId !== group.environmentId) {
      environmentByName.set(name, null);
    }
  }

  for (const group of groups) {
    const collision = environmentByName.get(group.displayName.trim().toLowerCase()) === null;
    if (!collision && group.environmentPresence !== "remote-only") continue;
    const remoteLabel = group.remoteEnvironmentLabels[0];
    const label = collision
      ? (formatCompactHostLabel(group.environmentLabel) ?? formatCompactHostLabel(remoteLabel))
      : formatCompactHostLabel(remoteLabel ?? group.environmentLabel);
    if (label !== null) {
      contexts.set(group.projectKey, {
        label,
        machineKind: group.machineKind,
        reason: collision ? "collision" : "remote-only",
      });
    }
  }
  return contexts;
}

export function resolveThreadRowEnvironmentLabel(input: {
  readonly view: "project-folder" | "status-card" | "search";
  readonly environmentId: string;
  readonly environmentLabel: string | null;
  readonly primaryEnvironmentId: string | null;
  readonly hasMultipleEnvironments: boolean;
  readonly folderEnvironmentPresence: EnvironmentPresence | null;
}): string | null {
  if (!input.hasMultipleEnvironments || input.environmentId === input.primaryEnvironmentId) {
    return null;
  }
  if (input.view === "project-folder" && input.folderEnvironmentPresence !== "mixed") {
    return null;
  }
  return formatCompactHostLabel(input.environmentLabel);
}

function isWorkingStatus(status: SidebarThreadStatus) {
  return status === "working" || status === "preparing";
}

function isLoudStatus(status: SidebarThreadStatus) {
  return (
    status === "approval" ||
    status === "input" ||
    status === "request" ||
    status === "failed" ||
    status === "limited"
  );
}

export type StatusLaneKind =
  | "working"
  | "failed"
  | "approval"
  | "input"
  | "request"
  | "woke"
  | "unread-done"
  | "draft"
  | "none";

export function resolveStatusLaneKind(input: {
  readonly status: SidebarThreadStatus;
  readonly isUnread: boolean;
  readonly isWoke: boolean;
  readonly hasUnsentDraft: boolean;
}): StatusLaneKind {
  const { status, isUnread, isWoke, hasUnsentDraft } = input;
  if (isWorkingStatus(status)) return "working";
  if (status === "limited") return "failed";
  if (isLoudStatus(status)) return status;
  if (isWoke) return "woke";
  if (isUnread) return "unread-done";
  return hasUnsentDraft ? "draft" : "none";
}

export function shouldDimReadTitle(input: {
  readonly dimWhenRead: boolean;
  readonly status: SidebarThreadStatus;
  readonly isUnread: boolean;
  readonly isWoke: boolean;
  readonly isActive: boolean;
  readonly isSelected: boolean;
}): boolean {
  return (
    input.dimWhenRead &&
    (input.status === "ready" || input.status === "waiting") &&
    !input.isUnread &&
    !input.isWoke &&
    !input.isActive &&
    !input.isSelected
  );
}

export function isAttentionThread(input: {
  readonly status: SidebarThreadStatus;
  readonly isUnread: boolean;
  readonly isWoke: boolean;
}): boolean {
  return (
    input.isUnread || input.isWoke || isWorkingStatus(input.status) || isLoudStatus(input.status)
  );
}

export type RightSignalPresentation =
  | {
      readonly kind: "loud-pill";
      readonly tone: "approval" | "input" | "request" | "failed" | "limited";
    }
  | { readonly kind: "working-duration" }
  | { readonly kind: "woke" }
  | { readonly kind: "quiet-time"; readonly emphasized: boolean };

export function resolveRightSignalPresentation(input: {
  readonly status: SidebarThreadStatus;
  readonly isUnread: boolean;
  readonly isWoke: boolean;
}): RightSignalPresentation {
  const { status, isUnread, isWoke } = input;
  if (isLoudStatus(status)) return { kind: "loud-pill", tone: status };
  if (isWorkingStatus(status)) return { kind: "working-duration" };
  if (isWoke) return { kind: "woke" };
  return { kind: "quiet-time", emphasized: isUnread };
}

export type SidebarModeBadgeKind = "plan" | "full";

export function resolveSidebarModeBadges(input: {
  readonly showModeBadge: boolean;
  readonly interactionMode: ProviderInteractionMode;
  readonly runtimeMode: RuntimeMode;
}): ReadonlyArray<SidebarModeBadgeKind> {
  if (!input.showModeBadge) return [];
  const isFull = input.runtimeMode === "full-access";
  if (input.interactionMode === "plan") return isFull ? ["plan", "full"] : ["plan"];
  return isFull ? ["full"] : [];
}

export function formatCompactModelName(rawModel: string | null | undefined): string | null {
  const name = rawModel
    ?.slice(rawModel.lastIndexOf("/") + 1)
    .trim()
    .replace(/(?:[-@]\d{8}|:latest)+$/i, "");
  if (!name || name.toLowerCase() === "default") return null;
  return name
    .replace(/^claude-(opus|sonnet|haiku)-(\d+)-(\d+)$/, "$1-$2.$3")
    .replace(/^claude-(\d+)-(\d+)-(opus|sonnet|haiku)$/, "$3-$1.$2");
}

export interface FallbackProviderVisual {
  readonly inferredDriverKind: ProviderDriverKind | null;
  readonly fallbackInitials: string;
  readonly displayName: string;
}

const driverKindByAlias: Readonly<Record<string, string>> = {
  claude: "claudeAgent",
  "claude-code": "claudeAgent",
  claudeagent: "claudeAgent",
  codex: "codex",
  "openai-codex": "codex",
  omp: "omp",
  "oh-my-pi": "omp",
  pi: "pi",
  cursor: "cursor",
  "cursor-agent": "cursor",
  opencode: "opencode",
  antigravity: "antigravity",
  agy: "antigravity",
  kiro: "kiro",
  grok: "grok",
  muse: "muse",
  fx: "fx",
};

function findDriverKind(alias: string | undefined) {
  if (alias === undefined || !Object.hasOwn(driverKindByAlias, alias)) return undefined;
  return driverKindByAlias[alias];
}

export function resolveFallbackProviderVisual(input: {
  readonly instanceId: string;
  readonly runtimeProviderName: string | null | undefined;
  readonly knownDriverKinds: ReadonlySet<string>;
}): FallbackProviderVisual {
  const instanceId = input.instanceId.trim();
  const runtimeName = input.runtimeProviderName?.trim();
  const matched =
    findDriverKind(runtimeName?.toLowerCase()) ??
    findDriverKind(instanceId.split(/[-_:\s]+/, 1)[0]?.toLowerCase());
  const displayName = runtimeName || instanceId || "?";
  return {
    inferredDriverKind:
      matched !== undefined && input.knownDriverKinds.has(matched)
        ? ProviderDriverKind.make(matched)
        : null,
    fallbackInitials:
      displayName
        .toUpperCase()
        .replace(/[^A-Z0-9]/g, "")
        .slice(0, 2) || "?",
    displayName,
  };
}

export function shouldRenderSecondMetaRow(input: {
  readonly compactSingleLine: boolean;
  readonly showBranch: boolean;
  readonly branch: string | null;
  readonly showModeBadge: boolean;
  readonly modeBadgesCount: number;
  readonly showModel: boolean;
  readonly modelLabel: string | null;
  readonly environmentLabel: string | null;
  readonly hasPr: boolean;
  readonly hasIssue: boolean;
  readonly hasDiff: boolean;
  readonly runningTerminalCount: number;
}): boolean {
  return (
    !input.compactSingleLine &&
    ((input.showBranch && !!input.branch) ||
      (input.showModeBadge && input.modeBadgesCount > 0) ||
      (input.showModel && !!input.modelLabel) ||
      !!input.environmentLabel ||
      input.hasPr ||
      input.hasIssue ||
      input.hasDiff ||
      input.runningTerminalCount > 0)
  );
}

export type CollapseAllAction = "collapse-all" | "expand-all" | null;

export function resolveCollapseAllAction(
  folders: ReadonlyArray<{ readonly collapsed: boolean }>,
): CollapseAllAction {
  if (folders.length <= 1) return null;
  return folders.every((folder) => folder.collapsed) ? "expand-all" : "collapse-all";
}
