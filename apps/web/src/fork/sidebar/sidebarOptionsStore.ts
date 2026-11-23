import { create, type StoreApi, type UseBoundStore } from "zustand";

export const SIDEBAR_OPTIONS_STORAGE_KEY = "t3lab:sidebar-ui:v1";

export type SidebarGroupBy = "project" | "status";

export type SidebarDisplayBooleanOptionKey =
  | "compactSingleLine"
  | "dimWhenRead"
  | "showBranch"
  | "showModel"
  | "showModeBadge";

export interface PersistedSidebarUiOptions {
  readonly groupBy: SidebarGroupBy;
  readonly compactSingleLine: boolean;
  readonly dimWhenRead: boolean;
  readonly showBranch: boolean;
  readonly showModel: boolean;
  readonly showModeBadge: boolean;
}

export interface SidebarUiOptions extends PersistedSidebarUiOptions {
  readonly activityOnly: boolean;
}

const DEFAULT_SIDEBAR_UI_OPTIONS: SidebarUiOptions = {
  groupBy: "project",
  compactSingleLine: false,
  dimWhenRead: true,
  showBranch: true,
  showModel: true,
  showModeBadge: true,
  activityOnly: false,
};

const { activityOnly: _activityOnly, ...defaultPersistedOptions } = DEFAULT_SIDEBAR_UI_OPTIONS;

function isOptionsObject(raw: unknown): raw is Record<string, unknown> {
  return typeof raw === "object" && raw !== null && !Array.isArray(raw);
}

function readBooleanOption(raw: Record<string, unknown>, key: SidebarDisplayBooleanOptionKey) {
  const value = raw[key];
  return typeof value === "boolean" ? value : defaultPersistedOptions[key];
}

export function parseSidebarUiOptions(raw: unknown): PersistedSidebarUiOptions {
  if (!isOptionsObject(raw)) return defaultPersistedOptions;
  const groupBy = raw.groupBy;
  return {
    groupBy:
      groupBy === "status" || groupBy === "project" ? groupBy : defaultPersistedOptions.groupBy,
    compactSingleLine: readBooleanOption(raw, "compactSingleLine"),
    dimWhenRead: readBooleanOption(raw, "dimWhenRead"),
    showBranch: readBooleanOption(raw, "showBranch"),
    showModel: readBooleanOption(raw, "showModel"),
    showModeBadge: readBooleanOption(raw, "showModeBadge"),
  };
}

export function readPersistedSidebarUiOptions(
  storage?: Pick<Storage, "getItem"> | null,
): PersistedSidebarUiOptions {
  try {
    const target =
      storage === undefined && typeof window !== "undefined" ? window.localStorage : storage;
    const raw = target?.getItem(SIDEBAR_OPTIONS_STORAGE_KEY);
    if (raw == null) return defaultPersistedOptions;
    const parsed: unknown = JSON.parse(raw);
    return parseSidebarUiOptions(parsed);
  } catch {
    return defaultPersistedOptions;
  }
}

function writePersistedSidebarUiOptions(
  options: PersistedSidebarUiOptions,
  storage?: Pick<Storage, "setItem"> | null,
): void {
  try {
    const target =
      storage === undefined && typeof window !== "undefined" ? window.localStorage : storage;
    target?.setItem(SIDEBAR_OPTIONS_STORAGE_KEY, JSON.stringify(parseSidebarUiOptions(options)));
  } catch {
    // Keep the in-memory options when browser storage is disabled or full.
  }
}

export interface SidebarOptionsStoreState extends SidebarUiOptions {
  setGroupBy: (groupBy: SidebarGroupBy) => void;
  toggleOption: (key: SidebarDisplayBooleanOptionKey) => void;
  setOption: (key: SidebarDisplayBooleanOptionKey, value: boolean) => void;
  toggleActivityOnly: () => void;
  setActivityOnly: (value: boolean) => void;
  resetSidebarOptions: () => void;
}

export const useSidebarOptionsStore: UseBoundStore<StoreApi<SidebarOptionsStoreState>> =
  create<SidebarOptionsStoreState>((set, get) => {
    const setAndPersist = (patch: Partial<SidebarUiOptions>) => {
      set(patch);
      writePersistedSidebarUiOptions(get());
    };

    return {
      ...DEFAULT_SIDEBAR_UI_OPTIONS,
      ...readPersistedSidebarUiOptions(),
      setGroupBy: (groupBy) => setAndPersist({ groupBy }),
      toggleOption: (key) => setAndPersist({ [key]: !get()[key] }),
      setOption: (key, value) => setAndPersist({ [key]: value }),
      toggleActivityOnly: () => set((state) => ({ activityOnly: !state.activityOnly })),
      setActivityOnly: (activityOnly) => set({ activityOnly }),
      resetSidebarOptions: () => setAndPersist(DEFAULT_SIDEBAR_UI_OPTIONS),
    };
  });
