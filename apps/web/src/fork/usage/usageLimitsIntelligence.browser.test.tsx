import "~/index.css";

import {
  EnvironmentId,
  ProviderDriverKind,
  ProviderInstanceId,
  USAGE_CONTRACT_VERSION,
  UsageDay,
  UsageLimitSourceId,
  type ServerProvider,
  type UsageLimitSourceSnapshot,
  type UsageSummary,
} from "@t3tools/contracts";
import { mergeUsage } from "@t3tools/shared/usageMerge";
import type { Atom } from "effect/reactivity";
import { describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import { render } from "../../../test/render";
import { UsagePage } from "../../components/usage/UsagePage";
import { AppAtomRegistryProvider, appAtomRegistry } from "../../rpc/atomRegistry";
import { environmentPresentations } from "../../state/presentation";
import { useUsage, useUsageComparison, type EnvironmentUsageStatus } from "../../state/usage";
import { USAGE_UI_OPTIONS_STORAGE_KEY, useUsageOptionsStore } from "./usageOptionsStore";

const ENV_ID = EnvironmentId.make("env-local");
// Use a fixed future minute so resolveLimitsNow(nowMinute, refreshTickNow) stays deterministic regardless of wall clock.
const NOW_MINUTE = "2099-06-15T10:00";
const NOW_ISO = `${NOW_MINUTE}:00.000Z`;

const mockNavigate = vi.hoisted(() => vi.fn());

vi.mock("@tanstack/react-router", async (original) => {
  const actual = await original<typeof import("@tanstack/react-router")>();
  return {
    ...actual,
    Link: ({ children, to, ...rest }: Record<string, unknown>) => (
      <a href={String(to ?? "#")} {...rest}>
        {children as never}
      </a>
    ),
    useNavigate: () => mockNavigate,
  };
});

vi.mock("../../hooks/useNowMinute", () => ({
  useNowMinute: () => NOW_MINUTE,
}));

vi.mock("../../state/usage", async (original) => {
  const actual = await original<typeof import("../../state/usage")>();
  return {
    ...actual,
    useUsage: vi.fn(),
    useUsageComparison: vi.fn(),
  };
});

vi.mock("../../state/presentation", async (original) => {
  const { Atom } = await import("effect/reactivity");
  const actual = await original<typeof import("../../state/presentation")>();
  const mockAtom = Atom.make(new Map<EnvironmentId, unknown>());
  return {
    ...actual,
    environmentPresentations: {
      ...actual.environmentPresentations,
      presentationsAtom: mockAtom as never,
      presentationsWithProvidersAtom: mockAtom as never,
    },
  };
});

vi.mock("../../state/use-atom-command", async (original) => ({
  ...(await original<typeof import("../../state/use-atom-command")>()),
  useAtomCommand: (() => vi.fn().mockResolvedValue({ _tag: "Success", value: undefined })) as never,
}));

vi.mock("../../state/server", async (original) => {
  const { Atom } = await import("effect/reactivity");
  const actual = await original<typeof import("../../state/server")>();
  return {
    ...actual,
    primaryServerKeybindingsAtom: Atom.make([]) as never,
  };
});

function makeSummaryWithDays(days: readonly string[]): UsageSummary {
  return {
    contractVersion: USAGE_CONTRACT_VERSION,
    readAt: NOW_ISO,
    timeZone: "UTC",
    sinceDay: UsageDay.make("2099-06-09"),
    untilDay: UsageDay.make("2099-06-15"),
    buckets: days.map((day) => ({
      day: UsageDay.make(day),
      provider: "claude" as const,
      model: "claude-sonnet-4-5",
      totals: {
        uncachedInputTokens: 1_000,
        cachedInputTokens: 500,
        cacheCreationTokens: 0,
        outputTokens: 500,
        reasoningTokens: 0,
      },
      costUsd: 2.5,
      cacheSavingsUsd: 0.5,
      costSource: "modelPriced" as const,
      records: 2,
      unpricedRecords: 0,
      sessions: 1,
    })),
    sources: [
      {
        fingerprint: {
          hostId: "host-local",
          provider: "claude",
          resolvedHomePath: "/home/dev/.claude",
          volumeId: "dev:1",
        },
        status: "ok",
        scannedFiles: 2,
        skippedFiles: 0,
        malformedRecords: 0,
        distinctSessions: days.length,
        message: null,
      },
    ],
    pricing: { status: "fresh", source: "bundled", fetchedAt: NOW_ISO, knownModels: 10 },
    scanDurationMs: 5,
    projects: [],
    topSessions: [],
  };
}

function installUsageMock(
  days: readonly string[],
  envSpecs: readonly { readonly id: EnvironmentId; readonly label: string }[] = [
    { id: ENV_ID, label: "Workstation" },
  ],
) {
  const summary = makeSummaryWithDays(days);
  const allStatuses: EnvironmentUsageStatus[] = envSpecs.map((spec) => ({
    environmentId: spec.id,
    label: spec.label,
    isConnected: true,
    canReadDiagnostics: true,
    summary,
    error: null,
    isPending: false,
    hasFreshModernSummary: true,
    rejectedOversizedHourlyWindow: false,
  }));
  const merged = mergeUsage(
    envSpecs.map((spec) => ({
      environmentId: spec.id,
      label: spec.label,
      summary,
      isConnected: true,
    })),
    USAGE_CONTRACT_VERSION,
  );
  vi.mocked(useUsage).mockImplementation((_input, selectedEnvironmentIds) => {
    const selected =
      selectedEnvironmentIds === null || selectedEnvironmentIds === undefined
        ? allStatuses
        : allStatuses.filter((env) => selectedEnvironmentIds.has(env.environmentId));
    return {
      merged,
      environments: allStatuses,
      selectedEnvironments: selected,
      excludedLegacyEnvironments: [],
      answeredEnvironmentIds: new Set(envSpecs.map((spec) => spec.id)),
      hasEligibleAnswer: true,
      eligibleHasLegacyServer: false,
      detectedLegacyEnvironmentIds: new Set(),
      isStaleScope: false,
      isPending: false,
      shown: {
        merged,
        window: {
          sinceDay: UsageDay.make("2099-06-09"),
          untilDay: UsageDay.make("2099-06-15"),
          timeZone: "UTC",
          resolution: "day",
        },
      },
      isPartial: false,
      refresh: vi.fn().mockResolvedValue(undefined),
    };
  });
  vi.mocked(useUsageComparison).mockReturnValue({
    merged: null,
    isPending: false,
    coarseLegacySuppressed: false,
  });
}

function makeRichProviders(): {
  readonly providers: readonly ServerProvider[];
  readonly sources: readonly UsageLimitSourceSnapshot[];
} {
  // Claude: 5h window 50% elapsed (2.5h remaining), 75% used -> will-exhaust (1.5x pace).
  const claude: ServerProvider = {
    instanceId: ProviderInstanceId.make("claude-work"),
    driver: ProviderDriverKind.make("claudeAgent"),
    displayName: "Claude Work",
    enabled: true,
    installed: true,
    version: "2.0.0",
    status: "ready",
    auth: { status: "authenticated", label: "Max", email: "alice@example.com" },
    checkedAt: NOW_ISO,
    models: [],
    slashCommands: [],
    skills: [],
    usageLimits: {
      checkedAt: NOW_ISO,
      planTier: "Max 20x",
      windows: [
        {
          id: "five_hour",
          kind: "session",
          label: "Session",
          usedPercent: 75,
          resetsAt: "2099-06-15T12:30:00.000Z",
          windowDurationMins: 300,
          usedAmount: 75,
          limitAmount: 100,
          remainingAmount: 25,
          unit: "credits",
          category: "plan",
        },
        {
          id: "seven_day",
          kind: "weekly",
          label: "Weekly",
          usedPercent: 30,
          resetsAt: "2099-06-19T10:00:00.000Z",
          windowDurationMins: 10_080,
        },
      ],
      balances: [
        {
          id: "extra",
          label: "Extra credits",
          remaining: 18.5,
          limit: 50,
          unit: "USD",
          expiresAt: "2099-06-18T10:00:00.000Z",
        },
      ],
    },
  };

  // Codex: legacy-like minimal window (no new optional fields) with 76% used (triggers only when threshold drops to 70%).
  const codex: ServerProvider = {
    instanceId: ProviderInstanceId.make("codex-personal"),
    driver: ProviderDriverKind.make("codex"),
    displayName: "Codex Personal",
    enabled: true,
    installed: true,
    version: "0.99.0",
    status: "ready",
    auth: { status: "authenticated", label: "Plus" },
    checkedAt: NOW_ISO,
    models: [],
    slashCommands: [],
    skills: [],
    usageLimits: {
      checkedAt: NOW_ISO,
      windows: [
        {
          id: "primary",
          kind: "session",
          label: "Session",
          usedPercent: 76,
          resetsAt: "2099-06-15T14:00:00.000Z",
        },
      ],
      resetCredits: {
        availableCount: 1,
        nextExpiresAt: "2099-06-17T10:00:00.000Z",
      },
    },
  };

  // Upstream PR #15 HTTP quota source with high usage window (92% used -> critical alert).
  const httpSource: UsageLimitSourceSnapshot = {
    id: UsageLimitSourceId.make("gateway-http"),
    kind: "http",
    label: "Team Gateway",
    checkedAt: NOW_ISO,
    accounts: [],
    quotaAccounts: [
      {
        id: "shared-pool",
        label: "Shared Pool",
        windows: [
          {
            id: "daily",
            kind: "other",
            label: "Daily cap",
            usedPercent: 92,
            resetsAt: "2099-06-16T00:00:00.000Z",
          },
        ],
      },
    ],
  };

  return { providers: [claude, codex], sources: [httpSource] };
}

function setPresentations(
  providers: readonly ServerProvider[],
  usageLimitSources: readonly UsageLimitSourceSnapshot[] = [],
) {
  const entry = {
    entry: { target: { label: "Workstation" } },
    connection: { phase: "connected" },
    serverConfig: {
      providers: [...providers],
      usageLimitSources: [...usageLimitSources],
      environment: { capabilities: { usagePriceOverrides: true, usageModelAliases: true } },
    },
  };
  appAtomRegistry.set(
    environmentPresentations.presentationsAtom as unknown as Atom.Writable<
      Map<EnvironmentId, unknown>
    >,
    new Map([[ENV_ID, entry]]),
  );
}

function setupFixture(days: readonly string[] = ["2099-06-13", "2099-06-14", "2099-06-15"]) {
  vi.clearAllMocks();
  window.localStorage.removeItem(USAGE_UI_OPTIONS_STORAGE_KEY);
  useUsageOptionsStore.getState().resetUsageUiOptions();
  useUsageOptionsStore.setState({ manualSubscriptionOverrides: {} });
  const { providers, sources } = makeRichProviders();
  setPresentations(providers, sources);
  installUsageMock(days);
}

describe("Usage Limits Intelligence four-lens UI & Overview streak", () => {
  it("renders Overview activity streak and fast-burn quota strip indicator, and syncs Left/Used, Exact, and Topbar options", async () => {
    setupFixture();
    await using _screen = await render(
      <AppAtomRegistryProvider>
        <UsagePage />
      </AppAtomRegistryProvider>,
    );

    await expect.element(page.getByTestId("usage-kpi-streak")).toHaveTextContent("3d streak");
    await expect.element(page.getByTestId("usage-quota-strip-burn-icon")).toBeVisible();
    const firstStripChip = page.getByTestId("usage-quota-strip-chip").first();
    await expect.element(firstStripChip.getByText("25%")).toBeVisible();

    // Switch to Limits view.
    await userEvent.click(page.getByTestId("usage-view-limits"));
    await expect.element(page.getByTestId("usage-limits-enhanced")).toBeVisible();

    // Default Pool view displays remaining % ("left"); switch to Used mode.
    const firstWindowCard = page.getByTestId("usage-limit-window-card").first();
    await expect.element(firstWindowCard.getByText("25%", { exact: true }).first()).toBeVisible();
    await expect.element(firstWindowCard.getByText("left", { exact: true })).toBeVisible();
    await userEvent.click(page.getByTestId("usage-quota-mode-used"));
    await expect.element(firstWindowCard.getByText("75%", { exact: true }).first()).toBeVisible();
    await expect.element(firstWindowCard.getByText("used", { exact: true })).toBeVisible();

    // Switch to Matrix layout inside Pools: displays burn pace badge, balances, and HTTP quota source.
    await userEvent.click(page.getByTestId("usage-limits-layout-matrix"));
    await expect.element(page.getByTestId("usage-limits-matrix")).toBeVisible();
    await expect.element(page.getByText("Claude Work")).toBeVisible();
    await expect.element(page.getByText("Shared Pool")).toBeVisible();
    await expect.element(page.getByText("75 credits / 100 credits")).toBeVisible();
    await expect.element(page.getByTestId("usage-matrix-balance-pill")).toBeVisible();
    await expect
      .element(page.getByTestId("usage-matrix-pace-badge").first())
      .toHaveAttribute("data-pace", "will-exhaust");

    // Toggle Exact reset format and confirm matrix reset text actually switches from countdown to a formatted clock time.
    const firstMatrixReset = page.getByTestId("usage-matrix-window-reset").first();
    await expect.element(firstMatrixReset).toHaveTextContent("resets in 2h 30m");
    await userEvent.click(page.getByTestId("usage-reset-mode-exact"));
    await expect.element(firstMatrixReset).not.toHaveTextContent("resets in 2h 30m");
    await expect.element(firstMatrixReset.getByText(/Resets /)).toBeVisible();

    // Returning to Overview reflects Used % and Exact reset format on the Quota Strip too.
    await userEvent.click(page.getByTestId("usage-view-overview"));
    await expect.element(firstStripChip.getByText("75%")).toBeVisible();
    await expect.element(firstStripChip).not.toHaveTextContent("↻ 2h 30m");

    // Sync via Topbar display options menu (Used -> Left, alert threshold 80% -> 70%).
    await userEvent.click(page.getByTestId("usage-view-limits"));
    await userEvent.click(page.getByTestId("usage-options-trigger"));
    await userEvent.click(page.getByTestId("usage-options-used-mode"));
    await userEvent.click(page.getByTestId("usage-options-threshold-70"));
    await userEvent.keyboard("{Escape}");
    await expect
      .element(page.getByTestId("usage-matrix-window-percent").first())
      .toHaveTextContent("25% left");
    expect(useUsageOptionsStore.getState().alertThresholdPercent).toBe(70);
  });

  it("navigates Resets, Alerts (with threshold updates), and Expiries (with manual override round-trip)", async () => {
    setupFixture();
    useUsageOptionsStore.getState().setView("limits");

    await using _screen = await render(
      <AppAtomRegistryProvider>
        <UsagePage />
      </AppAtomRegistryProvider>,
    );

    // 1. Resets lens groups upcoming windows including HTTP quota account.
    await userEvent.click(page.getByTestId("usage-limits-lens-resets"));
    await expect.element(page.getByTestId("usage-limits-resets")).toBeVisible();
    await expect.element(page.getByTestId("usage-resets-group-next24h")).toBeVisible();
    await expect.element(page.getByTestId("usage-resets-group-next7d")).toBeVisible();
    await expect.element(page.getByText("Shared Pool")).toBeVisible();

    // 2. Alerts lens reflects severity ranking and responds immediately to threshold toggle (80% -> 70%).
    await userEvent.click(page.getByTestId("usage-limits-lens-alerts"));
    await expect.element(page.getByTestId("usage-limits-alerts")).toBeVisible();
    await expect
      .element(page.getByText(/Codex Personal · Session running low/))
      .not.toBeInTheDocument();

    await userEvent.click(page.getByTestId("usage-alert-threshold-70"));
    await expect.element(page.getByText(/Codex Personal · Session running low/)).toBeVisible();

    // 3. Expiries lens shows credit & balance expiries and lets user record & clear a manual renewal.
    await userEvent.click(page.getByTestId("usage-limits-lens-expiries"));
    await expect.element(page.getByTestId("usage-limits-expiries")).toBeVisible();
    await expect.element(page.getByTestId("usage-no-expiry-account-row").first()).toBeVisible();

    await userEvent.click(page.getByTestId("usage-set-expiry-btn").first());
    const dialog = page.getByTestId("usage-subscription-override-dialog");
    await expect.element(dialog).toBeVisible();

    await userEvent.fill(page.getByLabelText("Renewal / expiry date"), "2099-07-15");
    await userEvent.fill(page.getByLabelText("Monthly cost"), "200");
    await userEvent.fill(page.getByLabelText("Plan label override"), "Max Custom");
    await userEvent.click(page.getByTestId("usage-override-save"));

    await expect.element(dialog).not.toBeInTheDocument();
    const monthlySpendCard = page.getByTestId("usage-expiries-monthly-spend");
    await expect.element(monthlySpendCard.getByText("$200.00/mo")).toBeVisible();
    const manualExpiryRow = page
      .getByTestId("usage-expiry-row")
      .filter({ hasText: "Manual" })
      .first();
    await expect.element(manualExpiryRow).toBeVisible();
    await expect.element(manualExpiryRow.getByText("Jul 15, 2099")).toBeVisible();

    // Editing an existing override updates monthly cost without losing the saved expiry;
    // when a stored override carries a full ISO timestamp, editing only cost preserves it verbatim.
    const savedKey = Object.keys(useUsageOptionsStore.getState().manualSubscriptionOverrides)[0]!;
    useUsageOptionsStore.getState().setManualSubscriptionOverride(savedKey, {
      expiresAt: "2099-07-15T18:30:00.000Z",
      monthlyCost: 200,
      currency: "USD",
      planLabel: "Max Custom",
    });
    await userEvent.click(page.getByTestId("usage-expiry-edit-btn").first());
    await userEvent.clear(page.getByLabelText("Monthly cost"));
    await userEvent.fill(page.getByLabelText("Monthly cost"), "250");
    await userEvent.click(page.getByTestId("usage-override-save"));
    await expect.element(monthlySpendCard.getByText("$250.00/mo")).toBeVisible();
    expect(useUsageOptionsStore.getState().manualSubscriptionOverrides[savedKey]?.expiresAt).toBe(
      "2099-07-15T18:30:00.000Z",
    );

    // Resetting display defaults from Topbar must never wipe manual renewals.
    await userEvent.click(page.getByTestId("usage-options-trigger"));
    await userEvent.click(page.getByTestId("usage-options-reset"));
    await userEvent.keyboard("{Escape}");
    await userEvent.click(page.getByTestId("usage-view-limits"));
    await userEvent.click(page.getByTestId("usage-limits-lens-expiries"));
    await expect.element(monthlySpendCard.getByText("$250.00/mo")).toBeVisible();

    // Reopen and clear the manual override explicitly.
    await userEvent.click(page.getByTestId("usage-expiry-edit-btn").first());
    await expect.element(page.getByTestId("usage-override-clear")).toBeVisible();
    await userEvent.click(page.getByTestId("usage-override-clear"));
    await expect.element(monthlySpendCard.getByText("-", { exact: true })).toBeVisible();
  });

  it("filters bound HTTP quota accounts with their provider and falls back to Unscheduled on invalid Exact timestamps", async () => {
    setupFixture();
    const { providers } = makeRichProviders();
    const codex = providers[1]!;
    const httpMixed: UsageLimitSourceSnapshot = {
      id: UsageLimitSourceId.make("mixed-http"),
      kind: "http",
      label: "Mixed Gateway",
      checkedAt: NOW_ISO,
      accounts: [],
      quotaAccounts: [
        {
          id: "bound-codex",
          label: "Bound Codex HTTP",
          providerInstanceId: codex.instanceId,
          windows: [
            {
              id: "daily",
              kind: "other",
              label: "Daily cap",
              usedPercent: 45,
              resetsAt: "2099-06-16T00:00:00.000Z",
            },
          ],
        },
        {
          id: "unbound-team",
          label: "Unbound Team HTTP",
          windows: [
            {
              id: "invalid-reset",
              kind: "other",
              label: "Rolling cap",
              usedPercent: 30,
              resetsAt: "not-a-timestamp",
            },
          ],
        },
      ],
    };
    setPresentations(providers, [httpMixed]);
    useUsageOptionsStore.getState().setView("limits");
    useUsageOptionsStore.getState().setHiddenProviders(["codex"]);

    await using _screen = await render(
      <AppAtomRegistryProvider>
        <UsagePage />
      </AppAtomRegistryProvider>,
    );

    // Pool layout hides the Codex-bound HTTP quota while keeping the unbound HTTP source.
    await expect.element(page.getByText("Unbound Team HTTP")).toBeVisible();
    await expect.element(page.getByText("Bound Codex HTTP")).not.toBeInTheDocument();

    // Matrix layout matches the exact same bound-HTTP projection.
    await userEvent.click(page.getByTestId("usage-limits-layout-matrix"));
    await expect.element(page.getByText("Unbound Team HTTP")).toBeVisible();
    await expect.element(page.getByText("Bound Codex HTTP")).not.toBeInTheDocument();

    // Resets under Exact mode normalizes invalid timestamps to Unscheduled rather than blank.
    await userEvent.click(page.getByTestId("usage-limits-lens-resets"));
    await userEvent.click(page.getByTestId("usage-reset-mode-exact"));
    const unscheduledGroup = page.getByTestId("usage-resets-group-unscheduled");
    await expect.element(unscheduledGroup).toBeVisible();
    await expect.element(unscheduledGroup.getByText("Unscheduled")).toBeVisible();
  });

  it("degrades gracefully in Matrix view for legacy server payloads lacking optional fields", async () => {
    vi.clearAllMocks();
    window.localStorage.removeItem(USAGE_UI_OPTIONS_STORAGE_KEY);
    useUsageOptionsStore.getState().resetUsageUiOptions();
    useUsageOptionsStore.getState().setView("limits");
    useUsageOptionsStore.getState().setLimitsLayout("matrix");
    const legacyCodex: ServerProvider = {
      instanceId: ProviderInstanceId.make("codex-legacy"),
      driver: ProviderDriverKind.make("codex"),
      displayName: "Codex Legacy",
      enabled: true,
      installed: true,
      version: "0.50.0",
      status: "ready",
      auth: { status: "authenticated" },
      checkedAt: NOW_ISO,
      models: [],
      slashCommands: [],
      skills: [],
      usageLimits: {
        checkedAt: NOW_ISO,
        windows: [
          {
            id: "primary",
            kind: "session",
            label: "Session",
            usedPercent: 40,
          },
        ],
      },
    };
    setPresentations([legacyCodex], []);
    installUsageMock(["2099-06-15"]);

    await using _screen = await render(
      <AppAtomRegistryProvider>
        <UsagePage />
      </AppAtomRegistryProvider>,
    );

    await expect.element(page.getByText("Codex Legacy")).toBeVisible();
    await expect
      .element(page.getByTestId("usage-matrix-window-percent"))
      .toHaveTextContent("60% left");
    await expect.element(page.getByTestId("usage-matrix-pace-badge")).not.toBeInTheDocument();
    await expect.element(page.getByTestId("usage-matrix-balance-pill")).not.toBeInTheDocument();
  });

  it("marks streak with plus suffix when consecutive days reach the window start", async () => {
    setupFixture([
      "2099-06-09",
      "2099-06-10",
      "2099-06-11",
      "2099-06-12",
      "2099-06-13",
      "2099-06-14",
      "2099-06-15",
    ]);

    await using _screen = await render(
      <AppAtomRegistryProvider>
        <UsagePage />
      </AppAtomRegistryProvider>,
    );

    await expect.element(page.getByTestId("usage-kpi-streak")).toHaveTextContent("7+d streak");
  });

  it("retains manual renewal overrides when filtering environments down to a workspace-less hub route", async () => {
    vi.clearAllMocks();
    window.localStorage.removeItem(USAGE_UI_OPTIONS_STORAGE_KEY);
    useUsageOptionsStore.getState().resetUsageUiOptions();
    useUsageOptionsStore.setState({ manualSubscriptionOverrides: {} });
    useUsageOptionsStore.getState().setView("limits");
    useUsageOptionsStore.getState().setLimitsLens("expiries");

    const hubEnvId = EnvironmentId.make("env-hub");
    const desktopCodex: ServerProvider = {
      instanceId: ProviderInstanceId.make("codex-org"),
      driver: ProviderDriverKind.make("codex"),
      displayName: "Codex Org",
      enabled: true,
      installed: true,
      version: "0.99.0",
      status: "ready",
      auth: { status: "authenticated", email: "shared@example.com", workspaceId: "org" },
      checkedAt: NOW_ISO,
      models: [],
      slashCommands: [],
      skills: [],
      usageLimits: {
        checkedAt: NOW_ISO,
        windows: [{ id: "primary", kind: "session", label: "Session", usedPercent: 25 }],
      },
    };
    const hubSource: UsageLimitSourceSnapshot = {
      id: UsageLimitSourceId.make("cli-hub"),
      kind: "cliproxy",
      label: "Team Hub",
      checkedAt: NOW_ISO,
      accounts: [
        {
          id: "shared.json",
          driver: ProviderDriverKind.make("codex"),
          email: "shared@example.com",
          usageLimits: {
            checkedAt: NOW_ISO,
            windows: [{ id: "primary", kind: "session", label: "Session", usedPercent: 25 }],
          },
        },
      ],
    };
    appAtomRegistry.set(
      environmentPresentations.presentationsAtom as unknown as Atom.Writable<
        Map<EnvironmentId, unknown>
      >,
      new Map([
        [
          ENV_ID,
          {
            entry: { target: { label: "Workstation" } },
            connection: { phase: "connected" },
            serverConfig: {
              providers: [desktopCodex],
              usageLimitSources: [],
              environment: { capabilities: { usagePriceOverrides: true, usageModelAliases: true } },
            },
          },
        ],
        [
          hubEnvId,
          {
            entry: { target: { label: "Hub Server" } },
            connection: { phase: "connected" },
            serverConfig: {
              providers: [],
              usageLimitSources: [hubSource],
              environment: { capabilities: { usagePriceOverrides: true, usageModelAliases: true } },
            },
          },
        ],
      ]),
    );
    installUsageMock(
      ["2099-06-15"],
      [
        { id: ENV_ID, label: "Workstation" },
        { id: hubEnvId, label: "Hub Server" },
      ],
    );

    await using _screen = await render(
      <AppAtomRegistryProvider>
        <UsagePage />
      </AppAtomRegistryProvider>,
    );

    // Save a renewal while both environments are active.
    await userEvent.click(page.getByTestId("usage-set-expiry-btn").first());
    await userEvent.fill(page.getByLabelText("Renewal / expiry date"), "2099-08-15");
    await userEvent.fill(page.getByLabelText("Monthly cost"), "40");
    await userEvent.click(page.getByTestId("usage-override-save"));

    const monthlySpendCard = page.getByTestId("usage-expiries-monthly-spend");
    await expect.element(monthlySpendCard.getByText("$40.00/mo")).toBeVisible();
    await expect
      .element(page.getByTestId("usage-expiry-row").getByText("Aug 15, 2099"))
      .toBeVisible();

    // Narrow the environment picker to ONLY the workspace-less Hub Server.
    await userEvent.click(page.getByRole("button", { name: "All environments" }));
    await userEvent.click(page.getByRole("menuitemcheckbox", { name: /Workstation/ }));
    await userEvent.keyboard("{Escape}");

    // The environment picker reflects Hub Server only, while renewal and spend remain attached via canonical fleet identity.
    await expect.element(page.getByRole("button", { name: "Hub Server" })).toBeVisible();
    await expect.element(monthlySpendCard.getByText("$40.00/mo")).toBeVisible();
    await expect
      .element(page.getByTestId("usage-expiry-row").getByText("Aug 15, 2099"))
      .toBeVisible();
  });

  it("renders OpenRouter, GitHub Copilot, Ollama Cloud, and balance-only OpenAI API sources in Matrix view", async () => {
    vi.clearAllMocks();
    window.localStorage.removeItem(USAGE_UI_OPTIONS_STORAGE_KEY);
    useUsageOptionsStore.getState().resetUsageUiOptions();
    useUsageOptionsStore.setState({ manualSubscriptionOverrides: {} });
    useUsageOptionsStore.getState().setView("limits");
    useUsageOptionsStore.getState().setLimitsLens("pools");
    useUsageOptionsStore.getState().setLimitsLayout("matrix");

    const externalSources: UsageLimitSourceSnapshot[] = [
      {
        id: UsageLimitSourceId.make("openrouter-1"),
        kind: "openrouter",
        label: "OpenRouter",
        checkedAt: NOW_ISO,
        accounts: [],
        quotaAccounts: [
          {
            id: "openrouter",
            label: "OpenRouter Work",
            planTier: "Pay as you go",
            windows: [
              {
                id: "credits",
                kind: "other",
                label: "Credits",
                usedPercent: 30,
                usedAmount: 15,
                limitAmount: 50,
                remainingAmount: 35,
                unit: "USD",
                category: "balance",
              },
            ],
            balances: [{ id: "balance", label: "Balance", remaining: 35, unit: "USD" }],
          },
        ],
      },
      {
        id: UsageLimitSourceId.make("copilot-1"),
        kind: "copilot",
        label: "GitHub Copilot",
        checkedAt: NOW_ISO,
        accounts: [],
        quotaAccounts: [
          {
            id: "copilot",
            label: "Copilot Pro",
            planTier: "Pro",
            windows: [
              {
                id: "premium_interactions",
                kind: "monthly",
                label: "Credits",
                usedPercent: 20,
                usedAmount: 60,
                limitAmount: 300,
                remainingAmount: 240,
                unit: "credits",
                resetsAt: "2099-07-01",
              },
            ],
          },
        ],
      },
      {
        id: UsageLimitSourceId.make("ollama-default"),
        kind: "ollama",
        label: "Ollama Cloud",
        checkedAt: NOW_ISO,
        accounts: [],
        quotaAccounts: [
          {
            id: "ollama",
            label: "Ollama Cloud",
            planTier: "Pro",
            windows: [
              {
                id: "monthly",
                kind: "monthly",
                label: "Monthly",
                usedPercent: 40,
                usedAmount: 8,
                limitAmount: 20,
                remainingAmount: 12,
                unit: "USD",
              },
            ],
          },
        ],
      },
      {
        id: UsageLimitSourceId.make("openaiApi-1"),
        kind: "openaiApi",
        label: "OpenAI API",
        checkedAt: NOW_ISO,
        accounts: [],
        quotaAccounts: [
          {
            id: "openai-api",
            label: "OpenAI Org",
            windows: [],
            balances: [
              { id: "today", label: "Today", remaining: 4.5, unit: "USD", kind: "spend" },
              {
                id: "30-day-spend",
                label: "30-Day Spend",
                remaining: 92.25,
                unit: "USD",
                kind: "spend",
              },
            ],
          },
        ],
      },
    ];
    setPresentations([], externalSources);
    installUsageMock(["2099-06-15"]);

    await using _screen = await render(
      <AppAtomRegistryProvider>
        <UsagePage />
      </AppAtomRegistryProvider>,
    );

    await expect.element(page.getByText("OpenRouter Work")).toBeVisible();
    await expect.element(page.getByText("Copilot Pro")).toBeVisible();
    await expect.element(page.getByText("Ollama Cloud").first()).toBeVisible();
    await expect.element(page.getByText("OpenAI Org")).toBeVisible();
    await expect.element(page.getByText("GitHub Copilot").first()).toBeVisible();
    await expect.element(page.getByText("OpenAI API").first()).toBeVisible();
    await expect.element(page.getByText("$92.25")).toBeVisible();
    await expect.element(page.getByTestId("usage-source-icon-copilot")).toBeVisible();

    // Switch to Exact reset mode and verify Copilot's bare YYYY-MM-DD date renders as its UTC calendar date.
    await userEvent.click(page.getByTestId("usage-reset-mode-exact"));
    await expect.element(page.getByText(/Resets Jul 1, 2099/)).toBeVisible();

    await userEvent.click(page.getByTestId("usage-limits-lens-resets"));
    await expect.element(page.getByText("Jul 1, 2099")).toBeVisible();
  });

  it("renders Pools view without crashing on an invalid bare reset date alongside a valid Copilot date", async () => {
    vi.clearAllMocks();
    window.localStorage.removeItem(USAGE_UI_OPTIONS_STORAGE_KEY);
    useUsageOptionsStore.getState().resetUsageUiOptions();
    useUsageOptionsStore.setState({ manualSubscriptionOverrides: {} });
    useUsageOptionsStore.getState().setView("limits");
    useUsageOptionsStore.getState().setLimitsLens("pools");
    useUsageOptionsStore.getState().setLimitsLayout("pool");

    const sources: UsageLimitSourceSnapshot[] = [
      {
        id: UsageLimitSourceId.make("http-bad-date"),
        kind: "http",
        label: "Malformed Date Gateway",
        checkedAt: NOW_ISO,
        accounts: [],
        quotaAccounts: [
          {
            id: "bad-http",
            label: "Bad Date Pool",
            windows: [
              {
                id: "broken",
                kind: "monthly",
                label: "Broken Window",
                usedPercent: 40,
                resetsAt: "2099-13-45",
              },
              {
                id: "rollover",
                kind: "monthly",
                label: "Rollover Window",
                usedPercent: 30,
                resetsAt: "2099-06-31",
              },
            ],
          },
        ],
      },
      {
        id: UsageLimitSourceId.make("copilot-valid-date"),
        kind: "copilot",
        label: "GitHub Copilot",
        checkedAt: NOW_ISO,
        accounts: [],
        quotaAccounts: [
          {
            id: "copilot",
            label: "Copilot Valid",
            windows: [
              {
                id: "premium_interactions",
                kind: "monthly",
                label: "Credits",
                usedPercent: 20,
                resetsAt: "2099-07-01",
              },
            ],
          },
        ],
      },
    ];
    setPresentations([], sources);
    installUsageMock(["2099-06-15"]);

    await using _screen = await render(
      <AppAtomRegistryProvider>
        <UsagePage />
      </AppAtomRegistryProvider>,
    );

    // Countdown mode must neither crash on 2099-13-45 nor roll 2099-06-31 into a fake countdown.
    await expect.element(page.getByText("Bad Date Pool")).toBeVisible();
    await expect.element(page.getByText("Broken Window")).toBeVisible();
    await expect.element(page.getByText("Rollover Window")).toBeVisible();
    await expect.element(page.getByText("Copilot Valid")).toBeVisible();
    await expect.element(page.getByText("70% left", { exact: true })).toBeVisible();

    // Exact mode must omit both invalid dates (no countdown fallback) and display Copilot's valid UTC date cleanly.
    await userEvent.click(page.getByTestId("usage-reset-mode-exact"));
    await expect.element(page.getByText("Bad Date Pool")).toBeVisible();
    await expect.element(page.getByText("70% left", { exact: true })).toBeVisible();
    await expect.element(page.getByText(/Jul 1, 2099/)).toBeVisible();
    await expect.element(page.getByText(/2099-13-45/)).not.toBeInTheDocument();
    await expect.element(page.getByText(/2099-06-31/)).not.toBeInTheDocument();

    // Normalized Resets lens must classify 2099-06-31 as Unscheduled instead of rolling to Jul 1.
    await userEvent.click(page.getByTestId("usage-limits-lens-resets"));
    const unscheduled = page.getByTestId("usage-resets-group-unscheduled");
    await expect.element(unscheduled).toBeVisible();
    await expect.element(unscheduled.getByText(/Rollover Window/)).toBeVisible();
  });
});
