import {
  EnvironmentId,
  USAGE_CONTRACT_VERSION,
  UsageDay,
  type UsageSummary,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  filterUsageEnvironmentsForScope,
  hasContributingLegacyServer,
  mergeAnsweredUsage,
  type EnvironmentUsageStatus,
} from "./usage";

function makeSummary(overrides: Partial<UsageSummary> = {}): UsageSummary {
  return {
    contractVersion: USAGE_CONTRACT_VERSION,
    readAt: "2026-11-24T12:00:00.000Z",
    timeZone: "UTC",
    sinceDay: UsageDay.make("2026-11-24"),
    untilDay: UsageDay.make("2026-11-24"),
    buckets: [
      {
        day: UsageDay.make("2026-11-24"),
        provider: "omp",
        model: "openai/gpt-5",
        sourcePath: "/home/.omp/agent/sessions",
        totals: {
          uncachedInputTokens: 1000,
          cachedInputTokens: 500,
          cacheCreationTokens: 0,
          outputTokens: 300,
          reasoningTokens: 100,
        },
        costUsd: 1.5,
        providerReportedCostUsd: 1.5,
        cacheSavingsUsd: 0.4,
        costSource: "providerReported",
        records: 2,
        unpricedRecords: 0,
        sessions: 1,
      },
      {
        day: UsageDay.make("2026-11-24"),
        provider: "claude",
        model: "claude-opus-4-5",
        sourcePath: "/home/.claude/projects",
        totals: {
          uncachedInputTokens: 2000,
          cachedInputTokens: 1000,
          cacheCreationTokens: 200,
          outputTokens: 500,
          reasoningTokens: 0,
        },
        costUsd: 3,
        providerReportedCostUsd: 0,
        cacheSavingsUsd: 1.2,
        costSource: "modelPriced",
        records: 3,
        unpricedRecords: 0,
        sessions: 1,
      },
    ],
    sources: [
      {
        fingerprint: {
          hostId: "host-1",
          provider: "omp",
          resolvedHomePath: "/home/.omp/agent/sessions",
          volumeId: "1:1",
        },
        status: "ok",
        scannedFiles: 1,
        skippedFiles: 0,
        malformedRecords: 0,
        distinctSessions: 1,
        message: null,
      },
      {
        fingerprint: {
          hostId: "host-1",
          provider: "claude",
          resolvedHomePath: "/home/.claude/projects",
          volumeId: "1:2",
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
      fetchedAt: "2026-11-24T00:00:00.000Z",
      knownModels: 100,
    },
    scanDurationMs: 12,
    projects: [
      {
        projectKey: "t3:proj-a",
        label: "Project A",
        workspaceRoot: "/repo/a",
        t3ProjectId: "proj-a",
        worktreeCount: 1,
        provider: "omp",
        sourcePath: "/home/.omp/agent/sessions",
        totals: {
          uncachedInputTokens: 1000,
          cachedInputTokens: 500,
          cacheCreationTokens: 0,
          outputTokens: 300,
          reasoningTokens: 100,
        },
        costUsd: 1.5,
        providerReportedCostUsd: 1.5,
        cacheSavingsUsd: 0.4,
        records: 2,
        unpricedRecords: 0,
        sessions: 1,
        topModels: [{ model: "openai/gpt-5", costUsd: 1.5, totalTokens: 1800 }],
      },
      {
        projectKey: "t3:proj-a",
        label: "Project A",
        workspaceRoot: "/repo/a",
        t3ProjectId: "proj-a",
        worktreeCount: 0,
        provider: "claude",
        sourcePath: "/home/.claude/projects",
        totals: {
          uncachedInputTokens: 2000,
          cachedInputTokens: 1000,
          cacheCreationTokens: 200,
          outputTokens: 500,
          reasoningTokens: 0,
        },
        costUsd: 3,
        providerReportedCostUsd: 0,
        cacheSavingsUsd: 1.2,
        records: 3,
        unpricedRecords: 0,
        sessions: 1,
        topModels: [{ model: "claude-opus-4-5", costUsd: 3, totalTokens: 3700 }],
      },
    ],
    topSessions: [
      {
        sessionId: "sess-omp",
        provider: "omp",
        sourcePath: "/home/.omp/agent/sessions",
        title: "OMP task",
        t3ThreadId: "thread-omp",
        t3ProjectId: "proj-a",
        projectKey: "t3:proj-a",
        projectLabel: "Project A",
        primaryModel: "openai/gpt-5",
        models: ["openai/gpt-5"],
        totals: {
          uncachedInputTokens: 1000,
          cachedInputTokens: 500,
          cacheCreationTokens: 0,
          outputTokens: 300,
          reasoningTokens: 100,
        },
        costUsd: 1.5,
        providerReportedCostUsd: 1.5,
        records: 2,
        unpricedRecords: 0,
        firstTimestampMs: 1_700_000_000_000,
        lastTimestampMs: 1_700_000_100_000,
      },
      {
        sessionId: "sess-claude",
        provider: "claude",
        sourcePath: "/home/.claude/projects",
        title: "Claude task",
        projectKey: "t3:proj-a",
        projectLabel: "Project A",
        primaryModel: "claude-opus-4-5",
        models: ["claude-opus-4-5"],
        totals: {
          uncachedInputTokens: 2000,
          cachedInputTokens: 1000,
          cacheCreationTokens: 200,
          outputTokens: 500,
          reasoningTokens: 0,
        },
        costUsd: 3,
        providerReportedCostUsd: 0,
        records: 3,
        unpricedRecords: 0,
        firstTimestampMs: 1_700_000_000_000,
        lastTimestampMs: 1_700_000_200_000,
      },
    ],
    ...overrides,
  };
}

function makeEnv(
  summary: UsageSummary | null,
  environmentId = "env-local",
  label = "Local",
): EnvironmentUsageStatus {
  return {
    environmentId: EnvironmentId.make(environmentId),
    label,
    isPending: false,
    canReadDiagnostics: true,
    accessRequests: [],
    isConnected: true,
    error: null,
    summary,
  };
}

describe("filterUsageEnvironmentsForScope", () => {
  it("filters buckets, sources, projects, and topSessions for hidden providers", () => {
    const { eligible, excludedLegacy } = filterUsageEnvironmentsForScope(
      [makeEnv(makeSummary())],
      new Set(["claude"]),
    );
    expect(excludedLegacy).toEqual([]);
    const merged = mergeAnsweredUsage(eligible);
    expect(merged.costUsd).toBe(1.5);
    expect(merged.providerReportedCostUsd).toBe(1.5);
    expect(merged.projects).toHaveLength(1);
    expect(merged.projects[0]?.costUsd).toBe(1.5);
    expect(merged.projects[0]?.providers).toEqual(["omp"]);
    expect(merged.topSessions).toHaveLength(1);
    expect(merged.topSessions[0]?.sessionId).toBe("sess-omp");
  });

  it("preserves undefined projects/topSessions on legacy summaries", () => {
    const legacy = makeSummary();
    const { projects: _p, topSessions: _s, ...legacyRest } = legacy;
    const { eligible } = filterUsageEnvironmentsForScope(
      [makeEnv(legacyRest)],
      new Set(["claude"]),
    );
    expect(eligible[0]?.summary?.projects).toBeUndefined();
    expect(eligible[0]?.summary?.topSessions).toBeUndefined();
    const merged = mergeAnsweredUsage(eligible);
    expect(merged.hasProjectAttribution).toBe(false);
    expect(merged.hasSessionAttribution).toBe(false);
  });

  it("excludes legacy v6 servers that ignore an active projectFilter before dedupe and merge", () => {
    const modernSummary = makeSummary({
      readAt: "2026-11-24T12:00:00.000Z",
      projectFilter: { projectKey: "t3:proj-a" },
      buckets: [makeSummary().buckets[0]!],
      sources: [makeSummary().sources[0]!],
    });
    const {
      projects: _p,
      topSessions: _s,
      ...legacyBase
    } = makeSummary({
      // Newer readAt on the same shared source must NOT steal ownership or leak unfiltered $4.50 spend!
      readAt: "2026-11-24T12:05:00.000Z",
    });
    const { eligible, excludedLegacy } = filterUsageEnvironmentsForScope(
      [
        makeEnv(modernSummary, "env-modern", "Modern Host"),
        makeEnv(legacyBase, "env-legacy", "Legacy Host"),
      ],
      new Set(),
      { projectKey: "t3:proj-a" },
    );

    expect(excludedLegacy).toEqual([
      { environmentId: EnvironmentId.make("env-legacy"), label: "Legacy Host" },
    ]);
    const merged = mergeAnsweredUsage(eligible);
    expect(merged.costUsd).toBe(1.5);
    expect(merged.contributingEnvironments).toEqual([EnvironmentId.make("env-modern")]);
  });

  it("bases legacy MTD coarseness strictly on contributing sources after shared-source dedupe", () => {
    const modernNewer = makeSummary({
      readAt: "2026-11-24T12:10:00.000Z",
      buckets: [makeSummary().buckets[0]!],
      sources: [makeSummary().sources[0]!],
    });
    const {
      projects: _p,
      topSessions: _s,
      ...legacyOlderShared
    } = makeSummary({
      readAt: "2026-11-24T12:00:00.000Z",
      buckets: [makeSummary().buckets[0]!],
      sources: [makeSummary().sources[0]!],
    });
    const sharedEligible = [
      makeEnv(modernNewer, "env-modern", "Modern"),
      makeEnv(legacyOlderShared, "env-legacy", "Legacy"),
    ];
    const sharedMerged = mergeAnsweredUsage(sharedEligible);
    expect(sharedMerged.contributingEnvironments).toEqual([EnvironmentId.make("env-modern")]);
    expect(hasContributingLegacyServer(sharedEligible, sharedMerged)).toBe(false);

    // When the legacy peer owns a distinct contributing source, it DOES make exact MTD bounds coarse.
    const legacyDistinct: UsageSummary = {
      ...legacyOlderShared,
      buckets: [makeSummary().buckets[1]!],
      sources: [
        {
          ...makeSummary().sources[1]!,
          fingerprint: { ...makeSummary().sources[1]!.fingerprint, hostId: "host-legacy" },
        },
      ],
    };
    const distinctEligible = [
      makeEnv(modernNewer, "env-modern", "Modern"),
      makeEnv(legacyDistinct, "env-legacy", "Legacy"),
    ];
    const distinctMerged = mergeAnsweredUsage(distinctEligible);
    expect(hasContributingLegacyServer(distinctEligible, distinctMerged)).toBe(true);
  });
});
