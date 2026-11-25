import {
  USAGE_CONTRACT_VERSION,
  USAGE_MERGE_COMPATIBLE_SINCE,
  type EnvironmentId,
  type UsageBucket,
  type UsageProjectBucket,
  type UsageSessionSummary,
  type UsageDay,
  type UsageProviderKind,
  UsageSummary,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";

import { isModelCostUnknown, mergeUsage, type EnvironmentUsage } from "./usageMerge.ts";

const decodeSummary = Schema.decodeUnknownSync(UsageSummary);

function bucket(overrides: Partial<UsageBucket> = {}): UsageBucket {
  return {
    day: "2026-08-07" as UsageDay,
    provider: "claude",
    model: "claude-fable-5",
    totals: {
      uncachedInputTokens: 100,
      cachedInputTokens: 1000,
      cacheCreationTokens: 10,
      outputTokens: 50,
      reasoningTokens: 0,
    },
    costUsd: 10,
    cacheSavingsUsd: 2,
    costSource: "modelPriced",
    records: 5,
    unpricedRecords: 0,
    sessions: 1,
    ...overrides,
  };
}

function summary(
  buckets: readonly UsageBucket[],
  sources: readonly {
    provider: UsageProviderKind;
    hostId: string;
    homePath: string;
    volumeId?: string;
    physicalSourceId?: string;
    distinctSessions?: number;
  }[],
  contractVersion: number = USAGE_CONTRACT_VERSION,
): UsageSummary {
  return {
    contractVersion,
    readAt: "2026-08-07T00:00:00.000Z",
    timeZone: "UTC",
    sinceDay: "2026-08-01" as UsageDay,
    untilDay: "2026-08-31" as UsageDay,
    buckets,
    sources: sources.map((source) => ({
      fingerprint: {
        hostId: source.hostId,
        provider: source.provider,
        resolvedHomePath: source.homePath,
        volumeId: source.volumeId ?? `vol-${source.hostId}`,
        ...(source.physicalSourceId === undefined
          ? {}
          : { physicalSourceId: source.physicalSourceId }),
      },
      status: "ok" as const,
      scannedFiles: 1,
      skippedFiles: 0,
      malformedRecords: 0,
      distinctSessions: source.distinctSessions ?? 1,
      message: null,
    })),
    pricing: { status: "fresh", source: "litellm", fetchedAt: null, knownModels: 10 },
    scanDurationMs: 1,
  };
}

function environment(id: string, usageSummary: UsageSummary): EnvironmentUsage {
  return { environmentId: id as EnvironmentId, label: id, summary: usageSummary };
}

describe("mergeUsage", () => {
  it("uses exact reported spend in mixed buckets and degrades to reported-only legacy buckets", () => {
    const source = { provider: "claude", hostId: "mac", homePath: "/claude" } as const;
    const legacy = decodeSummary(
      summary(
        [bucket({ costSource: "providerReported", costUsd: 3 }), bucket({ costUsd: 5 })],
        [source],
        USAGE_MERGE_COMPATIBLE_SINCE,
      ),
    );
    const current = decodeSummary(
      summary(
        [bucket({ providerReportedCostUsd: 2, costUsd: 7 })],
        [{ ...source, hostId: "linux" }],
      ),
    );

    expect(mergeUsage([environment("old", legacy)], USAGE_CONTRACT_VERSION)).toMatchObject({
      providerReportedCostUsd: 3,
      hasProjectAttribution: false,
      hasSessionAttribution: false,
    });
    expect(
      mergeUsage([environment("old", legacy), environment("new", current)], USAGE_CONTRACT_VERSION)
        .providerReportedCostUsd,
    ).toBe(5);
  });

  it("merges projects only from owned sources, preserving their provider and model split", () => {
    const accounts = [
      { provider: "claude", hostId: "mac", homePath: "/claude" },
      { provider: "omp", hostId: "linux", homePath: "/omp" },
    ] as const;
    const attributed = (
      source: (typeof accounts)[number],
      costUsd: number,
      worktreeCount: number,
    ) => {
      const usage = bucket({ provider: source.provider, sourcePath: source.homePath, costUsd });
      const project: UsageProjectBucket = {
        projectKey: "path:/work/repo",
        label: "repo",
        workspaceRoot: "/work/repo",
        provider: source.provider,
        sourcePath: source.homePath,
        worktreeCount,
        totals: usage.totals,
        costUsd,
        cacheSavingsUsd: 2,
        records: 5,
        unpricedRecords: 0,
        sessions: 1,
        topModels: [{ model: usage.model, costUsd, totalTokens: 1160 }],
      };
      return decodeSummary({ ...summary([usage], [source]), projects: [project], topSessions: [] });
    };
    const main = attributed(accounts[0], 3, 1);
    const merged = mergeUsage(
      [
        environment("alias", main),
        environment("a-owner", main),
        environment("linux", attributed(accounts[1], 7, 2)),
      ],
      USAGE_CONTRACT_VERSION,
    );

    expect(merged.hasProjectAttribution).toBe(true);
    expect(merged.hasSessionAttribution).toBe(true);
    expect(merged.projects).toMatchObject([
      {
        costUsd: 10,
        totalTokens: 2320,
        costShare: 1,
        tokenShare: 1,
        sessions: 2,
        worktreeCount: 2,
        providers: ["claude", "omp"],
        topModel: "claude-fable-5",
        modelContributions: [
          { provider: "omp", costUsd: 7 },
          { provider: "claude", costUsd: 3 },
        ],
      },
    ]);
  });

  it("deduplicates sessions across distinct sources and keeps the winning environment for navigation", () => {
    const source = { provider: "claude", hostId: "a", homePath: "/a" } as const;
    const session: UsageSessionSummary = {
      sessionId: "shared",
      provider: "claude",
      projectKey: "t3:project",
      projectLabel: "repo",
      primaryModel: "model",
      models: ["model"],
      totals: bucket().totals,
      costUsd: 7,
      records: 2,
      unpricedRecords: 0,
      firstTimestampMs: 100,
      lastTimestampMs: 200,
    };
    const merged = mergeUsage(
      [
        environment("a", {
          ...summary([bucket()], [source]),
          topSessions: [
            { ...session, costUsd: 6, records: 1 },
            ...Array.from({ length: 51 }, (_, index) => ({
              ...session,
              sessionId: `unpriced-${index}`,
              costUsd: 0,
              totals: { ...session.totals, outputTokens: index },
              unpricedRecords: 2,
            })),
          ],
        }),
        environment("b", {
          ...summary([bucket()], [{ ...source, hostId: "b", homePath: "/b" }]),
          topSessions: [{ ...session, title: "Current name", t3ThreadId: "thread-in-b" }],
        }),
      ],
      USAGE_CONTRACT_VERSION,
    );

    expect(merged.topSessions).toHaveLength(50);
    expect(merged.topSessions[0]).toMatchObject({
      sessionId: "shared",
      environmentId: "b",
      t3ThreadId: "thread-in-b",
      costUsd: 7,
    });
    expect(merged.topSessions.filter(({ sessionId }) => sessionId === "shared")).toHaveLength(1);
    expect(merged.topSessions[1]?.sessionId).toBe("unpriced-50");
  });

  it("counts a Cursor account once across servers while retaining each server's other providers", () => {
    const account = {
      provider: "cursor" as const,
      hostId: "cursor.com",
      homePath: "cursor-account:account-hash",
      volumeId: "account-hash",
    };
    const merged = mergeUsage(
      [
        environment(
          "mac",
          summary([bucket({ provider: "cursor", sourcePath: account.homePath })], [account]),
        ),
        environment(
          "linux",
          summary(
            [
              bucket({ provider: "cursor", sourcePath: account.homePath }),
              bucket({ provider: "opencode", sourcePath: "/opencode" }),
            ],
            [account, { provider: "opencode", hostId: "linux", homePath: "/opencode" }],
          ),
        ),
      ],
      USAGE_CONTRACT_VERSION,
    );
    expect(
      merged.providers.map((provider) => [provider.provider, provider.costUsd]).sort(),
    ).toEqual([
      ["cursor", 10],
      ["opencode", 10],
    ]);
    expect(merged.duplicateSources).toHaveLength(1);
  });

  it("counts a shared transcript directory once", () => {
    const shared = { provider: "claude" as const, hostId: "mac", homePath: "/home/theo/.claude" };
    const merged = mergeUsage(
      [
        environment("env-a", summary([bucket()], [shared])),
        environment("env-b", summary([bucket()], [shared])),
      ],
      USAGE_CONTRACT_VERSION,
    );

    expect(merged.costUsd).toBe(10);
    expect(merged.records).toBe(5);
    expect(merged.sessions).toBe(1);
    expect(merged.duplicateSources).toHaveLength(1);
    expect(merged.contributingEnvironments).toEqual(["env-a"]);
  });

  it("drops only the duplicated provider, keeping the environment's other one", () => {
    const sharedClaude = {
      provider: "claude" as const,
      hostId: "mac",
      homePath: "/home/theo/.claude",
    };
    const merged = mergeUsage(
      [
        environment("env-a", summary([bucket()], [sharedClaude])),
        environment(
          "env-b",
          summary(
            [bucket(), bucket({ provider: "codex", model: "gpt-5.6-sol", costUsd: 4 })],
            [sharedClaude, { provider: "codex", hostId: "mac", homePath: "/home/theo/.codex" }],
          ),
        ),
      ],
      USAGE_CONTRACT_VERSION,
    );

    expect(merged.costUsd).toBe(14);
    expect(merged.providers.map((provider) => provider.provider).sort()).toEqual([
      "claude",
      "codex",
    ]);
    expect(merged.sessions).toBe(2);
    expect(
      Object.fromEntries(
        merged.providers.map((provider) => [provider.provider, provider.sessions]),
      ),
    ).toEqual({ claude: 1, codex: 1 });
  });

  it("counts overlapping provider roots once while keeping each environment's unique root", () => {
    const source = (homePath: string) => ({
      provider: "opencode" as const,
      hostId: "host",
      homePath,
    });
    const usage = (sourcePath: string, costUsd: number) =>
      bucket({ provider: "opencode", sourcePath, costUsd });
    const merged = mergeUsage(
      [
        environment(
          "env-a",
          summary([usage("/shared", 10), usage("/a", 2)], [source("/shared"), source("/a")]),
        ),
        environment(
          "env-b",
          summary([usage("/shared", 10), usage("/b", 3)], [source("/shared"), source("/b")]),
        ),
      ],
      USAGE_CONTRACT_VERSION,
    );
    expect(merged.costUsd).toBe(15);
    expect(merged.sessions).toBe(3);
  });

  it("uses the newest scan when environments share the same transcript directory", () => {
    const source = { provider: "claude" as const, hostId: "mac", homePath: "/home/theo/.claude" };
    const environments = [
      environment("env-a", summary([bucket({ costUsd: 4, records: 2 })], [source])),
      environment("env-b", {
        ...summary([bucket()], [source]),
        readAt: "2026-08-07T01:00:00.000Z",
      }),
    ];

    for (const ordered of [environments, environments.toReversed()]) {
      const merged = mergeUsage(ordered, USAGE_CONTRACT_VERSION);
      expect(merged.costUsd).toBe(10);
      expect(merged.records).toBe(5);
      expect(merged.sessions).toBe(1);
      expect(merged.contributingEnvironments).toEqual(["env-b"]);
      expect(merged.duplicateSources).toEqual(["env-a: /home/theo/.claude"]);
    }
  });

  it("prefers a complete scan over a newer partial scan of the same directory", () => {
    const source = { provider: "claude" as const, hostId: "mac", homePath: "/home/theo/.claude" };
    const incomplete = summary([bucket({ costUsd: 4, records: 2 })], [source]);
    const partial = environment("new", {
      ...incomplete,
      readAt: "2026-08-07T01:00:00.000Z",
      sources: incomplete.sources.map((entry) => ({ ...entry, status: "partial" as const })),
    });
    const complete = environment("old", summary([bucket()], [source]));

    for (const ordered of [
      [partial, complete],
      [complete, partial],
    ]) {
      const merged = mergeUsage(ordered, USAGE_CONTRACT_VERSION);
      expect(merged.costUsd).toBe(10);
      expect(merged.contributingEnvironments).toEqual(["old"]);
      expect(merged.duplicateSources).toEqual(["new: /home/theo/.claude"]);
    }
    expect(mergeUsage([partial], USAGE_CONTRACT_VERSION).costUsd).toBe(4);
  });

  it("keeps new cells from a later partial scan without recounting older cells", () => {
    const source = { provider: "claude" as const, hostId: "mac", homePath: "/home/theo/.claude" };
    const complete = environment(
      "old",
      summary([bucket()], [source], USAGE_MERGE_COMPATIBLE_SINCE),
    );
    const partialSummary = summary(
      [
        bucket({ sourcePath: source.homePath, costUsd: 4, records: 2 }),
        bucket({
          day: "2026-08-08" as UsageDay,
          sourcePath: source.homePath,
          costUsd: 3,
          records: 1,
        }),
      ],
      [{ ...source, distinctSessions: 2 }],
    );
    const partial = environment("new", {
      ...partialSummary,
      readAt: "2026-08-08T01:00:00.000Z",
      sources: partialSummary.sources.map((entry) => ({ ...entry, status: "partial" as const })),
    });

    for (const ordered of [
      [complete, partial],
      [partial, complete],
    ]) {
      const merged = mergeUsage(ordered, USAGE_CONTRACT_VERSION);
      expect(merged.costUsd).toBe(13);
      expect(merged.records).toBe(6);
      expect(merged.sessions).toBe(2);
      expect(merged.daily.map(({ day, costUsd }) => [day, costUsd])).toEqual([
        ["2026-08-07", 10],
        ["2026-08-08", 3],
      ]);
      expect(merged.contributingEnvironments).toEqual(
        ordered.map(({ environmentId }) => environmentId),
      );
      expect(merged.duplicateSources).toEqual(["new: /home/theo/.claude"]);
    }

    const filtered = environment("new", {
      ...partial.summary,
      modelFilter: { exclude: [{ model: "claude-fable-5" }] },
    });
    const merged = mergeUsage([complete, filtered], USAGE_CONTRACT_VERSION);
    expect(merged.costUsd).toBe(10);
    expect(merged.sessions).toBe(1);
  });

  it("retains a complete cell when a larger partial cell may have skipped old records", () => {
    const source = { provider: "claude" as const, hostId: "mac", homePath: "/home/theo/.claude" };
    const complete = environment("old", summary([bucket()], [source]));
    const partialSummary = summary(
      [
        bucket({
          costUsd: 4,
          records: 6,
          totals: {
            uncachedInputTokens: 80,
            cachedInputTokens: 500,
            cacheCreationTokens: 10,
            outputTokens: 30,
            reasoningTokens: 0,
          },
        }),
      ],
      [{ ...source, distinctSessions: 2 }],
    );
    const partial = environment("new", {
      ...partialSummary,
      readAt: "2026-08-07T01:00:00.000Z",
      sources: partialSummary.sources.map((entry) => ({ ...entry, status: "partial" as const })),
    });

    const merged = mergeUsage([complete, partial], USAGE_CONTRACT_VERSION);
    expect(merged.costUsd).toBe(10);
    expect(merged.totalTokens).toBe(1160);
    expect(merged.records).toBe(5);
    expect(merged.sessions).toBe(1);
    expect(merged.contributingEnvironments).toEqual(["old"]);
  });

  it("identifies an environment reporting an older contract version", () => {
    const merged = mergeUsage(
      [
        environment(
          "env-a",
          summary([bucket()], [{ provider: "claude", hostId: "mac", homePath: "/a" }]),
        ),
        environment(
          "env-b",
          summary(
            [bucket()],
            [{ provider: "claude", hostId: "linux", homePath: "/b" }],
            USAGE_MERGE_COMPATIBLE_SINCE - 1,
          ),
        ),
      ],
      USAGE_CONTRACT_VERSION,
    );

    expect(merged.costUsd).toBe(10);
    expect(merged.contractMismatches).toEqual([
      {
        environmentId: "env-b",
        direction: "serverBehind",
        contractVersion: USAGE_MERGE_COMPATIBLE_SINCE - 1,
      },
    ]);
  });

  it("identifies an environment reporting a newer contract version", () => {
    const merged = mergeUsage(
      [
        environment(
          "env-a",
          summary(
            [bucket()],
            [{ provider: "claude", hostId: "mac", homePath: "/a" }],
            USAGE_CONTRACT_VERSION + 1,
          ),
        ),
      ],
      USAGE_CONTRACT_VERSION,
    );

    expect(merged.costUsd).toBe(0);
    expect(merged.contractMismatches).toEqual([
      {
        environmentId: "env-a",
        direction: "clientBehind",
        contractVersion: USAGE_CONTRACT_VERSION + 1,
      },
    ]);
  });

  it("keeps the previous compatible contract version so additive provider expansions still merge", () => {
    const merged = mergeUsage(
      [
        environment(
          "env-a",
          summary(
            [bucket({ costUsd: 10 })],
            [{ provider: "claude", hostId: "mac", homePath: "/a" }],
          ),
        ),
        environment(
          "env-b",
          summary(
            [bucket({ costUsd: 4, provider: "codex", model: "gpt-5.6-sol" })],
            [{ provider: "codex", hostId: "linux", homePath: "/b" }],
            USAGE_CONTRACT_VERSION - 1,
          ),
        ),
      ],
      USAGE_CONTRACT_VERSION,
    );

    expect(merged.costUsd).toBe(14);
    expect(merged.contractMismatches).toEqual([]);
  });

  it("keeps known usage when newer providers and bucket variants cannot be decoded", () => {
    const known = summary([bucket()], [{ provider: "claude", hostId: "mac", homePath: "/a" }]);
    const decoded = decodeSummary({
      ...known,
      buckets: [
        ...known.buckets,
        { ...bucket(), provider: "future-provider", costUsd: 100 },
        { ...bucket(), costSource: "future-pricing", costUsd: 200 },
      ],
      sources: [
        ...known.sources,
        {
          ...known.sources[0],
          fingerprint: {
            ...known.sources[0]?.fingerprint,
            provider: "future-provider",
          },
        },
      ],
    });
    expect(decoded).toEqual(known);
    const merged = mergeUsage([environment("env-a", decoded)], USAGE_CONTRACT_VERSION);
    expect(merged.costUsd).toBe(10);
    expect(merged.totalTokens).toBe(1160);
    expect(merged.contractMismatches).toEqual([]);
  });

  it("normalizes model names during decoding before grouping usage", () => {
    const decoded = decodeSummary(
      summary(
        [
          bucket({ provider: "codex", model: " gpt-5 " }),
          bucket({ provider: "codex", model: "gpt-5" }),
        ],
        [{ provider: "codex", hostId: "mac", homePath: "/a" }],
      ),
    );

    expect(decoded.buckets.map((entry) => entry.model)).toEqual(["gpt-5", "gpt-5"]);
    const merged = mergeUsage([environment("env-a", decoded)], USAGE_CONTRACT_VERSION);
    expect(merged.models).toHaveLength(1);
    expect(merged.models[0]).toMatchObject({ model: "gpt-5", costUsd: 20, totalTokens: 2320 });
  });

  it("marks a model with no known rates as unpriced rather than free", () => {
    const merged = mergeUsage(
      [
        environment(
          "env-a",
          summary(
            [
              bucket({ costUsd: 75 }),
              bucket({
                provider: "codex",
                model: "unknown-model",
                costUsd: 0,
                costSource: "unpriced",
                unpricedRecords: 5,
              }),
            ],
            [
              { provider: "claude", hostId: "mac", homePath: "/a/.claude" },
              { provider: "codex", hostId: "mac", homePath: "/a/.codex" },
            ],
          ),
        ),
      ],
      USAGE_CONTRACT_VERSION,
    );

    expect(merged.models.find((model) => model.model === "unknown-model")?.unpricedRecords).toBe(5);
    expect(merged.models.filter(isModelCostUnknown).map((model) => model.model)).toEqual([
      "unknown-model",
    ]);
  });

  it("splits cost by category and speed, counting older servers as unsplit standard cost", () => {
    const merged = mergeUsage(
      [
        environment(
          "env-a",
          summary(
            [
              bucket({
                costUsd: 10,
                categoryCostUsd: { input: 1, cacheRead: 2, cacheWrite: 3, output: 4 },
                fastCostUsd: 6,
                speedPremiumUsd: 3,
              }),
              bucket({
                provider: "codex",
                model: "unknown-model",
                costUsd: 0,
                costSource: "unpriced",
                unpricedRecords: 5,
              }),
              bucket({
                provider: "codex",
                model: "partly-reported",
                costUsd: 0,
                unpricedRecords: 4,
              }),
            ],
            [
              { provider: "claude", hostId: "mac", homePath: "/a/.claude" },
              { provider: "codex", hostId: "mac", homePath: "/a/.codex" },
            ],
          ),
        ),
        environment(
          "env-b",
          summary(
            [bucket({ costUsd: 5 })],
            [{ provider: "claude", hostId: "linux", homePath: "/b/.claude" }],
            USAGE_MERGE_COMPATIBLE_SINCE,
          ),
        ),
      ],
      USAGE_CONTRACT_VERSION,
    );

    expect(merged.categoryCost).toEqual({
      input: 1,
      cacheRead: 2,
      cacheWrite: 3,
      output: 4,
      unsplit: 5,
    });
    expect(merged.speedCost).toEqual({ standard: 9, fast: 6, ultrafast: 0, premium: 3 });
    expect(merged.models.map(({ model, unpricedTokens }) => [model, unpricedTokens])).toEqual([
      ["claude-fable-5", 0],
      ["unknown-model", 1160],
      ["partly-reported", 928],
    ]);
  });

  it("keeps two machines apart when hostname and home path collide", () => {
    const shape = { provider: "claude" as const, hostId: "mac", homePath: "/Users/theo/.claude" };
    const merged = mergeUsage(
      [
        environment("env-a", summary([bucket()], [{ ...shape, volumeId: "16777220:1234" }])),
        environment("env-b", summary([bucket()], [{ ...shape, volumeId: "16777221:9999" }])),
      ],
      USAGE_CONTRACT_VERSION,
    );

    expect(merged.costUsd).toBe(20);
    expect(merged.duplicateSources).toHaveLength(0);
  });

  describe("one directory seen from both sides of a Windows and WSL boundary", () => {
    // Fingerprints the reporter captured for one NTFS directory, read natively by
    // Windows and through the drvfs mount by WSL. Path and dev:ino both differ.
    const physicalSourceId = "physical-claude-projects";
    const windows = {
      provider: "claude" as const,
      hostId: "MainPC",
      homePath: "C:\\Users\\user\\.claude\\projects",
      volumeId: "1280555009:3659174697951285",
      physicalSourceId,
      distinctSessions: 142,
    };
    const wsl = {
      provider: "claude" as const,
      hostId: "MainPC",
      homePath: "/mnt/c/Users/user/.claude/projects",
      volumeId: "112:3659174697951287",
      physicalSourceId,
      distinctSessions: 142,
    };

    it("counts it once, whichever scan is newer", () => {
      const environments = [
        environment(
          "windows",
          summary([bucket({ sourcePath: windows.homePath, records: 22433 })], [windows]),
        ),
        environment("wsl", {
          ...summary([bucket({ sourcePath: wsl.homePath, records: 22432 })], [wsl]),
          readAt: "2026-08-07T00:05:00.000Z",
        }),
      ];

      for (const ordered of [environments, environments.toReversed()]) {
        const merged = mergeUsage(ordered, USAGE_CONTRACT_VERSION);
        expect(merged.sessions).toBe(142);
        expect(merged.records).toBe(22432);
        expect(merged.costUsd).toBe(10);
        expect(merged.contributingEnvironments).toEqual(["wsl"]);
        expect(merged.duplicateSources).toEqual([`windows: ${windows.homePath}`]);
      }
    });

    it("keeps only new cells from a later partial scan through the other side", () => {
      const complete = environment(
        "windows",
        summary([bucket({ sourcePath: windows.homePath })], [windows]),
      );
      const partialSummary = summary(
        [
          bucket({ sourcePath: wsl.homePath, costUsd: 4, records: 2 }),
          bucket({ day: "2026-08-08" as UsageDay, sourcePath: wsl.homePath, costUsd: 3 }),
        ],
        [{ ...wsl, distinctSessions: 143 }],
      );
      const partial = environment("wsl", {
        ...partialSummary,
        readAt: "2026-08-08T01:00:00.000Z",
        sources: partialSummary.sources.map((entry) => ({ ...entry, status: "partial" as const })),
      });

      const merged = mergeUsage([complete, partial], USAGE_CONTRACT_VERSION);
      expect(merged.costUsd).toBe(13);
      expect(merged.sessions).toBe(143);
      expect(merged.daily.map(({ day, costUsd }) => [day, costUsd])).toEqual([
        ["2026-08-07", 10],
        ["2026-08-08", 3],
      ]);
    });

    it("counts it once when one server reaches it through two mounts", () => {
      const secondMount = { ...wsl, homePath: "/mnt/win/Users/user/.claude/projects" };
      const merged = mergeUsage(
        [
          environment(
            "wsl",
            summary(
              [
                bucket({ sourcePath: wsl.homePath }),
                bucket({
                  day: "2026-08-08" as UsageDay,
                  sourcePath: secondMount.homePath,
                  costUsd: 3,
                }),
              ],
              [wsl, secondMount],
            ),
          ),
        ],
        USAGE_CONTRACT_VERSION,
      );

      expect(merged.costUsd).toBe(10);
      expect(merged.sessions).toBe(142);
      expect(merged.daily.map(({ day }) => day)).toEqual(["2026-08-07"]);
      expect(merged.duplicateSources).toEqual([`wsl: ${secondMount.homePath}`]);
    });

    it("still counts a shared directory once when only one server reports physical identity", () => {
      const { physicalSourceId: _omitted, ...legacy } = windows;
      const merged = mergeUsage(
        [
          environment("desktop", summary([bucket({ sourcePath: windows.homePath })], [windows])),
          environment("standalone", summary([bucket({ sourcePath: legacy.homePath })], [legacy])),
        ],
        USAGE_CONTRACT_VERSION,
      );

      expect(merged.costUsd).toBe(10);
      expect(merged.sessions).toBe(142);
      expect(merged.duplicateSources).toHaveLength(1);
    });

    it("counts it once when two desktop installs with different scopes read it", () => {
      const merged = mergeUsage(
        [
          environment("packaged", summary([bucket({ sourcePath: windows.homePath })], [windows])),
          environment(
            "dev-build",
            summary(
              [bucket({ sourcePath: windows.homePath })],
              [{ ...windows, physicalSourceId: "physical-other-scope" }],
            ),
          ),
        ],
        USAGE_CONTRACT_VERSION,
      );

      expect(merged.costUsd).toBe(10);
      expect(merged.sessions).toBe(142);
      expect(merged.duplicateSources).toHaveLength(1);
    });
  });

  it("totals sessions from per-directory distinct counts, not per-bucket sums", () => {
    const merged = mergeUsage(
      [
        environment(
          "env-a",
          summary(
            [bucket({ day: "2026-08-06" as UsageDay }), bucket({ day: "2026-08-07" as UsageDay })],
            [
              {
                provider: "claude",
                hostId: "mac",
                homePath: "/a/.claude",
                distinctSessions: 1,
              },
            ],
          ),
        ),
      ],
      USAGE_CONTRACT_VERSION,
    );

    expect(merged.sessions).toBe(1);
    expect(merged.providers[0]?.sessions).toBe(1);
  });

  it("keeps spend provenance separate from unpriced record share, unions cross-provider worktrees, marks partial attribution, and prefers connected T3 thread metadata & title", () => {
    const sharedSource = { provider: "omp" as const, hostId: "mac", homePath: "/a/.omp" };
    const claudeSource = { provider: "claude" as const, hostId: "mac", homePath: "/a/.claude" };
    const linkedSummary: UsageSummary = {
      ...summary(
        [
          bucket({
            provider: "omp",
            sourcePath: "/a/.omp",
            costUsd: 10,
            providerReportedCostUsd: 4,
            costSource: "modelPriced",
            records: 10,
            unpricedRecords: 2,
          }),
          bucket({
            provider: "claude",
            sourcePath: "/a/.claude",
            costUsd: 0,
            providerReportedCostUsd: 0,
            costSource: "unpriced",
            records: 0,
            unpricedRecords: 0,
          }),
        ],
        [sharedSource, claudeSource],
      ),
      readAt: "2026-08-06T12:00:00.000Z",
      projects: [
        {
          projectKey: "t3:proj-1",
          label: "Alpha",
          workspaceRoot: "/work/alpha",
          t3ProjectId: "proj-1",
          worktreeCount: 1,
          worktreeRoots: ["/work/alpha-wt-a"],
          provider: "omp",
          sourcePath: "/a/.omp",
          totals: bucket().totals,
          costUsd: 10,
          providerReportedCostUsd: 4,
          cacheSavingsUsd: 0,
          records: 10,
          unpricedRecords: 2,
          sessions: 1,
        },
        {
          projectKey: "t3:proj-1",
          label: "Alpha",
          workspaceRoot: "/work/alpha",
          t3ProjectId: "proj-1",
          worktreeCount: 1,
          worktreeRoots: ["/work/alpha-wt-b"],
          provider: "claude",
          sourcePath: "/a/.claude",
          totals: bucket().totals,
          costUsd: 0,
          providerReportedCostUsd: 0,
          cacheSavingsUsd: 0,
          records: 0,
          unpricedRecords: 0,
          sessions: 1,
        },
      ],
      topSessions: [
        {
          sessionId: "sess-shared",
          provider: "omp",
          sourcePath: "/a/.omp",
          title: "Linked Thread Title",
          t3ThreadId: "thread-linked-1",
          t3ProjectId: "proj-1",
          projectKey: "t3:proj-1",
          projectLabel: "Alpha",
          primaryModel: "gpt-5",
          models: ["gpt-5"],
          totals: {
            uncachedInputTokens: 100,
            cachedInputTokens: 0,
            cacheCreationTokens: 0,
            outputTokens: 50,
            reasoningTokens: 0,
          },
          costUsd: 10,
          providerReportedCostUsd: 4,
          records: 10,
          unpricedRecords: 2,
          firstTimestampMs: 1_700_000_000_000,
          lastTimestampMs: 1_700_000_100_000,
        },
      ],
    };
    const offlineNewerLinkedSummary: UsageSummary = {
      ...linkedSummary,
      readAt: "2026-08-06T12:03:00.000Z",
      topSessions: [
        {
          ...linkedSummary.topSessions![0]!,
          t3ThreadId: "thread-offline-2",
          title: "Offline Thread Title",
        },
      ],
    };
    const newerUnlinkedSummary: UsageSummary = {
      ...summary(
        [
          bucket({
            provider: "omp",
            sourcePath: "/a/.omp",
            costUsd: 10,
            providerReportedCostUsd: 4,
            costSource: "modelPriced",
            records: 10,
            unpricedRecords: 2,
          }),
        ],
        [sharedSource],
      ),
      readAt: "2026-08-06T12:05:00.000Z",
      projects: [
        {
          projectKey: "t3:proj-1",
          label: "Alpha",
          workspaceRoot: "/work/alpha",
          t3ProjectId: "proj-1",
          worktreeCount: 1,
          worktreeRoots: ["/work/alpha-wt-a"],
          provider: "omp",
          sourcePath: "/a/.omp",
          totals: bucket().totals,
          costUsd: 10,
          providerReportedCostUsd: 4,
          cacheSavingsUsd: 0,
          records: 10,
          unpricedRecords: 2,
          sessions: 1,
        },
      ],
      topSessions: [
        {
          sessionId: "sess-shared",
          provider: "omp",
          sourcePath: "/a/.omp",
          // Unlinked CLI title must yield to borrowed live T3 thread title.
          title: "Unlinked Native CLI Title",
          projectKey: "path:/repo",
          projectLabel: "repo",
          primaryModel: "gpt-5",
          models: ["gpt-5"],
          totals: {
            uncachedInputTokens: 100,
            cachedInputTokens: 0,
            cacheCreationTokens: 0,
            outputTokens: 50,
            reasoningTokens: 0,
          },
          costUsd: 10,
          providerReportedCostUsd: 4,
          records: 10,
          unpricedRecords: 2,
          firstTimestampMs: 1_700_000_000_000,
          lastTimestampMs: 1_700_000_100_000,
        },
      ],
    };
    const legacyPeer = summary(
      [
        bucket({
          provider: "codex",
          sourcePath: "/b/.codex",
          costUsd: 0,
          records: 0,
          unpricedRecords: 0,
        }),
      ],
      [{ provider: "codex", hostId: "remote", homePath: "/b/.codex" }],
    );

    const merged = mergeUsage(
      [
        { ...environment("env-linked", linkedSummary), isConnected: true },
        { ...environment("env-offline-linked", offlineNewerLinkedSummary), isConnected: false },
        { ...environment("env-newer-unlinked", newerUnlinkedSummary), isConnected: true },
        environment("env-legacy", legacyPeer),
      ],
      USAGE_CONTRACT_VERSION,
    );

    // Spend provenance (40% reported / 60% estimated of priced USD) stays independent of unpriced record share (20%).
    expect(merged.costQuality.unpricedShare).toBeCloseTo(0.2, 5);
    expect(merged.costQuality.providerReportedShare).toBeCloseTo(0.4, 5);
    expect(merged.costQuality.modelPricedShare).toBeCloseTo(0.6, 5);
    expect(merged.partialProjectAttribution).toBe(true);
    expect(merged.partialSessionAttribution).toBe(true);
    // Disjoint worktrees across Claude (/work/alpha-wt-b) and omp (/work/alpha-wt-a) union to 2.
    expect(merged.projects[0]?.worktreeCount).toBe(2);
    // Connected linked copy wins over newer offline copy, and T3 title beats owner's unlinked CLI title.
    expect(merged.topSessions[0]).toMatchObject({
      sessionId: "sess-shared",
      t3ThreadId: "thread-linked-1",
      title: "Linked Thread Title",
      environmentId: "env-linked" as EnvironmentId,
    });
  });
});
