import { create, type StoreApi, type UseBoundStore } from "zustand";

export const HUD_OPTIONS_STORAGE_KEY = "t3lab:hud-ui:v1";

export type HudCardVisibilityKey =
  | "showComposerRing"
  | "showContext"
  | "showSession"
  | "showQuota"
  | "showActivity"
  | "showSystem";

export interface HudUiOptions {
  readonly showComposerRing: boolean;
  readonly showContext: boolean;
  readonly showSession: boolean;
  readonly showQuota: boolean;
  readonly showActivity: boolean;
  readonly showSystem: boolean;
  readonly systemExpanded: boolean;
}

export interface HudOptionsStoreState extends HudUiOptions {
  toggleCard: (key: HudCardVisibilityKey) => void;
  setCardVisible: (key: HudCardVisibilityKey, value: boolean) => void;
  setSystemExpanded: (expanded: boolean) => void;
  toggleSystemExpanded: () => void;
  resetHudOptions: () => void;
}

const DEFAULT_HUD_UI_OPTIONS: HudUiOptions = {
  showComposerRing: true,
  showContext: true,
  showSession: true,
  showQuota: true,
  showActivity: true,
  showSystem: true,
  systemExpanded: false,
};

function isOptionsObject(raw: unknown): raw is Record<string, unknown> {
  return typeof raw === "object" && raw !== null && !Array.isArray(raw);
}

function readBooleanOption(raw: Record<string, unknown>, key: keyof HudUiOptions): boolean {
  const value = raw[key];
  return typeof value === "boolean" ? value : DEFAULT_HUD_UI_OPTIONS[key];
}

export function parseHudUiOptions(raw: unknown): HudUiOptions {
  if (!isOptionsObject(raw)) return DEFAULT_HUD_UI_OPTIONS;
  return {
    showComposerRing: readBooleanOption(raw, "showComposerRing"),
    showContext: readBooleanOption(raw, "showContext"),
    showSession: readBooleanOption(raw, "showSession"),
    showQuota: readBooleanOption(raw, "showQuota"),
    showActivity: readBooleanOption(raw, "showActivity"),
    showSystem: readBooleanOption(raw, "showSystem"),
    systemExpanded: readBooleanOption(raw, "systemExpanded"),
  };
}

export function readPersistedHudUiOptions(storage?: Pick<Storage, "getItem"> | null): HudUiOptions {
  try {
    const target =
      storage === undefined && typeof window !== "undefined" ? window.localStorage : storage;
    const raw = target?.getItem(HUD_OPTIONS_STORAGE_KEY);
    if (raw == null) return DEFAULT_HUD_UI_OPTIONS;
    const parsed: unknown = JSON.parse(raw);
    return parseHudUiOptions(parsed);
  } catch {
    return DEFAULT_HUD_UI_OPTIONS;
  }
}

function writePersistedHudUiOptions(options: HudUiOptions): void {
  try {
    if (typeof window === "undefined") return;
    window.localStorage.setItem(
      HUD_OPTIONS_STORAGE_KEY,
      JSON.stringify(parseHudUiOptions(options)),
    );
  } catch {
    // Keep the in-memory options when browser storage is disabled or full.
  }
}

export function isDefaultHudUiOptions(
  options: Omit<HudUiOptions, "showComposerRing"> & Partial<Pick<HudUiOptions, "showComposerRing">>,
): boolean {
  return (
    (options.showComposerRing ?? DEFAULT_HUD_UI_OPTIONS.showComposerRing) ===
      DEFAULT_HUD_UI_OPTIONS.showComposerRing &&
    options.showContext === DEFAULT_HUD_UI_OPTIONS.showContext &&
    options.showSession === DEFAULT_HUD_UI_OPTIONS.showSession &&
    options.showQuota === DEFAULT_HUD_UI_OPTIONS.showQuota &&
    options.showActivity === DEFAULT_HUD_UI_OPTIONS.showActivity &&
    options.showSystem === DEFAULT_HUD_UI_OPTIONS.showSystem &&
    options.systemExpanded === DEFAULT_HUD_UI_OPTIONS.systemExpanded
  );
}

export const useHudOptionsStore: UseBoundStore<StoreApi<HudOptionsStoreState>> =
  create<HudOptionsStoreState>((set, get) => {
    const setAndPersist = (patch: Partial<HudUiOptions>) => {
      set(patch);
      writePersistedHudUiOptions(get());
    };

    return {
      ...readPersistedHudUiOptions(),
      toggleCard: (key) => setAndPersist({ [key]: !get()[key] }),
      setCardVisible: (key, value) => setAndPersist({ [key]: value }),
      setSystemExpanded: (systemExpanded) => setAndPersist({ systemExpanded }),
      toggleSystemExpanded: () => setAndPersist({ systemExpanded: !get().systemExpanded }),
      resetHudOptions: () => setAndPersist(DEFAULT_HUD_UI_OPTIONS),
    };
  });
