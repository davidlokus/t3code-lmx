import { scopeThreadRef } from "@t3tools/client-runtime/environment";
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
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { Atom } from "effect/reactivity";
import { describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import { act, render } from "../../../test/render";
import { useNowMinute } from "../../hooks/useNowMinute";
import { openSideThread } from "../../lib/sideChatPane";
import { selectActiveRightPanelSurface, useRightPanelStore } from "../../rightPanelStore";
import { AppAtomRegistryProvider } from "../../rpc/atomRegistry";
import { useQuietThreadProjection } from "../../state/entities";
import { serverEnvironment } from "../../state/server";
import { environmentThreadDetails } from "../../state/threads";
import { makeThreadProjectionFixture } from "../../test-fixtures";
import { HUD_OPTIONS_STORAGE_KEY, useHudOptionsStore } from "../hud/hudOptionsStore";
import { ComposerTelemetryControl } from "./ComposerTelemetryControl";

vi.mock("../../state/entities", { spy: true });
vi.mock("../../hooks/useNowMinute", { spy: true });
vi.mock("../../lib/sideChatPane", { spy: true });
vi.mock("../../state/server", { spy: true });
vi.mock("../../state/threads", { spy: true });

const ENV_ID = EnvironmentId.make("env-local");
const THREAD_ID = ThreadId.make("thread-telemetry-1");
const CHILD_THREAD_ID = ThreadId.make("thread-child-1");
const PROJECT_ID = ProjectId.make("proj-telemetry-1");
const PROVIDER_DRIVER = ProviderDriverKind.make("omp");
const PROVIDER_ID = ProviderInstanceId.make("omp");
const PROVIDER_THREAD_ID = ProviderThreadId.make("pt-telemetry-1");
const THREAD_REF = scopeThreadRef(ENV_ID, THREAD_ID);
const BASE_NOW_MINUTE = "2026-11-26T12:00";

const EMPTY_SETTINGS_ATOM = Atom.make(null).pipe(Atom.keepAlive);
const EMPTY_CHILD_ATOM = Atom.make<EnvironmentThreadStructure | null>(null).pipe(Atom.keepAlive);

function utc(iso: string) {
  return DateTime.makeUnsafe(iso);
}

function makeRichStructure(): EnvironmentThreadStructure {
  const base = makeThreadProjectionFixture();
  const run1Start = utc("2026-11-26T11:57:00.000Z");
  const run1End = utc("2026-11-26T11:57:20.000Z");
  const run2Start = utc("2026-11-26T11:58:00.000Z");
  const run2End = utc("2026-11-26T11:58:10.000Z");

  return {
    environmentId: ENV_ID,
    projection: {
      ...base,
      thread: {
        ...base.thread,
        id: THREAD_ID,
        projectId: PROJECT_ID,
        title: "Telemetry test thread",
        providerInstanceId: PROVIDER_ID,
        activeProviderThreadId: PROVIDER_THREAD_ID,
        modelSelection: {
          instanceId: PROVIDER_ID,
          model: "anthropic/claude-sonnet-4-6",
        },
      },
      runs: [
        {
          id: RunId.make("run-1"),
          threadId: THREAD_ID,
          ordinal: 1,
          providerInstanceId: PROVIDER_ID,
          modelSelection: { instanceId: PROVIDER_ID, model: "anthropic/claude-sonnet-4-6" },
          providerThreadId: PROVIDER_THREAD_ID,
          userMessageId: MessageId.make("msg-1"),
          rootNodeId: NodeId.make("node-root-1"),
          activeAttemptId: null,
          status: "completed",
          requestedAt: run1Start,
          startedAt: run1Start,
          workStartedAt: run1Start,
          completedAt: run1End,
          checkpointId: null,
          contextHandoffId: null,
        },
        {
          id: RunId.make("run-2"),
          threadId: THREAD_ID,
          ordinal: 2,
          providerInstanceId: PROVIDER_ID,
          modelSelection: { instanceId: PROVIDER_ID, model: "anthropic/claude-sonnet-4-6" },
          providerThreadId: PROVIDER_THREAD_ID,
          userMessageId: MessageId.make("msg-2"),
          rootNodeId: NodeId.make("node-root-2"),
          activeAttemptId: null,
          status: "completed",
          requestedAt: run2Start,
          startedAt: run2Start,
          workStartedAt: run2Start,
          completedAt: run2End,
          checkpointId: null,
          contextHandoffId: null,
        },
      ],
      providerTurns: [
        {
          id: ProviderTurnId.make("turn-1"),
          providerThreadId: PROVIDER_THREAD_ID,
          nodeId: NodeId.make("node-root-1"),
          runAttemptId: null,
          nativeTurnRef: null,
          ordinal: 1,
          status: "completed",
          startedAt: run1Start,
          completedAt: run1End,
          model: "anthropic/claude-sonnet-4-6",
          tokenUsage: {
            usedTokens: 120_000,
            maxTokens: 512_000,
            inputTokens: 118_000,
            cachedInputTokens: 90_000,
            outputTokens: 2_000,
            reasoningOutputTokens: 400,
            updatedAt: "2026-11-26T11:57:20.000Z",
          },
          turnTokenUsage: {
            usageScope: "main_agent",
            usageStatus: "complete",
            inputTokens: 118_000,
            cachedInputTokens: 90_000,
            cacheCreationTokens: 8_000,
            outputTokens: 2_000,
            reasoningTokens: 400,
            requestCount: 3,
            costUsd: 0.42,
            hasSubagents: true,
            models: ["anthropic/claude-sonnet-4-6"],
          },
        },
        {
          id: ProviderTurnId.make("turn-2"),
          providerThreadId: PROVIDER_THREAD_ID,
          nodeId: NodeId.make("node-root-2"),
          runAttemptId: null,
          nativeTurnRef: null,
          ordinal: 2,
          status: "completed",
          startedAt: run2Start,
          completedAt: run2End,
          model: "anthropic/claude-sonnet-4-6",
          tokenUsage: {
            usedTokens: 180_900,
            maxTokens: 512_000,
            inputTokens: 180_900,
            cachedInputTokens: 178_800,
            outputTokens: 1_500,
            reasoningOutputTokens: 300,
            updatedAt: "2026-11-26T11:58:10.000Z",
          },
          turnTokenUsage: {
            usageScope: "main_agent",
            usageStatus: "complete",
            inputTokens: 180_900,
            cachedInputTokens: 178_800,
            cacheCreationTokens: 0,
            outputTokens: 1_500,
            reasoningTokens: 300,
            requestCount: 2,
            costUsd: 0.25,
            hasSubagents: true,
            models: ["anthropic/claude-sonnet-4-6"],
          },
        },
      ],
      turnItems: [
        {
          id: TurnItemId.make("item-user-1"),
          threadId: THREAD_ID,
          runId: RunId.make("run-1"),
          nodeId: null,
          providerThreadId: PROVIDER_THREAD_ID,
          providerTurnId: ProviderTurnId.make("turn-1"),
          nativeItemRef: null,
          parentItemId: null,
          ordinal: 1,
          status: "completed",
          title: null,
          startedAt: run1Start,
          completedAt: run1Start,
          updatedAt: run1Start,
          type: "user_message",
          messageId: MessageId.make("msg-1"),
          text: "Analyze architecture across modules.",
          attachments: [],
          inputIntent: "turn_start",
          createdBy: "user",
          creationSource: "web",
        },
        {
          id: TurnItemId.make("item-tool-1"),
          threadId: THREAD_ID,
          runId: RunId.make("run-1"),
          nodeId: null,
          providerThreadId: PROVIDER_THREAD_ID,
          providerTurnId: ProviderTurnId.make("turn-1"),
          nativeItemRef: null,
          parentItemId: null,
          ordinal: 2,
          status: "completed",
          title: "Shell",
          startedAt: utc("2026-11-26T11:57:02.000Z"),
          completedAt: utc("2026-11-26T11:57:08.000Z"),
          updatedAt: utc("2026-11-26T11:57:08.000Z"),
          type: "command_execution",
          input: "git status",
          output: "clean workspace output".repeat(40),
          exitCode: 0,
        },
        {
          id: TurnItemId.make("item-mcp-1"),
          threadId: THREAD_ID,
          runId: RunId.make("run-1"),
          nodeId: null,
          providerThreadId: PROVIDER_THREAD_ID,
          providerTurnId: ProviderTurnId.make("turn-1"),
          nativeItemRef: null,
          parentItemId: null,
          ordinal: 3,
          status: "completed",
          title: "MCP search",
          startedAt: utc("2026-11-26T11:57:04.000Z"),
          completedAt: utc("2026-11-26T11:57:10.000Z"),
          updatedAt: utc("2026-11-26T11:57:10.000Z"),
          type: "dynamic_tool",
          toolName: "find",
          toolSource: { key: "mcp:openviking", name: "OpenViking", kind: "integration" },
          input: { query: "architecture" },
          output: { summary: "found notes".repeat(30) },
        },
        {
          id: TurnItemId.make("item-subagent-1"),
          threadId: THREAD_ID,
          runId: RunId.make("run-1"),
          nodeId: NodeId.make("sub-native-1"),
          providerThreadId: PROVIDER_THREAD_ID,
          providerTurnId: ProviderTurnId.make("turn-1"),
          nativeItemRef: { driver: PROVIDER_DRIVER, nativeId: "scout-1", strength: "strong" },
          parentItemId: null,
          ordinal: 4,
          status: "completed",
          title: "ServerView (scout)",
          startedAt: run1Start,
          completedAt: run1End,
          updatedAt: run1End,
          type: "subagent",
          subagentId: NodeId.make("sub-native-1"),
          origin: "provider_native",
          driver: PROVIDER_DRIVER,
          providerInstanceId: PROVIDER_ID,
          childThreadId: null,
          prompt: "Inspect server runtime architecture across modules",
          result: "Detailed server runtime findings".repeat(30),
        },
        {
          id: TurnItemId.make("item-assistant-2"),
          threadId: THREAD_ID,
          runId: RunId.make("run-2"),
          nodeId: null,
          providerThreadId: PROVIDER_THREAD_ID,
          providerTurnId: ProviderTurnId.make("turn-2"),
          nativeItemRef: null,
          parentItemId: null,
          ordinal: 5,
          status: "completed",
          title: null,
          startedAt: utc("2026-11-26T11:58:02.000Z"),
          completedAt: run2End,
          type: "assistant_message",
          messageId: MessageId.make("msg-a2"),
          streaming: false,
        },
      ],
      messages: [
        {
          id: MessageId.make("msg-a2"),
          threadId: THREAD_ID,
          runId: RunId.make("run-2"),
          nodeId: null,
          role: "assistant",
          text: "Architecture report complete.".repeat(60),
          attachments: [],
          streaming: false,
          createdBy: "agent",
          creationSource: "provider",
          createdAt: utc("2026-11-26T11:58:02.000Z"),
          updatedAt: run2End,
        },
      ],
      subagents: [
        {
          id: NodeId.make("sub-native-1"),
          threadId: THREAD_ID,
          runId: RunId.make("run-1"),
          parentNodeId: NodeId.make("node-root-1"),
          origin: "provider_native",
          createdBy: "agent",
          driver: PROVIDER_DRIVER,
          providerInstanceId: PROVIDER_ID,
          providerThreadId: PROVIDER_THREAD_ID,
          childThreadId: null,
          nativeTaskRef: { driver: PROVIDER_DRIVER, nativeId: "scout-1", strength: "strong" },
          prompt: "Inspect server runtime",
          title: "ServerView (scout)",
          model: "anthropic/claude-sonnet-4-6",
          status: "completed",
          result: "Detailed server runtime findings".repeat(30),
          usage: {
            totalTokens: 61_400,
            inputTokens: 58_000,
            cachedInputTokens: 52_000,
            outputTokens: 3_400,
            contextTokens: 204_400,
            contextWindow: 512_000,
            requests: 6,
            toolUses: 9,
            durationMs: 25_000,
            costUsd: 0.18,
          },
          startedAt: run1Start,
          completedAt: run1End,
          updatedAt: run1End,
        },
        {
          id: NodeId.make("sub-child-1"),
          threadId: THREAD_ID,
          runId: RunId.make("run-2"),
          parentNodeId: NodeId.make("node-root-2"),
          origin: "app_owned",
          createdBy: "agent",
          driver: PROVIDER_DRIVER,
          providerInstanceId: PROVIDER_ID,
          providerThreadId: PROVIDER_THREAD_ID,
          childThreadId: CHILD_THREAD_ID,
          nativeTaskRef: null,
          prompt: "Verify UI",
          title: "UI Verifier",
          model: "gpt-5.4",
          status: "completed",
          result: "Verified UI",
          usage: {
            totalTokens: 12_000,
            requests: 2,
            toolUses: 4,
            durationMs: 8_000,
            costUsd: 0.05,
          },
          startedAt: run2Start,
          completedAt: run2End,
          updatedAt: run2End,
        },
      ],
    },
  };
}

function makeContextWindow(): ContextWindowSnapshot {
  return {
    usedTokens: 180_900,
    totalProcessedTokens: null,
    maxTokens: 512_000,
    remainingTokens: 331_100,
    usedPercentage: (180_900 / 512_000) * 100,
    remainingPercentage: (331_100 / 512_000) * 100,
    inputTokens: 180_900,
    cachedInputTokens: 178_800,
    outputTokens: 1_500,
    reasoningOutputTokens: 300,
    lastUsedTokens: null,
    lastInputTokens: 180_900,
    lastCachedInputTokens: 178_800,
    lastOutputTokens: 1_500,
    lastReasoningOutputTokens: 300,
    toolUses: null,
    durationMs: null,
    compactsAutomatically: true,
    autoCompactThreshold: 400_000,
    cost: null,
    updatedAt: "2026-11-26T11:58:10.000Z",
  };
}

function setupTelemetryTestEnv(): Disposable {
  window.localStorage.removeItem(HUD_OPTIONS_STORAGE_KEY);
  useHudOptionsStore.getState().resetHudOptions();
  useRightPanelStore.setState({ byThreadKey: {}, threadPanelVisibilityByThreadKey: {} });
  vi.mocked(useNowMinute).mockReturnValue(BASE_NOW_MINUTE);
  vi.mocked(serverEnvironment.settingsValueAtom).mockReturnValue(EMPTY_SETTINGS_ATOM as never);
  vi.mocked(environmentThreadDetails.quietThreadAtom).mockReturnValue(EMPTY_CHILD_ATOM as never);
  vi.mocked(openSideThread).mockReset();
  return {
    [Symbol.dispose]: () => {
      window.localStorage.removeItem(HUD_OPTIONS_STORAGE_KEY);
      useHudOptionsStore.getState().resetHudOptions();
      useRightPanelStore.setState({ byThreadKey: {}, threadPanelVisibilityByThreadKey: {} });
    },
  };
}

describe("ComposerTelemetryControl", () => {
  it("renders the ring trigger, switches between Context window and Session stats, opens subagents, and omits middle dots", async () => {
    using _env = setupTelemetryTestEnv();
    vi.mocked(useQuietThreadProjection).mockReturnValue(makeRichStructure());
    const onCompact = vi.fn();

    await using screen = await render(
      <AppAtomRegistryProvider>
        <ComposerTelemetryControl
          threadRef={THREAD_REF}
          requestedModel="anthropic/claude-sonnet-4-6"
          contextWindow={makeContextWindow()}
          compactContext={{ onCompact, disabled: false, disabledReason: null }}
        />
      </AppAtomRegistryProvider>,
    );

    const trigger = screen.getByTestId("composer-telemetry-trigger");
    await expect.element(trigger).toBeVisible();
    await expect.element(trigger).toHaveTextContent("35.3%");

    await userEvent.click(trigger);

    const popover = page.getByTestId("composer-telemetry-popover");
    await expect.element(popover).toBeVisible();
    await expect
      .element(page.getByTestId("composer-telemetry-context-used"))
      .toHaveTextContent("Used 35.3%");
    await expect.element(page.getByTestId("composer-telemetry-bucket-messages")).toBeVisible();
    await expect.element(page.getByTestId("composer-telemetry-bucket-systemBase")).toBeVisible();
    await expect.element(page.getByTestId("composer-telemetry-bucket-tools")).toBeVisible();
    await expect.element(page.getByTestId("composer-telemetry-bucket-mcpTools")).toBeVisible();
    await expect.element(page.getByTestId("composer-telemetry-bucket-subagents")).toBeVisible();
    await expect.element(page.getByTestId("composer-telemetry-bucket-remaining")).toBeVisible();
    await expect
      .element(page.getByTestId("composer-telemetry-cache-split"))
      .toMatchTextContent(/98\.8%/);
    await expect
      .element(page.getByTestId("composer-telemetry-subagents"))
      .toMatchTextContent(/ServerView \(scout\)/);
    expect(popover.element().textContent ?? "").not.toContain("·");

    // Switch to Session stats tab and verify cumulative stats, expandable details, timing, and subagent summary.
    await userEvent.click(page.getByTestId("composer-telemetry-tab-session"));
    await expect.element(page.getByTestId("composer-telemetry-session-panel")).toBeVisible();
    await expect
      .element(page.getByTestId("composer-telemetry-stat-turns"))
      .toMatchTextContent(/2 \/ 5/);
    await expect
      .element(page.getByTestId("composer-telemetry-stat-cost"))
      .toMatchTextContent(/\$0\.67/);
    await expect
      .element(page.getByTestId("composer-telemetry-stat-tool-time"))
      .toMatchTextContent(/8s/);
    await expect
      .element(page.getByTestId("composer-telemetry-stat-model-time"))
      .toMatchTextContent(/22s/);
    await expect
      .element(page.getByTestId("composer-telemetry-subagent-summary"))
      .toMatchTextContent(/\$0\.23/);
    await expect
      .element(page.getByTestId("composer-telemetry-combined-cost"))
      .toMatchTextContent(/\$0\.90/);

    await userEvent.click(page.getByTestId("composer-telemetry-more-stats-toggle"));
    await expect.element(page.getByTestId("composer-telemetry-more-stats")).toBeVisible();
    await expect
      .element(page.getByTestId("composer-telemetry-stat-requests"))
      .toMatchTextContent(/5/);
    await expect.element(page.getByTestId("composer-telemetry-stat-tools")).toMatchTextContent(/2/);
    expect(popover.element().textContent ?? "").not.toContain("·");

    // Switch back to Context tab and click native subagent -> opens right-panel native inspector and closes popover.
    await userEvent.click(page.getByTestId("composer-telemetry-tab-context"));
    await userEvent.click(page.getByRole("button", { name: /ServerView \(scout\)/ }));
    expect(
      selectActiveRightPanelSurface(useRightPanelStore.getState().byThreadKey, THREAD_REF),
    ).toMatchObject({
      kind: "subagent",
      subagentId: NodeId.make("sub-native-1"),
      title: "ServerView (scout)",
    });

    // Reopen and click child-thread subagent -> calls openSideThread.
    await userEvent.click(trigger);
    await userEvent.click(page.getByRole("button", { name: /UI Verifier/ }));
    expect(openSideThread).toHaveBeenCalledTimes(1);
  });

  it("hides immediately via popover toggle, persists preference, and restores when re-enabled", async () => {
    using _env = setupTelemetryTestEnv();
    vi.mocked(useQuietThreadProjection).mockReturnValue(makeRichStructure());

    await using screen = await render(
      <AppAtomRegistryProvider>
        <ComposerTelemetryControl
          threadRef={THREAD_REF}
          requestedModel="anthropic/claude-sonnet-4-6"
          contextWindow={makeContextWindow()}
        />
      </AppAtomRegistryProvider>,
    );

    await userEvent.click(screen.getByTestId("composer-telemetry-trigger"));
    await userEvent.click(page.getByTestId("composer-telemetry-hide"));

    expect(useHudOptionsStore.getState().showComposerRing).toBe(false);
    expect(
      JSON.parse(window.localStorage.getItem(HUD_OPTIONS_STORAGE_KEY) ?? "{}").showComposerRing,
    ).toBe(false);
    await expect.element(screen.getByTestId("composer-telemetry-trigger")).not.toBeInTheDocument();

    await act(() => {
      useHudOptionsStore.getState().setCardVisible("showComposerRing", true);
    });
    await expect.element(screen.getByTestId("composer-telemetry-trigger")).toBeVisible();
  });

  it("renders nothing on a fresh thread without context usage or turns", async () => {
    using _env = setupTelemetryTestEnv();
    vi.mocked(useQuietThreadProjection).mockReturnValue({
      environmentId: ENV_ID,
      projection: makeThreadProjectionFixture(),
    });

    await using screen = await render(
      <AppAtomRegistryProvider>
        <ComposerTelemetryControl
          threadRef={THREAD_REF}
          requestedModel="anthropic/claude-sonnet-4-6"
          contextWindow={null}
        />
      </AppAtomRegistryProvider>,
    );

    await expect.element(screen.getByTestId("composer-telemetry-trigger")).not.toBeInTheDocument();
  });
});
