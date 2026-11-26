import type { ContextWindowSnapshot } from "@t3tools/client-runtime/state/context-window";
import type {
  ThreadStructure,
  ThreadStructureTurnItem,
} from "@t3tools/client-runtime/state/models";
import {
  EnvironmentId,
  MessageId,
  NodeId,
  PlanId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderThreadId,
  ProviderTurnId,
  RunId,
  ThreadId,
  TurnItemId,
  UsageLimitSourceId,
  type OrchestrationV2ProviderTurn,
  type OrchestrationV2Run,
  type OrchestrationV2Subagent,
  type ResourceTelemetryProcess,
  type ResourceTelemetrySnapshot,
  type ServerProvider,
  type ServerProviderUsageLimits,
  type TurnTokenUsage,
  type UsageLimitSourceSnapshot,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";
import { describe, expect, it, vi } from "vite-plus/test";
import { makeThreadProjectionFixture } from "../../test-fixtures";
import {
  deriveHudActivityMetrics,
  deriveHudContextMetrics,
  deriveHudHeaderSummary,
  deriveHudSessionMetrics,
  deriveHudSystemMetrics,
  derivePromptCacheCountdown,
  formatHudCompactDuration,
  resolveOmpThreadHudLimits,
} from "./hudMetrics.logic";
import {
  isDefaultHudUiOptions,
  parseHudUiOptions,
  readPersistedHudUiOptions,
} from "./hudOptionsStore";

const NOW = Date.parse("2026-01-01T00:01:00.000Z");
const at = (offset = 0) => DateTime.makeUnsafe(NOW + offset);
const iso = (offset = 0) => DateTime.formatIso(at(offset));
const ACTIVE_THREAD = ProviderThreadId.make("provider-active");
const RETIRED_THREAD = ProviderThreadId.make("provider-retired");
const BASE = makeThreadProjectionFixture();

function projection(overrides: Partial<ThreadStructure> = {}): ThreadStructure {
  return {
    ...BASE,
    thread: { ...BASE.thread, activeProviderThreadId: ACTIVE_THREAD },
    ...overrides,
  };
}

function contextWindow(overrides: Partial<ContextWindowSnapshot> = {}): ContextWindowSnapshot {
  return {
    usedTokens: 100,
    maxTokens: 1_000,
    remainingTokens: 900,
    usedPercentage: 10,
    remainingPercentage: 90,
    totalProcessedTokens: null,
    inputTokens: null,
    cachedInputTokens: null,
    outputTokens: null,
    reasoningOutputTokens: null,
    lastUsedTokens: null,
    lastInputTokens: null,
    lastCachedInputTokens: null,
    lastOutputTokens: null,
    lastReasoningOutputTokens: null,
    toolUses: null,
    durationMs: null,
    compactsAutomatically: null,
    autoCompactThreshold: null,
    cost: null,
    updatedAt: iso(),
    ...overrides,
  };
}

function turn(
  ordinal: number,
  fields: Partial<OrchestrationV2ProviderTurn> = {},
): OrchestrationV2ProviderTurn {
  return {
    id: ProviderTurnId.make(`turn-${ordinal}`),
    providerThreadId: ACTIVE_THREAD,
    nodeId: NodeId.make(`node-${ordinal}`),
    runAttemptId: null,
    nativeTurnRef: null,
    ordinal,
    status: "completed",
    startedAt: at(-3_000),
    completedAt: at(-1_000),
    ...fields,
  };
}

function tokenUsage(
  inputTokens: number,
  cachedInputTokens: number,
  outputTokens = 0,
): TurnTokenUsage {
  return {
    usageScope: "main_agent",
    usageStatus: "complete",
    hasSubagents: false,
    inputTokens,
    cachedInputTokens,
    outputTokens,
  };
}

function itemBase(ordinal: number) {
  return {
    id: TurnItemId.make(`item-${ordinal}`),
    threadId: BASE.thread.id,
    runId: null,
    nodeId: null,
    providerThreadId: ACTIVE_THREAD,
    providerTurnId: null,
    nativeItemRef: null,
    parentItemId: null,
    ordinal,
    status: "completed" as const,
    title: null,
    startedAt: null,
    completedAt: at(-5_000),
    updatedAt: at(-5_000),
  };
}

function userItem(ordinal: number, text: string) {
  return {
    ...itemBase(ordinal),
    type: "user_message" as const,
    createdBy: "user" as const,
    creationSource: "web" as const,
    inputIntent: "turn_start" as const,
    messageId: MessageId.make(`message-${ordinal}`),
    text,
    attachments: [],
  };
}

function message(
  ordinal: number,
  role: "user" | "assistant",
  text: string,
  streaming = false,
): ThreadStructure["messages"][number] {
  return {
    id: MessageId.make(`message-${ordinal}`),
    threadId: BASE.thread.id,
    runId: null,
    nodeId: null,
    role,
    text,
    attachments: [],
    streaming,
    createdBy: role === "user" ? "user" : "agent",
    creationSource: "web",
    createdAt: at(),
    updatedAt: at(),
  };
}

function context(overrides: Partial<Parameters<typeof deriveHudContextMetrics>[0]> = {}) {
  return deriveHudContextMetrics({
    contextWindow: null,
    liveTokenUsage: null,
    projection: null,
    requestedModel: "selected",
    nowMs: NOW,
    ...overrides,
  });
}

function session(overrides: Partial<Parameters<typeof deriveHudSessionMetrics>[0]> = {}) {
  return deriveHudSessionMetrics({
    contextWindow: null,
    projection: null,
    requestedModel: null,
    hasQuotaLimits: false,
    nowMs: NOW,
    ...overrides,
  });
}

function run(ordinal: number, fields: Partial<OrchestrationV2Run>): OrchestrationV2Run {
  return {
    id: RunId.make(`run-${ordinal}`),
    threadId: BASE.thread.id,
    providerInstanceId: BASE.thread.providerInstanceId,
    modelSelection: BASE.thread.modelSelection,
    providerThreadId: ACTIVE_THREAD,
    userMessageId: MessageId.make(`user-${ordinal}`),
    rootNodeId: null,
    activeAttemptId: null,
    ordinal,
    status: "completed",
    requestedAt: at(-70_000),
    startedAt: at(-70_000),
    completedAt: at(-40_000),
    checkpointId: null,
    contextHandoffId: null,
    ...fields,
  };
}

const DEFAULT_OPTIONS = {
  showContext: true,
  showSession: true,
  showQuota: true,
  showActivity: true,
  showSystem: true,
  systemExpanded: false,
};

function stubStorage(localStorage: Pick<Storage, "getItem" | "setItem">): Disposable {
  vi.stubGlobal("window", { localStorage });
  // A fresh import must read the staged browser storage during store initialization.
  vi.resetModules();
  return {
    [Symbol.dispose]: () => {
      vi.unstubAllGlobals();
      vi.resetModules();
    },
  };
}

describe("HUD display preferences", () => {
  it("persists toggles and System expansion, loads them on reload, and resets to defaults", async () => {
    const key = "t3lab:hud-ui:v1";
    const data = new Map([[key, '{"showContext":false,"showQuota":"invalid","ignored":true}']]);
    const storage = {
      getItem: (name: string) => data.get(name) ?? null,
      setItem: (name: string, value: string) => {
        data.set(name, value);
      },
    };
    using _storage = stubStorage(storage);
    const { useHudOptionsStore: oldStore } = await import("./hudOptionsStore");
    const state = oldStore.getState();
    expect(state).toMatchObject({ ...DEFAULT_OPTIONS, showContext: false });
    state.toggleCard("showContext");
    state.setCardVisible("showActivity", false);
    state.setSystemExpanded(true);
    expect(isDefaultHudUiOptions(oldStore.getState())).toBe(false);
    const expected = { ...DEFAULT_OPTIONS, showActivity: false, systemExpanded: true };
    expect(JSON.parse(data.get(key)!)).toEqual(expected);

    vi.resetModules();
    const { useHudOptionsStore: reloaded } = await import("./hudOptionsStore");
    expect(reloaded.getState()).toMatchObject(expected);
    reloaded.getState().toggleSystemExpanded();
    expect(readPersistedHudUiOptions(storage).systemExpanded).toBe(false);
    reloaded.getState().setSystemExpanded(true);
    reloaded.getState().resetHudOptions();
    expect(isDefaultHudUiOptions(reloaded.getState())).toBe(true);
    expect(readPersistedHudUiOptions(storage)).toEqual(DEFAULT_OPTIONS);
  });

  it.each(["{broken", "null", "[]", '"hidden"'])("recovers from persisted %s", (raw) => {
    expect(readPersistedHudUiOptions({ getItem: () => raw })).toEqual(DEFAULT_OPTIONS);
  });

  it("keeps valid booleans and ignores malformed or unrelated options", () => {
    expect(
      parseHudUiOptions({
        showQuota: false,
        showActivity: 0,
        showSession: "false",
        systemExpanded: true,
        unknown: true,
      }),
    ).toEqual({ ...DEFAULT_OPTIONS, showQuota: false, systemExpanded: true });
  });

  it("falls back to defaults when access to localStorage is denied", () => {
    vi.stubGlobal("window", {
      get localStorage(): Storage {
        throw new DOMException("Denied", "SecurityError");
      },
    });
    try {
      expect(readPersistedHudUiOptions()).toEqual(DEFAULT_OPTIONS);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("keeps in-memory edits when storage is full", async () => {
    using _storage = stubStorage({
      getItem: () => null,
      setItem: () => {
        throw new DOMException("Full", "QuotaExceededError");
      },
    });
    const { useHudOptionsStore: store } = await import("./hudOptionsStore");
    store.getState().toggleCard("showSystem");
    expect(store.getState().showSystem).toBe(false);
    expect(readPersistedHudUiOptions().showSystem).toBe(true);
  });
});

describe("HUD header", () => {
  it.each([
    ["running", true, true, "error", "approval"],
    ["running", false, true, "error", "input"],
    ["queued", false, false, "older error", "running"],
    ["waiting", false, false, "older error", "waiting"],
    ["failed", false, false, null, "error"],
    ["idle", false, false, "error", "error"],
    ["completed", false, false, "  ", "idle"],
  ] as const)(
    "shows %s with pending state %s/%s and error %s as %s",
    (runtimeStatus, hasPendingApproval, hasPendingUserInput, lastError, statusKind) => {
      expect(
        deriveHudHeaderSummary({
          runtimeStatus,
          hasPendingApproval,
          hasPendingUserInput,
          lastError,
          providerLabel: "Codex",
          requestedModel: null,
          projection: null,
        }).statusKind,
      ).toBe(statusKind);
    },
  );

  it("uses the latest delivered model on the active provider, not dropped or retired prompts", () => {
    const result = deriveHudHeaderSummary({
      runtimeStatus: "completed",
      hasPendingApproval: false,
      hasPendingUserInput: false,
      lastError: null,
      providerLabel: "Codex",
      requestedModel: "selected",
      projection: projection({
        providerTurns: [
          turn(1, { model: "previous" }),
          turn(2, { turnTokenUsage: { ...tokenUsage(10, 0), models: ["resolved", "resolved"] } }),
          turn(3, { model: "not-delivered", promptDropped: true }),
          turn(4, { model: "retired", providerThreadId: RETIRED_THREAD }),
        ],
      }),
    });
    expect(result).toMatchObject({
      providerLabel: "Codex",
      requestedModel: "selected",
      servedModel: "resolved",
      modelDisplay: "resolved",
      modelSwitched: true,
    });
  });
});

describe("HUD context lens", () => {
  it("distinguishes an empty measured context from missing or invalid measurement", () => {
    expect(context()).toBeNull();
    expect(context({ liveTokenUsage: { usedTokens: -1, updatedAt: iso() } })).toBeNull();
    expect(context({ liveTokenUsage: { usedTokens: 0, updatedAt: iso() } })).toMatchObject({
      usedPercentage: null,
      buckets: ["systemBase", "tools", "assistant", "user"].map((key) => ({
        key,
        tokens: 0,
        percentOfContext: 0,
        percentOfUsed: 0,
      })),
    });
  });

  it.each([
    [162_499, "normal", false],
    [162_500, "warning", false],
    [199_999, "warning", false],
    [200_000, "warning", true],
    [212_500, "error", true],
  ] as const)(
    "uses actual utilization and threshold boundaries at %i tokens",
    (usedTokens, usageTone, over200k) => {
      const live = { usedTokens, maxTokens: 250_000, updatedAt: iso() };
      expect(context({ liveTokenUsage: { ...live, autoCompactThreshold: 225_000 } })).toMatchObject(
        { usageTone, over200k, autoCompactTickPercent: 90 },
      );
      expect(
        context({ liveTokenUsage: { ...live, autoCompactThreshold: live.maxTokens } })
          ?.autoCompactTickPercent,
      ).toBeNull();
    },
  );

  it("counts only post-compaction text from the active provider and includes legacy items", () => {
    const turnItems: ThreadStructureTurnItem[] = [
      userItem(1, "old ".repeat(500)),
      { ...itemBase(2), type: "compaction", driver: null, summary: "older" },
      userItem(3, "also old ".repeat(500)),
      { ...itemBase(4), type: "compaction", driver: null, summary: "latest" },
      { ...userItem(5, ""), textOmitted: true },
      { ...userItem(6, "abcd"), providerThreadId: null },
      { ...itemBase(7), type: "compaction", providerThreadId: RETIRED_THREAD, driver: null },
      { ...itemBase(8), type: "command_execution", input: "abcd", output: "abcd" },
      {
        ...itemBase(9),
        type: "assistant_message",
        messageId: MessageId.make("message-9"),
        streaming: false,
      },
      {
        ...itemBase(10),
        type: "assistant_message",
        messageId: MessageId.make("message-10"),
        streaming: true,
      },
      {
        ...itemBase(11),
        type: "command_execution",
        providerThreadId: RETIRED_THREAD,
        input: "retired".repeat(100),
      },
      {
        ...itemBase(12),
        type: "proposed_plan",
        planId: PlanId.make("plan"),
        markdown: "not used as fallback".repeat(100),
        streaming: false,
      },
      { ...itemBase(13), type: "compaction", status: "running", driver: null },
    ];
    const result = context({
      contextWindow: contextWindow(),
      projection: projection({
        turnItems,
        messages: [
          message(5, "user", "user".repeat(3)),
          message(9, "assistant", "done".repeat(5)),
          message(10, "assistant", "streaming".repeat(100), true),
        ],
      }),
    });
    expect(result).toMatchObject({
      hasCompaction: true,
      isApproximate: true,
      buckets: [
        { key: "systemBase", tokens: 89 },
        { key: "tools", tokens: 2, percentOfUsed: 2 },
        { key: "assistant", tokens: 5 },
        { key: "user", tokens: 4 },
      ],
    });
    expect(result?.buckets[1]?.percentOfContext).toBeCloseTo(0.2);
  });

  it("caps compaction reserve and balances rounded buckets even on tiny budgets", () => {
    const turnItems: ThreadStructureTurnItem[] = [
      { ...itemBase(1), type: "compaction", driver: null, summary: "summary".repeat(200) },
      { ...itemBase(2), type: "command_execution", input: "x".repeat(40) },
      {
        ...itemBase(3),
        type: "proposed_plan",
        planId: PlanId.make("plan"),
        markdown: "x".repeat(40),
        streaming: false,
      },
      userItem(4, "x".repeat(40)),
    ];
    const thread = projection({ turnItems });
    const metrics = (usedTokens: number) =>
      context({ contextWindow: contextWindow({ usedTokens }), projection: thread })!.buckets;
    expect(metrics(13).map((bucket) => bucket.tokens)).toEqual([5, 2, 3, 3]);
    for (let used = 0; used < 40; used++) {
      const tokens = metrics(used).map((bucket) => bucket.tokens);
      expect(tokens.every((count) => Number.isInteger(count) && count >= 0)).toBe(true);
      expect(tokens.reduce((sum, count) => sum + count, 0)).toBe(used);
    }
  });

  it("bounds large dynamic tool payloads and still counts file diffs and search results", () => {
    const payload: { self?: unknown; text: string } = { text: "x".repeat(20_000) };
    payload.self = payload;
    const turnItems: ThreadStructureTurnItem[] = [
      {
        ...itemBase(1),
        type: "dynamic_tool",
        toolName: "read",
        input: payload,
        output: "x".repeat(20_000),
      },
      {
        ...itemBase(2),
        type: "file_change",
        fileName: "abcd",
        diffStr: "x".repeat(8),
        oldStr: "ignored".repeat(200),
      },
      {
        ...itemBase(3),
        type: "file_search",
        pattern: "abcd",
        results: [{ fileName: "abcd", preview: "abcd" }],
      },
      {
        ...itemBase(4),
        type: "web_search",
        patterns: ["abcd", "abcd"],
        results: [{ title: "abcd", snippet: "abcd" }],
      },
    ];
    const metrics = context({
      liveTokenUsage: { usedTokens: 10_000, updatedAt: iso() },
      projection: projection({ turnItems }),
    });
    expect(metrics?.buckets[1]).toMatchObject({ key: "tools", tokens: 4_106 });
  });

  it("uses measured output when text is absent, except usage predating compaction", () => {
    const liveTokenUsage = { usedTokens: 100, outputTokens: 20, updatedAt: iso(-10_000) };
    expect(context({ liveTokenUsage })?.buckets[2]?.tokens).toBe(20);
    const turnItems: ThreadStructureTurnItem[] = [
      { ...itemBase(1), type: "compaction", driver: null },
    ];
    expect(
      context({ liveTokenUsage, projection: projection({ turnItems }) })?.buckets[2]?.tokens,
    ).toBe(0);
  });
});

describe("HUD prompt cache", () => {
  it("weights only delivered, single-model turns on the active provider after a model switch", () => {
    const providerTurns = [
      turn(1, { model: "old", turnTokenUsage: tokenUsage(10_000, 9_800) }),
      turn(2, { turnTokenUsage: tokenUsage(20_000, 20_000) }),
      turn(3, { turnTokenUsage: { ...tokenUsage(100, 10), models: ["new", "new"] } }),
      turn(4, {
        model: "new",
        turnTokenUsage: { ...tokenUsage(15_000, 15_000), models: ["new", "old"] },
      }),
      turn(5, {
        model: "new",
        tokenUsage: {
          usedTokens: 1_000,
          inputTokens: 300,
          cachedInputTokens: 600,
          updatedAt: iso(),
        },
      }),
      turn(6, { model: "new", turnTokenUsage: tokenUsage(10_000, 0), promptDropped: true }),
      turn(7, {
        model: "new",
        turnTokenUsage: tokenUsage(10_000, 0),
        providerThreadId: RETIRED_THREAD,
      }),
    ];
    const result = context({
      contextWindow: contextWindow(),
      projection: projection({ providerTurns }),
    });
    expect(result).toMatchObject({
      cacheModel: "new",
      cacheSampleTurnCount: 2,
      lastTurnCacheHitRate: 100,
      cumulativeCacheHitRate: 77.5,
      promptCacheExpiresAtMs: NOW + 299_000,
      promptCacheRemainingMs: 299_000,
    });
  });

  it("refuses to carry a model-less aggregate snapshot over a known switch", () => {
    const providerTurns = [
      turn(1, { model: "old", turnTokenUsage: tokenUsage(200, 199) }),
      turn(2, { model: "new" }),
    ];
    const result = context({
      contextWindow: contextWindow({ inputTokens: 200, cachedInputTokens: 199 }),
      projection: projection({ providerTurns }),
    });
    expect(result).toMatchObject({
      cacheModel: "new",
      cacheSampleTurnCount: 0,
      lastTurnCacheHitRate: null,
      cumulativeCacheHitRate: null,
      promptCacheState: "unknown",
    });
  });

  it("blocks stale last-turn cache snapshot and stale live cache expiry after a same-thread model switch", () => {
    const oldTurn = turn(1, {
      model: "old",
      startedAt: at(-20_000),
      completedAt: at(-15_000),
      tokenUsage: {
        usedTokens: 500,
        inputTokens: 100,
        cachedInputTokens: 90,
        promptCacheExpiresAt: iso(120_000),
        updatedAt: iso(-15_000),
      },
      turnTokenUsage: { ...tokenUsage(100, 90, 20), models: ["old"] },
    });
    const newTurn = turn(2, {
      model: "new",
      startedAt: at(-5_000),
      completedAt: null,
      status: "running",
    });
    const result = context({
      requestedModel: "new",
      contextWindow: contextWindow({
        usedTokens: 600,
        lastInputTokens: 100,
        lastCachedInputTokens: 90,
        updatedAt: iso(-1_000),
      }),
      liveTokenUsage: oldTurn.tokenUsage,
      projection: projection({ providerTurns: [oldTurn, newTurn] }),
    });
    expect(result).toMatchObject({
      cacheModel: "new",
      cacheSampleTurnCount: 0,
      lastTurnCacheHitRate: null,
      cumulativeCacheHitRate: null,
      promptCacheExpiresAtMs: null,
      promptCacheState: "unknown",
    });
  });

  it("blocks another model's live cache expiry on an A -> B -> A switch when A already has an earlier sample", () => {
    const firstATurn = turn(1, {
      model: "model-a",
      startedAt: at(-600_000),
      completedAt: at(-590_000),
      tokenUsage: {
        usedTokens: 400,
        inputTokens: 100,
        cachedInputTokens: 80,
        updatedAt: iso(-590_000),
      },
      turnTokenUsage: tokenUsage(100, 80, 20),
    });
    const bTurn = turn(2, {
      model: "model-b",
      startedAt: at(-60_000),
      completedAt: at(-30_000),
      tokenUsage: {
        usedTokens: 500,
        inputTokens: 100,
        cachedInputTokens: 95,
        promptCacheExpiresAt: iso(240_000),
        updatedAt: iso(-30_000),
      },
      turnTokenUsage: tokenUsage(100, 95, 20),
    });
    const resumedATurn = turn(3, {
      model: "model-a",
      startedAt: at(-5_000),
      completedAt: null,
      status: "running",
    });
    const result = context({
      requestedModel: "model-a",
      liveTokenUsage: bTurn.tokenUsage,
      projection: projection({ providerTurns: [firstATurn, bTurn, resumedATurn] }),
    });
    expect(result).toMatchObject({
      cacheModel: "model-a",
      cacheSampleTurnCount: 1,
      lastTurnCacheHitRate: 80,
      cumulativeCacheHitRate: 80,
      // Must derive from model-a's 11:50 completion (cold), NOT model-b's 12:04 expiry (warm)!
      promptCacheExpiresAtMs: NOW - 590_000 + 300_000,
      promptCacheState: "cold",
    });
  });

  it("preserves a measured zero cache hit and omits zero counters from the last-turn breakdown", () => {
    const result = context({
      contextWindow: contextWindow({
        lastInputTokens: 100,
        lastCachedInputTokens: 0,
        lastOutputTokens: 12,
        inputTokens: 500,
        cachedInputTokens: 499,
      }),
      liveTokenUsage: {
        usedTokens: 100,
        inputTokens: 350,
        cachedInputTokens: 350,
        outputTokens: 500,
        reasoningOutputTokens: 4,
        updatedAt: iso(),
      },
    });
    expect(result).toMatchObject({
      lastTurnCacheHitRate: 0,
      cumulativeCacheHitRate: 0,
      cacheSampleTurnCount: 1,
      promptCacheExpiresAtMs: null,
      promptCacheState: "unknown",
      lastTurnBreakdown: [
        { key: "input", tokens: 100 },
        { key: "output", tokens: 12 },
        { key: "reasoning", tokens: 4 },
      ],
    });
  });

  it("honors explicit expiry, then a measured TTL, and becomes cold at the exact boundary", () => {
    const live = { usedTokens: 100, promptCacheTtlMs: 3_000, updatedAt: iso(-1_000) };
    expect(context({ liveTokenUsage: { ...live, promptCacheExpiresAt: iso(1) } })).toMatchObject({
      promptCacheExpiresAtMs: NOW + 1,
      promptCacheState: "warm",
      promptCacheRemainingMs: 1,
    });
    expect(
      context({ liveTokenUsage: { ...live, promptCacheExpiresAt: "invalid" } })
        ?.promptCacheExpiresAtMs,
    ).toBe(NOW + 2_000);
    expect(derivePromptCacheCountdown(NOW, NOW)).toEqual({ state: "cold", remainingMs: 0 });
    expect(derivePromptCacheCountdown(null, NOW)).toEqual({ state: "unknown", remainingMs: null });
  });
});

describe("HUD session KPIs", () => {
  it("does not fabricate speed, TTFT, duration, or cost when no telemetry exists", () => {
    expect(session()).toMatchObject({
      tokensPerSecond: null,
      ttftMs: null,
      activeDurationMs: null,
      wallClockSpanMs: null,
      cost: null,
      billingMode: "unknown",
    });
  });

  it("only accepts measured throughput with at least 100 ms and positive output", () => {
    expect(
      session({ contextWindow: contextWindow({ durationMs: 99, lastOutputTokens: 10 }) })
        .tokensPerSecond,
    ).toBeNull();
    expect(
      session({ contextWindow: contextWindow({ durationMs: 100, lastOutputTokens: 0 }) })
        .tokensPerSecond,
    ).toBeNull();
    expect(
      session({ contextWindow: contextWindow({ durationMs: 100, lastOutputTokens: 3 }) }),
    ).toMatchObject({
      tokensPerSecond: 30,
      ttftMs: null,
      activeDurationMs: 100,
      wallClockSpanMs: null,
    });
  });

  it("uses the latest valid completed turn and separates active run time from the session span", () => {
    const providerTurns = [
      turn(1, { model: "served", turnTokenUsage: tokenUsage(100, 0, 60) }),
      turn(2, { model: "served", startedAt: at(-1_050), turnTokenUsage: tokenUsage(100, 0, 100) }),
      turn(3, { model: "served", promptDropped: true, turnTokenUsage: tokenUsage(100, 0, 500) }),
      turn(4, {
        model: "served",
        status: "running",
        completedAt: null,
        turnTokenUsage: tokenUsage(100, 0, 500),
      }),
      turn(5, {
        model: "other-provider",
        providerThreadId: RETIRED_THREAD,
        startedAt: at(-2_500),
        completedAt: at(-2_000),
        turnTokenUsage: tokenUsage(100, 0, 200),
      }),
    ];
    const runs = [
      run(1, { workStartedAt: at(-50_000) }),
      run(2, { status: "waiting", startedAt: at(-8_000), completedAt: null }),
      run(3, { status: "queued", startedAt: null, completedAt: null }),
    ];
    const result = session({
      requestedModel: "requested",
      projection: projection({
        providerTurns,
        runs,
        thread: {
          ...BASE.thread,
          activeProviderThreadId: ACTIVE_THREAD,
          modelSelection: {
            ...BASE.thread.modelSelection,
            options: [
              { id: "thinking", value: true },
              { id: "effort", value: "high" },
            ],
          },
        },
      }),
    });
    expect(result).toMatchObject({
      tokensPerSecond: 30,
      ttftMs: null,
      activeDurationMs: 18_000,
      wallClockSpanMs: 50_000,
      turnCount: 4,
      modelDelta: { from: "requested", to: "served" },
      thinkingEffort: "high",
      interactionMode: "default",
      runtimeMode: "full-access",
    });
  });

  it("uses real zero cost but labels missing or invalid cost with observed quota as subscription", () => {
    const cost = { amount: 0, currency: "USD" };
    expect(session({ contextWindow: contextWindow({ cost }), hasQuotaLimits: true })).toMatchObject(
      { cost, billingMode: "cost" },
    );
    for (const invalid of [
      { amount: NaN, currency: "USD" },
      { amount: -1, currency: "USD" },
      { amount: 1, currency: " " },
    ]) {
      expect(
        session({ contextWindow: contextWindow({ cost: invalid }), hasQuotaLimits: true }),
      ).toMatchObject({ cost: null, billingMode: "subscription" });
    }
  });

  it("reads string thinking effort (omp/pi), live running turn speed, and positive TTFT", () => {
    const runningTurn = turn(1, {
      status: "running",
      startedAt: at(-10_000),
      completedAt: null,
      tokenUsage: {
        usedTokens: 24_016,
        maxTokens: 1_000_000,
        inputTokens: 22_354,
        cachedInputTokens: 19_328,
        outputTokens: 1_660,
        updatedAt: iso(-1_000),
      },
    });
    const result = session({
      projection: projection({
        providerTurns: [runningTurn],
        turnItems: [
          {
            ...userItem(1, "inspect repo"),
            providerTurnId: runningTurn.id,
            startedAt: at(-10_000),
          },
          {
            ...itemBase(2),
            type: "reasoning" as const,
            streaming: false,
            providerTurnId: runningTurn.id,
            startedAt: at(-8_400),
          },
          {
            ...itemBase(3),
            type: "assistant_message" as const,
            messageId: MessageId.make("message-3"),
            streaming: true,
            providerTurnId: runningTurn.id,
            startedAt: at(-7_000),
          },
        ],
        thread: {
          ...BASE.thread,
          activeProviderThreadId: ACTIVE_THREAD,
          modelSelection: {
            ...BASE.thread.modelSelection,
            options: [{ id: "thinking", value: "high" }],
          },
        },
      }),
    });
    expect(result).toMatchObject({
      thinkingEffort: "high",
      liveTurnOutputTokens: 1_660,
      liveTurnStartedAtMs: NOW - 10_000,
      tokensPerSecond: 166,
      ttftMs: 1_600,
    });

    // Explicit thinking: "off" suppresses the effort tag instead of showing "off".
    const thinkingOff = session({
      projection: projection({
        thread: {
          ...BASE.thread,
          modelSelection: {
            ...BASE.thread.modelSelection,
            options: [{ id: "thinking", value: "off" }],
          },
        },
      }),
    });
    expect(thinkingOff.thinkingEffort).toBeNull();
  });
});

function subagent(id: string, fields: Partial<OrchestrationV2Subagent>): OrchestrationV2Subagent {
  return {
    id: NodeId.make(id),
    threadId: BASE.thread.id,
    runId: null,
    parentNodeId: NodeId.make("root"),
    origin: "provider_native",
    createdBy: "agent",
    driver: ProviderDriverKind.make("codex"),
    providerInstanceId: BASE.thread.providerInstanceId,
    providerThreadId: ACTIVE_THREAD,
    childThreadId: null,
    nativeTaskRef: null,
    prompt: "",
    title: id,
    model: null,
    status: "completed",
    result: null,
    startedAt: at(-5_000),
    completedAt: at(-1_000),
    updatedAt: at(-1_000),
    ...fields,
  };
}

describe("HUD activity", () => {
  it("prioritizes active subagents, preserves remote and local navigation, and reports overflow", () => {
    const childThreadId = ThreadId.make("child-local");
    const remoteChild = {
      environmentId: EnvironmentId.make("remote"),
      threadId: ThreadId.make("child-remote"),
      label: "Remote",
    };
    const subagents = [
      subagent("local", {
        title: "Subagent: Local",
        status: "running",
        executedModel: "actual",
        model: "selected",
        completedAt: null,
        childThreadId,
        updatedAt: at(-2_000),
      }),
      subagent("cancelled", { status: "interrupted", updatedAt: at() }),
      subagent("remote", {
        status: "waiting",
        startedAt: null,
        completedAt: null,
        remoteChild,
        updatedAt: at(-1_000),
      }),
    ];
    expect(
      deriveHudActivityMetrics({
        projection: { subagents, turnItems: [] },
        nowMs: NOW,
        maxSubagents: 2,
      }),
    ).toMatchObject({
      subagents: [
        { id: "remote", status: "waiting", remoteChild, durationMs: null },
        {
          id: "local",
          title: "Local",
          status: "running",
          childThreadId,
          model: "actual",
          durationMs: 5_000,
        },
      ],
      totalSubagentCount: 3,
      overflowSubagentCount: 1,
      isEmpty: false,
    });
  });

  it("normalizes tool names, counts all failure signals once, and keeps running tools first", () => {
    const turnItems: ThreadStructureTurnItem[] = [
      {
        ...itemBase(1),
        type: "command_execution",
        input: "nonzero",
        exitCode: 1,
        outputIndicatesFailure: true,
      },
      {
        ...itemBase(2),
        type: "command_execution",
        input: "reported failure",
        exitCode: 0,
        outputIndicatesFailure: true,
      },
      { ...itemBase(3), type: "command_execution", input: "ok", exitCode: 0 },
      { ...itemBase(4), type: "dynamic_tool", toolName: " READ ", input: null },
      { ...itemBase(5), type: "dynamic_tool", toolName: "read", input: null },
      { ...itemBase(6), type: "web_search", status: "running" },
      { ...itemBase(7), type: "file_search", status: "failed" },
    ];
    expect(
      deriveHudActivityMetrics({ projection: { subagents: [], turnItems }, nowMs: NOW }),
    ).toMatchObject({
      tools: [
        { name: "web_search", runningCount: 1, status: "running" },
        { name: "command_execution", totalCount: 3, failedCount: 2, status: "partial_failure" },
        { name: "read", totalCount: 2, status: "completed" },
        { name: "file_search", failedCount: 1, status: "failed" },
      ],
      totalToolCalls: 7,
      overflowToolCount: 0,
    });
  });

  it("caps each activity list at eight without losing totals and auto-hides empty activity", () => {
    expect(deriveHudActivityMetrics({ projection: null, nowMs: NOW }).isEmpty).toBe(true);
    const subagents = Array.from({ length: 9 }, (_, index) => subagent(`agent-${index}`, {}));
    const turnItems = subagents.map((agent, index) => ({
      ...itemBase(index),
      type: "dynamic_tool" as const,
      toolName: `tool-${agent.id}`,
      input: null,
    }));
    expect(
      deriveHudActivityMetrics({ projection: { subagents, turnItems }, nowMs: NOW }),
    ).toMatchObject({
      totalSubagentCount: 9,
      overflowSubagentCount: 1,
      totalToolCalls: 9,
      overflowToolCount: 1,
      isEmpty: false,
    });
  });
});

function processSample(
  index: number,
  category: ResourceTelemetryProcess["category"],
  cpuPercent: number,
  residentBytes: number,
): ResourceTelemetryProcess {
  return {
    identity: { pid: index, startTimeMs: NOW },
    ppid: 0,
    childPids: [],
    depth: 0,
    name: category,
    command: category,
    status: "running",
    category,
    cpuPercent,
    residentBytes,
    cpuTimeMs: 0,
    peakResidentBytes: residentBytes,
    virtualBytes: 0,
    ioReadBytes: 0,
    ioWriteBytes: 0,
    ioReadBytesPerSecond: 0,
    ioWriteBytesPerSecond: 0,
    ioSemantics: "unavailable",
    runTimeMs: 0,
    firstSeenAt: at(),
    lastSeenAt: at(),
  };
}

function telemetry(processes: ResourceTelemetrySnapshot["processes"]): ResourceTelemetrySnapshot {
  const aggregate = {
    processCount: 9,
    currentCpuPercent: 18,
    currentRssBytes: 900,
    cpuTimeMs: 0,
    peakRssBytes: 900,
    ioReadBytes: 0,
    ioWriteBytes: 0,
    ioReadBytesPerSecond: 0,
    ioWriteBytesPerSecond: 0,
    processStarts: 0,
    processExits: 0,
  };
  const health = {
    status: "degraded" as const,
    lastSampleAt: Option.some(at()),
    lastError: Option.none(),
  };
  return {
    readAt: at(),
    sampleIntervalMs: 1_000,
    processes,
    power: {
      source: "unknown",
      idle: "unknown",
      idleSeconds: null,
      locked: "unknown",
      suspended: false,
      onBattery: "unknown",
      lowPowerMode: "unknown",
      thermalState: "unknown",
      stale: true,
      updatedAt: at(),
    },
    groups: { allT3: aggregate, backend: aggregate, electron: aggregate, monitor: aggregate },
    health: {
      native: health,
      desktop: health,
      sidecarVersion: Option.none(),
      sidecarPid: Option.none(),
      restartCount: 0,
      collectionDurationMicros: 0,
      scannedProcessCount: 0,
      retainedProcessCount: 0,
      inaccessibleProcessCount: 0,
    },
    speedLimitPercent: Option.none(),
    attribution: { readAt: at(), entries: [] },
  };
}

describe("HUD system metrics", () => {
  it("exposes no invented process or host memory values when telemetry is missing", () => {
    expect(
      deriveHudSystemMetrics({
        snapshot: null,
        contextWindow: null,
        projection: {
          providerTurns: [turn(1, { tokenUsage: { usedTokens: 900, updatedAt: iso() } })],
        },
      }),
    ).toEqual({
      available: false,
      cpuPercent: null,
      rssBytes: null,
      processCount: null,
      healthStatus: null,
      categories: [],
      totalProcessedTokens: null,
    });
  });

  it("preserves real process aggregate values and buckets each process by reported category", () => {
    const snapshot = telemetry([
      processSample(1, "provider-root", 3.5, 120),
      processSample(2, "terminal-root", 1, 50),
      processSample(3, "server", 5, 100),
      processSample(4, "server-child", 2.5, 60),
      processSample(5, "electron-main", 3, 200),
      processSample(6, "electron-renderer", 3, 300),
      processSample(7, "resource-monitor", 0, 80),
      processSample(8, "unknown-t3", 0, 30),
    ]);
    expect(
      deriveHudSystemMetrics({
        snapshot,
        contextWindow: contextWindow({
          totalProcessedTokens: 1_234,
          inputTokens: 1_000,
          outputTokens: 234,
        }),
        projection: null,
      }),
    ).toEqual({
      available: true,
      cpuPercent: 18,
      rssBytes: 900,
      processCount: 9,
      healthStatus: "degraded",
      categories: [
        { key: "provider", processCount: 1, cpuPercent: 3.5, rssBytes: 120 },
        { key: "terminal", processCount: 1, cpuPercent: 1, rssBytes: 50 },
        { key: "server", processCount: 2, cpuPercent: 7.5, rssBytes: 160 },
        { key: "desktop", processCount: 2, cpuPercent: 6, rssBytes: 500 },
        { key: "other", processCount: 2, cpuPercent: 0, rssBytes: 110 },
      ],
      totalProcessedTokens: 1_234,
    });
  });

  it("treats zero-sample telemetry snapshots as unavailable and ignores compaction occupancy as processed tokens", () => {
    const baseSnapshot = telemetry([]);
    const emptySnapshot: ResourceTelemetrySnapshot = {
      ...baseSnapshot,
      groups: {
        ...baseSnapshot.groups,
        allT3: {
          ...baseSnapshot.groups.allT3,
          processCount: 0,
          currentCpuPercent: 0,
          currentRssBytes: 0,
        },
      },
      health: {
        ...baseSnapshot.health,
        native: { status: "starting", lastSampleAt: Option.none(), lastError: Option.none() },
      },
    };
    const compactionOnlyWindow = contextWindow({
      usedTokens: 80_000,
      totalProcessedTokens: 240_000,
      compactsAutomatically: true,
    });
    expect(
      deriveHudSystemMetrics({
        snapshot: emptySnapshot,
        contextWindow: compactionOnlyWindow,
        projection: null,
      }),
    ).toEqual({
      available: false,
      cpuPercent: null,
      rssBytes: null,
      processCount: null,
      healthStatus: "starting",
      categories: [],
      totalProcessedTokens: null,
    });
    // Real summed turn tokens take precedence over compaction occupancy
    expect(
      deriveHudSystemMetrics({
        snapshot: null,
        contextWindow: compactionOnlyWindow,
        projection: { providerTurns: [turn(1, { turnTokenUsage: tokenUsage(100, 40, 25) })] },
      }).totalProcessedTokens,
    ).toBe(125);
  });

  it("sums observed input and output without counting occupancy, dropped turns, or cached input twice", () => {
    const providerTurns = [
      turn(1, { turnTokenUsage: tokenUsage(100, 90, 20) }),
      turn(2, {
        tokenUsage: { usedTokens: 9_000, inputTokens: 10, outputTokens: 3, updatedAt: iso() },
      }),
      turn(3, { tokenUsage: { usedTokens: 20_000, updatedAt: iso() } }),
      turn(4, { turnTokenUsage: tokenUsage(500, 500, 30), promptDropped: true }),
    ];
    expect(
      deriveHudSystemMetrics({ snapshot: null, contextWindow: null, projection: { providerTurns } })
        .totalProcessedTokens,
    ).toBe(133);
  });
});

it("formats real zero and rolls rounded seconds over to minutes", () => {
  expect(formatHudCompactDuration(0)).toBe("0ms");
  expect(formatHudCompactDuration(59_600)).toBe("1m 0s");
});

function makeServerProvider(
  instanceId: string,
  driver: string,
  options?: { readonly enabled?: boolean; readonly usageLimits?: ServerProviderUsageLimits },
): ServerProvider {
  return {
    instanceId: ProviderInstanceId.make(instanceId),
    driver: ProviderDriverKind.make(driver),
    displayName: instanceId,
    enabled: options?.enabled ?? true,
    installed: true,
    version: "1.0.0",
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt: iso(),
    models: [],
    slashCommands: [],
    skills: [],
    ...(options?.usageLimits ? { usageLimits: options.usageLimits } : {}),
  };
}

function makeUsageLimits(
  windowId: string,
  label: string,
  usedPercent: number,
): ServerProviderUsageLimits {
  return {
    checkedAt: iso(),
    windows: [
      {
        id: windowId,
        kind: "session",
        label,
        usedPercent,
        windowDurationMins: 300,
        resetsAt: iso(3_600_000),
      },
    ],
  };
}

describe("resolveOmpThreadHudLimits", () => {
  const ompPersonal = makeServerProvider("omp-personal", "omp");
  const ompWork = makeServerProvider("omp-work", "omp");

  it("matches only the active sub-backend from this omp instance snapshot and hides unmatched or default models", () => {
    const ownSource: UsageLimitSourceSnapshot = {
      id: UsageLimitSourceId.make("omp-instance:omp-personal"),
      kind: "omp",
      label: "omp (personal)",
      checkedAt: iso(),
      accounts: [
        {
          id: "codex:1",
          driver: ProviderDriverKind.make("codex"),
          email: "dev@example.com",
          usageLimits: makeUsageLimits("primary", "5h", 35),
        },
        {
          id: "claudeAgent:1",
          driver: ProviderDriverKind.make("claudeAgent"),
          email: "dev@example.com",
          usageLimits: makeUsageLimits("five_hour", "Claude 5h", 80),
        },
      ],
      quotaAccounts: [
        {
          id: "zai:abc",
          label: "zai · dev@example.com",
          windows: makeUsageLimits("tokens", "Z.ai 5h", 22).windows,
        },
      ],
    };

    const codex = resolveOmpThreadHudLimits({
      provider: ompPersonal,
      model: "openai-codex/gpt-6.2-sol",
      providers: [ompPersonal],
      sources: [ownSource],
      nowMs: NOW,
    });
    expect(codex?.kind).toBe("instance");
    if (codex?.kind === "instance") {
      expect(codex.limits.windows.map((window) => window.label)).toEqual(["5h"]);
      expect(codex.limits.windows[0]?.usedPercent).toBe(35);
    }

    const zai = resolveOmpThreadHudLimits({
      provider: ompPersonal,
      model: "zai/glm-4.7",
      providers: [ompPersonal],
      sources: [ownSource],
      nowMs: NOW,
    });
    expect(zai?.kind).toBe("instance");
    if (zai?.kind === "instance") {
      expect(zai.limits.windows.map((window) => window.label)).toEqual(["Z.ai 5h"]);
    }

    expect(
      resolveOmpThreadHudLimits({
        provider: ompPersonal,
        model: "devin/swe-2-1",
        providers: [ompPersonal],
        sources: [ownSource],
        nowMs: NOW,
      }),
    ).toBeNull();
    expect(
      resolveOmpThreadHudLimits({
        provider: ompPersonal,
        model: "default",
        providers: [ompPersonal],
        sources: [ownSource],
        nowMs: NOW,
      }),
    ).toBeNull();

    // Served failover sub-backend wins over requested model; unprefixed served falls back to prefixed requested
    const failover = resolveOmpThreadHudLimits({
      provider: ompPersonal,
      model: "anthropic/claude-opus-4-6",
      fallbackModel: "openai-codex/gpt-6.2-sol",
      providers: [ompPersonal],
      sources: [ownSource],
      nowMs: NOW,
    });
    expect(failover?.kind).toBe("instance");
    if (failover?.kind === "instance") {
      expect(failover.limits.windows[0]?.label).toBe("Claude 5h");
    }

    const unprefixedServed = resolveOmpThreadHudLimits({
      provider: ompPersonal,
      model: "gpt-6.2-sol",
      fallbackModel: "openai-codex/gpt-6.2-sol",
      providers: [ompPersonal],
      sources: [ownSource],
      nowMs: NOW,
    });
    expect(unprefixedServed?.kind).toBe("instance");
    if (unprefixedServed?.kind === "instance") {
      expect(unprefixedServed.limits.windows[0]?.label).toBe("5h");
    }
  });

  it("never borrows another omp instance snapshot and falls back only to an unambiguous native provider", () => {
    const personalSource: UsageLimitSourceSnapshot = {
      id: UsageLimitSourceId.make("omp-instance:omp-personal"),
      kind: "omp",
      label: "omp (personal)",
      checkedAt: iso(),
      accounts: [
        {
          id: "codex:1",
          driver: ProviderDriverKind.make("codex"),
          email: "personal@example.com",
          usageLimits: makeUsageLimits("primary", "Personal 5h", 15),
        },
      ],
    };

    // omp-work has no snapshot of its own and must NOT borrow omp-personal's snapshot
    expect(
      resolveOmpThreadHudLimits({
        provider: ompWork,
        model: "openai-codex/gpt-6.2-sol",
        providers: [ompPersonal, ompWork],
        sources: [personalSource],
        nowMs: NOW,
      }),
    ).toBeNull();

    // Unambiguous single enabled native provider fallback works when omp snapshot lacks that sub-backend
    const nativeCodex = makeServerProvider("codex", "codex", {
      usageLimits: makeUsageLimits("primary", "Native 5h", 42),
    });
    const fallback = resolveOmpThreadHudLimits({
      provider: ompWork,
      model: "openai-codex/gpt-6.2-sol",
      providers: [ompPersonal, ompWork, nativeCodex],
      sources: [personalSource],
      nowMs: NOW,
    });
    expect(fallback?.kind).toBe("instance");
    if (fallback?.kind === "instance") {
      expect(fallback.limits.windows[0]?.label).toBe("Native 5h");
    }

    // Two enabled native codex providers are ambiguous -> return null instead of guessing
    const secondCodex = makeServerProvider("codex-2", "codex", {
      usageLimits: makeUsageLimits("primary", "Second 5h", 90),
    });
    expect(
      resolveOmpThreadHudLimits({
        provider: ompWork,
        model: "openai-codex/gpt-6.2-sol",
        providers: [ompPersonal, ompWork, nativeCodex, secondCodex],
        sources: [personalSource],
        nowMs: NOW,
      }),
    ).toBeNull();
  });

  it("pools multiple matching sub-backend accounts, filters Antigravity windows by model, and accepts a single manual omp source", () => {
    const manualSource: UsageLimitSourceSnapshot = {
      id: UsageLimitSourceId.make("manual-omp"),
      kind: "omp",
      label: "OMP Local Cache",
      checkedAt: iso(),
      accounts: [
        {
          id: "codex:1",
          driver: ProviderDriverKind.make("codex"),
          email: "a@example.com",
          usageLimits: makeUsageLimits("primary", "5h", 20),
        },
        {
          id: "codex:2",
          driver: ProviderDriverKind.make("codex"),
          email: "b@example.com",
          usageLimits: makeUsageLimits("primary", "5h", 60),
        },
        {
          id: "antigravity:1",
          driver: ProviderDriverKind.make("antigravity"),
          email: "a@example.com",
          usageLimits: {
            checkedAt: iso(),
            windows: [
              {
                id: "gemini-5h",
                kind: "session",
                label: "Gemini 5h",
                usedPercent: 10,
                windowDurationMins: 300,
                resetsAt: iso(3_600_000),
              },
              {
                id: "claude-5h",
                kind: "session",
                label: "Claude 5h",
                usedPercent: 70,
                windowDurationMins: 300,
                resetsAt: iso(3_600_000),
              },
            ],
          },
        },
      ],
    };

    const pooled = resolveOmpThreadHudLimits({
      provider: ompPersonal,
      model: "openai-codex/gpt-6.2-sol",
      providers: [ompPersonal],
      sources: [manualSource],
      nowMs: NOW,
    });
    expect(pooled?.kind).toBe("pool");
    if (pooled?.kind === "pool") {
      expect(pooled.windows[0]?.usedPercent).toBe(40);
    }

    const antigravity = resolveOmpThreadHudLimits({
      provider: ompPersonal,
      model: "google-antigravity/gemini-3-pro",
      providers: [ompPersonal],
      sources: [manualSource],
      nowMs: NOW,
    });
    expect(antigravity?.kind).toBe("instance");
    if (antigravity?.kind === "instance") {
      expect(antigravity.limits.windows.map((window) => window.id)).toEqual(["gemini-5h"]);
    }

    // Manual source is NOT borrowed when multiple enabled omp instances exist without an exact omp-instance match
    expect(
      resolveOmpThreadHudLimits({
        provider: ompWork,
        model: "openai-codex/gpt-6.2-sol",
        providers: [ompPersonal, ompWork],
        sources: [manualSource],
        nowMs: NOW,
      }),
    ).toBeNull();
  });
});
