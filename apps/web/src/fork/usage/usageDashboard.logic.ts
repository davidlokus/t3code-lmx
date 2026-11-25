import { UsageDay, type UsageSummaryInput, type UsageTokenTotals } from "@t3tools/contracts";
import {
  type DailyTotals,
  isModelCostUnknown,
  type MergedProjectTotals,
  type MergedSessionTotals,
  type MergedUsage,
  type ModelTotals,
} from "@t3tools/shared/usageMerge";
import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";

import type { UsageBudgetScope, UsagePeriodPreset } from "./usageOptionsStore";

export interface UsageWindowPair {
  readonly current: UsageSummaryInput;
  readonly previous: UsageSummaryInput;
  readonly preset: UsagePeriodPreset;
  readonly currentClipped: boolean;
  readonly previousClipped: boolean;
}

function calendarWindow(
  start: DateTime.DateTime,
  end: DateTime.DateTime,
  timeZone: string,
  resolution: "day" | "hour" = "day",
): UsageSummaryInput {
  return {
    sinceDay: UsageDay.make(DateTime.formatIsoDate(start)),
    untilDay: UsageDay.make(DateTime.formatIsoDate(end)),
    timeZone,
    resolution,
  };
}

function exactWindow(
  start: DateTime.DateTime,
  until: DateTime.DateTime,
  timeZone: string,
  resolution: "day" | "hour",
): UsageSummaryInput {
  // A preset opened exactly at midnight still needs a non-empty half-open range.
  const end =
    DateTime.toEpochMillis(until) > DateTime.toEpochMillis(start)
      ? until
      : DateTime.add(start, { milliseconds: 1 });
  return {
    ...calendarWindow(start, DateTime.subtract(end, { milliseconds: 1 }), timeZone, resolution),
    sinceTime: DateTime.formatIso(start),
    untilTime: DateTime.formatIso(end),
  };
}

const MAX_LEGACY_HOURLY_WINDOW_MS = 24 * 60 * 60 * 1000;

function clampHourlyRange(
  start: DateTime.DateTime,
  until: DateTime.DateTime,
  legacyCompatible: boolean,
): DateTime.DateTime {
  if (!legacyCompatible) return start;
  const startMs = DateTime.toEpochMillis(start);
  const untilMs = DateTime.toEpochMillis(until);
  if (untilMs - startMs <= MAX_LEGACY_HOURLY_WINDOW_MS) return start;
  return DateTime.subtract(until, { milliseconds: MAX_LEGACY_HOURLY_WINDOW_MS });
}

export function buildUsageWindowPair(
  preset: UsagePeriodPreset,
  now = new Date(),
  timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
  options?: { readonly legacyCompatible?: boolean },
): UsageWindowPair {
  const legacyCompatible = options?.legacyCompatible === true;
  const instant = DateTime.makeUnsafe(now);
  const zoned = DateTime.setZoneNamed(instant, timeZone);
  const local = Option.getOrElse(zoned, () => DateTime.setZoneNamedUnsafe(instant, "UTC"));
  const zone = Option.isSome(zoned) ? timeZone : "UTC";
  switch (preset) {
    case "today": {
      const yesterday = DateTime.subtract(local, { days: 1 });
      const rawTodayStart = DateTime.startOf(local, "day");
      const todayStart = clampHourlyRange(rawTodayStart, local, legacyCompatible);
      const currentClipped =
        DateTime.toEpochMillis(todayStart) > DateTime.toEpochMillis(rawTodayStart);
      const rawYesterdayStart = DateTime.startOf(yesterday, "day");
      const yesterdayStart = clampHourlyRange(rawYesterdayStart, yesterday, legacyCompatible);
      const previousClipped =
        DateTime.toEpochMillis(yesterdayStart) > DateTime.toEpochMillis(rawYesterdayStart);
      return {
        preset,
        current: exactWindow(todayStart, local, zone, "hour"),
        previous: exactWindow(yesterdayStart, yesterday, zone, "hour"),
        currentClipped,
        previousClipped,
      };
    }
    case "mtd": {
      const start = DateTime.startOf(local, "month");
      const priorStart = DateTime.subtract(start, { months: 1 });
      const matchingDate = DateTime.subtract(local, { months: 1 });
      const priorEnd =
        DateTime.toParts(matchingDate).day < DateTime.toParts(local).day ? start : matchingDate;
      return {
        preset,
        current: exactWindow(start, local, zone, "day"),
        previous: exactWindow(priorStart, priorEnd, zone, "day"),
        currentClipped: false,
        previousClipped: false,
      };
    }
    case "24h": {
      const end = DateTime.startOf(local, "minute");
      const start = DateTime.subtract(end, { hours: 24 });
      const priorStart = DateTime.subtract(start, { hours: 24 });
      return {
        preset,
        current: exactWindow(start, end, zone, "hour"),
        previous: exactWindow(priorStart, start, zone, "hour"),
        currentClipped: false,
        previousClipped: false,
      };
    }
    default: {
      const days = preset === "7d" ? 7 : preset === "30d" ? 30 : 90;
      const start = DateTime.subtract(local, { days: days - 1 });
      return {
        preset,
        current: calendarWindow(start, local, zone),
        previous: calendarWindow(
          DateTime.subtract(start, { days }),
          DateTime.subtract(start, { days: 1 }),
          zone,
        ),
        currentClipped: false,
        previousClipped: false,
      };
    }
  }
}

export interface UsageDelta {
  readonly current: number;
  readonly previous: number;
  readonly percentChange: number | null;
  readonly direction: "up" | "down" | "flat" | "unknown";
}

export function computeUsageDelta(current: number, previous: number | null): UsageDelta {
  const percentChange =
    previous !== null && previous > 0 ? ((current - previous) / previous) * 100 : NaN;
  return {
    current,
    previous: previous ?? 0,
    percentChange: Number.isFinite(percentChange) ? percentChange : null,
    direction: !Number.isFinite(percentChange)
      ? "unknown"
      : percentChange > 0
        ? "up"
        : percentChange < 0
          ? "down"
          : "flat",
  };
}

export type UsageRiskTone = "normal" | "warning" | "error";

export interface UsageBudgetStatus {
  readonly periodKind: "daily" | "monthly";
  readonly spentUsd: number;
  readonly limitUsd: number;
  readonly ratio: number;
  readonly tone: UsageRiskTone;
  readonly scope: UsageBudgetScope;
}

export function deriveSoftBudgetStatus(input: {
  readonly preset: UsagePeriodPreset;
  readonly totalCostUsd: number;
  readonly reportedCostUsd: number;
  readonly dailyBudgetUsd: number | null;
  readonly monthlyBudgetUsd: number | null;
  readonly budgetScope: UsageBudgetScope;
  readonly showBudget: boolean;
}): UsageBudgetStatus | null {
  const { preset, showBudget, budgetScope } = input;
  if (!showBudget || (preset !== "today" && preset !== "mtd")) return null;
  const limitUsd = preset === "today" ? input.dailyBudgetUsd : input.monthlyBudgetUsd;
  if (limitUsd === null || limitUsd <= 0 || !Number.isFinite(limitUsd)) return null;
  const spentUsd = budgetScope === "reportedOnly" ? input.reportedCostUsd : input.totalCostUsd;
  const ratio = spentUsd / limitUsd;
  return {
    periodKind: preset === "today" ? "daily" : "monthly",
    spentUsd,
    limitUsd,
    ratio,
    tone: ratio > 1 ? "error" : ratio >= 0.8 ? "warning" : "normal",
    scope: budgetScope,
  };
}

export interface UsageKpiSnapshot {
  readonly costUsd: number;
  readonly totalTokens: number;
  readonly sessions: number;
  readonly activePeriods: number;
  readonly burnPerActivePeriodCostUsd: number | null;
  readonly burnPerActivePeriodTokens: number | null;
  readonly costPerMillionTokens: number | null;
  readonly cacheHitRate: number | null;
  readonly cacheSavingsUsd: number;
  readonly cacheSavingsMultiplier: number | null;
  readonly cachedInputTokens: number;
  readonly cacheCreationTokens: number;
  readonly outputTokens: number;
  readonly reasoningTokens: number;
  readonly reasoningShare: number | null;
  readonly speedPremiumUsd: number;
  readonly providerReportedShare: number;
  readonly modelPricedShare: number;
  readonly unpricedShare: number;
  readonly providerReportedCostUsd: number;
}

function cacheHitRate(
  tokens: Pick<
    UsageTokenTotals,
    "uncachedInputTokens" | "cachedInputTokens" | "cacheCreationTokens"
  >,
): number | null {
  const input = tokens.uncachedInputTokens + tokens.cachedInputTokens + tokens.cacheCreationTokens;
  return input > 0 ? tokens.cachedInputTokens / input : null;
}

export function deriveUsageKpis(merged: MergedUsage, resolution: "day" | "hour"): UsageKpiSnapshot {
  const {
    costUsd,
    totalTokens,
    sessions,
    cachedInputTokens,
    cacheCreationTokens,
    outputTokens,
    reasoningTokens,
    costQuality,
    speedCost,
    providerReportedCostUsd,
  } = merged;
  const activePeriods = (resolution === "hour" ? merged.hourly : merged.daily).length;
  return {
    costUsd,
    totalTokens,
    sessions,
    activePeriods,
    burnPerActivePeriodCostUsd: activePeriods > 0 ? costUsd / activePeriods : null,
    burnPerActivePeriodTokens: activePeriods > 0 ? totalTokens / activePeriods : null,
    costPerMillionTokens: totalTokens > 0 ? (costUsd * 1_000_000) / totalTokens : null,
    cacheHitRate: cacheHitRate(merged),
    cacheSavingsUsd: costQuality.cacheSavingsUsd,
    cacheSavingsMultiplier: costUsd > 0 ? (costUsd + costQuality.cacheSavingsUsd) / costUsd : null,
    cachedInputTokens,
    cacheCreationTokens,
    outputTokens,
    reasoningTokens,
    reasoningShare: outputTokens > 0 ? reasoningTokens / outputTokens : null,
    speedPremiumUsd: speedCost.premium,
    providerReportedShare: costQuality.providerReportedShare,
    modelPricedShare: costQuality.modelPricedShare,
    unpricedShare: costQuality.unpricedShare,
    providerReportedCostUsd,
  };
}

export interface UsageStreakSnapshot {
  readonly currentDays: number;
  readonly longestDays: number;
  readonly activeDays: number;
  readonly reachesWindowStart: boolean;
}

const UTC_DAY_MS = 24 * 60 * 60 * 1_000;

function utcDayMillis(day: string): number {
  const ms = Date.parse(day);
  return Number.isFinite(ms) && DateTime.formatIsoDate(DateTime.makeUnsafe(ms)) === day ? ms : NaN;
}

export function computeUsageStreak(
  daily: readonly Pick<DailyTotals, "day" | "totalTokens" | "costUsd">[],
  todayDay: string,
  windowStartDay: string,
): UsageStreakSnapshot {
  const today = utcDayMillis(todayDay);
  const windowStart = utcDayMillis(windowStartDay);
  const active = new Set<number>();
  for (const { day, totalTokens, costUsd } of daily) {
    if (!(totalTokens > 0 || costUsd > 0)) continue;
    const ms = utcDayMillis(day);
    if (ms >= windowStart && ms <= today) active.add(ms);
  }

  const currentEnd = active.has(today) ? today : today - UTC_DAY_MS;
  let currentDays = 0;
  let longestDays = 0;
  let reachesWindowStart = false;
  for (const start of active) {
    if (active.has(start - UTC_DAY_MS)) continue;
    let next = start + UTC_DAY_MS;
    while (active.has(next)) next += UTC_DAY_MS;
    const days = (next - start) / UTC_DAY_MS;
    longestDays = Math.max(longestDays, days);
    if (next - UTC_DAY_MS === currentEnd) {
      currentDays = days;
      reachesWindowStart = start === windowStart;
    }
  }
  return { currentDays, longestDays, activeDays: active.size, reachesWindowStart };
}

export function quotaRiskTone(remainingPercent: number): UsageRiskTone {
  return remainingPercent <= 10 ? "error" : remainingPercent <= 20 ? "warning" : "normal";
}

export type UsageModelSortKey = "cost" | "tokens" | "share" | "cacheHit" | "perMillion" | "model";
export type UsageProjectSortKey = "cost" | "tokens" | "share" | "sessions" | "label";
export type UsageSessionSortKey = "cost" | "tokens" | "cacheHit" | "lastActive" | "title";
export type UsageSortDirection = "asc" | "desc";

type SortValue = number | string | null;

function compareValues(a: SortValue, b: SortValue, direction: UsageSortDirection): number {
  if (a === null || b === null) return Number(a === null) - Number(b === null);
  const order =
    typeof a === "number" && typeof b === "number" ? a - b : String(a).localeCompare(String(b));
  return direction === "asc" ? order : -order;
}

export function sortAndFilterUsageModels(
  models: readonly ModelTotals[],
  options: {
    readonly query: string;
    readonly sortKey: UsageModelSortKey;
    readonly direction: UsageSortDirection;
    readonly metric: "cost" | "tokens";
  },
): readonly ModelTotals[] {
  const query = options.query.trim().toLowerCase();
  const rows = query
    ? models.filter(
        (row) => row.model.toLowerCase().includes(query) || row.provider.includes(query),
      )
    : [...models];
  const value = (row: ModelTotals): SortValue => {
    switch (options.sortKey) {
      case "cost":
        return isModelCostUnknown(row) ? null : row.costUsd;
      case "tokens":
        return row.totalTokens;
      case "share":
        return options.metric === "cost" ? row.costShare : row.tokenShare;
      case "cacheHit":
        return cacheHitRate(row.tokens);
      case "perMillion": {
        const pricedTokens = row.totalTokens - row.unpricedTokens;
        return pricedTokens > 0 && !isModelCostUnknown(row)
          ? (row.costUsd / pricedTokens) * 1_000_000
          : null;
      }
      case "model":
        return row.model;
    }
  };
  return rows.sort((a, b) => compareValues(value(a), value(b), options.direction));
}

export function sortAndFilterUsageProjects(
  projects: readonly MergedProjectTotals[],
  options: {
    readonly query: string;
    readonly sortKey: UsageProjectSortKey;
    readonly direction: UsageSortDirection;
    readonly metric: "cost" | "tokens";
  },
): readonly MergedProjectTotals[] {
  const query = options.query.trim().toLowerCase();
  const rows = query
    ? projects.filter(
        (row) =>
          row.label.toLowerCase().includes(query) ||
          row.workspaceRoot?.toLowerCase().includes(query) ||
          row.providers.some((provider) => provider.includes(query)),
      )
    : [...projects];
  const value = (row: MergedProjectTotals): SortValue => {
    switch (options.sortKey) {
      case "cost":
        return row.records > 0 && row.records === row.unpricedRecords ? null : row.costUsd;
      case "tokens":
        return row.totalTokens;
      case "share":
        return options.metric === "cost" ? row.costShare : row.tokenShare;
      case "sessions":
        return row.sessions;
      case "label":
        return row.label;
    }
  };
  return rows.sort((a, b) => compareValues(value(a), value(b), options.direction));
}

export function sortAndFilterUsageSessions(
  sessions: readonly MergedSessionTotals[],
  options: {
    readonly query: string;
    readonly sortKey: UsageSessionSortKey;
    readonly direction: UsageSortDirection;
  },
): readonly MergedSessionTotals[] {
  const query = options.query.trim().toLowerCase();
  const rows = query
    ? sessions.filter(
        (row) =>
          row.title?.toLowerCase().includes(query) ||
          row.sessionId.toLowerCase().includes(query) ||
          row.projectLabel.toLowerCase().includes(query) ||
          row.provider.includes(query) ||
          row.models.some((model) => model.toLowerCase().includes(query)),
      )
    : [...sessions];
  const value = (row: MergedSessionTotals): SortValue => {
    switch (options.sortKey) {
      case "cost":
        return row.records > 0 && row.records === row.unpricedRecords ? null : row.costUsd;
      case "tokens":
        return row.totalTokens;
      case "cacheHit":
        return cacheHitRate(row.totals);
      case "lastActive":
        return row.lastTimestampMs;
      case "title":
        return row.title ?? row.sessionId;
    }
  };
  return rows.sort((a, b) => compareValues(value(a), value(b), options.direction));
}

type CsvCell = string | number | undefined;

function csvRow(cells: readonly CsvCell[]): string {
  return cells
    .map((cell) => {
      if (cell === undefined) return "";
      if (typeof cell === "number") return String(cell);
      // Native titles and model names are untrusted spreadsheet cells, even when CSV-quoted.
      const value = /^(?:\s*[=+@-]|[\t\r\n])/.test(cell) ? `'${cell}` : cell;
      return /[",\r\n]/.test(value) ? `"${value.replaceAll('"', '""')}"` : value;
    })
    .join(",");
}

export type UsageExportBoundsNote =
  | "coarseCalendarDaysForLegacyServer"
  | "clipped24hForLegacyServer";

export function serializeUsageExportCsv(input: {
  readonly merged: MergedUsage;
  readonly window: UsageSummaryInput;
  readonly breakdownTab: "model" | "project" | "session" | "time";
  readonly boundsNote?: UsageExportBoundsNote;
}): string {
  const { merged, window, breakdownTab, boundsNote } = input;
  const windowHeaders = [
    "sinceDay",
    "untilDay",
    "timeZone",
    "sinceTime",
    "untilTime",
    "projectFilter",
    ...(boundsNote === undefined ? [] : ["boundsNote"]),
  ];
  const bounds = [
    window.sinceDay,
    window.untilDay,
    window.timeZone,
    window.sinceTime,
    window.untilTime,
    window.projectFilter?.projectKey,
    ...(boundsNote === undefined ? [] : [boundsNote]),
  ];
  let fields: readonly string[];
  let rows: CsvCell[][];
  switch (breakdownTab) {
    case "model":
      fields = ["provider", "model", "unpricedRecords"];
      rows = merged.models.map((row) => [
        row.provider,
        row.model,
        row.unpricedRecords,
        row.costUsd,
        row.totalTokens,
      ]);
      break;
    case "project":
      fields = ["projectKey", "label", "workspaceRoot", "worktreeCount", "sessions"];
      rows = merged.projects.map((row) => [
        row.projectKey,
        row.label,
        row.workspaceRoot,
        row.worktreeCount,
        row.sessions,
        row.costUsd,
        row.totalTokens,
      ]);
      break;
    case "session":
      fields = [
        "provider",
        "sessionId",
        "title",
        "projectKey",
        "primaryModel",
        "environmentId",
        "lastTimestampMs",
      ];
      rows = merged.topSessions.map((row) => [
        row.provider,
        row.sessionId,
        row.title,
        row.projectKey,
        row.primaryModel,
        row.environmentId,
        row.lastTimestampMs,
        row.costUsd,
        row.totalTokens,
      ]);
      break;
    case "time": {
      fields = ["day", "hourStart", "provider"];
      const periods = window.resolution === "hour" ? merged.hourly : merged.daily;
      rows = [];
      for (const period of periods) {
        const hour =
          "hourStart" in period && typeof period.hourStart === "string"
            ? period.hourStart
            : undefined;
        rows.push([period.day, hour, undefined, period.costUsd, period.totalTokens]);
        for (const [provider, spend] of period.byProvider) {
          rows.push([period.day, hour, provider, spend.costUsd, spend.totalTokens]);
        }
      }
      break;
    }
  }
  return [
    csvRow(["rowType", ...windowHeaders, ...fields, "costUsd", "totalTokens"]),
    csvRow([
      "total",
      ...bounds,
      ...fields.map(() => undefined),
      merged.costUsd,
      merged.totalTokens,
    ]),
    ...rows.map((row) => csvRow([breakdownTab, ...bounds, ...row])),
  ].join("\r\n");
}

export function serializeUsageExportJson(input: {
  readonly merged: MergedUsage;
  readonly window: UsageSummaryInput;
  readonly comparison: MergedUsage | null;
  readonly boundsNote?: UsageExportBoundsNote;
}): string {
  const payload =
    input.boundsNote === undefined
      ? { merged: input.merged, window: input.window, comparison: input.comparison }
      : {
          merged: input.merged,
          window: input.window,
          comparison: input.comparison,
          boundsNote: input.boundsNote,
        };
  return JSON.stringify(
    payload,
    (_key, value: unknown) => (value instanceof Map ? Object.fromEntries(value) : value),
    2,
  );
}
