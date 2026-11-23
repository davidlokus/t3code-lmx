import { describe, expect, it, vi } from "vite-plus/test";

import { parseSidebarUiOptions, readPersistedSidebarUiOptions } from "./sidebarOptionsStore";
import {
  formatCompactHostLabel,
  formatCompactModelName,
  isAttentionThread,
  type ProjectHostInput,
  resolveCollapseAllAction,
  resolveFallbackProviderVisual,
  resolveProjectHeaderHostContextMap,
  resolveRightSignalPresentation,
  resolveSidebarModeBadges,
  resolveStatusLaneKind,
  resolveThreadRowEnvironmentLabel,
  shouldDimReadTitle,
  shouldRenderSecondMetaRow,
} from "./sidebarPresentation.logic";

const localGroup: ProjectHostInput = {
  projectKey: "local:repo",
  displayName: " Repo ",
  environmentId: "local",
  environmentPresence: "local-only",
  memberEnvironmentIds: ["local"],
  environmentLabel: " MacBook Pro (2) ",
  remoteEnvironmentLabels: [],
  machineKind: "laptop",
};

const remoteGroup: ProjectHostInput = {
  projectKey: "remote:repo",
  displayName: "repo",
  environmentId: "remote",
  environmentPresence: "remote-only",
  memberEnvironmentIds: ["remote"],
  environmentLabel: "T101 endpoint",
  remoteEnvironmentLabels: [" T101 (3) "],
  machineKind: "linux",
};

describe("project host context", () => {
  it.each([
    [" MacBook Pro (2) ", "MacBook Pro"],
    ["Host (2) (3)", "Host (2)"],
    ["Host(2)", "Host(2)"],
    ["Host (work)", "Host (work)"],
    [" \t ", null],
  ])("compacts host label %s without changing intentional suffixes", (label, expected) => {
    expect(formatCompactHostLabel(label)).toBe(expected);
  });

  it("hides even remote project headers on a single connected host", () => {
    expect(
      resolveProjectHeaderHostContextMap({
        groups: [remoteGroup],
        primaryEnvironmentId: "local",
        connectedEnvironmentCount: 1,
      }).size,
    ).toBe(0);
  });

  it("labels every normalized collision across represented hosts even if one is disconnected", () => {
    const otherLocal = { ...localGroup, projectKey: "local:other", displayName: "REPO" };
    const contexts = resolveProjectHeaderHostContextMap({
      groups: [localGroup, { ...remoteGroup, environmentLabel: " " }, otherLocal],
      primaryEnvironmentId: "local",
      connectedEnvironmentCount: 1,
    });
    const localContext = { label: "MacBook Pro", machineKind: "laptop", reason: "collision" };
    expect(contexts).toEqual(
      new Map([
        [localGroup.projectKey, localContext],
        [remoteGroup.projectKey, { label: "T101", machineKind: "linux", reason: "collision" }],
        [otherLocal.projectKey, localContext],
      ]),
    );
  });

  it("does not label same-host collisions or a uniquely named mixed project", () => {
    expect(
      resolveProjectHeaderHostContextMap({
        groups: [
          localGroup,
          { ...localGroup, projectKey: "local:repo2", displayName: "repo" },
          {
            ...localGroup,
            projectKey: "mixed",
            displayName: "Mixed",
            environmentPresence: "mixed",
            memberEnvironmentIds: ["local", "remote"],
            remoteEnvironmentLabels: ["T101"],
          },
        ],
        primaryEnvironmentId: "local",
        connectedEnvironmentCount: 2,
      }).size,
    ).toBe(0);
  });

  it("uses the remote label for noncolliding remote projects and omits missing labels", () => {
    const fallback = { ...remoteGroup, projectKey: "remote:other", displayName: "Other" };
    const contexts = resolveProjectHeaderHostContextMap({
      groups: [
        remoteGroup,
        { ...fallback, remoteEnvironmentLabels: [] },
        {
          ...fallback,
          projectKey: "remote:missing",
          environmentLabel: null,
          remoteEnvironmentLabels: [],
        },
      ],
      primaryEnvironmentId: "local",
      connectedEnvironmentCount: 2,
    });
    expect(contexts).toEqual(
      new Map([
        [remoteGroup.projectKey, { label: "T101", machineKind: "linux", reason: "remote-only" }],
        [
          fallback.projectKey,
          { label: "T101 endpoint", machineKind: "linux", reason: "remote-only" },
        ],
      ]),
    );
  });
});

describe("thread row host context", () => {
  const remoteThread = {
    view: "status-card",
    environmentId: "remote",
    environmentLabel: " T101 (2) ",
    primaryEnvironmentId: "local",
    hasMultipleEnvironments: true,
    folderEnvironmentPresence: null,
  } as const;

  it("omits host labels in a single-environment status view", () => {
    expect(
      resolveThreadRowEnvironmentLabel({ ...remoteThread, hasMultipleEnvironments: false }),
    ).toBeNull();
  });

  it.each([
    ["local-only", null],
    ["remote-only", null],
    ["mixed", "T101"],
  ] as const)("puts a non-primary row label only in a mixed folder (%s)", (presence, expected) => {
    expect(
      resolveThreadRowEnvironmentLabel({
        ...remoteThread,
        view: "project-folder",
        folderEnvironmentPresence: presence,
      }),
    ).toBe(expected);
  });

  it.each(["status-card", "search"] as const)("labels only non-primary rows in %s", (view) => {
    expect(resolveThreadRowEnvironmentLabel({ ...remoteThread, view })).toBe("T101");
    expect(
      resolveThreadRowEnvironmentLabel({ ...remoteThread, view, environmentId: "local" }),
    ).toBeNull();
  });
});

describe("row status lane and title contrast", () => {
  it.each([
    ["working", "working"],
    ["preparing", "working"],
    ["failed", "failed"],
    ["limited", "failed"],
    ["approval", "approval"],
    ["input", "input"],
    ["request", "request"],
  ] as const)("puts %s ahead of wake, unread completion, and draft", (status, expected) => {
    expect(
      resolveStatusLaneKind({ status, isUnread: true, isWoke: true, hasUnsentDraft: true }),
    ).toBe(expected);
  });

  it.each([
    [true, true, true, "woke"],
    [false, true, true, "unread-done"],
    [false, false, true, "draft"],
    [false, false, false, "none"],
  ] as const)(
    "resolves a ready row with woke=%s, unread=%s, draft=%s",
    (isWoke, isUnread, hasUnsentDraft, expected) => {
      expect(resolveStatusLaneKind({ status: "ready", isWoke, isUnread, hasUnsentDraft })).toBe(
        expected,
      );
    },
  );

  it("preserves an unseen completion on an otherwise quiet waiting thread", () => {
    expect(
      resolveStatusLaneKind({
        status: "waiting",
        isWoke: false,
        isUnread: true,
        hasUnsentDraft: true,
      }),
    ).toBe("unread-done");
  });

  const quietReadTitle = {
    dimWhenRead: true,
    status: "ready",
    isUnread: false,
    isWoke: false,
    isActive: false,
    isSelected: false,
  } as const;

  it("dims only quiet read titles when the option is enabled", () => {
    expect(shouldDimReadTitle(quietReadTitle)).toBe(true);
    expect(shouldDimReadTitle({ ...quietReadTitle, status: "waiting" })).toBe(true);
    expect(shouldDimReadTitle({ ...quietReadTitle, dimWhenRead: false })).toBe(false);
    for (const key of ["isUnread", "isWoke", "isActive", "isSelected"] as const) {
      expect(shouldDimReadTitle({ ...quietReadTitle, [key]: true }), key).toBe(false);
    }
    for (const status of [
      "working",
      "preparing",
      "failed",
      "limited",
      "approval",
      "input",
      "request",
    ] as const) {
      expect(shouldDimReadTitle({ ...quietReadTitle, status }), status).toBe(false);
    }
  });
});

describe("attention filter and right signals", () => {
  it.each(["approval", "input", "request", "failed", "limited"] as const)(
    "shows a %s pill ahead of unread and wake cues and includes it in attention",
    (status) => {
      expect(isAttentionThread({ status, isUnread: false, isWoke: false })).toBe(true);
      expect(resolveRightSignalPresentation({ status, isUnread: true, isWoke: true })).toEqual({
        kind: "loud-pill",
        tone: status,
      });
    },
  );

  it.each(["working", "preparing"] as const)("keeps %s in attention with a duration", (status) => {
    expect(isAttentionThread({ status, isUnread: false, isWoke: false })).toBe(true);
    expect(resolveRightSignalPresentation({ status, isUnread: true, isWoke: true })).toEqual({
      kind: "working-duration",
    });
  });

  it("preserves unread timestamp emphasis and puts wake ahead of it", () => {
    const quiet = { status: "ready", isUnread: false, isWoke: false } as const;
    const unread = { ...quiet, isUnread: true };
    expect(isAttentionThread(quiet)).toBe(false);
    expect(isAttentionThread({ ...quiet, status: "waiting" })).toBe(false);
    expect(isAttentionThread(unread)).toBe(true);
    expect(isAttentionThread({ ...quiet, isWoke: true })).toBe(true);
    expect(resolveRightSignalPresentation(quiet)).toEqual({
      kind: "quiet-time",
      emphasized: false,
    });
    expect(resolveRightSignalPresentation(unread)).toEqual({
      kind: "quiet-time",
      emphasized: true,
    });
    expect(resolveRightSignalPresentation({ ...unread, isWoke: true })).toEqual({ kind: "woke" });
  });
});

describe("mode and model labels", () => {
  it("can show Plan and Full together without labeling other runtime modes", () => {
    const both = {
      showModeBadge: true,
      interactionMode: "plan",
      runtimeMode: "full-access",
    } as const;
    expect(resolveSidebarModeBadges(both)).toEqual(["plan", "full"]);
    expect(resolveSidebarModeBadges({ ...both, runtimeMode: "auto" })).toEqual(["plan"]);
    expect(resolveSidebarModeBadges({ ...both, interactionMode: "default" })).toEqual(["full"]);
    expect(
      resolveSidebarModeBadges({
        ...both,
        interactionMode: "default",
        runtimeMode: "approval-required",
      }),
    ).toEqual([]);
    expect(resolveSidebarModeBadges({ ...both, showModeBadge: false })).toEqual([]);
  });

  it.each([
    [null, null],
    [undefined, null],
    ["   ", null],
    ["DeFaUlT", null],
    ["provider/DEFAULT:latest", null],
    ["openai-codex/gpt-5.4", "gpt-5.4"],
    ["gateway/team/claude-4-6-opus@20250929:latest", "opus-4.6"],
    ["claude-opus-4-6", "opus-4.6"],
    ["claude-sonnet-4-5-20250929", "sonnet-4.5"],
    ["claude-haiku-4-5", "haiku-4.5"],
    ["GLM-5.4", "GLM-5.4"],
    ["k3.1-pro", "k3.1-pro"],
    ["gpt-6.2-sol-1234", "gpt-6.2-sol-1234"],
  ])("formats model %s without inventing a label", (raw, expected) => {
    expect(formatCompactModelName(raw)).toBe(expected);
  });
});

describe("removed provider visuals", () => {
  it("infers omp from a historical instance ID without a runtime provider name", () => {
    expect(
      resolveFallbackProviderVisual({
        instanceId: "omp_omp_3",
        runtimeProviderName: null,
        knownDriverKinds: new Set(["omp"]),
      }),
    ).toEqual({ inferredDriverKind: "omp", fallbackInitials: "OM", displayName: "omp_omp_3" });
  });

  it.each([
    [" Claude-Code ", "claudeAgent"],
    ["OpenAI-Codex", "codex"],
    ["OH-MY-PI", "omp"],
    ["Cursor-Agent", "cursor"],
    ["AGY", "antigravity"],
  ])(
    "prefers runtime alias %s over a conflicting instance prefix",
    (runtimeProviderName, expected) => {
      expect(
        resolveFallbackProviderVisual({
          instanceId: "pi:deleted",
          runtimeProviderName,
          knownDriverKinds: new Set([expected, "pi"]),
        }).inferredDriverKind,
      ).toBe(expected);
    },
  );

  it("uses a monogram when the inferred driver is not available", () => {
    expect(
      resolveFallbackProviderVisual({
        instanceId: "OMP_omp_3",
        runtimeProviderName: "Custom 3",
        knownDriverKinds: new Set(["pi"]),
      }),
    ).toEqual({ inferredDriverKind: null, fallbackInitials: "CU", displayName: "Custom 3" });
  });

  it.each([
    ["-9x", "9X"],
    ["!", "?"],
    ["constructor", "CO"],
  ])("keeps a nonempty neutral monogram for unknown instance %s", (instanceId, expected) => {
    const visual = resolveFallbackProviderVisual({
      instanceId,
      runtimeProviderName: undefined,
      knownDriverKinds: new Set(),
    });
    expect(visual.inferredDriverKind).toBeNull();
    expect(visual.fallbackInitials).toBe(expected);
  });
});

describe("adaptive metadata row", () => {
  const empty = {
    compactSingleLine: false,
    showBranch: true,
    branch: null,
    showModeBadge: true,
    modeBadgesCount: 0,
    showModel: true,
    modelLabel: null,
    environmentLabel: null,
    hasPr: false,
    hasIssue: false,
    hasDiff: false,
    runningTerminalCount: 0,
  } as const;

  it("collapses when all optional metadata is absent or hidden", () => {
    expect(shouldRenderSecondMetaRow(empty)).toBe(false);
    expect(
      shouldRenderSecondMetaRow({
        ...empty,
        showBranch: false,
        branch: "feature/branch",
        showModeBadge: false,
        modeBadgesCount: 2,
        showModel: false,
        modelLabel: "opus-4.6",
      }),
    ).toBe(false);
  });

  it.each([
    ["branch", { branch: "feature/branch" }],
    ["mode", { modeBadgesCount: 1 }],
    ["model", { modelLabel: "opus-4.6" }],
    ["host", { environmentLabel: "T101" }],
    ["PR", { hasPr: true }],
    ["issue", { hasIssue: true }],
    ["diff", { hasDiff: true }],
    ["terminal", { runningTerminalCount: 1 }],
  ] as const)(
    "shows the second row for visible %s metadata unless compact mode overrides it",
    (_, metadata) => {
      expect(shouldRenderSecondMetaRow({ ...empty, ...metadata })).toBe(true);
      expect(shouldRenderSecondMetaRow({ ...empty, ...metadata, compactSingleLine: true })).toBe(
        false,
      );
    },
  );
});

describe("collapse-all action", () => {
  it.each([
    [[], null],
    [[true], null],
    [[false], null],
    [[false, false], "collapse-all"],
    [[true, false], "collapse-all"],
    [[true, true], "expand-all"],
  ] as const)("resolves collapse-all action for folder states %j", (collapsed, expected) => {
    expect(resolveCollapseAllAction(collapsed.map((value) => ({ collapsed: value })))).toBe(
      expected,
    );
  });
});

describe("sidebar options persistence", () => {
  const defaults = {
    groupBy: "project",
    compactSingleLine: false,
    dimWhenRead: true,
    showBranch: true,
    showModel: true,
    showModeBadge: true,
  } as const;

  it("preserves false preferences, sanitizes bad fields individually, and ignores transient data", () => {
    expect(
      parseSidebarUiOptions({
        groupBy: "remote",
        compactSingleLine: "true",
        dimWhenRead: false,
        showBranch: 0,
        showModel: false,
        activityOnly: true,
      }),
    ).toEqual({ ...defaults, dimWhenRead: false, showModel: false });
  });

  it.each(["{broken", "null", "[]", '"status"'])("recovers from stored %s", (raw) => {
    expect(readPersistedSidebarUiOptions({ getItem: () => raw })).toEqual(defaults);
  });

  it("falls back when localStorage access is denied or absent", () => {
    expect(readPersistedSidebarUiOptions()).toEqual(defaults);
    vi.stubGlobal("window", {
      get localStorage(): Storage {
        throw new DOMException("Storage is disabled", "SecurityError");
      },
    });
    try {
      expect(readPersistedSidebarUiOptions()).toEqual(defaults);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("hydrates display preferences but keeps activity session-only, even after a reload", async () => {
    const key = "t3lab:sidebar-ui:v1";
    const initialJson = JSON.stringify({ groupBy: "status", showModel: false, activityOnly: true });
    const data = new Map([[key, initialJson]]);
    const storage = {
      getItem: (name: string) => data.get(name) ?? null,
      setItem: (name: string, value: string) => {
        data.set(name, value);
      },
    };
    vi.stubGlobal("window", { localStorage: storage });
    vi.resetModules();
    try {
      // Initialize the store against seeded storage, not the test file's import-time environment.
      const { useSidebarOptionsStore: store } = await import("./sidebarOptionsStore");
      expect(store.getState()).toMatchObject({
        groupBy: "status",
        showModel: false,
        activityOnly: false,
      });
      store.getState().setActivityOnly(true);
      expect(store.getState().activityOnly).toBe(true);
      store.getState().toggleActivityOnly();
      expect(store.getState().activityOnly).toBe(false);
      expect(data.get(key)).toBe(initialJson);

      store.getState().setActivityOnly(true);
      store.getState().setGroupBy("project");
      store.getState().toggleOption("showBranch");
      store.getState().setOption("compactSingleLine", true);
      const expected = {
        ...defaults,
        showModel: false,
        showBranch: false,
        compactSingleLine: true,
      };
      const persisted: unknown = JSON.parse(data.get(key) ?? "null");
      expect(persisted).toEqual(expected);

      vi.resetModules();
      // A fresh module instance hydrates from storage without keeping the previous activity filter.
      const { useSidebarOptionsStore: reloaded } = await import("./sidebarOptionsStore");
      expect(reloaded.getState()).toMatchObject({ ...expected, activityOnly: false });
      reloaded.getState().setActivityOnly(true);
      reloaded.getState().resetSidebarOptions();
      expect(reloaded.getState()).toMatchObject({ ...defaults, activityOnly: false });
      expect(readPersistedSidebarUiOptions(storage)).toEqual(defaults);
    } finally {
      vi.unstubAllGlobals();
      vi.resetModules();
    }
  });

  it("keeps preferences usable when storage is too full to write", async () => {
    vi.stubGlobal("window", {
      localStorage: {
        getItem: () => null,
        setItem: () => {
          throw new DOMException("Storage is full", "QuotaExceededError");
        },
      },
    });
    vi.resetModules();
    try {
      // Load the store only after installing the failing browser storage implementation.
      const { useSidebarOptionsStore: store } = await import("./sidebarOptionsStore");
      store.getState().setGroupBy("status");
      expect(store.getState().groupBy).toBe("status");
      expect(readPersistedSidebarUiOptions().groupBy).toBe("project");
    } finally {
      vi.unstubAllGlobals();
      vi.resetModules();
    }
  });
});
