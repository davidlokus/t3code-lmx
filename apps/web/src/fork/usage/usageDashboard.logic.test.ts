import { EnvironmentId, USAGE_CONTRACT_VERSION, type UsageTokenTotals } from "@t3tools/contracts";
import {
  mergeUsage,
  type MergedProjectTotals,
  type MergedSessionTotals,
  type ModelTotals,
} from "@t3tools/shared/usageMerge";
import { describe, expect, it } from "vite-plus/test";

import {
  buildUsageWindowPair,
  computeUsageDelta,
  deriveSoftBudgetStatus,
  deriveUsageKpis,
  quotaRiskTone,
  serializeUsageExportCsv,
  serializeUsageExportJson,
  sortAndFilterUsageModels,
  sortAndFilterUsageProjects,
  sortAndFilterUsageSessions,
} from "./usageDashboard.logic";
import {
  isDefaultUsageUiOptions,
  parseUsageUiOptions,
  readPersistedUsageUiOptions,
  USAGE_UI_OPTIONS_STORAGE_KEY,
} from "./usageOptionsStore";

describe("usage windows", () => {
  it("uses local midnight and the same clock time yesterday in a fractional-offset zone", () => {
    const { current, previous } = buildUsageWindowPair(
      "today",
      new Date("2026-11-24T08:15:00Z"),
      "Asia/Kathmandu",
    );
    expect(current).toMatchObject({
      sinceDay: "2026-11-24",
      untilDay: "2026-11-24",
      resolution: "hour",
      sinceTime: "2026-11-23T18:15:00.000Z",
      untilTime: "2026-11-24T08:15:00.000Z",
    });
    expect(previous).toMatchObject({
      sinceDay: "2026-11-23",
      untilDay: "2026-11-23",
      resolution: "hour",
      sinceTime: "2026-11-22T18:15:00.000Z",
      untilTime: "2026-11-23T08:15:00.000Z",
    });
  });

  it("includes the repeated autumn hour in today without lengthening the rolling 24h preset", () => {
    const now = new Date("2026-11-02T04:30:38Z");
    const timeZone = "America/New_York";
    const today = buildUsageWindowPair("today", now, timeZone);
    expect(today.current).toMatchObject({
      sinceDay: "2026-11-01",
      untilDay: "2026-11-01",
      sinceTime: "2026-11-01T04:00:00.000Z",
    });
    expect(today.previous.untilTime).toBe("2026-11-01T03:30:38.000Z");

    const legacyToday = buildUsageWindowPair("today", now, timeZone, { legacyCompatible: true });
    expect(legacyToday.currentClipped).toBe(true);
    expect(legacyToday.previousClipped).toBe(false);
    expect(today.currentClipped).toBe(false);
    expect(today.previousClipped).toBe(false);
    expect(
      Date.parse(legacyToday.current.untilTime!) - Date.parse(legacyToday.current.sinceTime!),
    ).toBeLessThanOrEqual(24 * 60 * 60 * 1000);
    expect(legacyToday.current.untilTime).toBe("2026-11-02T04:30:38.000Z");

    // The day AFTER DST fall-back at 23:30 EST: Today is complete (<24h), but Yesterday spanned 24h30m and gets clipped.
    const dayAfterDst = buildUsageWindowPair("today", new Date("2026-11-03T04:30:38Z"), timeZone, {
      legacyCompatible: true,
    });
    expect(dayAfterDst.currentClipped).toBe(false);
    expect(dayAfterDst.previousClipped).toBe(true);

    const rolling = buildUsageWindowPair("24h", now, timeZone);
    expect(rolling.current.sinceTime).toBe("2026-11-01T04:30:00.000Z");
    expect(rolling.current.untilTime).toBe("2026-11-02T04:30:00.000Z");
    expect(rolling.previous.sinceTime).toBe("2026-10-31T04:30:00.000Z");
    expect(rolling.previous.untilTime).toBe(rolling.current.sinceTime);
  });

  it("compares MTD against the matching span but does not spill into this month", () => {
    const march = buildUsageWindowPair("mtd", new Date("2026-03-31T12:20:00Z"), "UTC");
    expect(march.current).toMatchObject({
      sinceDay: "2026-03-01",
      untilDay: "2026-03-31",
      resolution: "day",
      untilTime: "2026-03-31T12:20:00.000Z",
    });
    expect(march.previous).toMatchObject({
      sinceDay: "2026-02-01",
      untilDay: "2026-02-28",
      untilTime: "2026-03-01T00:00:00.000Z",
    });
    const january = buildUsageWindowPair("mtd", new Date("2026-01-04T09:50:00Z"), "UTC");
    expect(january.previous).toMatchObject({
      sinceDay: "2025-12-01",
      untilTime: "2025-12-04T09:50:00.000Z",
    });
  });

  it.each([
    ["7d", "2026-03-25", "2026-03-18", "2026-03-24"],
    ["30d", "2026-03-02", "2026-01-31", "2026-03-01"],
    ["90d", "2026-01-01", "2025-10-03", "2025-12-31"],
  ] as const)(
    "preserves calendar-day counts in %s and its preceding window",
    (preset, sinceDay, priorSinceDay, priorUntilDay) => {
      const { current, previous } = buildUsageWindowPair(
        preset,
        new Date("2026-03-31T12:20:00Z"),
        "UTC",
      );
      expect(current).toEqual({
        sinceDay,
        untilDay: "2026-03-31",
        resolution: "day",
        timeZone: "UTC",
      });
      expect(previous).toEqual({
        sinceDay: priorSinceDay,
        untilDay: priorUntilDay,
        resolution: "day",
        timeZone: "UTC",
      });
    },
  );

  it("keeps exact presets valid at midnight even with an invalid time zone", () => {
    const { current } = buildUsageWindowPair(
      "today",
      new Date("2026-11-24T00:00:00Z"),
      "Invalid/Zone",
    );
    expect(current).toMatchObject({
      timeZone: "UTC",
      sinceTime: "2026-11-24T00:00:00.000Z",
      untilTime: "2026-11-24T00:00:00.001Z",
    });
  });
});

describe("usage options", () => {
  it("inherits only valid legacy hidden providers without opening on the old default Limits tab", () => {
    const storage = {
      getItem: (key: string) =>
        key === "t3code:usage-page-preferences:v1"
          ? '{"metric":"limits","windowDays":7,"hiddenProviders":["omp","unknown","omp","codex"]}'
          : null,
    };
    const options = readPersistedUsageUiOptions(storage);
    expect(options).toMatchObject({
      view: "overview",
      metric: "cost",
      period: "30d",
      hiddenProviders: ["omp", "codex"],
    });
    expect(isDefaultUsageUiOptions(options)).toBe(false);
  });

  it("restores fields independently and does not read legacy preferences over a current save", () => {
    const stored = parseUsageUiOptions({
      view: "limits",
      metric: "tokens",
      period: "mtd",
      chartMode: "line",
      showQuotaStrip: false,
      showShareBars: false,
      showComparison: "true",
      showBudget: false,
      dailyBudgetUsd: Infinity,
      monthlyBudgetUsd: 12.5,
      budgetScope: "reportedOnly",
      hiddenProviders: ["claude"],
    });
    const storage = {
      getItem: (key: string) =>
        key === USAGE_UI_OPTIONS_STORAGE_KEY ? JSON.stringify(stored) : "unreachable",
    };
    expect(readPersistedUsageUiOptions(storage)).toEqual({
      view: "limits",
      metric: "tokens",
      period: "mtd",
      chartMode: "line",
      showQuotaStrip: false,
      showShareBars: false,
      showComparison: true,
      showBudget: false,
      dailyBudgetUsd: null,
      monthlyBudgetUsd: 12.5,
      budgetScope: "reportedOnly",
      hiddenProviders: ["claude"],
    });
  });

  it("recovers when stored JSON is corrupt or storage is unavailable", () => {
    expect(isDefaultUsageUiOptions(readPersistedUsageUiOptions({ getItem: () => "{" }))).toBe(true);
    expect(
      isDefaultUsageUiOptions(
        readPersistedUsageUiOptions({
          getItem: () => {
            throw new Error("storage denied");
          },
        }),
      ),
    ).toBe(true);
    expect(isDefaultUsageUiOptions(readPersistedUsageUiOptions(null))).toBe(true);
  });
});

describe("usage metrics", () => {
  it.each([
    [12, 10, 20, "up"],
    [5, 10, -50, "down"],
    [10, 10, 0, "flat"],
    [5, 0, null, "unknown"],
    [5, -1, null, "unknown"],
    [5, null, null, "unknown"],
  ] as const)(
    "computes %s vs %s without dividing by a missing baseline",
    (current, previous, percentChange, direction) => {
      expect(computeUsageDelta(current, previous)).toMatchObject({ percentChange, direction });
    },
  );

  it("applies distinct quota and budget thresholds to the selected budget scope", () => {
    const input = {
      preset: "today",
      totalCostUsd: 11,
      reportedCostUsd: 8,
      dailyBudgetUsd: 10,
      monthlyBudgetUsd: 20,
      budgetScope: "all",
      showBudget: true,
    } as const;
    expect(deriveSoftBudgetStatus(input)).toMatchObject({
      periodKind: "daily",
      spentUsd: 11,
      tone: "error",
    });
    expect(deriveSoftBudgetStatus({ ...input, budgetScope: "reportedOnly" })).toMatchObject({
      spentUsd: 8,
      ratio: 0.8,
      tone: "warning",
    });
    expect(deriveSoftBudgetStatus({ ...input, totalCostUsd: 10 })?.tone).toBe("warning");
    expect(deriveSoftBudgetStatus({ ...input, preset: "mtd" })).toMatchObject({
      periodKind: "monthly",
      limitUsd: 20,
      tone: "normal",
    });
    expect(deriveSoftBudgetStatus({ ...input, preset: "7d" })).toBeNull();
    expect(deriveSoftBudgetStatus({ ...input, showBudget: false })).toBeNull();
    expect(deriveSoftBudgetStatus({ ...input, dailyBudgetUsd: 0 })).toBeNull();
    expect([10, 10.01, 20, 20.01].map(quotaRiskTone)).toEqual([
      "error",
      "warning",
      "warning",
      "normal",
    ]);
  });

  it("uses all input channels for cache hit rate and only output for reasoning share", () => {
    const none = mergeUsage([], USAGE_CONTRACT_VERSION);
    const hour = {
      day: "2026-11-24",
      hourStart: "2026-11-24T00:00:00Z",
      costUsd: 6,
      totalTokens: 80,
      byProvider: new Map(),
    };
    const usage = {
      ...none,
      costUsd: 12,
      totalTokens: 160,
      sessions: 2,
      uncachedInputTokens: 20,
      cachedInputTokens: 45,
      cacheCreationTokens: 10,
      outputTokens: 85,
      reasoningTokens: 17,
      providerReportedCostUsd: 4,
      costQuality: { ...none.costQuality, cacheSavingsUsd: 24, unpricedShare: 0.25 },
      speedCost: { ...none.speedCost, premium: 2 },
      daily: [hour],
      hourly: [hour, { ...hour, hourStart: "2026-11-24T01:00:00Z" }],
    };
    expect(deriveUsageKpis(usage, "hour")).toMatchObject({
      cacheHitRate: 0.6,
      reasoningShare: 0.2,
      cacheSavingsMultiplier: 3,
      activePeriods: 2,
      burnPerActivePeriodCostUsd: 6,
      burnPerActivePeriodTokens: 80,
      costPerMillionTokens: 75_000,
      sessions: 2,
      providerReportedCostUsd: 4,
      unpricedShare: 0.25,
      speedPremiumUsd: 2,
    });
    expect(deriveUsageKpis(usage, "day").burnPerActivePeriodCostUsd).toBe(12);
    expect(deriveUsageKpis(none, "day")).toMatchObject({
      costPerMillionTokens: null,
      cacheHitRate: null,
      cacheSavingsMultiplier: null,
      reasoningShare: null,
    });
  });
});

const totals: UsageTokenTotals = {
  uncachedInputTokens: 10,
  cachedInputTokens: 5,
  cacheCreationTokens: 5,
  outputTokens: 20,
  reasoningTokens: 1,
};
const model: ModelTotals = {
  provider: "omp",
  model: "gpt",
  tokens: totals,
  totalTokens: 40,
  costUsd: 1,
  records: 1,
  unpricedRecords: 0,
  unpricedTokens: 0,
  costShare: 1,
  tokenShare: 0.4,
};
const project: MergedProjectTotals = {
  projectKey: "path:/work/fork",
  label: "Repo",
  workspaceRoot: "/work/fork",
  providers: ["omp"],
  worktreeCount: 1,
  providerReportedCostUsd: 1,
  cacheSavingsUsd: 0,
  sessions: 1,
  totals,
  totalTokens: 40,
  costUsd: 1,
  records: 1,
  unpricedRecords: 0,
  topModel: "gpt",
  modelContributions: [],
  costShare: 1,
  tokenShare: 0.4,
};
const session: MergedSessionTotals = {
  provider: "omp",
  sessionId: "session-uuid",
  title: '=text,"Quoted"',
  projectKey: project.projectKey,
  projectLabel: project.label,
  environmentId: EnvironmentId.make("owner"),
  primaryModel: "gpt",
  models: ["gpt"],
  totals,
  totalTokens: 40,
  costUsd: 1,
  firstTimestampMs: 1,
  lastTimestampMs: 2,
  records: 1,
  unpricedRecords: 0,
};

describe("usage breakdown and exports", () => {
  it("puts unknown cost last, sorts shares by the active metric, and matches mixed-case queries", () => {
    const unpriced = {
      ...model,
      model: "New_model",
      totalTokens: 60,
      costUsd: 0,
      unpricedRecords: 1,
      costShare: 0,
      tokenShare: 0.6,
    };
    const models = [unpriced, model];
    const partiallyUnpriced: ModelTotals = {
      ...model,
      model: "partial-priced",
      // 100 total tokens, 90 unpriced => 10 priced tokens @ $1 => $100,000 / 1M (more expensive than `model` @ $25,000 / 1M)
      totalTokens: 100,
      unpricedTokens: 90,
      costUsd: 1,
    };
    expect(
      sortAndFilterUsageModels([partiallyUnpriced, model, unpriced], {
        query: "",
        sortKey: "perMillion",
        direction: "asc",
        metric: "cost",
      }).map((entry) => entry.model),
    ).toEqual(["gpt", "partial-priced", "New_model"]);
    expect(
      sortAndFilterUsageModels(models, {
        query: " OMP ",
        sortKey: "share",
        direction: "desc",
        metric: "tokens",
      }),
    ).toEqual([unpriced, model]);
    expect(
      sortAndFilterUsageModels(models, {
        query: "new_MODEL",
        sortKey: "cost",
        direction: "asc",
        metric: "cost",
      }),
    ).toEqual([unpriced]);
    const other = { ...project, label: "Other", workspaceRoot: "/work/other", sessions: 9 };
    expect(
      sortAndFilterUsageProjects([other, project], {
        query: "WORK/FORK",
        sortKey: "sessions",
        direction: "desc",
        metric: "tokens",
      }),
    ).toEqual([project]);
    const old = { ...session, sessionId: "old", lastTimestampMs: 1, title: "Old topic" };
    expect(
      sortAndFilterUsageSessions([old, session], {
        query: "repo",
        sortKey: "lastActive",
        direction: "desc",
      }),
    ).toEqual([session, old]);
  });

  it("exports window scope, totals and breakdown rows without losing map entries or spreadsheet safety", () => {
    const window = {
      ...buildUsageWindowPair("today", new Date("2026-11-24T01:30:00Z"), "UTC").current,
      projectFilter: { projectKey: project.projectKey },
    };
    const hour = {
      day: "2026-11-24",
      hourStart: "2026-11-24T00:00:00.000Z",
      costUsd: 1,
      totalTokens: 40,
      byProvider: new Map([["omp" as const, { costUsd: 1, totalTokens: 40 }]]),
    };
    const merged = {
      ...mergeUsage([], USAGE_CONTRACT_VERSION),
      costUsd: 1,
      totalTokens: 40,
      models: [model],
      projects: [project],
      topSessions: [session],
      hourly: [hour],
    };
    const csv = serializeUsageExportCsv({ merged, window, breakdownTab: "session" });
    expect(csv).toContain('"\'=text,""Quoted"""');
    expect(csv.split("\r\n")[1]).toMatch(
      /^total,2026-11-24,2026-11-24,UTC,.*path:\/work\/fork,.*1,40$/,
    );
    expect(serializeUsageExportCsv({ merged, window, breakdownTab: "time" })).toContain(
      `${hour.hourStart},omp,1,40`,
    );
    expect(serializeUsageExportCsv({ merged, window, breakdownTab: "project" })).toContain(
      "path:/work/fork,Repo,/work/fork,1,1,1,40",
    );
    expect(serializeUsageExportCsv({ merged, window, breakdownTab: "model" })).toContain(
      "omp,gpt,0,1,40",
    );
    expect(
      JSON.parse(serializeUsageExportJson({ merged, window, comparison: null })),
    ).toMatchObject({
      window,
      comparison: null,
      merged: { hourly: [{ byProvider: { omp: { costUsd: 1, totalTokens: 40 } } }] },
    });
    const coarseCsv = serializeUsageExportCsv({
      merged,
      window: {
        sinceDay: window.sinceDay,
        untilDay: window.untilDay,
        timeZone: window.timeZone,
        resolution: "day",
      },
      breakdownTab: "model",
      boundsNote: "coarseCalendarDaysForLegacyServer",
    });
    expect(coarseCsv).toContain("boundsNote");
    expect(coarseCsv).toContain("coarseCalendarDaysForLegacyServer");
    expect(
      JSON.parse(
        serializeUsageExportJson({
          merged,
          window: {
            sinceDay: window.sinceDay,
            untilDay: window.untilDay,
            timeZone: window.timeZone,
            resolution: "day",
          },
          comparison: null,
          boundsNote: "coarseCalendarDaysForLegacyServer",
        }),
      ),
    ).toMatchObject({ boundsNote: "coarseCalendarDaysForLegacyServer" });
  });
});
