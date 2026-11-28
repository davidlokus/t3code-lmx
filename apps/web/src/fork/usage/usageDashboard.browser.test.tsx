import "~/index.css";

import {
  EnvironmentId,
  ProviderDriverKind,
  ProviderInstanceId,
  USAGE_CONTRACT_VERSION,
  UsageDay,
  type ServerProvider,
  type UsageSummary,
  type UsageSummaryInput,
} from "@t3tools/contracts";
import { mergeUsage } from "@t3tools/shared/usageMerge";
import type { Atom } from "effect/reactivity";
import { describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import { render } from "../../../test/render";
import { UsagePage } from "../../components/usage/UsagePage";
import { AppAtomRegistryProvider, appAtomRegistry } from "../../rpc/atomRegistry";
import { environmentPresentations } from "../../state/presentation";
import {
  filterUsageEnvironmentsForScope,
  useUsage,
  useUsageComparison,
  type EnvironmentUsageStatus,
} from "../../state/usage";
import { USAGE_UI_OPTIONS_STORAGE_KEY, useUsageOptionsStore } from "./usageOptionsStore";

const ENV_ID = EnvironmentId.make("env-local");
const NOW_MINUTE = "2026-11-24T10:00";
const NOW_MS = Date.parse(`${NOW_MINUTE}:00Z`);

const mockNavigate = vi.hoisted(() => vi.fn());

vi.mock("@tanstack/react-router", async (original) => {
  const actual = await original<typeof import("@tanstack/react-router")>();
  return {
    ...actual,
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
  const makeRule = (key: string, command: "usage.cost" | "usage.tokens" | "usage.limits") => ({
    command,
    shortcut: {
      key,
      metaKey: false,
      ctrlKey: false,
      shiftKey: false,
      altKey: false,
      modKey: false,
    },
    whenAst: { type: "identifier", name: "usagePageOpen" },
  });
  return {
    ...actual,
    primaryServerKeybindingsAtom: Atom.make([
      makeRule("c", "usage.cost"),
      makeRule("t", "usage.tokens"),
      makeRule("l", "usage.limits"),
    ]) as never,
  };
});

function makeProviderWithLimits(
  instanceId: string,
  driver: "claudeAgent" | "codex",
  displayName: string,
  plan: string,
  windows: ReadonlyArray<{
    readonly id: string;
    readonly kind: "session" | "weekly";
    readonly label: string;
    readonly usedPercent: number;
    readonly resetsAt: string;
    readonly windowMinutes: number;
  }>,
): ServerProvider {
  const checkedAt = new Date(NOW_MS).toISOString();
  return {
    instanceId: ProviderInstanceId.make(instanceId),
    driver: ProviderDriverKind.make(driver),
    displayName,
    enabled: true,
    installed: true,
    version: "1.0.0",
    status: "ready",
    auth: { status: "authenticated", label: plan },
    checkedAt,
    models: [],
    slashCommands: [],
    skills: [],
    usageLimits: {
      checkedAt,
      windows: [...windows],
    },
  };
}

function setPresentations(providers: readonly ServerProvider[]) {
  const entry = {
    entry: { target: { label: "Workstation" } },
    connection: { phase: "connected" },
    serverConfig: {
      providers: [...providers],
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

function makeRichSummary(options?: {
  readonly legacy?: boolean;
  readonly costMultiplier?: number;
}): UsageSummary {
  const scale = options?.costMultiplier ?? 1;
  const legacy = options?.legacy ?? false;
  return {
    contractVersion: USAGE_CONTRACT_VERSION,
    readAt: new Date(NOW_MS).toISOString(),
    scanDurationMs: 12,
    sinceDay: UsageDay.make("2026-11-20"),
    untilDay: UsageDay.make("2026-11-24"),
    timeZone: "UTC",
    buckets: [
      {
        day: UsageDay.make("2026-11-24"),
        provider: "claude",
        model: "claude-opus-4-6",
        totals: {
          uncachedInputTokens: 100_000,
          cachedInputTokens: 900_000,
          cacheCreationTokens: 0,
          outputTokens: 50_000,
          reasoningTokens: 20_000,
        },
        costUsd: 6 * scale,
        providerReportedCostUsd: 6 * scale,
        cacheSavingsUsd: 12 * scale,
        categoryCostUsd: {
          input: 1.5 * scale,
          cacheRead: 1.5 * scale,
          cacheWrite: 0,
          output: 3 * scale,
        },
        costSource: "providerReported",
        records: 10,
        unpricedRecords: 0,
        unpricedTokens: 0,
        sessions: 2,
      },
      {
        day: UsageDay.make("2026-11-23"),
        provider: "codex",
        model: "gpt-5.4",
        totals: {
          uncachedInputTokens: 200_000,
          cachedInputTokens: 200_000,
          cacheCreationTokens: 0,
          outputTokens: 100_000,
          reasoningTokens: 40_000,
        },
        costUsd: 6 * scale,
        providerReportedCostUsd: 0,
        cacheSavingsUsd: 2 * scale,
        categoryCostUsd: {
          input: 2 * scale,
          cacheRead: 0.5 * scale,
          cacheWrite: 0,
          output: 3.5 * scale,
        },
        costSource: "modelPriced",
        records: 10,
        unpricedRecords: 0,
        unpricedTokens: 0,
        sessions: 2,
      },
      {
        day: UsageDay.make("2026-11-24"),
        provider: "omp",
        model: "custom-unpriced-v1",
        totals: {
          uncachedInputTokens: 50_000,
          cachedInputTokens: 0,
          cacheCreationTokens: 0,
          outputTokens: 10_000,
          reasoningTokens: 0,
        },
        costUsd: 0,
        providerReportedCostUsd: 0,
        cacheSavingsUsd: 0,
        costSource: "unpriced",
        records: 2,
        unpricedRecords: 2,
        unpricedTokens: 60_000,
        sessions: 1,
      },
    ],
    sources: [
      {
        fingerprint: {
          hostId: "host-1",
          provider: "claude",
          resolvedHomePath: "/Users/dev/.claude",
          volumeId: "vol-1",
        },
        status: "ok",
        scannedFiles: 2,
        skippedFiles: 0,
        malformedRecords: 0,
        distinctSessions: 2,
        message: null,
      },
      {
        fingerprint: {
          hostId: "host-1",
          provider: "codex",
          resolvedHomePath: "/Users/dev/.codex",
          volumeId: "vol-1",
        },
        status: "ok",
        scannedFiles: 2,
        skippedFiles: 0,
        malformedRecords: 0,
        distinctSessions: 2,
        message: null,
      },
      {
        fingerprint: {
          hostId: "host-1",
          provider: "omp",
          resolvedHomePath: "/Users/dev/.omp",
          volumeId: "vol-1",
        },
        status: "ok",
        scannedFiles: 1,
        skippedFiles: 0,
        malformedRecords: 0,
        distinctSessions: 1,
        message: null,
      },
    ],
    pricing: {
      status: "fresh",
      source: "litellm",
      fetchedAt: new Date(NOW_MS).toISOString(),
      knownModels: 120,
    },
    ...(legacy
      ? {}
      : {
          projects: [
            {
              projectKey: "t3:proj-alpha",
              label: "Alpha App",
              workspaceRoot: "/Users/dev/alpha",
              t3ProjectId: "proj-alpha",
              worktreeCount: 2,
              provider: "claude",
              totals: {
                uncachedInputTokens: 100_000,
                cachedInputTokens: 900_000,
                cacheCreationTokens: 0,
                outputTokens: 50_000,
                reasoningTokens: 20_000,
              },
              costUsd: 6 * scale,
              providerReportedCostUsd: 6 * scale,
              cacheSavingsUsd: 12 * scale,
              records: 10,
              unpricedRecords: 0,
              sessions: 2,
              topModels: [
                {
                  model: "claude-opus-4-6",
                  costUsd: 6 * scale,
                  totalTokens: 1_050_000,
                },
              ],
            },
            {
              projectKey: "path:/Users/dev/beta",
              label: "beta-cli",
              workspaceRoot: "/Users/dev/beta",
              worktreeCount: 0,
              provider: "codex",
              totals: {
                uncachedInputTokens: 200_000,
                cachedInputTokens: 200_000,
                cacheCreationTokens: 0,
                outputTokens: 100_000,
                reasoningTokens: 40_000,
              },
              costUsd: 6 * scale,
              providerReportedCostUsd: 0,
              cacheSavingsUsd: 2 * scale,
              records: 10,
              unpricedRecords: 0,
              sessions: 2,
              topModels: [
                {
                  model: "gpt-5.4",
                  costUsd: 6 * scale,
                  totalTokens: 500_000,
                },
              ],
            },
          ],
          topSessions: [
            {
              sessionId: "sess-t3-linked",
              provider: "claude",
              title: "Refactor Usage Dashboard",
              t3ThreadId: "thread-42",
              t3ProjectId: "proj-alpha",
              projectKey: "t3:proj-alpha",
              projectLabel: "Alpha App",
              cwd: "/Users/dev/alpha",
              primaryModel: "claude-opus-4-6",
              models: ["claude-opus-4-6"],
              totals: {
                uncachedInputTokens: 100_000,
                cachedInputTokens: 900_000,
                cacheCreationTokens: 0,
                outputTokens: 50_000,
                reasoningTokens: 20_000,
              },
              costUsd: 6 * scale,
              providerReportedCostUsd: 6 * scale,
              records: 10,
              unpricedRecords: 0,
              firstTimestampMs: NOW_MS - 3_600_000,
              lastTimestampMs: NOW_MS - 60_000,
            },
            {
              sessionId: "sess-external-cli-123456",
              provider: "codex",
              title: "Standalone CLI Fix",
              projectKey: "path:/Users/dev/beta",
              projectLabel: "beta-cli",
              cwd: "/Users/dev/beta",
              primaryModel: "gpt-5.4",
              models: ["gpt-5.4"],
              totals: {
                uncachedInputTokens: 200_000,
                cachedInputTokens: 200_000,
                cacheCreationTokens: 0,
                outputTokens: 100_000,
                reasoningTokens: 40_000,
              },
              costUsd: 6 * scale,
              providerReportedCostUsd: 0,
              records: 10,
              unpricedRecords: 0,
              firstTimestampMs: NOW_MS - 7_200_000,
              lastTimestampMs: NOW_MS - 120_000,
            },
          ],
        }),
  };
}

function wireUsageMocks(options?: {
  readonly summary?: UsageSummary;
  readonly previousSummary?: UsageSummary | null;
}) {
  const currentSummary = options?.summary ?? makeRichSummary();
  const previousSummary =
    options && "previousSummary" in options
      ? options.previousSummary
      : makeRichSummary({ costMultiplier: 0.8 });

  const envStatus = (summary: UsageSummary): EnvironmentUsageStatus => ({
    environmentId: ENV_ID,
    label: "Workstation",
    isPending: false,
    canReadDiagnostics: true,
    accessRequests: [],
    isConnected: true,
    error: null,
    summary,
  });

  vi.mocked(useUsage).mockImplementation((input, _selectedIds, hiddenProviders = new Set()) => {
    const summaryForInput: UsageSummary =
      input.projectFilter === undefined
        ? currentSummary
        : { ...currentSummary, projectFilter: input.projectFilter };
    const { eligible, excludedLegacy } = filterUsageEnvironmentsForScope(
      [envStatus(summaryForInput)],
      hiddenProviders,
      input.projectFilter,
    );
    const merged = mergeUsage(
      eligible.flatMap((entry) =>
        entry.summary
          ? [{ environmentId: entry.environmentId, label: entry.label, summary: entry.summary }]
          : [],
      ),
      USAGE_CONTRACT_VERSION,
    );
    const isLegacy =
      currentSummary.projects === undefined && currentSummary.topSessions === undefined;
    const hasEligibleAnswer = eligible.some((entry) => entry.summary !== null);
    return {
      merged,
      environments: [envStatus(summaryForInput)],
      selectedEnvironments: [envStatus(summaryForInput)],
      excludedLegacyEnvironments: excludedLegacy,
      answeredEnvironmentIds: hasEligibleAnswer ? new Set([ENV_ID]) : new Set(),
      hasEligibleAnswer,
      eligibleHasLegacyServer: hasEligibleAnswer && isLegacy,
      detectedLegacyEnvironmentIds: isLegacy ? new Set([ENV_ID]) : new Set(),
      isStaleScope: false,
      isPending: false,
      shown: hasEligibleAnswer ? { window: input, merged } : null,
      isPartial: false,
      refresh: vi.fn().mockResolvedValue(undefined),
    };
  });

  vi.mocked(useUsageComparison).mockImplementation(
    (input, _selectedIds, hiddenProviders = new Set()) => {
      if (input === null || previousSummary === null) {
        return { merged: null, isPending: false };
      }
      const summaryForInput: UsageSummary =
        input.projectFilter === undefined
          ? previousSummary
          : { ...previousSummary, projectFilter: input.projectFilter };
      const { eligible } = filterUsageEnvironmentsForScope(
        [envStatus(summaryForInput)],
        hiddenProviders,
        input.projectFilter,
      );
      const merged = mergeUsage(
        eligible.flatMap((entry) =>
          entry.summary
            ? [{ environmentId: entry.environmentId, label: entry.label, summary: entry.summary }]
            : [],
        ),
        USAGE_CONTRACT_VERSION,
      );
      return { merged, isPending: false };
    },
  );
}

async function setupDashboard(options?: {
  readonly providers?: readonly ServerProvider[];
  readonly summary?: UsageSummary;
  readonly previousSummary?: UsageSummary | null;
}) {
  await page.viewport(1360, 960);
  globalThis.localStorage.removeItem(USAGE_UI_OPTIONS_STORAGE_KEY);
  useUsageOptionsStore.getState().resetUsageUiOptions();
  mockNavigate.mockReset();
  vi.mocked(useUsage).mockReset();
  vi.mocked(useUsageComparison).mockReset();

  const providers =
    options && "providers" in options
      ? options.providers!
      : [
          makeProviderWithLimits("claude-main", "claudeAgent", "Claude Max", "Max", [
            {
              id: "session",
              kind: "session",
              label: "5-hour session",
              usedPercent: 45,
              resetsAt: new Date(NOW_MS + 90 * 60_000).toISOString(),
              windowMinutes: 300,
            },
            {
              id: "weekly",
              kind: "weekly",
              label: "Weekly",
              usedPercent: 85,
              resetsAt: new Date(NOW_MS + 2 * 86_400_000).toISOString(),
              windowMinutes: 10_080,
            },
          ]),
          makeProviderWithLimits("codex-main", "codex", "Codex Pro", "ChatGPT Plus Subscription", [
            {
              id: "primary",
              kind: "session",
              label: "5h limit",
              usedPercent: 92,
              resetsAt: new Date(NOW_MS + 35 * 60_000).toISOString(),
              windowMinutes: 300,
            },
          ]),
        ];
  setPresentations(providers);
  wireUsageMocks(options);
  const screen = await render(
    <AppAtomRegistryProvider>
      <UsagePage />
    </AppAtomRegistryProvider>,
  );
  return {
    screen,
    async [Symbol.asyncDispose]() {
      await screen[Symbol.asyncDispose]();
      globalThis.localStorage.removeItem(USAGE_UI_OPTIONS_STORAGE_KEY);
      useUsageOptionsStore.getState().resetUsageUiOptions();
      vi.restoreAllMocks();
    },
  };
}

describe("UsageDashboard", () => {
  it("lands on Overview (Cost) by default, shows risk-tiered Quota Strip, and jumps to Limits with Plan & reset details", async () => {
    await using _ctx = await setupDashboard();

    await expect.element(page.getByTestId("usage-kpi-cards")).toBeVisible();
    await expect.element(page.getByTestId("usage-kpi-primary").getByText("$12.00")).toBeVisible();
    await expect.element(page.getByTestId("usage-kpi-delta")).toHaveTextContent("+25%");
    await expect
      .element(page.getByTestId("usage-cost-source").getByText("Reported", { exact: false }))
      .toBeVisible();
    await expect.element(page.getByTestId("usage-unpriced-action")).toBeVisible();

    const chips = page.getByTestId("usage-quota-strip-chip");
    expect(chips.elements().length).toBe(3);
    expect(chips.elements().map((el) => el.getAttribute("data-tone"))).toEqual([
      "normal",
      "warning",
      "error",
    ]);

    await userEvent.click(chips.first());
    await expect.element(page.getByTestId("usage-limits-enhanced")).toBeVisible();
    await expect
      .element(page.getByTestId("usage-manage-hubs-link"))
      .toHaveAttribute("href", "/settings/providers#usage-providers");

    const planBadges = page.getByTestId("usage-limit-plan-badge").elements();
    expect(planBadges.map((el) => el.textContent)).toContain("Max");
    await expect.element(page.getByTestId("usage-limits-matrix")).toBeVisible();

    await userEvent.click(page.getByTestId("usage-limits-layout-pool"));
    await expect.element(page.getByTestId("usage-limits-pool-table")).toBeVisible();
    const windowCards = page.getByTestId("usage-limit-window-card").elements();
    expect(windowCards.map((el) => el.getAttribute("data-tone"))).toEqual([
      "normal",
      "warning",
      "error",
    ]);
    await expect
      .element(
        page
          .getByTestId("usage-limit-reset-info")
          .first()
          .getByText(/resets/i),
      )
      .toBeVisible();

    const comparisonCallsInLimits = vi
      .mocked(useUsageComparison)
      .mock.calls.slice(-1)
      .map((call) => call[0]);
    expect(comparisonCallsInLimits).toEqual([null]);
  });

  it("auto-hides Quota Strip when no provider reports subscription limits", async () => {
    await using _ctx = await setupDashboard({ providers: [] });

    await expect.element(page.getByTestId("usage-kpi-cards")).toBeVisible();
    expect(page.getByTestId("usage-quota-strip").elements()).toHaveLength(0);
  });

  it("supports keyboard shortcuts c/t/l and switches chart modes and solo provider filter", async () => {
    await using _ctx = await setupDashboard();

    await expect
      .element(page.getByTestId("usage-trend-chart"))
      .toHaveAttribute("data-chart-mode", "stacked-bar");

    await userEvent.click(page.getByTestId("usage-chart-mode-line"));
    await expect
      .element(page.getByTestId("usage-trend-chart"))
      .toHaveAttribute("data-chart-mode", "line");

    await userEvent.click(page.getByTestId("usage-provider-row-claude"));
    await expect
      .element(page.getByTestId("usage-filter-chip-provider"))
      .toHaveTextContent("Provider: Claude Code");
    await expect.element(page.getByTestId("usage-kpi-primary").getByText("$6.00")).toBeVisible();

    await userEvent.click(page.getByTestId("usage-filter-chip-provider"));
    expect(page.getByTestId("usage-filter-chip-provider").elements()).toHaveLength(0);
    await expect.element(page.getByTestId("usage-kpi-primary").getByText("$12.00")).toBeVisible();

    await userEvent.keyboard("t");
    await expect.element(page.getByTestId("usage-kpi-primary").getByText("1.61M")).toBeVisible();

    await userEvent.keyboard("l");
    await expect.element(page.getByTestId("usage-limits-enhanced")).toBeVisible();

    await userEvent.keyboard("c");
    await expect.element(page.getByTestId("usage-kpi-primary").getByText("$12.00")).toBeVisible();
  });

  it("enforces soft budget period gating (Today/MTD only) and all vs reportedOnly scope isolation", async () => {
    await using _ctx = await setupDashboard();

    await userEvent.click(page.getByTestId("usage-options-trigger"));
    await userEvent.click(page.getByTestId("usage-configure-budget-item"));

    await userEvent.type(page.getByLabelText("Daily budget (USD)"), "10");
    await userEvent.type(page.getByLabelText("Monthly budget (USD)"), "100");
    await userEvent.click(page.getByRole("button", { name: "Save budget" }));

    // Default period is 30d: soft budget MUST NOT appear on 30d.
    expect(page.getByTestId("usage-soft-budget").elements()).toHaveLength(0);

    // Switch to Today: all spend = $12 / $10 = 120% -> error tone.
    await userEvent.click(page.getByTestId("usage-period-today"));
    await expect.element(page.getByTestId("usage-soft-budget")).toBeVisible();
    await expect
      .element(page.getByTestId("usage-soft-budget"))
      .toHaveAttribute("data-tone", "error");
    await expect
      .element(page.getByTestId("usage-soft-budget").getByText("$12.00 / $10.00", { exact: false }))
      .toBeVisible();

    // Switch budget scope to Reported only: reported = $6 / $10 = 60% -> normal tone.
    await userEvent.click(page.getByTestId("usage-options-trigger"));
    await userEvent.click(page.getByTestId("usage-configure-budget-item"));
    await userEvent.click(page.getByRole("button", { name: "Reported only" }));
    await userEvent.click(page.getByRole("button", { name: "Save budget" }));

    await expect
      .element(page.getByTestId("usage-soft-budget"))
      .toHaveAttribute("data-tone", "normal");
    await expect
      .element(page.getByTestId("usage-soft-budget").getByText("$6.00 / $10.00", { exact: false }))
      .toBeVisible();

    // Switch to Month (MTD): monthly budget = $6 / $100 -> normal tone.
    await userEvent.click(page.getByTestId("usage-period-mtd"));
    await expect
      .element(page.getByTestId("usage-soft-budget").getByText("$6.00 / $100.00", { exact: false }))
      .toBeVisible();

    // Switch to 7d: hidden again.
    await userEvent.click(page.getByTestId("usage-period-7d"));
    expect(page.getByTestId("usage-soft-budget").elements()).toHaveLength(0);
  });

  it("supports Model dialog with Reasoning + Projects, Project cross-filtering, Top Sessions navigation/dialog, and fixes Day/Hour Tokens mode", async () => {
    await using _ctx = await setupDashboard();

    // 1) Model tab: search, unpriced Set price, Model dialog with Reasoning + Projects.
    await expect.element(page.getByTestId("usage-model-set-price")).toBeVisible();
    await userEvent.click(page.getByRole("button", { name: "claude-opus-4-6" }));
    const modelDialog = page.getByRole("dialog", { name: "claude-opus-4-6" });
    await expect.element(modelDialog).toBeVisible();
    await expect
      .element(modelDialog.getByRole("term").getByText("Reasoning", { exact: true }))
      .toBeVisible();
    await expect
      .element(modelDialog.getByTestId("usage-model-projects").getByText("Alpha App"))
      .toBeVisible();
    await userEvent.click(modelDialog.getByRole("button", { name: "Close" }));

    // 2) Project tab: worktree badge + click cross-filter passes projectFilter to useUsage.
    await userEvent.click(page.getByTestId("usage-breakdown-tab-project"));
    await expect.element(page.getByText("2 worktrees")).toBeVisible();
    await userEvent.click(page.getByRole("button", { name: /Alpha App/ }));
    await expect
      .element(page.getByTestId("usage-filter-chip-project"))
      .toHaveTextContent("Project: Alpha App");
    const lastInput = vi.mocked(useUsage).mock.calls.at(-1)?.[0] as UsageSummaryInput | undefined;
    expect(lastInput?.projectFilter).toEqual({ projectKey: "t3:proj-alpha" });
    await userEvent.click(page.getByTestId("usage-filter-chip-project"));

    // 3) Top Sessions tab: T3-linked row navigates; external CLI row opens UsageSessionDialog.
    await userEvent.click(page.getByTestId("usage-breakdown-tab-session"));
    await userEvent.click(page.getByRole("button", { name: /Refactor Usage Dashboard/ }));
    expect(mockNavigate).toHaveBeenCalledTimes(1);
    expect(mockNavigate.mock.calls[0]?.[0]).toMatchObject({
      to: "/$environmentId/$threadId",
    });

    await userEvent.click(page.getByRole("button", { name: /Standalone CLI Fix/ }));
    await expect.element(page.getByTestId("usage-session-dialog")).toBeVisible();
    await expect
      .element(page.getByTestId("usage-session-dialog").getByText("sess-external-cli-123456"))
      .toBeVisible();
    await userEvent.click(
      page.getByTestId("usage-session-dialog").getByRole("button", { name: "Close" }).first(),
    );

    // 4) Day/Hour tab: Cost mode shows USD; Tokens mode shows formatted tokens (NO USD in provider/total cells!).
    await userEvent.click(page.getByTestId("usage-breakdown-tab-time"));
    expect(page.getByTestId("usage-time-total-cell").first().element().textContent).toContain("$");

    await userEvent.click(page.getByTestId("usage-metric-tokens"));
    const firstRowTotal = page.getByTestId("usage-time-total-cell").first();
    const firstRowSecondary = page.getByTestId("usage-time-secondary-cell").first();
    await expect.element(firstRowTotal).toHaveTextContent("1.11M");
    expect(firstRowTotal.element().textContent).not.toContain("$");
    await expect.element(firstRowSecondary).toHaveTextContent("$6.00");

    // Clicking a Day row locks that bucket chip.
    await userEvent.click(page.getByTestId("usage-time-row").first());
    await expect.element(page.getByTestId("usage-filter-chip-period")).toBeVisible();
  });

  it("shows honest upgrade notices on Project and Top Sessions tabs for legacy servers", async () => {
    await using _ctx = await setupDashboard({
      summary: makeRichSummary({ legacy: true }),
      previousSummary: null,
    });

    await userEvent.click(page.getByTestId("usage-breakdown-tab-project"));
    await expect.element(page.getByTestId("usage-projects-unsupported")).toBeVisible();

    await userEvent.click(page.getByTestId("usage-breakdown-tab-session"));
    await expect.element(page.getByTestId("usage-sessions-unsupported")).toBeVisible();
  });

  it("exports CSV/JSON and persists + resets options under t3lab:usage-ui:v1", async () => {
    const createObjectUrlSpy = vi
      .spyOn(URL, "createObjectURL")
      .mockReturnValue("blob:usage-test-export");
    const revokeObjectUrlSpy = vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
    const anchorClickSpy = vi
      .spyOn(HTMLAnchorElement.prototype, "click")
      .mockImplementation(() => {});

    await using _ctx = await setupDashboard();

    await userEvent.click(page.getByTestId("usage-export-trigger"));
    await userEvent.click(page.getByTestId("usage-export-csv"));
    expect(createObjectUrlSpy).toHaveBeenCalledTimes(1);
    expect(anchorClickSpy).toHaveBeenCalledTimes(1);
    expect(revokeObjectUrlSpy).toHaveBeenCalledTimes(1);

    await userEvent.click(page.getByTestId("usage-export-trigger"));
    await userEvent.click(page.getByTestId("usage-export-json"));
    expect(createObjectUrlSpy).toHaveBeenCalledTimes(2);

    // Toggle comparison off and verify persistence + lazy query suspension.
    await userEvent.click(page.getByTestId("usage-options-trigger"));
    await userEvent.click(page.getByRole("menuitemcheckbox", { name: "Period comparison delta" }));
    expect(page.getByTestId("usage-kpi-delta").elements()).toHaveLength(0);
    const saved = JSON.parse(globalThis.localStorage.getItem(USAGE_UI_OPTIONS_STORAGE_KEY) ?? "{}");
    expect(saved.showComparison).toBe(false);
    expect(vi.mocked(useUsageComparison).mock.calls.at(-1)?.[0]).toBeNull();

    // Reset defaults restores showComparison = true.
    await userEvent.click(page.getByTestId("usage-options-reset"));
    await expect.element(page.getByTestId("usage-kpi-delta")).toBeVisible();
  });

  it("gates soft budget, delta, and exports during stale scope transitions and shows Quota Strip while transcript scan is pending", async () => {
    await using _ctx = await setupDashboard();
    useUsageOptionsStore.getState().setBudget({ dailyBudgetUsd: 10, budgetScope: "all" });
    useUsageOptionsStore.getState().setPeriod("today");

    // Simulate stale 30d data still shown while Today is loading.
    const staleSummary = makeRichSummary({ costMultiplier: 10 });
    const staleMerged = mergeUsage(
      [{ environmentId: ENV_ID, label: "Workstation", summary: staleSummary }],
      USAGE_CONTRACT_VERSION,
    );
    vi.mocked(useUsage).mockReturnValue({
      merged: staleMerged,
      environments: [
        {
          environmentId: ENV_ID,
          label: "Workstation",
          isPending: true,
          canReadDiagnostics: true,
          accessRequests: [],
          isConnected: true,
          error: null,
          summary: null,
        },
      ],
      selectedEnvironments: [
        {
          environmentId: ENV_ID,
          label: "Workstation",
          isPending: true,
          canReadDiagnostics: true,
          accessRequests: [],
          isConnected: true,
          error: null,
          summary: null,
        },
      ],
      excludedLegacyEnvironments: [],
      answeredEnvironmentIds: new Set(),
      hasEligibleAnswer: false,
      eligibleHasLegacyServer: false,
      detectedLegacyEnvironmentIds: new Set(),
      isStaleScope: true,
      isPending: true,
      shown: {
        window: {
          sinceDay: UsageDay.make("2026-10-25"),
          untilDay: UsageDay.make("2026-11-24"),
          timeZone: "UTC",
          resolution: "day",
        },
        merged: staleMerged,
      },
      isPartial: false,
      refresh: vi.fn().mockResolvedValue(undefined),
    });

    await _ctx.screen.rerender(
      <AppAtomRegistryProvider>
        <UsagePage />
      </AppAtomRegistryProvider>,
    );

    // Budget bar & comparison delta MUST NOT flash stale 30d $120 spend on Today; Export MUST be disabled.
    expect(page.getByTestId("usage-soft-budget").elements()).toHaveLength(0);
    expect(page.getByTestId("usage-kpi-delta").elements()).toHaveLength(0);
    await expect.element(page.getByTestId("usage-export-trigger")).toBeDisabled();

    // Failed transition (0 answered, 0 pending, error set) MUST NOT render a fake $0 KPI/budget or allow export.
    const emptyMerged = mergeUsage([], USAGE_CONTRACT_VERSION);
    vi.mocked(useUsage).mockReturnValue({
      merged: emptyMerged,
      environments: [
        {
          environmentId: ENV_ID,
          label: "Workstation",
          isPending: false,
          canReadDiagnostics: true,
          accessRequests: [],
          isConnected: true,
          error: "This environment could not report usage.",
          summary: null,
        },
      ],
      selectedEnvironments: [
        {
          environmentId: ENV_ID,
          label: "Workstation",
          isPending: false,
          canReadDiagnostics: true,
          accessRequests: [],
          isConnected: true,
          error: "This environment could not report usage.",
          summary: null,
        },
      ],
      excludedLegacyEnvironments: [],
      answeredEnvironmentIds: new Set(),
      hasEligibleAnswer: false,
      eligibleHasLegacyServer: false,
      detectedLegacyEnvironmentIds: new Set(),
      isStaleScope: false,
      isPending: false,
      shown: null,
      isPartial: false,
      refresh: vi.fn().mockResolvedValue(undefined),
    });
    // Transition the mounted dashboard to Month (with monthly budget configured) to exercise the live failed state.
    useUsageOptionsStore.getState().setBudget({ monthlyBudgetUsd: 50 });
    useUsageOptionsStore.getState().setPeriod("mtd");
    await expect.element(page.getByTestId("usage-scope-unavailable")).toBeVisible();
    expect(page.getByTestId("usage-kpi-cards").elements()).toHaveLength(0);
    expect(page.getByTestId("usage-soft-budget").elements()).toHaveLength(0);
    await expect.element(page.getByTestId("usage-export-trigger")).toBeDisabled();
    await expect.element(page.getByTestId("usage-quota-strip")).toBeVisible();
  });

  it("keeps Tokens by type with Reasoning visible beside Cost by speed, and labels offline T3-linked hosts accurately", async () => {
    const fastRich = makeRichSummary();
    const withFastAndOffline: UsageSummary = {
      ...fastRich,
      buckets: [
        {
          ...fastRich.buckets[0]!,
          fastCostUsd: 2,
          speedPremiumUsd: 0.5,
        },
        ...fastRich.buckets.slice(1),
      ],
    };
    await using _ctx = await setupDashboard({ summary: withFastAndOffline });

    // Even when fast spend triggers Cost by speed, Tokens by type (with Reasoning) MUST stay visible in Cost mode.
    const shareBars = page.getByTestId("usage-share-bars");
    await expect.element(shareBars.getByText("Cost by type")).toBeVisible();
    await expect.element(shareBars.getByText("Cost by speed")).toBeVisible();
    await expect.element(shareBars.getByText("Tokens by type")).toBeVisible();
    await expect.element(shareBars.getByText("Reasoning", { exact: false }).first()).toBeVisible();

    // Mark the host offline while keeping its cached summary so T3-linked session shows "Host offline".
    const merged = mergeUsage(
      [
        {
          environmentId: ENV_ID,
          label: "Workstation",
          isConnected: false,
          summary: withFastAndOffline,
        },
      ],
      USAGE_CONTRACT_VERSION,
    );
    const offlineEnv: EnvironmentUsageStatus = {
      environmentId: ENV_ID,
      label: "Workstation",
      isPending: false,
      canReadDiagnostics: true,
      accessRequests: [],
      isConnected: false,
      error: null,
      summary: withFastAndOffline,
    };
    vi.mocked(useUsage).mockImplementation((input) => ({
      merged,
      environments: [offlineEnv],
      selectedEnvironments: [offlineEnv],
      excludedLegacyEnvironments: [],
      answeredEnvironmentIds: new Set([ENV_ID]),
      hasEligibleAnswer: true,
      eligibleHasLegacyServer: false,
      detectedLegacyEnvironmentIds: new Set(),
      isStaleScope: false,
      isPending: false,
      shown: { window: input, merged },
      isPartial: false,
      refresh: vi.fn().mockResolvedValue(undefined),
    }));
    await _ctx.screen.rerender(
      <AppAtomRegistryProvider>
        <UsagePage />
      </AppAtomRegistryProvider>,
    );

    await userEvent.click(page.getByTestId("usage-breakdown-tab-session"));
    await expect.element(page.getByTestId("usage-session-host-offline")).toBeVisible();
    await userEvent.click(page.getByRole("button", { name: /Refactor Usage Dashboard/ }));
    expect(mockNavigate).not.toHaveBeenCalled();
    await expect
      .element(
        page
          .getByTestId("usage-session-dialog")
          .getByText("Linked to a T3 thread on an offline environment"),
      )
      .toBeVisible();
  });

  it("retries a cold-open >24h DST fall-back Today rejection against a legacy server with <=24h bounds and pauses budget & comparison", async () => {
    const resolvedOptionsSpy = vi
      .spyOn(Intl.DateTimeFormat.prototype, "resolvedOptions")
      .mockReturnValue({
        locale: "en-US",
        calendar: "gregory",
        numberingSystem: "latn",
        timeZone: "America/New_York",
      });
    // 2026-11-01 is fall-back Sunday in America/New_York (25h day); 2026-11-02T04:30:38Z is 23:30:38 EST (24h30m38s since midnight EDT).
    let currentNowMs = Date.parse("2026-11-02T04:30:38Z");
    const RealDate = Date;
    class FixedDate extends RealDate {
      constructor(...args: ConstructorParameters<typeof Date> | []) {
        if (args.length === 0) {
          super(currentNowMs);
        } else {
          super(...(args as [string | number | Date]));
        }
      }
      static override now() {
        return currentNowMs;
      }
    }
    vi.stubGlobal("Date", FixedDate);

    try {
      await page.viewport(1360, 960);
      globalThis.localStorage.removeItem(USAGE_UI_OPTIONS_STORAGE_KEY);
      useUsageOptionsStore.getState().resetUsageUiOptions();
      useUsageOptionsStore.getState().setPeriod("today");
      useUsageOptionsStore.getState().setBudget({ dailyBudgetUsd: 10, budgetScope: "all" });
      mockNavigate.mockReset();
      vi.mocked(useUsage).mockReset();
      vi.mocked(useUsageComparison).mockReset();
      vi.mocked(useUsageComparison).mockReturnValue({ merged: null, isPending: false });
      const LEGACY_ENV_ID = EnvironmentId.make("env-legacy-unselected");
      appAtomRegistry.set(
        environmentPresentations.presentationsAtom as unknown as Atom.Writable<
          Map<EnvironmentId, unknown>
        >,
        new Map([
          [
            ENV_ID,
            {
              entry: { target: { label: "Primary Host" } },
              connection: { phase: "connected" },
              serverConfig: { providers: [] },
            },
          ],
          [
            LEGACY_ENV_ID,
            {
              entry: { target: { label: "Old Peer" } },
              connection: { phase: "connected" },
              serverConfig: { providers: [] },
            },
          ],
        ]),
      );

      const cachedModernSummary = makeRichSummary();
      const cachedModernMerged = mergeUsage(
        [{ environmentId: ENV_ID, label: "Primary Host", summary: cachedModernSummary }],
        USAGE_CONTRACT_VERSION,
      );
      const seenSpansMs: number[] = [];
      const refreshCalls: UsageSummaryInput[] = [];
      const mockRefresh = vi.fn().mockImplementation(async (nextInput?: UsageSummaryInput) => {
        if (nextInput) refreshCalls.push(nextInput);
      });
      const initialUntilIso = new RealDate(currentNowMs).toISOString();

      vi.mocked(useUsage).mockImplementation((input, selectedIds) => {
        const spanMs =
          input.sinceTime !== undefined && input.untilTime !== undefined
            ? RealDate.parse(input.untilTime) - RealDate.parse(input.sinceTime)
            : 0;
        seenSpansMs.push(spanMs);
        const primarySelected =
          selectedIds === undefined || selectedIds === null || selectedIds.has(ENV_ID);
        const legacyPeerSelected =
          selectedIds === undefined || selectedIds === null || selectedIds.has(LEGACY_ENV_ID);

        // Old Peer ALWAYS rejects >24h; Primary Host rejects ONLY on the initial anchor (simulating upgrade before Refresh).
        const primaryRejectedInitial =
          input.resolution === "hour" &&
          spanMs > 24 * 60 * 60 * 1000 &&
          input.untilTime === initialUntilIso;

        const primaryEnv: EnvironmentUsageStatus = primaryRejectedInitial
          ? {
              environmentId: ENV_ID,
              label: "Primary Host",
              isPending: true,
              canReadDiagnostics: true,
              accessRequests: [],
              isConnected: true,
              error: "This environment could not report usage.",
              rejectedOversizedHourlyWindow: true,
              hasFreshModernSummary: false,
              summary: cachedModernSummary,
            }
          : {
              environmentId: ENV_ID,
              label: "Primary Host",
              isPending: false,
              canReadDiagnostics: true,
              accessRequests: [],
              isConnected: true,
              error: null,
              hasFreshModernSummary: true,
              summary: cachedModernSummary,
            };

        const legacyPeerRejected = input.resolution === "hour" && spanMs > 24 * 60 * 60 * 1000;
        const legacyPeerEnv: EnvironmentUsageStatus = {
          environmentId: LEGACY_ENV_ID,
          label: "Old Peer",
          isPending: false,
          canReadDiagnostics: true,
          accessRequests: [],
          isConnected: true,
          error: legacyPeerRejected ? "This environment could not report usage." : null,
          ...(legacyPeerRejected ? { rejectedOversizedHourlyWindow: true } : {}),
          summary: legacyPeerRejected ? null : makeRichSummary({ legacy: true }),
        };

        const allEnvs = [primaryEnv, legacyPeerEnv];
        const selectedEnvs = allEnvs.filter(
          (env) =>
            (env.environmentId === ENV_ID && primarySelected) ||
            (env.environmentId === LEGACY_ENV_ID && legacyPeerSelected),
        );
        const detectedLegacyIds = new Set<EnvironmentId>();
        if (primaryRejectedInitial) detectedLegacyIds.add(ENV_ID);
        detectedLegacyIds.add(LEGACY_ENV_ID);

        return {
          merged: cachedModernMerged,
          environments: allEnvs,
          selectedEnvironments: selectedEnvs,
          excludedLegacyEnvironments: [],
          answeredEnvironmentIds: new Set([ENV_ID]),
          hasEligibleAnswer: true,
          eligibleHasLegacyServer: false,
          detectedLegacyEnvironmentIds: detectedLegacyIds,
          isStaleScope: false,
          isPending: false,
          shown: { window: input, merged: cachedModernMerged },
          isPartial: false,
          refresh: mockRefresh,
        };
      });

      await using _screen = await render(
        <AppAtomRegistryProvider>
          <UsagePage />
        </AppAtomRegistryProvider>,
      );

      // 1) Initial anchor with both selected: Primary Host rejected full key, clipped key returned fresh modern -> pinned without oscillating!
      await expect.element(page.getByTestId("usage-legacy-clipped-today-notice")).toBeVisible();
      expect(seenSpansMs.some((span) => span > 24 * 60 * 60 * 1000)).toBe(true);
      expect(seenSpansMs.at(-1)).toBeLessThanOrEqual(24 * 60 * 60 * 1000);
      expect(seenSpansMs.length).toBeLessThan(10);
      expect(page.getByTestId("usage-soft-budget").elements()).toHaveLength(0);

      // 2) Deselect Old Peer (leaving only upgraded Primary Host), then Refresh on a new anchor -> MUST re-probe FULL >24h range and restore Today's budget!
      await userEvent.click(page.getByRole("button", { name: "All environments" }));
      await userEvent.click(page.getByRole("menuitemcheckbox", { name: /Old Peer/ }));
      await userEvent.keyboard("{Escape}");

      currentNowMs = RealDate.parse("2026-11-02T04:35:00Z");
      await userEvent.click(page.getByRole("button", { name: "Refresh usage" }));

      expect(refreshCalls.length).toBe(1);
      const refreshedSpanMs =
        RealDate.parse(refreshCalls[0]!.untilTime!) - RealDate.parse(refreshCalls[0]!.sinceTime!);
      expect(refreshedSpanMs).toBeGreaterThan(24 * 60 * 60 * 1000);
      expect(seenSpansMs.at(-1)).toBeGreaterThan(24 * 60 * 60 * 1000);
      await expect.element(page.getByTestId("usage-soft-budget")).toBeVisible();
      expect(page.getByTestId("usage-legacy-clipped-today-notice").elements()).toHaveLength(0);
    } finally {
      vi.unstubAllGlobals();
      resolvedOptionsSpy.mockRestore();
      globalThis.localStorage.removeItem(USAGE_UI_OPTIONS_STORAGE_KEY);
      useUsageOptionsStore.getState().resetUsageUiOptions();
      vi.restoreAllMocks();
    }
  });

  it("prompts for agent usage access before rendering usage data when an environment has unanswered access requests", async () => {
    await page.viewport(1360, 960);
    globalThis.localStorage.removeItem(USAGE_UI_OPTIONS_STORAGE_KEY);
    useUsageOptionsStore.getState().resetUsageUiOptions();
    vi.mocked(useUsage).mockReset();
    vi.mocked(useUsageComparison).mockReset();
    vi.mocked(useUsageComparison).mockReturnValue({ merged: null, isPending: false });

    const emptyMerged = mergeUsage([], USAGE_CONTRACT_VERSION);
    const pendingAccessEnv: EnvironmentUsageStatus = {
      environmentId: ENV_ID,
      label: "Workstation",
      isPending: false,
      canReadDiagnostics: true,
      accessRequests: [
        {
          instanceId: ProviderInstanceId.make("claude-main"),
          driver: ProviderDriverKind.make("claudeAgent"),
          provider: "claude",
          paths: ["/home/dev/.claude"],
        },
      ],
      isConnected: true,
      error: null,
      summary: null,
    };
    vi.mocked(useUsage).mockReturnValue({
      merged: emptyMerged,
      environments: [pendingAccessEnv],
      selectedEnvironments: [pendingAccessEnv],
      excludedLegacyEnvironments: [],
      answeredEnvironmentIds: new Set(),
      hasEligibleAnswer: false,
      eligibleHasLegacyServer: false,
      detectedLegacyEnvironmentIds: new Set(),
      isStaleScope: false,
      isPending: false,
      shown: null,
      isPartial: false,
      refresh: vi.fn().mockResolvedValue(undefined),
    });

    await using _screen = await render(
      <AppAtomRegistryProvider>
        <UsagePage />
      </AppAtomRegistryProvider>,
    );

    await expect.element(page.getByRole("heading", { name: "Show agent usage?" })).toBeVisible();
    await expect.element(page.getByRole("button", { name: "Allow", exact: true })).toBeVisible();
    await expect.element(page.getByRole("button", { name: "Don't allow" })).toBeVisible();
  });
});
