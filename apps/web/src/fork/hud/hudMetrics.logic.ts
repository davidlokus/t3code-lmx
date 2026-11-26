import type { ContextWindowSnapshot } from "@t3tools/client-runtime/state/context-window";
import type {
  ThreadStructure,
  ThreadStructureTurnItem,
} from "@t3tools/client-runtime/state/models";
import { formatSubagentDisplayTitle } from "@t3tools/client-runtime/state/subagent-display";
import {
  EnvironmentId,
  isOrchestrationV2WorkActive,
  isProviderAvailable,
  ProviderDriverKind,
  type NodeId,
  type OrchestrationV2ProviderTurn,
  type OrchestrationV2ProviderTurnTokenUsage,
  type OrchestrationV2RemoteTaskChild,
  type OrchestrationV2RunStatus,
  type OrchestrationV2Subagent,
  type OrchestrationV2SubagentUsage,
  type ProviderThreadId,
  type ResourceTelemetryProcessCategory,
  type ResourceTelemetrySnapshot,
  type ResourceTelemetrySourceStatus,
  type ServerProvider,
  type ServerProviderUsageLimits,
  type ThreadId,
  type ProviderTurnId,
  type ServerSettings,
  type UsageLimitSourceSnapshot,
  type UsageLimitSourceSnapshots,
} from "@t3tools/contracts";
import {
  estimateModelReferenceCost,
  type ReferenceCostEstimate,
  type ReferenceCostTokenCounts,
} from "@t3tools/shared/modelReferencePricing";
import { formatDuration } from "@t3tools/shared/orchestrationTiming";
import {
  antigravityWindowLimitsModel,
  collectLimitAccounts,
  collectLimitPools,
  displayLimitWindows,
} from "@t3tools/shared/usageLimits";
import { limitsNotice } from "@t3tools/shared/usageLimitsCopy";
import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";
import { msg } from "gt-react";

import type { ThreadDetailsLimits } from "~/components/chat/ThreadDetailsUsage.logic";
import type { MessageResolver } from "~/i18n/messages";

export type HudThreadStatusKind = "running" | "approval" | "input" | "error" | "waiting" | "idle";

export interface HudHeaderSummary {
  readonly statusKind: HudThreadStatusKind;
  readonly providerLabel: string;
  readonly requestedModel: string | null;
  readonly servedModel: string | null;
  readonly modelDisplay: string | null;
  readonly modelSwitched: boolean;
}

type HeaderProjection = Pick<ThreadStructure, "thread" | "providerTurns">;

function nonEmptyText(value: string | null | undefined): string | null {
  return value?.trim() || null;
}

function isRunExecuting(status: OrchestrationV2RunStatus | "idle" | null | undefined): boolean {
  return (
    status === "preparing" || status === "queued" || status === "starting" || status === "running"
  );
}

function deliveredOnThread(turn: OrchestrationV2ProviderTurn, threadId: ProviderThreadId | null) {
  return !turn.promptDropped && (threadId === null || turn.providerThreadId === threadId);
}

function timestampMs(value: DateTime.Utc | null | undefined): number | null {
  return value == null ? null : DateTime.toEpochMillis(value);
}

function parseTimestampMs(value: string | null | undefined): number | null {
  if (!value) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function isLaterTurn(turn: OrchestrationV2ProviderTurn, previous: OrchestrationV2ProviderTurn) {
  if (turn.providerThreadId === previous.providerThreadId) return turn.ordinal >= previous.ordinal;
  // Snapshots group turns by provider thread, so ordinals and array position cannot order a switch.
  const at = timestampMs(turn.startedAt ?? turn.completedAt) ?? -Infinity;
  const previousAt = timestampMs(previous.startedAt ?? previous.completedAt) ?? -Infinity;
  return at >= previousAt;
}

function latestDeliveredTurn(projection: HeaderProjection | null | undefined) {
  const activeThreadId = projection?.thread.activeProviderThreadId ?? null;
  let latest: OrchestrationV2ProviderTurn | undefined;
  for (const turn of projection?.providerTurns ?? []) {
    if (deliveredOnThread(turn, activeThreadId) && (!latest || isLaterTurn(turn, latest))) {
      latest = turn;
    }
  }
  return latest;
}

function hasMultipleModels(turn: OrchestrationV2ProviderTurn | undefined): boolean {
  const models = turn?.turnTokenUsage?.models;
  return models?.some((model) => model !== models[0]) ?? false;
}

function reportedModel(turn: OrchestrationV2ProviderTurn | undefined): string | null {
  return (
    turn?.model ?? (hasMultipleModels(turn) ? null : (turn?.turnTokenUsage?.models?.[0] ?? null))
  );
}

export function deriveHudHeaderSummary(input: {
  readonly runtimeStatus: OrchestrationV2RunStatus | "idle" | null | undefined;
  readonly hasPendingApproval: boolean;
  readonly hasPendingUserInput: boolean;
  readonly lastError: string | null | undefined;
  readonly providerLabel: string;
  readonly requestedModel: string | null | undefined;
  readonly projection: HeaderProjection | null | undefined;
}): HudHeaderSummary {
  let statusKind: HudThreadStatusKind = "idle";
  if (input.hasPendingApproval) statusKind = "approval";
  else if (input.hasPendingUserInput) statusKind = "input";
  else if (isRunExecuting(input.runtimeStatus)) statusKind = "running";
  else if (input.runtimeStatus === "waiting") statusKind = "waiting";
  else if (input.runtimeStatus === "failed" || nonEmptyText(input.lastError)) statusKind = "error";

  const requestedModel = nonEmptyText(input.requestedModel);
  const servedModel = reportedModel(latestDeliveredTurn(input.projection));
  return {
    statusKind,
    providerLabel: input.providerLabel,
    requestedModel,
    servedModel,
    modelDisplay: servedModel ?? requestedModel,
    modelSwitched:
      requestedModel !== null && servedModel !== null && requestedModel !== servedModel,
  };
}

export type HudContextBucketKey = "systemBase" | "tools" | "assistant" | "user";
export type HudContextUsageTone = "normal" | "warning" | "error";
export type HudPromptCacheState = "warm" | "cold" | "unknown";

export interface HudContextBucket {
  readonly key: HudContextBucketKey;
  readonly tokens: number;
  readonly percentOfContext: number;
  readonly percentOfUsed: number;
}

export interface HudContextTurnBreakdownItem {
  readonly key: "input" | "cachedInput" | "output" | "reasoning";
  readonly tokens: number;
}

export interface HudContextMetrics {
  readonly usedTokens: number;
  readonly maxTokens: number | null;
  readonly usedPercentage: number | null;
  readonly usageTone: HudContextUsageTone;
  readonly over200k: boolean;
  readonly autoCompactThreshold: number | null;
  readonly autoCompactTickPercent: number | null;
  readonly hasCompaction: boolean;
  readonly isApproximate: true;
  readonly buckets: readonly HudContextBucket[];
  readonly lastTurnCacheHitRate: number | null;
  readonly cumulativeCacheHitRate: number | null;
  readonly cacheSampleTurnCount: number;
  readonly cacheModel: string | null;
  readonly promptCacheExpiresAtMs: number | null;
  readonly promptCacheState: HudPromptCacheState;
  readonly promptCacheRemainingMs: number | null;
  readonly lastTurnBreakdown: readonly HudContextTurnBreakdownItem[];
}

type ContextProjection = Pick<
  ThreadStructure,
  "thread" | "providerThreads" | "providerTurns" | "turnItems" | "messages"
>;

function isNonNegativeCount(value: number | null | undefined): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function nonNegativeCount(value: number | null | undefined): number | null {
  return isNonNegativeCount(value) ? value : null;
}

function positiveCount(value: number | null | undefined): number | null {
  return isNonNegativeCount(value) && value > 0 ? value : null;
}

const MAX_DYNAMIC_TOOL_CHARS = 16_384;
const MAX_DYNAMIC_TOOL_DEPTH = 12;
const INFERRED_PROMPT_CACHE_TTL_MS = 300_000;

type ToolItem = Extract<
  ThreadStructureTurnItem,
  {
    readonly type:
      | "command_execution"
      | "file_change"
      | "file_search"
      | "web_search"
      | "dynamic_tool";
  }
>;

function isToolItem(item: ThreadStructureTurnItem): item is ToolItem {
  return (
    item.type === "command_execution" ||
    item.type === "file_change" ||
    item.type === "file_search" ||
    item.type === "web_search" ||
    item.type === "dynamic_tool"
  );
}

// Count approximate JSON characters without allocating serialized tool bodies or walking past the cap.
function boundedJsonLength(value: unknown, limit: number, depth = 0): number {
  if (limit <= 0) return 0;
  if (typeof value === "string") return Math.min(limit, value.length + 2);
  if (typeof value === "number") return Math.min(limit, String(value).length);
  if (typeof value === "boolean") return Math.min(limit, value ? 4 : 5);
  if (value === null) return Math.min(limit, 4);
  if (typeof value !== "object") return 0;
  if (depth >= MAX_DYNAMIC_TOOL_DEPTH || limit <= 2) return Math.min(limit, 2);

  let length = 2;
  if (Array.isArray(value)) {
    for (const entry of value) {
      length += 1 + boundedJsonLength(entry, limit - length - 1, depth + 1);
      if (length >= limit) return limit;
    }
  } else {
    for (const key in value) {
      const property = Object.getOwnPropertyDescriptor(value, key);
      if (!property) continue;
      length += key.length + 4;
      if (length >= limit) return limit;
      const entry: unknown = property.value;
      length += boundedJsonLength(entry, limit - length, depth + 1);
      if (length >= limit) return limit;
    }
  }
  return length;
}

function toolCharacterCount(item: ToolItem): number {
  switch (item.type) {
    case "command_execution":
      return item.input.length + (item.output?.length ?? 0);
    case "file_change":
      return (
        item.fileName.length +
        (item.diffStr?.length ?? (item.oldStr?.length ?? 0) + (item.newStr?.length ?? 0))
      );
    case "file_search": {
      let count = item.pattern?.length ?? 0;
      for (const result of item.results ?? []) {
        count += result.fileName.length + (result.preview?.length ?? 0);
      }
      return count;
    }
    case "web_search": {
      let count = 0;
      for (const pattern of item.patterns ?? []) count += pattern.length;
      for (const result of item.results ?? []) {
        count +=
          (result.title?.length ?? 0) + (result.url?.length ?? 0) + (result.snippet?.length ?? 0);
      }
      return count;
    }
    case "dynamic_tool": {
      const nameLength = Math.min(MAX_DYNAMIC_TOOL_CHARS, item.toolName?.length ?? 0);
      try {
        const inputLength = boundedJsonLength(item.input, MAX_DYNAMIC_TOOL_CHARS - nameLength);
        return (
          nameLength +
          inputLength +
          boundedJsonLength(item.output, MAX_DYNAMIC_TOOL_CHARS - nameLength - inputLength)
        );
      } catch {
        return nameLength;
      }
    }
  }
}

function estimateBuckets(
  usedTokens: number,
  maxTokens: number | null,
  tools: number,
  assistant: number,
  user: number,
  compactionSummary: string | undefined,
): readonly HudContextBucket[] {
  const contentEstimate = tools + assistant + user;
  let systemBase = usedTokens - contentEstimate;
  if (usedTokens === 0) {
    systemBase = 0;
    tools = 0;
    assistant = 0;
    user = 0;
  } else if (systemBase < 0) {
    systemBase = Math.min(
      Math.round(usedTokens * 0.35),
      compactionSummary ? Math.round(compactionSummary.length / 4) : Math.round(usedTokens * 0.12),
    );
    const contentTokens = usedTokens - systemBase;
    const scale = contentTokens / contentEstimate;
    // Assign the largest bucket the remainder after rounding the other two.
    if (tools >= assistant && tools >= user) {
      assistant = Math.round(assistant * scale);
      user = Math.round(user * scale);
      tools = contentTokens - assistant - user;
    } else if (assistant >= user) {
      tools = Math.round(tools * scale);
      user = Math.round(user * scale);
      assistant = contentTokens - tools - user;
    } else {
      tools = Math.round(tools * scale);
      assistant = Math.round(assistant * scale);
      user = contentTokens - tools - assistant;
    }
  }

  const contextTokens = maxTokens ?? usedTokens;
  const bucket = (key: HudContextBucketKey, tokens: number): HudContextBucket => ({
    key,
    tokens,
    percentOfContext: contextTokens > 0 ? (tokens / contextTokens) * 100 : 0,
    percentOfUsed: usedTokens > 0 ? (tokens / usedTokens) * 100 : 0,
  });
  return [
    bucket("systemBase", systemBase),
    bucket("tools", tools),
    bucket("assistant", assistant),
    bucket("user", user),
  ];
}

function inActiveContext(item: ThreadStructureTurnItem, threadId: ProviderThreadId | null) {
  return item.providerThreadId === null || threadId === null || item.providerThreadId === threadId;
}

function contextCharacterCounts(
  projection: ContextProjection | null | undefined,
  activeThreadId: ProviderThreadId | null,
  firstItemIndex: number,
  splitTools = false,
) {
  let user = 0;
  let tools = 0;
  let assistant = 0;
  let mcpTools = 0;
  let subagents = 0;
  let plan = 0;
  // Index messages only when a structural item needs its separate text body.
  let messages:
    | Map<ThreadStructure["messages"][number]["id"], ThreadStructure["messages"][number]>
    | undefined;
  const items = projection?.turnItems ?? [];
  for (let index = firstItemIndex; index < items.length; index++) {
    const item = items[index]!;
    if (!inActiveContext(item, activeThreadId)) continue;
    if (isToolItem(item)) {
      const length = toolCharacterCount(item);
      if (
        splitTools &&
        (item.toolSource?.key.startsWith("mcp:") ||
          (item.type === "dynamic_tool" && item.toolName?.startsWith("mcp__")))
      ) {
        mcpTools += length;
      } else {
        tools += length;
      }
    } else if (splitTools && item.type === "subagent") {
      subagents += item.prompt.length + (item.result?.length ?? 0);
    } else if (item.type === "user_message" && (!item.textOmitted || item.text.length > 0)) {
      user += item.text.length;
    } else if (item.type === "assistant_message" || item.type === "user_message") {
      if (item.type === "assistant_message" && item.streaming) continue;
      if (!messages) {
        messages = new Map();
        for (const message of projection?.messages ?? []) messages.set(message.id, message);
      }
      const message = messages.get(item.messageId);
      if (item.type === "user_message") user += message?.text.length ?? 0;
      else if (message && !message.streaming) assistant += message.text.length;
    } else if (item.type === "proposed_plan" && !item.streaming) {
      plan += item.markdown.length;
    }
  }
  return { user, tools, mcpTools, subagents, assistant: assistant || plan };
}

function resolveLastTurnBreakdown(
  window: ContextWindowSnapshot | null | undefined,
  live: OrchestrationV2ProviderTurnTokenUsage | null | undefined,
  latestTurn: OrchestrationV2ProviderTurn | undefined,
): readonly HudContextTurnBreakdownItem[] {
  const usage = latestTurn?.turnTokenUsage;
  const fallback = latestTurn?.tokenUsage;
  const tokens: Readonly<Record<HudContextTurnBreakdownItem["key"], number | null | undefined>> = {
    input:
      window?.lastInputTokens ?? live?.inputTokens ?? usage?.inputTokens ?? fallback?.inputTokens,
    cachedInput:
      window?.lastCachedInputTokens ??
      live?.cachedInputTokens ??
      usage?.cachedInputTokens ??
      fallback?.cachedInputTokens,
    output:
      window?.lastOutputTokens ??
      live?.outputTokens ??
      usage?.outputTokens ??
      fallback?.outputTokens,
    reasoning:
      window?.lastReasoningOutputTokens ??
      live?.reasoningOutputTokens ??
      usage?.reasoningTokens ??
      fallback?.reasoningOutputTokens,
  };
  const breakdown: HudContextTurnBreakdownItem[] = [];
  for (const key of ["input", "cachedInput", "output", "reasoning"] as const) {
    const count = positiveCount(tokens[key]);
    if (count !== null) breakdown.push({ key, tokens: count });
  }
  return breakdown;
}

function assistantOutputEstimate(
  window: ContextWindowSnapshot | null | undefined,
  live: OrchestrationV2ProviderTurnTokenUsage | null | undefined,
  latestTurn: OrchestrationV2ProviderTurn | undefined,
  compactedAt: number | null,
): number {
  const windowTime = parseTimestampMs(window?.updatedAt);
  const liveTime = parseTimestampMs(live?.updatedAt);
  const turnTime =
    timestampMs(latestTurn?.completedAt) ?? parseTimestampMs(latestTurn?.tokenUsage?.updatedAt);
  const count =
    (compactedAt === null || (windowTime !== null && windowTime >= compactedAt)
      ? window?.lastOutputTokens
      : null) ??
    (compactedAt === null || (liveTime !== null && liveTime >= compactedAt)
      ? live?.outputTokens
      : null) ??
    (compactedAt === null || (turnTime !== null && turnTime > compactedAt)
      ? (latestTurn?.turnTokenUsage?.outputTokens ?? latestTurn?.tokenUsage?.outputTokens)
      : null);
  return positiveCount(count) ?? 0;
}

function cacheRate(
  input: number | null | undefined,
  cached: number | null | undefined,
): number | null {
  return isNonNegativeCount(input) &&
    input > 0 &&
    typeof cached === "number" &&
    Number.isFinite(cached)
    ? (Math.max(0, Math.min(cached, input)) / input) * 100
    : null;
}

function summarizePromptCache(
  projection: HeaderProjection | null | undefined,
  latestTurn: OrchestrationV2ProviderTurn | undefined,
  requestedModel: string | null | undefined,
  window: ContextWindowSnapshot | null | undefined,
) {
  const activeThreadId = projection?.thread.activeProviderThreadId ?? null;
  const turns = projection?.providerTurns ?? [];
  const latestIsMixed = hasMultipleModels(latestTurn);
  const model = (latestIsMixed ? null : reportedModel(latestTurn)) ?? nonEmptyText(requestedModel);
  const hasOtherModel = turns.some((turn) => {
    if (!deliveredOnThread(turn, activeThreadId)) return false;
    const reported = reportedModel(turn);
    return hasMultipleModels(turn) || (reported !== null && reported !== model);
  });

  let sampleCount = 0;
  let totalInput = 0;
  let totalCached = 0;
  let lastRate: number | null = null;
  let lastSample: OrchestrationV2ProviderTurn | undefined;
  let latestCompletedAt: number | null = null;
  for (const turn of turns) {
    if (
      !deliveredOnThread(turn, activeThreadId) ||
      hasMultipleModels(turn) ||
      turn.turnTokenUsage?.localCommand
    )
      continue;
    const reported = reportedModel(turn);
    if (reported === null ? hasOtherModel : reported !== model) continue;
    if (turn.status === "completed" && turn.completedAt !== null) {
      latestCompletedAt = Math.max(
        latestCompletedAt ?? -Infinity,
        DateTime.toEpochMillis(turn.completedAt),
      );
    }
    const usage = turn.turnTokenUsage;
    const source =
      usage?.inputTokens !== undefined && usage.cachedInputTokens !== undefined
        ? usage
        : turn.tokenUsage;
    const input = source?.inputTokens;
    const cached = source?.cachedInputTokens;
    if (
      !isNonNegativeCount(input) ||
      input === 0 ||
      cached === undefined ||
      !Number.isFinite(cached)
    )
      continue;
    const cacheRead = Math.max(0, Math.min(cached, input));
    totalInput += input;
    totalCached += cacheRead;
    sampleCount++;
    if (!lastSample || isLaterTurn(turn, lastSample)) {
      lastSample = turn;
      lastRate = (cacheRead / input) * 100;
    }
  }
  if (sampleCount > 0) {
    return {
      model,
      hasOtherModel,
      latestIsMixed,
      sampleCount,
      lastRate,
      cumulativeRate: (totalCached / totalInput) * 100,
      latestCompletedAt,
    };
  }

  // Model-less snapshots have no provenance after a switch; only use them on single-model threads.
  const snapshotRate =
    latestIsMixed || hasOtherModel
      ? null
      : (cacheRate(window?.lastInputTokens, window?.lastCachedInputTokens) ??
        cacheRate(window?.inputTokens, window?.cachedInputTokens));
  return {
    model,
    hasOtherModel,
    latestIsMixed,
    sampleCount: snapshotRate === null ? 0 : 1,
    lastRate: snapshotRate,
    cumulativeRate: snapshotRate,
    latestCompletedAt,
  };
}

function promptCacheExpiration(
  live: OrchestrationV2ProviderTurnTokenUsage | null | undefined,
  liveMatchesActiveModel: boolean,
  lastRate: number | null,
  completedAt: number | null,
  window: ContextWindowSnapshot | null | undefined,
  allowWindowFallback: boolean,
): number | null {
  if (liveMatchesActiveModel) {
    const expiresAt = parseTimestampMs(live?.promptCacheExpiresAt);
    if (expiresAt !== null) return expiresAt;
    const ttl = positiveCount(live?.promptCacheTtlMs);
    const liveUpdatedAt = parseTimestampMs(live?.updatedAt);
    if (ttl !== null && liveUpdatedAt !== null) return liveUpdatedAt + ttl;
  }
  if (lastRate === null || lastRate <= 0) return null;
  const lastActivity =
    completedAt ?? (allowWindowFallback ? parseTimestampMs(window?.updatedAt) : null);
  return lastActivity === null ? null : lastActivity + INFERRED_PROMPT_CACHE_TTL_MS;
}

export function derivePromptCacheCountdown(
  expiresAtMs: number | null,
  nowMs: number,
): { readonly state: HudPromptCacheState; readonly remainingMs: number | null } {
  if (expiresAtMs === null || !Number.isFinite(expiresAtMs) || !Number.isFinite(nowMs)) {
    return { state: "unknown", remainingMs: null };
  }
  return expiresAtMs > nowMs
    ? { state: "warm", remainingMs: expiresAtMs - nowMs }
    : { state: "cold", remainingMs: 0 };
}

type ContextUsageInput = {
  readonly contextWindow?: ContextWindowSnapshot | null | undefined;
  readonly liveTokenUsage?: OrchestrationV2ProviderTurnTokenUsage | null | undefined;
};

function measureContextUsage({ contextWindow, liveTokenUsage }: ContextUsageInput) {
  const usedTokens =
    nonNegativeCount(contextWindow?.usedTokens) ?? nonNegativeCount(liveTokenUsage?.usedTokens);
  if (usedTokens === null) return null;
  const maxTokens =
    positiveCount(contextWindow?.maxTokens) ?? positiveCount(liveTokenUsage?.maxTokens);
  const usedPercentage = maxTokens === null ? null : Math.min(100, (usedTokens / maxTokens) * 100);
  const usageTone: HudContextUsageTone =
    usedPercentage === null || usedPercentage < 65
      ? "normal"
      : usedPercentage < 85
        ? "warning"
        : "error";
  const autoCompactThreshold =
    positiveCount(contextWindow?.autoCompactThreshold) ??
    positiveCount(liveTokenUsage?.autoCompactThreshold);
  const autoCompactTickPercent =
    maxTokens !== null && autoCompactThreshold !== null && autoCompactThreshold < maxTokens
      ? (autoCompactThreshold / maxTokens) * 100
      : null;
  return {
    usedTokens,
    maxTokens,
    usedPercentage,
    usageTone,
    autoCompactThreshold,
    autoCompactTickPercent,
    over200k: usedTokens >= 200_000,
  };
}

type PromptCacheInput = ContextUsageInput & {
  readonly projection?: HeaderProjection | null | undefined;
  readonly requestedModel?: string | null | undefined;
  readonly nowMs: number;
};

function measurePromptCache(
  input: PromptCacheInput,
  latestTurn: OrchestrationV2ProviderTurn | undefined,
) {
  const { projection, contextWindow, liveTokenUsage } = input;
  const cache = summarizePromptCache(projection, latestTurn, input.requestedModel, contextWindow);
  const turnUsage = latestTurn?.tokenUsage;
  const liveOwnedByLatestTurn =
    turnUsage != null &&
    liveTokenUsage != null &&
    (turnUsage === liveTokenUsage ||
      (turnUsage.updatedAt === liveTokenUsage.updatedAt &&
        turnUsage.usedTokens === liveTokenUsage.usedTokens &&
        turnUsage.promptCacheExpiresAt === liveTokenUsage.promptCacheExpiresAt &&
        turnUsage.promptCacheTtlMs === liveTokenUsage.promptCacheTtlMs));
  const liveMatchesActiveModel =
    !cache.latestIsMixed &&
    (!cache.hasOtherModel ||
      (cache.model !== null && reportedModel(latestTurn) === cache.model && liveOwnedByLatestTurn));
  const expiresAt = promptCacheExpiration(
    liveTokenUsage,
    liveMatchesActiveModel,
    cache.lastRate,
    cache.latestCompletedAt,
    contextWindow,
    !cache.hasOtherModel && !cache.latestIsMixed,
  );
  return { cache, expiresAt, countdown: derivePromptCacheCountdown(expiresAt, input.nowMs) };
}

function latestContextCompactionIndex(
  items: ThreadStructure["turnItems"],
  providerThreadId: ProviderThreadId | null,
) {
  return items.findLastIndex(
    (item) =>
      item.type === "compaction" &&
      item.status === "completed" &&
      inActiveContext(item, providerThreadId),
  );
}

export function deriveHudContextMetrics(input: {
  readonly contextWindow: ContextWindowSnapshot | null | undefined;
  readonly liveTokenUsage: OrchestrationV2ProviderTurnTokenUsage | null | undefined;
  readonly projection: ContextProjection | null | undefined;
  readonly requestedModel: string | null | undefined;
  readonly nowMs: number;
}): HudContextMetrics | null {
  const { contextWindow, liveTokenUsage, projection } = input;
  const measured = measureContextUsage(input);
  if (measured === null) return null;
  const { usedTokens, maxTokens } = measured;

  const activeThreadId = projection?.thread.activeProviderThreadId ?? null;
  const items = projection?.turnItems ?? [];
  const compactionIndex = latestContextCompactionIndex(items, activeThreadId);
  const compaction = items[compactionIndex];
  const latestTurn = latestDeliveredTurn(projection);
  let tools = 0;
  let assistant = 0;
  let user = 0;
  if (usedTokens > 0) {
    const chars = contextCharacterCounts(projection, activeThreadId, compactionIndex + 1);
    tools = Math.round(chars.tools / 4);
    user = Math.round(chars.user / 4);
    const compactedAt =
      compaction?.type === "compaction"
        ? timestampMs(compaction.completedAt ?? compaction.updatedAt)
        : null;
    assistant =
      chars.assistant > 0
        ? Math.round(chars.assistant / 4)
        : assistantOutputEstimate(contextWindow, liveTokenUsage, latestTurn, compactedAt);
  }
  const { cache, expiresAt, countdown } = measurePromptCache(input, latestTurn);
  return {
    ...measured,
    hasCompaction: compactionIndex >= 0,
    isApproximate: true,
    buckets: estimateBuckets(
      usedTokens,
      maxTokens,
      tools,
      assistant,
      user,
      compaction?.type === "compaction" ? compaction.summary : undefined,
    ),
    lastTurnCacheHitRate: cache.lastRate,
    cumulativeCacheHitRate: cache.cumulativeRate,
    cacheSampleTurnCount: cache.sampleCount,
    cacheModel: cache.model,
    promptCacheExpiresAtMs: expiresAt,
    promptCacheState: countdown.state,
    promptCacheRemainingMs: countdown.remainingMs,
    lastTurnBreakdown: resolveLastTurnBreakdown(contextWindow, liveTokenUsage, latestTurn),
  };
}

function splitPromptInput(
  inputTokens: number | null | undefined,
  cachedInputTokens: number | null | undefined,
) {
  if (!isNonNegativeCount(inputTokens) || !isNonNegativeCount(cachedInputTokens)) return null;
  if (inputTokens === 0) return null;
  const cacheReuseTokens = Math.min(cachedInputTokens, inputTokens);
  const cacheReusePercent = (cacheReuseTokens / inputTokens) * 100;
  return {
    cacheReuseTokens,
    cacheReusePercent,
    newInputTokens: inputTokens - cacheReuseTokens,
    newInputPercent: 100 - cacheReusePercent,
  };
}

export function deriveComposerContextBreakdown(
  input: ContextUsageInput & { readonly projection?: ContextProjection | null | undefined },
) {
  const { projection, contextWindow } = input;
  const latestTurn = latestDeliveredTurn(projection);
  const liveTokenUsage = input.liveTokenUsage ?? latestTurn?.tokenUsage;
  const measured = measureContextUsage({ contextWindow, liveTokenUsage });
  if (measured === null) return null;
  const { usedTokens, maxTokens } = measured;
  const activeThreadId = projection?.thread.activeProviderThreadId ?? null;
  const items = projection?.turnItems ?? [];
  const compactionIndex = latestContextCompactionIndex(items, activeThreadId);
  const compaction = items[compactionIndex];
  const compactedAt =
    compaction?.type === "compaction"
      ? timestampMs(compaction.completedAt ?? compaction.updatedAt)
      : null;

  const chars =
    usedTokens > 0
      ? contextCharacterCounts(projection, activeThreadId, compactionIndex + 1, true)
      : null;
  const assistant =
    chars === null
      ? 0
      : chars.assistant > 0
        ? Math.round(chars.assistant / 4)
        : assistantOutputEstimate(contextWindow, liveTokenUsage, latestTurn, compactedAt);
  const observed = [
    ["messages", assistant + Math.round((chars?.user ?? 0) / 4)],
    ["tools", Math.round((chars?.tools ?? 0) / 4)],
    ["mcpTools", Math.round((chars?.mcpTools ?? 0) / 4)],
    ["subagents", Math.round((chars?.subagents ?? 0) / 4)],
  ] as const;
  const observedTotal = observed.reduce((total, [, tokens]) => total + tokens, 0);
  const systemBase =
    observedTotal <= usedTokens
      ? usedTokens - observedTotal
      : Math.min(
          Math.round(usedTokens * 0.35),
          compaction?.type === "compaction" && compaction.summary
            ? Math.round(compaction.summary.length / 4)
            : Math.round(usedTokens * 0.12),
        );
  const observedBudget = Math.min(observedTotal, usedTokens - systemBase);
  const contextCapacity = Math.max(maxTokens ?? usedTokens, usedTokens);
  const bucket = (
    key: (typeof observed)[number][0] | "systemBase" | "remaining",
    tokens: number | null,
  ) => ({
    key,
    tokens,
    percentOfContext: contextCapacity > 0 && tokens !== null ? (tokens / contextCapacity) * 100 : 0,
    percentOfUsed:
      key !== "remaining" && usedTokens > 0 && tokens !== null ? (tokens / usedTokens) * 100 : 0,
  });
  let raw = 0;
  let scaled = 0;
  const estimatedBuckets = observed.map(([key, tokens]) => {
    raw += tokens;
    const next = observedTotal > 0 ? Math.round((raw / observedTotal) * observedBudget) : 0;
    const entry = bucket(key, next - scaled);
    scaled = next;
    return entry;
  });

  // Cache reuse is the latest step's input split, not a slice of the whole context window.
  const contextIsFresh =
    compactedAt === null ||
    (parseTimestampMs(contextWindow?.updatedAt) ?? -Infinity) >= compactedAt;
  const liveIsFresh =
    compactedAt === null ||
    (parseTimestampMs(liveTokenUsage?.updatedAt) ?? -Infinity) >= compactedAt;
  const cacheSplit =
    (contextIsFresh
      ? (splitPromptInput(contextWindow?.lastInputTokens, contextWindow?.lastCachedInputTokens) ??
        splitPromptInput(contextWindow?.inputTokens, contextWindow?.cachedInputTokens))
      : null) ??
    (liveIsFresh
      ? splitPromptInput(liveTokenUsage?.inputTokens, liveTokenUsage?.cachedInputTokens)
      : null);
  return {
    ...measured,
    hasCompaction: compactionIndex >= 0,
    isApproximate: true as const,
    buckets: [
      estimatedBuckets[0]!,
      bucket("systemBase", systemBase),
      ...estimatedBuckets.slice(1),
      bucket("remaining", maxTokens === null ? null : Math.max(0, maxTokens - usedTokens)),
    ],
    cacheSplit,
  };
}

export type HudBillingMode = "cost" | "subscription" | "unknown";

export interface HudSessionMetrics {
  readonly tokensPerSecond: number | null;
  readonly liveTurnOutputTokens: number | null;
  readonly liveTurnStartedAtMs: number | null;
  readonly ttftMs: number | null;
  readonly activeDurationMs: number | null;
  readonly completedDurationMs: number;
  readonly activeRunStartedAtMs: number | null;
  readonly earliestRunStartedAtMs: number | null;
  readonly wallClockSpanMs: number | null;
  readonly turnCount: number;
  readonly cost: { readonly amount: number; readonly currency: string } | null;
  readonly billingMode: HudBillingMode;
  readonly requestedModel: string | null;
  readonly servedModel: string | null;
  readonly modelDelta: { readonly from: string; readonly to: string } | null;
  readonly thinkingEffort: string | null;
  readonly interactionMode: string | null;
  readonly runtimeMode: string | null;
}

const MAX_TTFT_MS = 30 * 60_000;

function outputRate(
  tokens: number | null | undefined,
  durationMs: number | null | undefined,
  minDurationMs = 100,
): number | null {
  const output = positiveCount(tokens);
  return output !== null &&
    durationMs != null &&
    Number.isFinite(durationMs) &&
    durationMs >= minDurationMs
    ? (output / durationMs) * 1_000
    : null;
}

function measureTurns(
  turns: ThreadStructure["providerTurns"],
  activeThreadId: ProviderThreadId | null,
) {
  let turnCount = 0;
  let tokensPerSecond: number | null = null;
  let latestRateAt = -Infinity;
  let liveTurn: OrchestrationV2ProviderTurn | undefined;
  let liveTurnOutputTokens: number | null = null;
  let liveTurnStartedAtMs: number | null = null;
  for (const turn of turns) {
    if (turn.promptDropped) continue;
    turnCount++;
    if (turn.turnTokenUsage?.localCommand) continue;
    if (
      turn.status === "running" &&
      deliveredOnThread(turn, activeThreadId) &&
      turn.startedAt !== null
    ) {
      const liveOutput = positiveCount(
        turn.turnTokenUsage?.outputTokens ?? turn.tokenUsage?.outputTokens,
      );
      if (liveOutput !== null && (!liveTurn || isLaterTurn(turn, liveTurn))) {
        liveTurn = turn;
        liveTurnOutputTokens = liveOutput;
        liveTurnStartedAtMs = DateTime.toEpochMillis(turn.startedAt);
      }
      continue;
    }
    if (turn.status !== "completed" || turn.startedAt === null || turn.completedAt === null)
      continue;
    const completedAt = DateTime.toEpochMillis(turn.completedAt);
    if (completedAt < latestRateAt) continue;
    const durationMs = completedAt - DateTime.toEpochMillis(turn.startedAt);
    const rate = outputRate(
      turn.turnTokenUsage?.outputTokens ?? turn.tokenUsage?.outputTokens,
      durationMs,
    );
    if (rate !== null) {
      tokensPerSecond = rate;
      latestRateAt = completedAt;
    }
  }
  return { turnCount, tokensPerSecond, liveTurnOutputTokens, liveTurnStartedAtMs };
}

function measureTurnTtft(
  projection:
    | (Pick<ThreadStructure, "thread" | "providerTurns"> &
        Partial<Pick<ThreadStructure, "turnItems">>)
    | null
    | undefined,
): number | null {
  const items = projection?.turnItems;
  if (!projection || !items || items.length === 0) return null;
  const activeThreadId = projection.thread.activeProviderThreadId ?? null;
  const earliestOutputByTurn = new Map<string, number>();
  for (const item of items) {
    if (
      item.providerTurnId === null ||
      item.startedAt === null ||
      !(item.type === "reasoning" || item.type === "assistant_message" || isToolItem(item))
    ) {
      continue;
    }
    const startedAt = DateTime.toEpochMillis(item.startedAt);
    const existing = earliestOutputByTurn.get(item.providerTurnId);
    if (existing === undefined || startedAt < existing) {
      earliestOutputByTurn.set(item.providerTurnId, startedAt);
    }
  }
  if (earliestOutputByTurn.size === 0) return null;

  let chosenTurn: OrchestrationV2ProviderTurn | undefined;
  let chosenTtftMs: number | null = null;
  for (const turn of projection.providerTurns) {
    if (
      !deliveredOnThread(turn, activeThreadId) ||
      turn.turnTokenUsage?.localCommand ||
      turn.startedAt === null
    ) {
      continue;
    }
    const firstOutputAt = earliestOutputByTurn.get(turn.id);
    if (firstOutputAt === undefined) continue;
    const delta = firstOutputAt - DateTime.toEpochMillis(turn.startedAt);
    if (!Number.isFinite(delta) || delta <= 0 || delta > MAX_TTFT_MS) continue;
    if (!chosenTurn || isLaterTurn(turn, chosenTurn)) {
      chosenTurn = turn;
      chosenTtftMs = delta;
    }
  }
  return chosenTtftMs;
}

type TimeInterval = [startMs: number, endMs: number];

function measureRuns(runs: ThreadStructure["runs"], nowMs: number, intervals?: TimeInterval[]) {
  let activeDurationMs: number | null = null;
  let completedDurationMs = 0;
  let activeRunStartedAtMs: number | null = null;
  let earliestStart = Infinity;
  let latestEnd = -Infinity;
  for (const run of runs) {
    const start = timestampMs(run.workStartedAt ?? run.startedAt);
    if (start === null) continue;
    earliestStart = Math.min(earliestStart, start);
    const completed = timestampMs(run.completedAt);
    const active = completed === null && (isRunExecuting(run.status) || run.status === "waiting");
    if (active) {
      activeRunStartedAtMs =
        activeRunStartedAtMs === null ? start : Math.min(activeRunStartedAtMs, start);
    }
    const end = completed ?? (active && Number.isFinite(nowMs) ? nowMs : null);
    if (end === null) continue;
    const elapsed = Math.max(0, end - start);
    if (elapsed > 0) intervals?.push([start, end]);
    if (completed !== null) completedDurationMs += elapsed;
    activeDurationMs = (activeDurationMs ?? 0) + elapsed;
    latestEnd = Math.max(latestEnd, end);
  }
  return {
    activeDurationMs,
    completedDurationMs,
    activeRunStartedAtMs,
    earliestRunStartedAtMs: earliestStart === Infinity ? null : earliestStart,
    wallClockSpanMs: latestEnd === -Infinity ? null : Math.max(0, latestEnd - earliestStart),
  };
}

function readThinkingEffort(thread: ThreadStructure["thread"] | undefined): string | null {
  const options = thread?.modelSelection.options;
  if (!options) return null;
  for (const id of ["reasoningEffort", "effort", "thinkingLevel", "thinking"]) {
    const value = options.find((option) => option.id === id)?.value;
    if (typeof value === "string") {
      const effort = nonEmptyText(value);
      if (effort !== null) {
        return effort.toLowerCase() === "off" ? null : effort;
      }
    }
    if (id === "thinking" && value === true) return "enabled";
  }
  return null;
}

export function deriveHudSessionMetrics(input: {
  readonly contextWindow: ContextWindowSnapshot | null | undefined;
  readonly projection:
    | (Pick<ThreadStructure, "thread" | "runs" | "providerTurns"> &
        Partial<Pick<ThreadStructure, "turnItems">>)
    | null
    | undefined;
  readonly requestedModel: string | null | undefined;
  readonly hasQuotaLimits: boolean;
  readonly nowMs: number;
}): HudSessionMetrics {
  const { contextWindow, projection } = input;
  const activeThreadId = projection?.thread.activeProviderThreadId ?? null;
  const turns = measureTurns(projection?.providerTurns ?? [], activeThreadId);
  const runs = measureRuns(projection?.runs ?? [], input.nowMs);
  const reportedCost = contextWindow?.cost;
  const cost =
    reportedCost &&
    Number.isFinite(reportedCost.amount) &&
    reportedCost.amount >= 0 &&
    typeof reportedCost.currency === "string" &&
    reportedCost.currency.trim()
      ? reportedCost
      : null;
  const requestedModel = nonEmptyText(input.requestedModel);
  const servedModel = reportedModel(latestDeliveredTurn(projection));
  const liveTokensPerSecond =
    turns.liveTurnOutputTokens !== null && turns.liveTurnStartedAtMs !== null
      ? outputRate(turns.liveTurnOutputTokens, input.nowMs - turns.liveTurnStartedAtMs, 500)
      : null;
  return {
    tokensPerSecond:
      turns.tokensPerSecond ??
      liveTokensPerSecond ??
      outputRate(contextWindow?.lastOutputTokens, contextWindow?.durationMs),
    liveTurnOutputTokens: turns.liveTurnOutputTokens,
    liveTurnStartedAtMs: turns.liveTurnStartedAtMs,
    ttftMs: measureTurnTtft(projection),
    activeDurationMs: runs.activeDurationMs ?? positiveCount(contextWindow?.durationMs),
    completedDurationMs: runs.completedDurationMs,
    activeRunStartedAtMs: runs.activeRunStartedAtMs,
    earliestRunStartedAtMs: runs.earliestRunStartedAtMs,
    wallClockSpanMs: runs.wallClockSpanMs,
    turnCount: turns.turnCount,
    cost,
    billingMode: cost !== null ? "cost" : input.hasQuotaLimits ? "subscription" : "unknown",
    requestedModel,
    servedModel,
    modelDelta:
      requestedModel !== null && servedModel !== null && requestedModel !== servedModel
        ? { from: requestedModel, to: servedModel }
        : null,
    thinkingEffort: readThinkingEffort(projection?.thread),
    interactionMode: projection?.thread.interactionMode ?? null,
    runtimeMode: projection?.thread.runtimeMode ?? null,
  };
}

export type HudSubagentStatus = "running" | "waiting" | "completed" | "failed" | "cancelled";

export interface HudSubagentEntry {
  readonly id: NodeId;
  readonly origin?: OrchestrationV2Subagent["origin"];
  readonly title: string;
  readonly status: HudSubagentStatus;
  readonly isActive: boolean;
  readonly model: string | null;
  readonly childThreadId: ThreadId | null;
  readonly remoteChild: OrchestrationV2RemoteTaskChild | null;
  readonly startedAtMs: number | null;
  readonly durationMs: number | null;
}

export type HudToolStatus = "running" | "partial_failure" | "failed" | "completed";

export interface HudToolEntry {
  readonly name: string;
  readonly totalCount: number;
  readonly runningCount: number;
  readonly failedCount: number;
  readonly status: HudToolStatus;
}

export interface HudActivityMetrics {
  readonly subagents: readonly HudSubagentEntry[];
  readonly totalSubagentCount: number;
  readonly overflowSubagentCount: number;
  readonly tools: readonly HudToolEntry[];
  readonly totalToolCalls: number;
  readonly overflowToolCount: number;
  readonly isEmpty: boolean;
}

const DEFAULT_ACTIVITY_LIMIT = 8;

type ToolCounts = { name: string; totalCount: number; runningCount: number; failedCount: number };

function subagentStatus(status: OrchestrationV2Subagent["status"]): HudSubagentStatus {
  switch (status) {
    case "idle":
    case "pending":
      return "waiting";
    case "interrupted":
      return "cancelled";
    default:
      return status;
  }
}

function presentSubagent(agent: OrchestrationV2Subagent, nowMs: number): HudSubagentEntry {
  const start = timestampMs(agent.startedAt);
  const completed = timestampMs(agent.completedAt);
  const isActive = completed === null && isOrchestrationV2WorkActive(agent.status);
  const end = completed ?? (isActive && Number.isFinite(nowMs) ? nowMs : null);
  return {
    id: agent.id,
    origin: agent.origin,
    title: formatSubagentDisplayTitle(agent.title ?? agent.id).trim() || agent.id,
    status: subagentStatus(agent.status),
    isActive,
    model: agent.executedModel ?? agent.model ?? agent.modelSelection?.model ?? null,
    childThreadId: agent.childThreadId,
    remoteChild: agent.remoteChild ?? null,
    startedAtMs: start,
    durationMs: start === null || end === null ? null : Math.max(0, end - start),
  };
}

function activityLimit(limit: number | undefined) {
  return Number.isFinite(limit) && limit !== undefined
    ? Math.max(0, Math.trunc(limit))
    : DEFAULT_ACTIVITY_LIMIT;
}

function compareSubagents(left: OrchestrationV2Subagent, right: OrchestrationV2Subagent) {
  return (
    Number(isOrchestrationV2WorkActive(right.status)) -
      Number(isOrchestrationV2WorkActive(left.status)) ||
    DateTime.toEpochMillis(right.updatedAt) - DateTime.toEpochMillis(left.updatedAt)
  );
}

function toolStatus(counts: ToolCounts): HudToolStatus {
  if (counts.runningCount > 0) return "running";
  if (counts.failedCount === 0) return "completed";
  return counts.failedCount === counts.totalCount ? "failed" : "partial_failure";
}

export function deriveHudActivityMetrics(input: {
  readonly projection: Pick<ThreadStructure, "subagents" | "turnItems"> | null | undefined;
  readonly nowMs: number;
  readonly maxSubagents?: number;
  readonly maxTools?: number;
}): HudActivityMetrics {
  const agents = input.projection?.subagents ?? [];
  const topAgents = agents.toSorted(compareSubagents);
  topAgents.length = Math.min(topAgents.length, activityLimit(input.maxSubagents));
  const subagents = topAgents.map((agent) => presentSubagent(agent, input.nowMs));

  let totalToolCalls = 0;
  const countsByName = new Map<string, ToolCounts>();
  for (const item of input.projection?.turnItems ?? []) {
    if (!isToolItem(item)) continue;
    const name =
      item.type === "dynamic_tool" ? item.toolName?.trim().toLowerCase() || item.type : item.type;
    let counts = countsByName.get(name);
    if (!counts) {
      counts = { name, totalCount: 0, runningCount: 0, failedCount: 0 };
      countsByName.set(name, counts);
    }
    counts.totalCount++;
    totalToolCalls++;
    const failed =
      item.status === "failed" ||
      (item.type === "command_execution" &&
        ((item.exitCode !== undefined && item.exitCode !== 0) ||
          item.outputIndicatesFailure === true));
    if (failed) counts.failedCount++;
    else if (isOrchestrationV2WorkActive(item.status)) counts.runningCount++;
  }
  const topTools = [...countsByName.values()].sort(
    (left, right) =>
      Number(right.runningCount > 0) - Number(left.runningCount > 0) ||
      right.totalCount - left.totalCount,
  );
  topTools.length = Math.min(topTools.length, activityLimit(input.maxTools));
  const tools = topTools.map((counts) => ({ ...counts, status: toolStatus(counts) }));
  return {
    subagents,
    totalSubagentCount: agents.length,
    overflowSubagentCount: agents.length - subagents.length,
    tools,
    totalToolCalls,
    overflowToolCount: countsByName.size - tools.length,
    isEmpty: agents.length === 0 && totalToolCalls === 0,
  };
}

type SessionProjection = HeaderProjection &
  Partial<Pick<ThreadStructure, "runs" | "turnItems" | "subagents">>;

type SessionTelemetryInput = Omit<PromptCacheInput, "projection"> & {
  readonly projection?: SessionProjection | null | undefined;
  readonly childThreadProjections?: ReadonlyMap<ThreadId, SessionProjection> | undefined;
  readonly settings?:
    | Partial<Pick<ServerSettings, "usageModelAliases" | "usagePriceOverrides">>
    | undefined;
};

type TurnTotals = {
  readonly input: number | null;
  readonly output: number | null;
  readonly cacheRead: number | null;
  readonly cacheWrite: number | null;
  readonly reasoning: number | null;
};

function readTurnTotals(turn: OrchestrationV2ProviderTurn): TurnTotals {
  const usage = turn.turnTokenUsage;
  const snapshot = turn.tokenUsage;
  // Legacy snapshots are last-step observations, never the cumulative context watermark.
  const input = nonNegativeCount(usage === undefined ? snapshot?.inputTokens : usage.inputTokens);
  const output = nonNegativeCount(
    usage === undefined ? snapshot?.outputTokens : usage.outputTokens,
  );
  const cacheRead = nonNegativeCount(
    usage === undefined ? snapshot?.cachedInputTokens : usage.cachedInputTokens,
  );
  const cacheWrite = nonNegativeCount(usage?.cacheCreationTokens);
  const reasoning = nonNegativeCount(
    usage === undefined ? snapshot?.reasoningOutputTokens : usage.reasoningTokens,
  );
  return {
    input,
    output,
    cacheRead: input === null || cacheRead === null ? cacheRead : Math.min(cacheRead, input),
    cacheWrite,
    reasoning: output === null || reasoning === null ? reasoning : Math.min(reasoning, output),
  };
}

function isModelStep(turn: OrchestrationV2ProviderTurn, { input, output }: TurnTotals) {
  return (
    !turn.turnTokenUsage?.localCommand &&
    ((input ?? 0) > 0 ||
      (output ?? 0) > 0 ||
      positiveCount(turn.turnTokenUsage?.requestCount) !== null ||
      (turn.startedAt !== null && (turn.status === "completed" || turn.status === "failed")))
  );
}

function validReportedAmount(value: number | undefined) {
  return value !== undefined && Number.isFinite(value) && value >= 0 ? value : null;
}

function summarizeSessionTurns(projection: SessionProjection | null | undefined) {
  const activeThreadId = projection?.thread.activeProviderThreadId ?? null;
  const tokens = {
    input: 0,
    output: 0,
    uncachedInput: 0,
    cacheRead: 0,
    cacheWrite: 0,
    reasoning: 0,
  };
  let turns = 0;
  let steps = 0;
  let requests: number | null = null;
  let measuredInput = false;
  let measuredOutput = false;
  let cacheSampleInput = 0;
  let cacheSampleRead = 0;
  let reportedCostUsd: number | null = null;
  let missingCost = false;
  let speedOutput = 0;
  let speedDuration = 0;
  let peak: number | null = null;
  let latest: number | null = null;
  let latestRateAt = -Infinity;
  let liveTurn: OrchestrationV2ProviderTurn | undefined;
  let liveTurnOutputTokens: number | null = null;
  let liveTurnStartedAtMs: number | null = null;
  for (const turn of projection?.providerTurns ?? []) {
    if (turn.promptDropped) continue;
    turns++;
    const usage = turn.turnTokenUsage;
    const cost = validReportedAmount(usage?.costUsd);
    if (cost !== null) reportedCostUsd = (reportedCostUsd ?? 0) + cost;
    if (usage?.localCommand) continue;

    const counts = readTurnTotals(turn);
    const modelStep = isModelStep(turn, counts);
    const requestCount = positiveCount(usage?.requestCount);
    if (requestCount !== null) requests = (requests ?? 0) + requestCount;
    steps += requestCount ?? (modelStep ? 1 : 0);
    if (modelStep && cost === null) missingCost = true;
    if (counts.input !== null) {
      measuredInput = true;
      tokens.input += counts.input;
      tokens.uncachedInput += Math.max(
        0,
        counts.input - (counts.cacheRead ?? 0) - (counts.cacheWrite ?? 0),
      );
      if (counts.input > 0 && counts.cacheRead !== null) {
        cacheSampleInput += counts.input;
        cacheSampleRead += counts.cacheRead;
      }
    }
    if (counts.output !== null) measuredOutput = true;
    tokens.output += counts.output ?? 0;
    tokens.cacheRead += counts.cacheRead ?? 0;
    tokens.cacheWrite += counts.cacheWrite ?? 0;
    tokens.reasoning += counts.reasoning ?? 0;

    const startedAt = timestampMs(turn.startedAt);
    if (startedAt === null) continue;
    if (turn.status === "running" && deliveredOnThread(turn, activeThreadId)) {
      if (liveTurn === undefined || isLaterTurn(turn, liveTurn)) {
        liveTurn = turn;
        liveTurnStartedAtMs = startedAt;
        liveTurnOutputTokens = positiveCount(
          Math.max(counts.output ?? 0, positiveCount(turn.tokenUsage?.outputTokens) ?? 0),
        );
      }
      continue;
    }
    const completedAt = timestampMs(turn.completedAt);
    if (turn.status !== "completed" || completedAt === null) continue;
    const duration = completedAt - startedAt;
    const rate = outputRate(counts.output, duration);
    if (rate === null || counts.output === null) continue;
    speedOutput += counts.output;
    speedDuration += duration;
    peak = Math.max(peak ?? 0, rate);
    if (completedAt >= latestRateAt) {
      latest = rate;
      latestRateAt = completedAt;
    }
  }
  return {
    turns,
    steps,
    requests,
    tokens: { ...tokens, total: tokens.input + tokens.output },
    measuredInput,
    measuredOutput,
    hitRate: cacheSampleInput === 0 ? null : (cacheSampleRead / cacheSampleInput) * 100,
    reportedCostUsd: missingCost ? null : validReportedAmount(reportedCostUsd ?? undefined),
    speed: {
      average: outputRate(speedOutput, speedDuration),
      peak,
      latest,
      liveTurnOutputTokens,
      liveTurnStartedAtMs,
    },
  };
}

function latestSessionCost(
  input: ContextUsageInput & { readonly projection?: SessionProjection | null | undefined },
) {
  const latest: { cost: ContextWindowSnapshot["cost"]; at: number } = { cost: null, at: -Infinity };
  const consider = (
    snapshot: ContextWindowSnapshot | OrchestrationV2ProviderTurnTokenUsage | null | undefined,
  ) => {
    if (snapshot?.cost == null || validReportedAmount(snapshot.cost.amount) === null) return;
    if (!snapshot.cost.currency.trim()) return;
    const at = parseTimestampMs(snapshot.updatedAt) ?? -Infinity;
    if (at < latest.at) return;
    latest.at = at;
    latest.cost = snapshot.cost;
  };
  const { projection } = input;
  const activeThreadId = projection?.thread.activeProviderThreadId ?? null;
  for (const turn of projection?.providerTurns ?? []) {
    if (deliveredOnThread(turn, activeThreadId)) consider(turn.tokenUsage);
  }
  consider(input.liveTokenUsage);
  consider(input.contextWindow);
  return latest.cost;
}

function estimateSessionCost(input: SessionTelemetryInput): ReferenceCostEstimate | null {
  const { projection, settings } = input;
  const turns = projection?.providerTurns ?? [];
  const requested = nonEmptyText(input.requestedModel ?? projection?.thread.modelSelection.model);
  const activeThreadId = projection?.thread.activeProviderThreadId ?? null;
  const isSingleModel = turns.every((turn) => {
    if (turn.promptDropped || turn.turnTokenUsage?.localCommand) return true;
    const model = reportedModel(turn);
    return (
      deliveredOnThread(turn, activeThreadId) &&
      !hasMultipleModels(turn) &&
      (model === null || model === requested)
    );
  });
  let amount = 0;
  let source: ReferenceCostEstimate["source"] | null = null;
  for (const turn of turns) {
    if (turn.promptDropped || turn.turnTokenUsage?.localCommand) continue;
    const counts = readTurnTotals(turn);
    if (!isModelStep(turn, counts)) continue;
    if (hasMultipleModels(turn) || counts.input === null || counts.output === null) return null;
    if (counts.input === 0 && counts.output === 0) continue;
    const tokens: ReferenceCostTokenCounts = {
      inputTokens: counts.input,
      outputTokens: counts.output,
      cachedInputTokens: counts.cacheRead ?? undefined,
      cacheCreationTokens: counts.cacheWrite ?? undefined,
    };
    const model = reportedModel(turn) ?? (isSingleModel ? requested : null);
    const cost = estimateModelReferenceCost(model, tokens, settings);
    if (cost === null) return null;
    amount += cost.amount;
    if (source !== "reference") source = cost.source;
  }
  return source !== null && Number.isFinite(amount) ? { amount, currency: "USD", source } : null;
}

function mergeIntervals(intervals: TimeInterval[]) {
  intervals.sort(([left], [right]) => left - right);
  let count = 0;
  for (const interval of intervals) {
    const previous = intervals[count - 1];
    if (previous && interval[0] <= previous[1]) previous[1] = Math.max(previous[1], interval[1]);
    else intervals[count++] = interval;
  }
  intervals.length = count;
}

function measureSessionTools(
  projection: SessionProjection | null | undefined,
  activeIntervals: TimeInterval[],
  nowMs: number,
) {
  let toolCalls = 0;
  let errors = 0;
  const errorTurns = new Set<ProviderTurnId>();
  const toolIntervals: TimeInterval[] = [];
  for (const item of projection?.turnItems ?? []) {
    if (item.type === "error") {
      errors++;
      if (item.providerTurnId !== null) errorTurns.add(item.providerTurnId);
    }
    if (!isToolItem(item) || item.toolNonExecutionKind !== undefined) continue;
    toolCalls++;
    const start = timestampMs(item.startedAt);
    const end =
      timestampMs(item.completedAt) ??
      (isOrchestrationV2WorkActive(item.status) && Number.isFinite(nowMs) ? nowMs : null);
    if (start !== null && end !== null && end > start) toolIntervals.push([start, end]);
  }
  for (const turn of projection?.providerTurns ?? []) {
    if (turn.status === "failed" && !turn.promptDropped && !errorTurns.has(turn.id)) errors++;
  }
  mergeIntervals(toolIntervals);
  if (activeIntervals.length === 0) {
    return {
      toolCalls,
      errors,
      toolDurationMs: toolIntervals.reduce((total, [start, end]) => total + end - start, 0),
    };
  }

  // The tools may run in parallel or outlive their launching run.
  mergeIntervals(activeIntervals);
  let toolDurationMs = 0;
  let tool = 0;
  let active = 0;
  while (tool < toolIntervals.length && active < activeIntervals.length) {
    const [toolStart, toolEnd] = toolIntervals[tool]!;
    const [runStart, runEnd] = activeIntervals[active]!;
    toolDurationMs += Math.max(0, Math.min(toolEnd, runEnd) - Math.max(toolStart, runStart));
    if (toolEnd < runEnd) tool++;
    else active++;
  }
  return { toolCalls, errors, toolDurationMs };
}

function childThreadUsage(
  projection: SessionProjection,
  nowMs: number,
): OrchestrationV2SubagentUsage {
  const usage = summarizeSessionTurns(projection);
  const snapshot = latestDeliveredTurn(projection)?.tokenUsage;
  const contextWindow = positiveCount(snapshot?.maxTokens);
  const durationMs = measureRuns(projection.runs ?? [], nowMs).activeDurationMs;
  let toolUses = 0;
  for (const item of projection.turnItems ?? []) {
    if (isToolItem(item) && item.toolNonExecutionKind === undefined) toolUses++;
  }
  const reported = usage.reportedCostUsd === null ? latestSessionCost({ projection }) : null;
  const costUsd = usage.reportedCostUsd ?? (reported?.currency === "USD" ? reported.amount : null);
  return {
    ...(usage.measuredInput && usage.measuredOutput ? { totalTokens: usage.tokens.total } : {}),
    ...(usage.measuredInput ? { inputTokens: usage.tokens.input } : {}),
    ...(usage.measuredOutput ? { outputTokens: usage.tokens.output } : {}),
    ...(usage.tokens.cacheRead > 0 ? { cachedInputTokens: usage.tokens.cacheRead } : {}),
    ...(usage.tokens.cacheWrite > 0 ? { cacheCreationTokens: usage.tokens.cacheWrite } : {}),
    ...(usage.tokens.reasoning > 0 ? { reasoningOutputTokens: usage.tokens.reasoning } : {}),
    ...(snapshot === undefined ? {} : { contextTokens: snapshot.usedTokens }),
    ...(contextWindow === null ? {} : { contextWindow }),
    ...(usage.requests === null ? {} : { requests: usage.requests }),
    ...(toolUses > 0 ? { toolUses } : {}),
    ...(durationMs === null ? {} : { durationMs }),
    ...(costUsd === null ? {} : { costUsd }),
  };
}

function summarizeSubagents(input: SessionTelemetryInput) {
  const byThreadOrId = new Map<string, OrchestrationV2Subagent>();
  for (const agent of input.projection?.subagents ?? []) {
    const key =
      agent.remoteChild !== undefined
        ? `remote:${JSON.stringify([agent.remoteChild.environmentId, agent.remoteChild.threadId])}`
        : agent.childThreadId === null
          ? `agent:${agent.id}`
          : `child:${agent.childThreadId}`;
    const duplicate = byThreadOrId.get(key);
    if (duplicate === undefined) {
      byThreadOrId.set(key, agent);
    } else {
      const [chosen, other] =
        compareSubagents(agent, duplicate) < 0 ? [agent, duplicate] : [duplicate, agent];
      byThreadOrId.set(
        key,
        chosen.usage === undefined ? { ...chosen, usage: other.usage } : chosen,
      );
    }
  }
  const subagents: Array<
    HudSubagentEntry & { readonly usage: OrchestrationV2SubagentUsage | null }
  > = [];
  const subagentSummary = {
    total: byThreadOrId.size,
    active: 0,
    completed: 0,
    failed: 0,
    cancelled: 0,
    totalTokens: null as number | null,
    requests: null as number | null,
    toolUses: null as number | null,
    durationMs: null as number | null,
    costUsd: null as number | null,
  };
  for (const agent of [...byThreadOrId.values()].sort(compareSubagents)) {
    const entry = presentSubagent(agent, input.nowMs);
    const child =
      agent.childThreadId === null || agent.remoteChild !== undefined
        ? undefined
        : input.childThreadProjections?.get(agent.childThreadId);
    const loadedUsage = child === undefined ? undefined : childThreadUsage(child, input.nowMs);
    const usage =
      loadedUsage === undefined || Object.keys(loadedUsage).length === 0
        ? (agent.usage ?? null)
        : { ...agent.usage, ...loadedUsage };
    subagents.push({ ...entry, usage, durationMs: usage?.durationMs ?? entry.durationMs });
    if (entry.isActive) subagentSummary.active++;
    else if (
      entry.status === "completed" ||
      entry.status === "failed" ||
      entry.status === "cancelled"
    ) {
      subagentSummary[entry.status]++;
    }
    // Child and native counters describe the same work; the parent's otherUsage also covers
    // compaction and cannot be attributed to these children.
    if (usage !== null) {
      const totalTokens =
        usage.totalTokens ??
        (usage.inputTokens !== undefined && usage.outputTokens !== undefined
          ? usage.inputTokens + usage.outputTokens
          : undefined);
      if (totalTokens !== undefined)
        subagentSummary.totalTokens = (subagentSummary.totalTokens ?? 0) + totalTokens;
      for (const key of ["requests", "toolUses", "durationMs", "costUsd"] as const) {
        const value = usage[key];
        if (value !== undefined) subagentSummary[key] = (subagentSummary[key] ?? 0) + value;
      }
    }
  }
  return { subagents, subagentSummary };
}

export function deriveSessionTelemetryMetrics(input: SessionTelemetryInput) {
  const { projection, contextWindow, nowMs } = input;
  const turns = summarizeSessionTurns(projection);
  const latestTurn = latestDeliveredTurn(projection);
  const { cache, expiresAt, countdown } = measurePromptCache(
    { ...input, liveTokenUsage: input.liveTokenUsage ?? latestTurn?.tokenUsage },
    latestTurn,
  );
  const runIntervals: TimeInterval[] = [];
  const runs = measureRuns(projection?.runs ?? [], nowMs, runIntervals);
  const activeDurationMs = runs.activeDurationMs ?? positiveCount(contextWindow?.durationMs);
  const {
    toolCalls,
    errors,
    toolDurationMs: measuredToolMs,
  } = measureSessionTools(projection, runIntervals, nowMs);
  const toolDurationMs =
    activeDurationMs === null ? measuredToolMs : Math.min(activeDurationMs, measuredToolMs);
  const reported =
    turns.reportedCostUsd === null
      ? latestSessionCost(input)
      : { amount: turns.reportedCostUsd, currency: "USD" };
  const cost =
    reported !== null
      ? { ...reported, source: "reported" as const }
      : (estimateSessionCost(input) ?? { amount: null, currency: null, source: null });
  const liveElapsedMs =
    turns.speed.liveTurnStartedAtMs === null ? null : nowMs - turns.speed.liveTurnStartedAtMs;
  return {
    turns: turns.turns,
    steps: turns.steps,
    cumulativeTokens: turns.tokens,
    speed: {
      ...turns.speed,
      latest:
        turns.speed.latest ??
        outputRate(turns.speed.liveTurnOutputTokens, liveElapsedMs, 500) ??
        outputRate(contextWindow?.lastOutputTokens, contextWindow?.durationMs),
    },
    cache: {
      hitRate: turns.hitRate ?? cache.cumulativeRate,
      lastTurnHitRate: cache.lastRate,
      state: countdown.state,
      remainingMs: countdown.remainingMs,
      expiresAtMs: expiresAt,
    },
    counts: { requests: turns.requests, errors, toolCalls },
    timing: {
      modelDurationMs: activeDurationMs === null ? null : activeDurationMs - toolDurationMs,
      toolDurationMs,
      ttftMs: measureTurnTtft(projection),
      activeDurationMs,
      completedDurationMs: runs.completedDurationMs,
      activeRunStartedAtMs: runs.activeRunStartedAtMs,
      wallClockSpanMs: runs.wallClockSpanMs,
    },
    cost,
    ...summarizeSubagents(input),
  };
}

export type HudSystemCategoryKey = "provider" | "terminal" | "server" | "desktop" | "other";

export interface HudSystemCategorySummary {
  readonly key: HudSystemCategoryKey;
  readonly processCount: number;
  readonly cpuPercent: number;
  readonly rssBytes: number;
}

export interface HudSystemMetrics {
  readonly available: boolean;
  readonly cpuPercent: number | null;
  readonly rssBytes: number | null;
  readonly processCount: number | null;
  readonly healthStatus: ResourceTelemetrySourceStatus | null;
  readonly categories: readonly HudSystemCategorySummary[];
  readonly totalProcessedTokens: number | null;
}

const SYSTEM_CATEGORY_KEYS = ["provider", "terminal", "server", "desktop", "other"] as const;
const SYSTEM_CATEGORY_BY_PROCESS = {
  "provider-root": "provider",
  "terminal-root": "terminal",
  server: "server",
  "server-child": "server",
  "electron-main": "desktop",
  "electron-renderer": "desktop",
  "electron-gpu": "desktop",
  "electron-utility": "desktop",
  "resource-monitor": "other",
  "unknown-t3": "other",
} satisfies Record<ResourceTelemetryProcessCategory, HudSystemCategoryKey>;

function summarizeSystemCategories(
  processes: ResourceTelemetrySnapshot["processes"],
): HudSystemCategorySummary[] {
  const categories = new Map<
    HudSystemCategoryKey,
    { processCount: number; cpuPercent: number; rssBytes: number }
  >();
  for (const process of processes) {
    const key = SYSTEM_CATEGORY_BY_PROCESS[process.category];
    const category = categories.get(key);
    if (category) {
      category.processCount++;
      category.cpuPercent += process.cpuPercent;
      category.rssBytes += process.residentBytes;
    } else {
      categories.set(key, {
        processCount: 1,
        cpuPercent: process.cpuPercent,
        rssBytes: process.residentBytes,
      });
    }
  }
  const summaries: HudSystemCategorySummary[] = [];
  for (const key of SYSTEM_CATEGORY_KEYS) {
    const category = categories.get(key);
    if (category) summaries.push({ key, ...category });
  }
  return summaries;
}

function sumProcessedTokens(turns: ThreadStructure["providerTurns"]): number | null {
  let total: number | null = null;
  for (const turn of turns) {
    if (turn.promptDropped || turn.turnTokenUsage?.localCommand) continue;
    const usage = turn.turnTokenUsage;
    const source =
      usage?.inputTokens !== undefined && usage.outputTokens !== undefined
        ? usage
        : turn.tokenUsage;
    const input = source?.inputTokens;
    const output = source?.outputTokens;
    if (isNonNegativeCount(input) && isNonNegativeCount(output)) {
      total = (total ?? 0) + input + output;
    }
  }
  return total;
}

function hasSnapshotProcessedTokens(window: ContextWindowSnapshot | null | undefined): boolean {
  if (!window) return false;
  // Post-compaction snapshots store pre-compaction window occupancy in totalProcessedTokens with null counters.
  return (
    window.inputTokens !== null ||
    window.outputTokens !== null ||
    window.lastInputTokens !== null ||
    window.lastOutputTokens !== null
  );
}

export function deriveHudSystemMetrics(input: {
  readonly snapshot: ResourceTelemetrySnapshot | null | undefined;
  readonly contextWindow: ContextWindowSnapshot | null | undefined;
  readonly projection: Pick<ThreadStructure, "providerTurns"> | null | undefined;
}): HudSystemMetrics {
  const snapshot = input.snapshot ?? null;
  const aggregate = snapshot?.groups.allT3;
  const hasObservedSample =
    snapshot !== null &&
    aggregate !== undefined &&
    (snapshot.processes.length > 0 ||
      aggregate.processCount > 0 ||
      Option.isSome(snapshot.health.native.lastSampleAt));
  const summedTurnTokens = sumProcessedTokens(input.projection?.providerTurns ?? []);
  const snapshotProcessedTokens = hasSnapshotProcessedTokens(input.contextWindow)
    ? nonNegativeCount(input.contextWindow?.totalProcessedTokens)
    : null;
  return {
    available: hasObservedSample,
    cpuPercent: hasObservedSample ? aggregate.currentCpuPercent : null,
    rssBytes: hasObservedSample ? aggregate.currentRssBytes : null,
    processCount: hasObservedSample ? aggregate.processCount : null,
    healthStatus: snapshot?.health.native.status ?? null,
    categories: hasObservedSample ? summarizeSystemCategories(snapshot.processes) : [],
    totalProcessedTokens: summedTurnTokens ?? snapshotProcessedTokens,
  };
}

export function formatHudCompactDuration(ms: number, resolve?: MessageResolver): string {
  if (!Number.isFinite(ms) || ms < 0) return "–";
  if (!resolve) return ms === 0 ? "0ms" : formatDuration(ms);
  if (ms === 0)
    return resolve(msg("{seconds}s", { seconds: 0, $context: "elapsed time, seconds" }));
  if (ms < 1_000) return `${Math.max(1, Math.round(ms))}ms`;
  if (ms < 10_000) {
    return resolve(
      msg("{seconds}s", { seconds: Math.round(ms / 100) / 10, $context: "elapsed time, seconds" }),
    );
  }
  const totalSeconds = Math.round(ms / 1_000);
  if (totalSeconds < 60) {
    return resolve(msg("{seconds}s", { seconds: totalSeconds, $context: "elapsed time, seconds" }));
  }
  const hours = Math.floor(totalSeconds / 3_600);
  const minutes = Math.floor((totalSeconds % 3_600) / 60);
  const seconds = totalSeconds % 60;
  if (hours === 0) {
    return resolve(
      msg("{minutes}m {seconds}s", {
        minutes,
        seconds: String(seconds).padStart(2, "0"),
        $context: "elapsed time, minutes and seconds",
      }),
    );
  }
  return resolve(
    msg("{hours}h {minutes}m", {
      hours,
      minutes: String(minutes).padStart(2, "0"),
      $context: "elapsed time, hours and minutes",
    }),
  );
}

const OMP_HUD_ENVIRONMENT = EnvironmentId.make("hud-omp");
const OMP_SUBPROVIDER_DRIVERS: Readonly<Record<string, ProviderDriverKind | undefined>> = {
  "openai-codex": ProviderDriverKind.make("codex"),
  anthropic: ProviderDriverKind.make("claudeAgent"),
  claude: ProviderDriverKind.make("claudeAgent"),
  cursor: ProviderDriverKind.make("cursor"),
  "google-antigravity": ProviderDriverKind.make("antigravity"),
  "xai-oauth": ProviderDriverKind.make("grok"),
  "opencode-go": ProviderDriverKind.make("opencode"),
  "muse-code": ProviderDriverKind.make("muse"),
};

function parseOmpModelSubprovider(model: string | null | undefined): {
  readonly subprovider: string;
  readonly bareModel: string;
} | null {
  const trimmed = nonEmptyText(model);
  if (trimmed === null || trimmed === "default") return null;
  const slashIndex = trimmed.indexOf("/");
  if (slashIndex <= 0) return null;
  const subprovider = trimmed.slice(0, slashIndex).trim().toLowerCase();
  const bareModel = trimmed.slice(slashIndex + 1).trim();
  return subprovider && bareModel ? { subprovider, bareModel } : null;
}

function filterLimitsForSubproviderModel(
  driver: ProviderDriverKind | undefined,
  limits: ServerProviderUsageLimits,
  bareModel: string,
): ServerProviderUsageLimits {
  if (driver !== "antigravity") return limits;
  return {
    ...limits,
    windows: limits.windows.filter((window) => antigravityWindowLimitsModel(window, bareModel)),
  };
}

function hasUsableLimits(
  limits: ServerProviderUsageLimits | undefined,
): limits is ServerProviderUsageLimits {
  return limits !== undefined && limitsNotice(limits) === null && limits.windows.length > 0;
}

function poolOmpSourceAccounts(
  source: UsageLimitSourceSnapshot,
  accounts: UsageLimitSourceSnapshot["accounts"],
  nowMs: number,
): ThreadDetailsLimits | null {
  const presentations = new Map([
    [
      OMP_HUD_ENVIRONMENT,
      {
        entry: { target: { label: "" } },
        serverConfig: {
          providers: [],
          usageLimitSources: [{ ...source, accounts, quotaAccounts: undefined }],
        },
      },
    ],
  ]);
  const pools = collectLimitPools(collectLimitAccounts(presentations), nowMs);
  const windows = pools.flatMap(displayLimitWindows);
  return windows.length > 0 ? { kind: "pool", windows } : null;
}

function ompSubproviderTokens(
  subprovider: string,
  mappedDriver: ProviderDriverKind | undefined,
): ReadonlySet<string> {
  const tokens = new Set<string>([subprovider]);
  if (mappedDriver !== undefined) {
    tokens.add(mappedDriver.toLowerCase());
    for (const [key, driver] of Object.entries(OMP_SUBPROVIDER_DRIVERS)) {
      if (driver === mappedDriver) tokens.add(key);
    }
  }
  return tokens;
}

export function resolveOmpThreadHudLimits(input: {
  readonly provider: ServerProvider | undefined;
  readonly model: string | null | undefined;
  readonly fallbackModel?: string | null | undefined;
  readonly providers: readonly ServerProvider[];
  readonly sources: UsageLimitSourceSnapshots;
  readonly nowMs: number;
}): ThreadDetailsLimits | null {
  const { provider, providers, sources, nowMs } = input;
  if (!provider || provider.driver !== "omp") return null;
  const parsed =
    parseOmpModelSubprovider(input.model) ?? parseOmpModelSubprovider(input.fallbackModel);
  if (!parsed) return null;

  const { subprovider, bareModel } = parsed;
  const mappedDriver = Object.hasOwn(OMP_SUBPROVIDER_DRIVERS, subprovider)
    ? OMP_SUBPROVIDER_DRIVERS[subprovider]
    : undefined;
  const ompSources = sources.filter((source) => source.kind === "omp");
  const ownSourceId = `omp-instance:${provider.instanceId}`;
  const ownSource = ompSources.find((source) => source.id === ownSourceId);
  const enabledOmpCount = providers.filter(
    (entry) => entry.driver === "omp" && entry.enabled,
  ).length;
  // Never borrow another instance's auto-discovered snapshot; fall back only to a single manual omp source.
  const targetSource =
    ownSource ??
    (ompSources.length === 1 &&
    !ompSources[0]!.id.startsWith("omp-instance:") &&
    enabledOmpCount <= 1
      ? ompSources[0]
      : undefined);

  if (targetSource) {
    if (mappedDriver !== undefined) {
      const matchingAccounts = targetSource.accounts.flatMap((account) => {
        if (account.driver !== mappedDriver) return [];
        const limits = filterLimitsForSubproviderModel(
          mappedDriver,
          account.usageLimits,
          bareModel,
        );
        return hasUsableLimits(limits) ? [{ ...account, usageLimits: limits }] : [];
      });
      if (matchingAccounts.length === 1) {
        return { kind: "instance", limits: matchingAccounts[0]!.usageLimits };
      }
      if (matchingAccounts.length > 1) {
        const pooled = poolOmpSourceAccounts(targetSource, matchingAccounts, nowMs);
        if (pooled) return pooled;
      }
    }

    const tokens = ompSubproviderTokens(subprovider, mappedDriver);
    const matchingQuotas = (targetSource.quotaAccounts ?? []).flatMap((account) => {
      const idPrefix = account.id.split(":")[0]?.trim().toLowerCase() ?? "";
      const labelPrefix = account.label.split(" · ")[0]?.trim().toLowerCase() ?? "";
      if (!tokens.has(idPrefix) && !tokens.has(labelPrefix)) return [];
      const limits = filterLimitsForSubproviderModel(
        mappedDriver,
        {
          checkedAt: targetSource.checkedAt,
          windows: account.windows,
          ...(account.planTier === undefined ? {} : { planTier: account.planTier }),
          ...(account.balances === undefined ? {} : { balances: account.balances }),
        },
        bareModel,
      );
      return hasUsableLimits(limits) ? [{ account, limits }] : [];
    });
    if (matchingQuotas.length === 1) {
      return { kind: "instance", limits: matchingQuotas[0]!.limits };
    }
    if (matchingQuotas.length > 1) {
      const poolDriver = mappedDriver ?? provider.driver;
      const limitAccounts = matchingQuotas.map(({ account, limits }) => ({
        key: `${targetSource.id}:${account.id}`,
        driver: poolDriver,
        displayName: account.label,
        email: undefined,
        plan: account.planTier,
        accentColor: undefined,
        environments: [],
        sourceLabel: targetSource.label,
        redeem: null,
        limits,
      }));
      const windows = collectLimitPools(limitAccounts, nowMs).flatMap(displayLimitWindows);
      if (windows.length > 0) return { kind: "pool", windows };
    }
  }

  if (mappedDriver !== undefined) {
    const enabledNative = providers.filter(
      (entry) => entry.driver === mappedDriver && entry.enabled,
    );
    if (enabledNative.length === 1) {
      const candidate = enabledNative[0]!;
      if (candidate.installed && isProviderAvailable(candidate) && candidate.usageLimits) {
        const limits = filterLimitsForSubproviderModel(
          mappedDriver,
          candidate.usageLimits,
          bareModel,
        );
        if (hasUsableLimits(limits)) return { kind: "instance", limits };
      }
    }
  }

  return null;
}
