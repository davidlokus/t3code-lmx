import { secondTick } from "@t3tools/client-runtime/clock";
import type { ContextWindowSnapshot } from "@t3tools/client-runtime/state/context-window";
import type { EnvironmentThreadStructure } from "@t3tools/client-runtime/state/models";
import {
  EnvironmentId,
  MessageId,
  NodeId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderThreadId,
  ProviderTurnId,
  RunId,
  ThreadId,
  TurnItemId,
  type DiscoveredLocalServer,
  type ResourceTelemetrySnapshot,
  type ServerProvider,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";
import { describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import { act, render } from "../../../test/render";
import { ChatCanvasContext } from "../../components/chat/ChatCanvasContext";
import { resolveChatCanvasLayout } from "../../components/chat/chatCanvasLayout";
import { ThreadDetailsPanel } from "../../components/chat/ThreadDetailsPanel";
import type { ThreadDetailsUsageInput } from "../../components/chat/ThreadDetailsUsage";
import { PopoverCreateHandle } from "../../components/ui/popover";
import { useNowMinute } from "../../hooks/useNowMinute";
import { getClientSettings, updateClientSettings } from "../../hooks/useSettings";
import { useResourceTelemetry } from "../../lib/resourceTelemetryState";
import { openSideThread } from "../../lib/sideChatPane";
import { useThreadDiscoveredPorts } from "../../portDiscoveryState";
import { useRightPanelStore } from "../../rightPanelStore";
import {
  useProject,
  useProjects,
  useQuietThreadProjection,
  useQuietThreadShell,
  useServerConfigs,
  useThreadError,
} from "../../state/entities";
import { makeThreadProjectionFixture } from "../../test-fixtures";
import { HUD_OPTIONS_STORAGE_KEY, useHudOptionsStore } from "./hudOptionsStore";
import { ThreadHudHeader, ThreadHudSections } from "./ThreadHudSections";

vi.mock("../../state/entities", { spy: true });
vi.mock("../../hooks/useNowMinute", { spy: true });
vi.mock("../../lib/resourceTelemetryState", { spy: true });
vi.mock("../../portDiscoveryState", { spy: true });
vi.mock("../../lib/sideChatPane", { spy: true });

const ENV_ID = EnvironmentId.make("env-local");
const THREAD_ID = ThreadId.make("thread-hud-1");
const CHILD_THREAD_ID = ThreadId.make("thread-sub-1");
const PROJECT_ID = ProjectId.make("proj-1");
const PROVIDER_DRIVER = ProviderDriverKind.make("claudeAgent");
const PROVIDER_ID = ProviderInstanceId.make("claudeAgent");
const PROVIDER_THREAD_ID = ProviderThreadId.make("pt-1");
const EMPTY_SOURCES: ThreadDetailsUsageInput["sources"] = [];
const BASE_NOW_MINUTE = "2026-11-23T12:00";
const BASE_NOW_MS = Date.parse(`${BASE_NOW_MINUTE}:00Z`);

function utc(iso: string) {
  return DateTime.makeUnsafe(iso);
}

function makeRichStructure(): EnvironmentThreadStructure {
  const base = makeThreadProjectionFixture();
  const modelSelection = {
    instanceId: PROVIDER_ID,
    model: "claude-sonnet-4-6",
    options: [{ id: "reasoningEffort", value: "high" }],
  };
  const startedAt = utc("2026-11-23T11:58:00.000Z");
  const completedAt = utc("2026-11-23T11:58:10.000Z");

  return {
    environmentId: ENV_ID,
    projection: {
      ...base,
      thread: {
        ...base.thread,
        id: THREAD_ID,
        projectId: PROJECT_ID,
        title: "Implement HUD",
        providerInstanceId: PROVIDER_ID,
        activeProviderThreadId: PROVIDER_THREAD_ID,
        modelSelection,
        interactionMode: "plan",
        runtimeMode: "full-access",
      },
      runs: [
        {
          id: RunId.make("run-1"),
          threadId: THREAD_ID,
          ordinal: 1,
          providerInstanceId: PROVIDER_ID,
          modelSelection,
          providerThreadId: PROVIDER_THREAD_ID,
          userMessageId: MessageId.make("msg-u1"),
          rootNodeId: NodeId.make("node-1"),
          activeAttemptId: null,
          status: "completed",
          requestedAt: startedAt,
          startedAt,
          completedAt,
          checkpointId: null,
          contextHandoffId: null,
        },
      ],
      providerTurns: [
        {
          id: ProviderTurnId.make("turn-1"),
          providerThreadId: PROVIDER_THREAD_ID,
          nodeId: NodeId.make("node-1"),
          runAttemptId: null,
          nativeTurnRef: null,
          ordinal: 1,
          status: "completed",
          startedAt,
          completedAt,
          model: "claude-opus-4-6",
          tokenUsage: {
            usedTokens: 210_000,
            maxTokens: 250_000,
            inputTokens: 100_000,
            cachedInputTokens: 80_000,
            outputTokens: 600,
            reasoningOutputTokens: 120,
            autoCompactThreshold: 225_000,
            promptCacheExpiresAt: new Date(secondTick.getSnapshot() + 180_000).toISOString(),
            updatedAt: "2026-11-23T11:58:10.000Z",
          },
          turnTokenUsage: {
            usageScope: "main_agent",
            usageStatus: "complete",
            inputTokens: 100_000,
            cachedInputTokens: 80_000,
            outputTokens: 600,
            reasoningTokens: 120,
            hasSubagents: true,
            models: ["claude-opus-4-6"],
          },
        },
      ],
      subagents: [
        {
          id: NodeId.make("sub-1"),
          threadId: THREAD_ID,
          runId: RunId.make("run-1"),
          parentNodeId: NodeId.make("node-1"),
          origin: "app_owned",
          createdBy: "agent",
          driver: PROVIDER_DRIVER,
          providerInstanceId: PROVIDER_ID,
          providerThreadId: null,
          childThreadId: CHILD_THREAD_ID,
          nativeTaskRef: null,
          prompt: "Audit metrics",
          title: "Metrics Auditor",
          model: "claude-opus-4-6",
          status: "running",
          result: null,
          startedAt,
          completedAt: null,
          updatedAt: completedAt,
        },
      ],
      messages: [
        {
          id: MessageId.make("msg-u1"),
          threadId: THREAD_ID,
          runId: RunId.make("run-1"),
          nodeId: NodeId.make("node-1"),
          role: "user",
          text: "Build the right-side HUD dashboard".repeat(40),
          attachments: [],
          streaming: false,
          createdBy: "user",
          creationSource: "web",
          createdAt: startedAt,
          updatedAt: startedAt,
        },
        {
          id: MessageId.make("msg-a1"),
          threadId: THREAD_ID,
          runId: RunId.make("run-1"),
          nodeId: NodeId.make("node-2"),
          role: "assistant",
          text: "Implemented context lens and metrics".repeat(60),
          attachments: [],
          streaming: false,
          createdBy: "agent",
          creationSource: "provider",
          createdAt: completedAt,
          updatedAt: completedAt,
        },
      ],
      turnItems: [
        {
          id: TurnItemId.make("item-compact"),
          threadId: THREAD_ID,
          runId: RunId.make("run-1"),
          nodeId: NodeId.make("node-c"),
          providerThreadId: PROVIDER_THREAD_ID,
          providerTurnId: ProviderTurnId.make("turn-1"),
          nativeItemRef: null,
          parentItemId: null,
          ordinal: 1,
          status: "completed",
          title: null,
          startedAt,
          completedAt,
          updatedAt: completedAt,
          type: "compaction",
          driver: PROVIDER_DRIVER,
          summary: "Compacted earlier session",
          beforeTokenCount: 240_000,
          afterTokenCount: 80_000,
        },
        {
          id: TurnItemId.make("item-u1"),
          threadId: THREAD_ID,
          runId: RunId.make("run-1"),
          nodeId: NodeId.make("node-1"),
          providerThreadId: PROVIDER_THREAD_ID,
          providerTurnId: ProviderTurnId.make("turn-1"),
          nativeItemRef: null,
          parentItemId: null,
          ordinal: 2,
          status: "completed",
          title: null,
          startedAt,
          completedAt: startedAt,
          updatedAt: startedAt,
          type: "user_message",
          createdBy: "user",
          creationSource: "web",
          messageId: MessageId.make("msg-u1"),
          inputIntent: "turn_start",
          text: "Build the right-side HUD dashboard".repeat(40),
          attachments: [],
        },
        {
          id: TurnItemId.make("item-cmd-ok"),
          threadId: THREAD_ID,
          runId: RunId.make("run-1"),
          nodeId: NodeId.make("node-t1"),
          providerThreadId: PROVIDER_THREAD_ID,
          providerTurnId: ProviderTurnId.make("turn-1"),
          nativeItemRef: null,
          parentItemId: null,
          ordinal: 3,
          status: "completed",
          title: null,
          startedAt,
          completedAt,
          updatedAt: completedAt,
          type: "command_execution",
          input: "vp test run",
          output: "All passed".repeat(20),
          exitCode: 0,
        },
        {
          id: TurnItemId.make("item-cmd-fail"),
          threadId: THREAD_ID,
          runId: RunId.make("run-1"),
          nodeId: NodeId.make("node-t2"),
          providerThreadId: PROVIDER_THREAD_ID,
          providerTurnId: ProviderTurnId.make("turn-1"),
          nativeItemRef: null,
          parentItemId: null,
          ordinal: 4,
          status: "failed",
          title: null,
          startedAt,
          completedAt,
          updatedAt: completedAt,
          type: "command_execution",
          input: "vp lint",
          output: "Lint failed",
          exitCode: 1,
        },
      ],
    },
  };
}

function makeProviderWithLimits(options?: { readonly unsupported?: boolean }): ServerProvider {
  return {
    instanceId: PROVIDER_ID,
    driver: PROVIDER_DRIVER,
    displayName: "Claude",
    enabled: true,
    installed: true,
    version: "1.0.0",
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt: "2026-11-23T11:59:00.000Z",
    models: [],
    slashCommands: [],
    skills: [],
    usageLimits: options?.unsupported
      ? {
          checkedAt: "2026-11-23T11:59:00.000Z",
          windows: [],
          unavailable: { reason: "unsupported", message: "API key account" },
        }
      : {
          checkedAt: "2026-11-23T11:59:00.000Z",
          windows: [
            {
              id: "5h",
              kind: "session",
              label: "5h",
              usedPercent: 40,
              windowDurationMins: 300,
              resetsAt: new Date(BASE_NOW_MS + 2 * 3600_000 + 15 * 60_000).toISOString(),
            },
          ],
        },
  };
}

function makeTelemetrySnapshot(): ResourceTelemetrySnapshot {
  const nowUtc = utc("2026-11-23T12:00:00.000Z");
  return {
    readAt: nowUtc,
    sampleIntervalMs: 5000,
    processes: [
      {
        identity: { pid: 1001, startTimeMs: 1000 },
        ppid: 1,
        childPids: [],
        depth: 0,
        name: "claude",
        command: "claude --mcp",
        status: "running",
        category: "provider-root",
        cpuPercent: 18.4,
        cpuTimeMs: 12000,
        residentBytes: 256 * 1024 * 1024,
        peakResidentBytes: 300 * 1024 * 1024,
        virtualBytes: 512 * 1024 * 1024,
        ioReadBytes: 0,
        ioWriteBytes: 0,
        ioReadBytesPerSecond: 0,
        ioWriteBytesPerSecond: 0,
        ioSemantics: "unavailable",
        runTimeMs: 60000,
        firstSeenAt: nowUtc,
        lastSeenAt: nowUtc,
      },
      {
        identity: { pid: 1002, startTimeMs: 1000 },
        ppid: 1,
        childPids: [],
        depth: 0,
        name: "node",
        command: "t3-server",
        status: "running",
        category: "server",
        cpuPercent: 4.1,
        cpuTimeMs: 4000,
        residentBytes: 128 * 1024 * 1024,
        peakResidentBytes: 140 * 1024 * 1024,
        virtualBytes: 256 * 1024 * 1024,
        ioReadBytes: 0,
        ioWriteBytes: 0,
        ioReadBytesPerSecond: 0,
        ioWriteBytesPerSecond: 0,
        ioSemantics: "unavailable",
        runTimeMs: 60000,
        firstSeenAt: nowUtc,
        lastSeenAt: nowUtc,
      },
    ],
    groups: {
      backend: {
        processCount: 2,
        currentCpuPercent: 22.5,
        cpuTimeMs: 16000,
        currentRssBytes: 384 * 1024 * 1024,
        peakRssBytes: 440 * 1024 * 1024,
        ioReadBytes: 0,
        ioWriteBytes: 0,
        ioReadBytesPerSecond: 0,
        ioWriteBytesPerSecond: 0,
        processStarts: 2,
        processExits: 0,
      },
      electron: {
        processCount: 0,
        currentCpuPercent: 0,
        cpuTimeMs: 0,
        currentRssBytes: 0,
        peakRssBytes: 0,
        ioReadBytes: 0,
        ioWriteBytes: 0,
        ioReadBytesPerSecond: 0,
        ioWriteBytesPerSecond: 0,
        processStarts: 0,
        processExits: 0,
      },
      monitor: {
        processCount: 0,
        currentCpuPercent: 0,
        cpuTimeMs: 0,
        currentRssBytes: 0,
        peakRssBytes: 0,
        ioReadBytes: 0,
        ioWriteBytes: 0,
        ioReadBytesPerSecond: 0,
        ioWriteBytesPerSecond: 0,
        processStarts: 0,
        processExits: 0,
      },
      allT3: {
        processCount: 2,
        currentCpuPercent: 22.5,
        cpuTimeMs: 16000,
        currentRssBytes: 384 * 1024 * 1024,
        peakRssBytes: 440 * 1024 * 1024,
        ioReadBytes: 0,
        ioWriteBytes: 0,
        ioReadBytesPerSecond: 0,
        ioWriteBytesPerSecond: 0,
        processStarts: 2,
        processExits: 0,
      },
    },
    power: {
      source: "node-macos-native",
      idle: "false",
      idleSeconds: 0,
      locked: "false",
      suspended: false,
      onBattery: "false",
      lowPowerMode: "false",
      thermalState: "nominal",
      stale: false,
      updatedAt: nowUtc,
    },
    speedLimitPercent: Option.none(),
    attribution: { readAt: nowUtc, entries: [] },
    health: {
      native: { status: "healthy", lastSampleAt: Option.some(nowUtc), lastError: Option.none() },
      desktop: { status: "stopped", lastSampleAt: Option.none(), lastError: Option.none() },
      sidecarVersion: Option.some("1.0.0"),
      sidecarPid: Option.some(2000),
      restartCount: 0,
      collectionDurationMicros: 500,
      scannedProcessCount: 10,
      retainedProcessCount: 2,
      inaccessibleProcessCount: 0,
    },
  };
}

function makeContextWindow(): ContextWindowSnapshot {
  return {
    usedTokens: 210_000,
    totalProcessedTokens: 540_000,
    maxTokens: 250_000,
    remainingTokens: 40_000,
    usedPercentage: 84,
    remainingPercentage: 16,
    inputTokens: 100_000,
    cachedInputTokens: 80_000,
    outputTokens: 600,
    reasoningOutputTokens: 120,
    lastUsedTokens: 210_000,
    lastInputTokens: 100_000,
    lastCachedInputTokens: 80_000,
    lastOutputTokens: 600,
    lastReasoningOutputTokens: 120,
    toolUses: 2,
    durationMs: 10_000,
    compactsAutomatically: true,
    autoCompactThreshold: 225_000,
    cost: null,
    updatedAt: "2026-11-23T11:58:10.000Z",
  };
}

function makeDiscoveredPort(): DiscoveredLocalServer {
  return {
    host: "127.0.0.1",
    port: 5173,
    url: "http://127.0.0.1:5173",
    processName: "vite",
    pid: 4040,
    terminal: { threadId: THREAD_ID, terminalId: "term-1" },
  };
}

function resetTestState() {
  useHudOptionsStore.getState().resetHudOptions();
  window.localStorage.removeItem(HUD_OPTIONS_STORAGE_KEY);
  useRightPanelStore.setState({ threadPanelVisibilityByThreadKey: {} });
  vi.mocked(useNowMinute).mockReturnValue(BASE_NOW_MINUTE);
  vi.mocked(useThreadError).mockReturnValue(null);
  vi.mocked(useQuietThreadShell).mockReturnValue(null);
  vi.mocked(useThreadDiscoveredPorts).mockReturnValue([]);
  vi.mocked(openSideThread).mockReset();
  vi.mocked(useResourceTelemetry).mockReturnValue({
    data: makeTelemetrySnapshot(),
    error: null,
    isPending: false,
    refresh: vi.fn(),
    retry: vi.fn(async () => makeTelemetrySnapshot()),
  });
}

describe("T3 Lab right-side Thread HUD", () => {
  it("renders B1–B7 cards, persists HUD display options, invokes /compact and subagent open, and gates System telemetry", async () => {
    using stack = new DisposableStack();
    stack.defer(() => {
      useHudOptionsStore.getState().resetHudOptions();
      window.localStorage.removeItem(HUD_OPTIONS_STORAGE_KEY);
      useRightPanelStore.setState({ threadPanelVisibilityByThreadKey: {} });
    });
    resetTestState();
    vi.mocked(useResourceTelemetry).mockClear();
    vi.mocked(useQuietThreadProjection).mockReturnValue(makeRichStructure());
    vi.mocked(useThreadDiscoveredPorts).mockReturnValue([makeDiscoveredPort()]);

    const onCompact = vi.fn();
    const usage: ThreadDetailsUsageInput = {
      providerInstanceId: PROVIDER_ID,
      model: "claude-sonnet-4-6",
      providers: [makeProviderWithLimits()],
      sources: EMPTY_SOURCES,
      contextWindow: makeContextWindow(),
    };

    await using screen = await render(
      <div className="w-[280px]">
        <ThreadHudHeader environmentId={ENV_ID} threadId={THREAD_ID} usage={usage} />
        <ThreadHudSections
          environmentId={ENV_ID}
          threadId={THREAD_ID}
          usage={usage}
          compactContext={{ onCompact, disabled: false, disabledReason: null }}
        />
      </div>,
    );

    // B1 Header: model switch reflected
    await expect
      .element(screen.getByTestId("hud-header-identity"))
      .toHaveTextContent("Claude · claude-opus-4-6");

    // B3 Context Lens: !200k+, warning tone, 4 buckets with ≈ and Compaction base, cache warm, /compact
    await expect.element(screen.getByTestId("hud-context-over-200k")).toHaveTextContent("!200k+");
    await expect
      .element(screen.getByTestId("hud-context-percent"))
      .toHaveAttribute("data-tone", "warning");
    const systemBaseBucket = screen.getByTestId("hud-context-bucket-systemBase");
    await expect.element(systemBaseBucket.getByText("Compaction base")).toBeVisible();
    await expect.element(systemBaseBucket.getByText(/^≈ /)).toBeVisible();
    await expect.element(screen.getByTestId("hud-autocompact-tick")).toBeInTheDocument();
    await expect.element(screen.getByTestId("hud-cache-hit-rate")).toHaveTextContent("80%");
    await expect
      .element(screen.getByTestId("hud-prompt-cache-status"))
      .toHaveAttribute("data-cache-state", "warm");

    await userEvent.click(screen.getByTestId("hud-compact-button"));
    expect(onCompact).toHaveBeenCalledTimes(1);

    // B4 Session KPIs: real tok/s, honest TTFT –, equal Span shown, Subscription, model delta
    const speedKpi = screen.getByTestId("hud-kpi-speed");
    await expect.element(speedKpi.getByText("60.0 tok/s")).toBeVisible();
    await expect.element(speedKpi.getByText("TTFT –")).toBeVisible();
    await expect
      .element(screen.getByTestId("hud-kpi-duration").getByText("Span 10s"))
      .toBeVisible();
    await expect
      .element(screen.getByTestId("hud-kpi-billing").getByText("Subscription"))
      .toBeVisible();
    await expect
      .element(screen.getByTestId("hud-kpi-model-delta").getByText("claude-opus-4-6"))
      .toBeVisible();

    // B5 Quota: directly visible countdown without hovering
    await expect.element(screen.getByTestId("hud-quota-card")).toBeVisible();
    await expect.element(screen.getByTestId("hud-quota-countdown")).toHaveTextContent("2h 15m");

    // B6 Activity: subagent model + accessible status + click navigation + partial-failure tool chip
    await expect.element(screen.getByTestId("hud-activity-card")).toBeVisible();
    const subagentRow = screen.getByTestId("hud-subagent-row");
    await expect.element(subagentRow.getByText("Metrics Auditor")).toBeVisible();
    await expect
      .element(subagentRow.getByTestId("hud-subagent-model"))
      .toHaveTextContent("claude-opus-4-6");
    await expect.element(subagentRow.getByText("Running,")).toBeInTheDocument();
    await userEvent.click(subagentRow);
    expect(openSideThread).toHaveBeenCalledTimes(1);
    await expect
      .element(screen.getByTestId("hud-tool-chip"))
      .toHaveAttribute("data-tool-status", "partial_failure");
    await expect.element(screen.getByTestId("hud-tool-failure-badge")).toHaveTextContent("!1");

    // B7 System: default collapsed with real T3 telemetry, expands to show categories, ports, Σ tokens
    expect(useResourceTelemetry).toHaveBeenCalledWith(ENV_ID);
    const systemToggle = screen.getByTestId("hud-system-toggle");
    await expect.element(systemToggle).toHaveAttribute("aria-expanded", "false");
    expect(screen.getByTestId("hud-system-summary").element().textContent).toContain("23%");
    await expect.element(screen.getByTestId("hud-system-details")).not.toBeInTheDocument();

    await userEvent.click(systemToggle);
    await expect.element(systemToggle).toHaveAttribute("aria-expanded", "true");
    await expect.element(screen.getByTestId("hud-system-category-provider")).toBeVisible();
    await expect.element(screen.getByTestId("hud-system-ports").getByText(":5173")).toBeVisible();
    // Sum of turn input (100k) + output (600) = 100.6k (~101k) preferred over snapshot occupancy
    await expect
      .element(screen.getByTestId("hud-system-total-tokens").getByText("Σ 101k"))
      .toBeVisible();

    // Closing the right panel unmounts System telemetry subscription
    vi.mocked(useResourceTelemetry).mockClear();
    await act(() => {
      useRightPanelStore
        .getState()
        .setThreadPanelOpen({ environmentId: ENV_ID, threadId: THREAD_ID }, "inline", false);
    });
    await expect.element(screen.getByTestId("hud-system-card")).not.toBeInTheDocument();
    expect(useResourceTelemetry).not.toHaveBeenCalled();

    // Reopen panel & toggle HUD display options in 🎛 menu + persist + reset
    await act(() => {
      useRightPanelStore
        .getState()
        .setThreadPanelOpen({ environmentId: ENV_ID, threadId: THREAD_ID }, "inline", true);
    });
    await userEvent.click(screen.getByTestId("hud-options-trigger"));
    await userEvent.click(page.getByRole("menuitemcheckbox", { name: "Context lens" }));
    await expect
      .element(page.getByRole("menuitemcheckbox", { name: "Context lens" }))
      .toHaveAttribute("aria-checked", "false");
    await expect.element(screen.getByTestId("hud-context-card")).not.toBeInTheDocument();
    const persisted = JSON.parse(window.localStorage.getItem(HUD_OPTIONS_STORAGE_KEY) ?? "{}");
    expect(persisted.showContext).toBe(false);

    await userEvent.click(page.getByTestId("hud-options-reset"));
    await expect.element(screen.getByTestId("hud-context-card")).toBeVisible();
    await expect
      .element(screen.getByTestId("hud-system-toggle"))
      .toHaveAttribute("aria-expanded", "false");
  });

  it("auto-hides unsupported Quota and empty Activity, never fabricates Session metrics, and exposes disabled compact tooltip", async () => {
    using stack = new DisposableStack();
    stack.defer(() => {
      useHudOptionsStore.getState().resetHudOptions();
      window.localStorage.removeItem(HUD_OPTIONS_STORAGE_KEY);
      useRightPanelStore.setState({ threadPanelVisibilityByThreadKey: {} });
    });
    resetTestState();

    const base = makeThreadProjectionFixture();
    vi.mocked(useQuietThreadProjection).mockReturnValue({
      environmentId: ENV_ID,
      projection: {
        ...base,
        thread: {
          ...base.thread,
          id: THREAD_ID,
          projectId: PROJECT_ID,
          title: "Fresh thread",
          providerInstanceId: PROVIDER_ID,
          activeProviderThreadId: PROVIDER_THREAD_ID,
          modelSelection: { instanceId: PROVIDER_ID, model: "replay-dev" },
        },
        providerTurns: [
          {
            id: ProviderTurnId.make("turn-cold"),
            providerThreadId: PROVIDER_THREAD_ID,
            nodeId: NodeId.make("node-cold"),
            runAttemptId: null,
            nativeTurnRef: null,
            ordinal: 1,
            status: "completed",
            startedAt: utc("2026-11-23T11:00:00.000Z"),
            completedAt: utc("2026-11-23T11:00:01.000Z"),
            tokenUsage: {
              usedTokens: 12_000,
              maxTokens: 200_000,
              inputTokens: 10_000,
              cachedInputTokens: 5_000,
              promptCacheExpiresAt: new Date(secondTick.getSnapshot() - 60_000).toISOString(),
              updatedAt: "2026-11-23T11:00:01.000Z",
            },
          },
        ],
      },
    });

    // Provider reports unsupported usage limits (0 windows) -> HUD Quota auto-hides & Session is NOT "Subscription"
    const usage: ThreadDetailsUsageInput = {
      providerInstanceId: PROVIDER_ID,
      model: "replay-dev",
      providers: [makeProviderWithLimits({ unsupported: true })],
      sources: EMPTY_SOURCES,
      contextWindow: null,
    };

    const disabledReason = "Wait for the current turn to finish before compacting.";
    await using screen = await render(
      <div className="w-[280px]">
        <ThreadHudSections
          environmentId={ENV_ID}
          threadId={THREAD_ID}
          usage={usage}
          compactContext={{
            onCompact: vi.fn(),
            disabled: true,
            disabledReason,
          }}
        />
      </div>,
    );

    // Quota & Activity auto-hide
    await expect.element(screen.getByTestId("hud-quota-card")).not.toBeInTheDocument();
    await expect.element(screen.getByTestId("hud-activity-card")).not.toBeInTheDocument();

    // Context shows System base (no compaction), Cold cache status, and disabled Compact button with tooltip
    await expect
      .element(screen.getByTestId("hud-context-bucket-systemBase").getByText("System base"))
      .toBeVisible();
    await expect
      .element(screen.getByTestId("hud-prompt-cache-status"))
      .toHaveAttribute("data-cache-state", "cold");
    const compactButton = screen.getByTestId("hud-compact-button");
    await expect.element(compactButton).toBeDisabled();
    await userEvent.hover(compactButton);
    await expect.element(page.getByText(disabledReason)).toBeVisible();

    // Session displays honest – placeholders (never 0 tok/s, $0.00, or false Subscription)
    const emptySpeedText = screen.getByTestId("hud-kpi-speed").element().textContent ?? "";
    expect(emptySpeedText).toContain("–");
    expect(emptySpeedText).not.toContain("0 tok/s");
    const emptyBillingText = screen.getByTestId("hud-kpi-billing").element().textContent ?? "";
    expect(emptyBillingText).toContain("–");
    expect(emptyBillingText).not.toContain("$0.00");
    expect(emptyBillingText).not.toContain("Subscription");
  });

  it("unsubscribes System telemetry on narrow popover close, keeps popover open during HUD menu interaction, and reverses legacy Usage/Context cleanly", async () => {
    const initialSettings = getClientSettings();
    using stack = new DisposableStack();
    const anchor = document.createElement("div");
    document.body.append(anchor);
    stack.defer(() => {
      anchor.remove();
      useHudOptionsStore.getState().resetHudOptions();
      window.localStorage.removeItem(HUD_OPTIONS_STORAGE_KEY);
      useRightPanelStore.setState({ threadPanelVisibilityByThreadKey: {} });
      updateClientSettings({
        threadDetailsItems: initialSettings.threadDetailsItems,
        threadDetailsUsageEnabled: initialSettings.threadDetailsUsageEnabled,
      });
    });

    resetTestState();
    vi.mocked(useProject).mockReturnValue({
      id: PROJECT_ID,
      environmentId: ENV_ID,
      title: "hud-project",
      workspaceRoot: "/work/hud",
      repositoryIdentity: null,
      defaultModelSelection: null,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      scripts: [],
    });
    vi.mocked(useProjects).mockReturnValue([]);
    vi.mocked(useServerConfigs).mockReturnValue(new Map());
    vi.mocked(useQuietThreadProjection).mockReturnValue(makeRichStructure());
    updateClientSettings({
      threadDetailsItems: { usage: true, context: true },
      threadDetailsUsageEnabled: true,
    });

    // Narrow canvas -> detailsCardPlacement is null (popover mode), while inline preference still defaults true!
    const container = { width: 900, height: 600 };
    const threadRef = { environmentId: ENV_ID, threadId: THREAD_ID };
    const handle = PopoverCreateHandle();
    const noop = () => {};
    const scriptResult = async () => ({ ok: true }) as never;
    const usage: ThreadDetailsUsageInput = {
      providerInstanceId: PROVIDER_ID,
      model: "claude-sonnet-4-6",
      providers: [makeProviderWithLimits()],
      sources: EMPTY_SOURCES,
      contextWindow: makeContextWindow(),
    };

    vi.mocked(useResourceTelemetry).mockClear();
    await using _screen = await render(
      <ChatCanvasContext
        value={{
          container,
          lane: { padding: 48, minChatWidth: 640 },
          layout: resolveChatCanvasLayout({ container, preview: null }),
          previewKey: null,
          registerTimeline: noop,
          measureDetailsCard: noop,
          detailsCardTopInset: 0,
          preferredDetailsCard: null,
          detailsCardPlacement: null,
        }}
      >
        <ThreadDetailsPanel
          anchor={{ current: anchor }}
          handle={handle}
          environmentId={ENV_ID}
          threadId={THREAD_ID}
          projectId={PROJECT_ID}
          composerDraftTarget={threadRef}
          worktreePath={null}
          isServerThread
          activeProjectName="hud-project"
          activeProjectScripts={undefined}
          preferredScriptId={null}
          keybindings={[]}
          availableEditors={[]}
          showOpenInPicker={false}
          openInShortcutEnabled={false}
          gitCwd="/work/hud"
          workspaceMutationId={null}
          isGitRepo={false}
          offersWorkspaceModes={false}
          envLocked
          availableEnvironments={[]}
          onEnvModeChange={noop}
          envMode="local"
          startFromOrigin={false}
          onStartFromOriginChange={noop}
          onComposerFocusRequest={noop}
          onRunProjectScript={noop}
          onAddProjectScript={scriptResult}
          onUpdateProjectScript={scriptResult}
          onDeleteProjectScript={scriptResult}
          usage={usage}
        />
      </ChatCanvasContext>,
    );

    // Popover starts closed -> even though inline pref defaults true, System telemetry MUST NOT subscribe
    expect(useResourceTelemetry).not.toHaveBeenCalled();

    // Open narrow popover -> HUD mounts, System subscribes, legacy Context/Usage are deduplicated
    await act(() => {
      useRightPanelStore.getState().setThreadPanelOpen(threadRef, "popover", true);
    });
    await expect.element(page.getByTestId("hud-context-card")).toBeVisible();
    await expect.element(page.getByTestId("hud-quota-card")).toBeVisible();
    expect(useResourceTelemetry).toHaveBeenCalledWith(ENV_ID);
    await expect
      .element(page.getByRole("region", { name: "Context window" }))
      .not.toBeInTheDocument();

    // Open 🎛 menu inside popover & disable Context lens + Quota limits -> popover stays open and legacy rows restore
    await userEvent.click(page.getByTestId("hud-options-trigger"));
    await userEvent.click(page.getByRole("menuitemcheckbox", { name: "Context lens" }));
    await expect.element(page.getByTestId("hud-header")).toBeVisible();
    await expect.element(page.getByTestId("hud-context-card")).not.toBeInTheDocument();
    await expect.element(page.getByRole("region", { name: "Context window" })).toBeVisible();

    await userEvent.click(page.getByRole("menuitemcheckbox", { name: "Quota limits" }));
    await expect.element(page.getByTestId("hud-quota-card")).not.toBeInTheDocument();
    await expect.element(page.getByRole("region", { name: "Usage limits" })).toBeVisible();

    // Close narrow popover -> System card unmounts and telemetry hook is no longer called
    vi.mocked(useResourceTelemetry).mockClear();
    await act(() => {
      useRightPanelStore.getState().setThreadPanelOpen(threadRef, "popover", false);
    });
    await expect.element(page.getByTestId("hud-system-card")).not.toBeInTheDocument();
    expect(useResourceTelemetry).not.toHaveBeenCalled();
  });
});
