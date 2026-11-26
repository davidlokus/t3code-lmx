import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import {
  ChatFileAttachment,
  INCOGNITO_BROWSER_PROFILE_ID,
  PreviewSessionSnapshot,
  ScopedThreadRef,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

import { decodeLinkedThreadSurface } from "./linkedThreadSurface";
import { resolveStorage } from "./lib/storage";
import { randomUUID } from "./lib/utils";
import {
  decodeSubagentSurface,
  decodeThreadSurface,
  type RightPanelSurface,
} from "./rightPanelStore";

export type ClosedView =
  | {
      kind: "panel-tab";
      threadRef: ScopedThreadRef;
      surface: Exclude<RightPanelSurface, { kind: "terminal" }>;
    }
  | { kind: "browser"; threadRef: ScopedThreadRef; snapshot: PreviewSessionSnapshot };

export type ClosedViewEntry = ClosedView & { id: string };

interface ClosedViewStoreState {
  entries: ClosedViewEntry[];
  remember: (view: ClosedView) => string | null;
  defer: (id: string) => void;
  remove: (id: string) => void;
}

const sameTarget = (entry: ClosedViewEntry, view: ClosedView): boolean => {
  if (
    entry.kind !== view.kind ||
    scopedThreadKey(entry.threadRef) !== scopedThreadKey(view.threadRef)
  ) {
    return false;
  }
  switch (entry.kind) {
    case "panel-tab":
      return view.kind === "panel-tab" && entry.surface.id === view.surface.id;
    case "browser":
      return view.kind === "browser" && entry.snapshot.tabId === view.snapshot.tabId;
  }
};

const isPersistentView = (entry: ClosedViewEntry) =>
  entry.kind !== "browser" || entry.snapshot.profileId !== INCOGNITO_BROWSER_PROFILE_ID;

const isThreadRef = Schema.is(ScopedThreadRef);
const isSnapshot = Schema.is(PreviewSessionSnapshot);
const isAttachment = Schema.is(ChatFileAttachment);

function isValidPanelSurface(
  surface: Exclude<Extract<ClosedView, { kind: "panel-tab" }>["surface"], { kind: "subagent" }>,
) {
  switch (surface.kind) {
    case "diff":
    case "files":
    case "pull-requests":
      return surface.id === surface.kind;
    case "preview":
      return surface.resourceId === null || typeof surface.resourceId === "string";
    case "file":
      return (
        typeof surface.relativePath === "string" &&
        (surface.revealLine === null || Number.isSafeInteger(surface.revealLine)) &&
        Number.isSafeInteger(surface.revealRequestId) &&
        (surface.attachment === undefined || isAttachment(surface.attachment))
      );
    case "device":
      return (
        (surface.title === undefined || typeof surface.title === "string") &&
        (surface.target === undefined ||
          (surface.target !== null &&
            typeof surface.target.hostId === "string" &&
            typeof surface.target.deviceId === "string" &&
            typeof surface.target.name === "string" &&
            (surface.target.platform === "ios" || surface.target.platform === "android")))
      );
    case "thread":
      return typeof surface.threadId === "string" && surface.id === `thread:${surface.threadId}`;
    case "linked-thread":
      return (
        (surface.title === null || typeof surface.title === "string") &&
        decodeLinkedThreadSurface(surface)?.id === surface.id
      );
    case "pull-request":
      return (
        typeof surface.projectId === "string" &&
        typeof surface.repository === "string" &&
        Number.isSafeInteger(surface.number) &&
        surface.number > 0 &&
        (surface.environmentId === undefined || typeof surface.environmentId === "string") &&
        (surface.host === undefined || typeof surface.host === "string") &&
        (surface.url === undefined || typeof surface.url === "string")
      );
    case "issue":
      return (
        typeof surface.projectId === "string" &&
        typeof surface.tracker === "string" &&
        typeof surface.scope === "string" &&
        typeof surface.key === "string" &&
        (surface.environmentId === undefined || typeof surface.environmentId === "string") &&
        (surface.host === undefined || typeof surface.host === "string") &&
        (surface.url === undefined || typeof surface.url === "string")
      );
    default:
      return false;
  }
}

function decodeSavedView(entry: unknown): ClosedViewEntry | null {
  const view = entry as ClosedViewEntry | null;
  if (!view || typeof view.id !== "string" || !isThreadRef(view.threadRef)) return null;
  if (view.kind === "browser") {
    return isSnapshot(view.snapshot) && isPersistentView(view) ? view : null;
  }
  if (view.kind !== "panel-tab" || !view.surface || typeof view.surface !== "object") return null;
  const { surface } = view;
  if (
    surface.kind === "subagent" ||
    (typeof surface.id === "string" && surface.id.startsWith("subagent:"))
  ) {
    const decoded = decodeSubagentSurface(surface);
    return decoded === null ? null : { ...view, surface: decoded };
  }
  const savedSurface: { kind?: unknown } = surface;
  // A closed side chat tab saved before its surface became `thread`.
  if (savedSurface.kind === "side-chat") {
    const decoded = decodeThreadSurface(surface);
    return decoded === null ? null : { ...view, surface: decoded };
  }
  if (typeof surface.id !== "string") return null;
  return isValidPanelSurface(surface) ? view : null;
}

function decodeSavedViews(persisted: unknown): Pick<ClosedViewStoreState, "entries"> {
  const entries =
    persisted && typeof persisted === "object" && "entries" in persisted
      ? persisted.entries
      : undefined;
  return {
    entries: Array.isArray(entries)
      ? entries.flatMap((entry) => {
          const decoded = decodeSavedView(entry);
          return decoded === null ? [] : [decoded];
        })
      : [],
  };
}

export const useClosedViewStore = create<ClosedViewStoreState>()(
  persist(
    (set) => ({
      entries: [],
      remember: (view) => {
        if (view.kind === "panel-tab" && view.surface.kind === "subagent") {
          const surface = decodeSubagentSurface(view.surface);
          if (surface === null) return null;
          view = { ...view, surface };
        }
        const id = randomUUID();
        set((state) => ({
          entries: [
            { ...view, id },
            ...state.entries.filter((entry) => !sameTarget(entry, view)),
          ].slice(0, 20),
        }));
        return id;
      },
      defer: (id) =>
        set((state) => {
          const entry = state.entries.find((entry) => entry.id === id);
          return entry
            ? { entries: [...state.entries.filter((entry) => entry.id !== id), entry] }
            : state;
        }),
      remove: (id) =>
        set((state) => ({ entries: state.entries.filter((entry) => entry.id !== id) })),
    }),
    {
      name: "t3code:closed-views:v2",
      storage: createJSONStorage(() =>
        resolveStorage(typeof window !== "undefined" ? window.localStorage : undefined),
      ),
      version: 3,
      migrate: decodeSavedViews,
      merge: (persisted, current) =>
        persisted === undefined ? current : { ...current, ...decodeSavedViews(persisted) },
      partialize: ({ entries }) => ({ entries: entries.filter(isPersistentView) }),
    },
  ),
);
