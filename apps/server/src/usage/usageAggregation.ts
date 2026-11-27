// @effect-diagnostics globalDate:off
import type {
  UsageBucket,
  UsageCategoryCost,
  UsageDay,
  UsageModelFilter,
  UsageModelSelector,
  UsageProjectBucket,
  UsageProjectFilter,
  UsageResolution,
  UsageSessionSummary,
  UsageTokenTotals,
} from "@t3tools/contracts";

import { EMPTY_TOTALS, totalTokens, type UsageRecord } from "@t3tools/provider-core/server/usage";
import {
  cacheSavingsUsd,
  lookupRate,
  priceUsage,
  type PricedUsage,
  type RateTable,
} from "./usagePricing.ts";
import type { UsageProjectResolution } from "./usageProjectResolution.ts";

// en-CA gives ISO-ordered parts in the requested zone; Date getters are host-local.
function makeDayFormatter(timeZone: string): (timestampMs: number) => string {
  let format: Intl.DateTimeFormat;
  try {
    format = new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    });
  } catch {
    format = new Intl.DateTimeFormat("en-CA", {
      timeZone: "UTC",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    });
  }
  // Cache quarter-hour slots to avoid per-record Intl calls; fixed-offset midnight can split slots and needs exact formatting.
  const days = new Map<number, string | null>();
  return (timestampMs) => {
    const slot = Math.floor(timestampMs / QUARTER_HOUR_MS);
    let day = days.get(slot);
    if (day === undefined) {
      const first = format.format(new Date(slot * QUARTER_HOUR_MS));
      const last = format.format(new Date((slot + 1) * QUARTER_HOUR_MS - 1));
      day = first === last ? first : null;
      days.set(slot, day);
    }
    return day ?? format.format(new Date(timestampMs));
  };
}

const QUARTER_HOUR_MS = 15 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;

type ExactWindow = { readonly sinceTimeMs: number; readonly untilTimeMs: number };

interface MutableSpend {
  totals: { -readonly [K in keyof UsageTokenTotals]: number };
  costUsd: number;
  providerReportedCostUsd: number;
  records: number;
  unpricedRecords: number;
}

interface MutableBucket extends MutableSpend {
  cacheSavingsUsd: number;
  categoryCostUsd: UsageCategoryCost | null;
  fastCostUsd: number;
  ultrafastCostUsd: number;
  speedPremiumUsd: number;
  unpricedTokens: number;
  providerReportedRecords: number;
  sessions: Set<string>;
}

interface ModelSpend {
  readonly model: string;
  costUsd: number;
  totalTokens: number;
}

interface MutableProject extends MutableSpend {
  readonly project: UsageProjectResolution["project"];
  readonly provider: UsageRecord["provider"];
  readonly source: string;
  readonly sessions: Set<string>;
  readonly worktrees: Set<string>;
  readonly models: Map<string, ModelSpend>;
  cacheSavingsUsd: number;
}

interface MutableSession extends MutableSpend {
  readonly sessionId: string;
  readonly provider: UsageRecord["provider"];
  readonly source: string;
  readonly models: Map<string, ModelSpend>;
  firstTimestampMs: number;
  lastTimestampMs: number;
  totalTokens: number;
  attribution: UsageProjectResolution;
  nativeTitle: string | undefined;
}

function emptySpend(): MutableSpend {
  return {
    totals: { ...EMPTY_TOTALS },
    costUsd: 0,
    providerReportedCostUsd: 0,
    records: 0,
    unpricedRecords: 0,
  };
}

function accumulateSpend(spend: MutableSpend, tokens: UsageTokenTotals, priced: PricedUsage): void {
  const totals = spend.totals;
  totals.uncachedInputTokens += tokens.uncachedInputTokens;
  totals.cachedInputTokens += tokens.cachedInputTokens;
  totals.cacheCreationTokens += tokens.cacheCreationTokens;
  totals.outputTokens += tokens.outputTokens;
  totals.reasoningTokens += tokens.reasoningTokens;
  spend.costUsd += priced.costUsd;
  spend.records += 1;
  if (priced.costSource === "providerReported") spend.providerReportedCostUsd += priced.costUsd;
  if (priced.costSource === "unpriced") spend.unpricedRecords += 1;
}

function accumulateModel(
  models: Map<string, ModelSpend>,
  model: string,
  cost: number,
  tokens: number,
) {
  const held = models.get(model);
  if (held === undefined) models.set(model, { model, costUsd: cost, totalTokens: tokens });
  else {
    held.costUsd += cost;
    held.totalTokens += tokens;
  }
}

function rankModels(models: ReadonlyMap<string, ModelSpend>) {
  return [...models.values()].sort(
    (a, b) =>
      b.costUsd - a.costUsd || b.totalTokens - a.totalTokens || a.model.localeCompare(b.model),
  );
}

export interface AggregateOptions {
  readonly timeZone: string;
  readonly sinceDay: string;
  readonly untilDay: string;
  readonly rates: RateTable;
  readonly priceOverrides?: RateTable;
  readonly modelAliases?: ReadonlyMap<string, string>;
  readonly rateModel?: (provider: UsageRecord["provider"], model: string) => string | undefined;
  readonly modelFilter?: UsageModelFilter;
  readonly projectFilter?: UsageProjectFilter;
  readonly providers?: ReadonlySet<UsageRecord["provider"]>;
  readonly resolveProject?: (record: UsageRecord) => UsageProjectResolution;
  readonly resolution?: UsageResolution;
  readonly sinceTimeMs?: number;
  readonly untilTimeMs?: number;
}

export function usageTimestampFilter(
  options: Pick<
    AggregateOptions,
    "timeZone" | "sinceDay" | "untilDay" | "sinceTimeMs" | "untilTimeMs"
  >,
) {
  const toDay = makeDayFormatter(options.timeZone);
  return (timestampMs: number) => {
    if (options.sinceTimeMs !== undefined && options.untilTimeMs !== undefined) {
      return timestampMs >= options.sinceTimeMs && timestampMs < options.untilTimeMs;
    }
    const day = toDay(timestampMs);
    return day >= options.sinceDay && day <= options.untilDay;
  };
}

export function resolveModelAliases(
  aliases: Readonly<Record<string, string>>,
): ReadonlyMap<string, string> {
  const models = Object.keys(aliases);
  const memo = new Map<string, string | null>();
  for (const model of models) {
    if (memo.has(model)) continue;
    const path: string[] = [];
    let target = model;
    while (Object.hasOwn(aliases, target) && !memo.has(target)) {
      path.push(target);
      // Null marks both the active walk and paths that end in a cycle.
      memo.set(target, null);
      target = aliases[target]!;
    }
    const terminal = Object.hasOwn(aliases, target) ? (memo.get(target) ?? null) : target;
    for (const alias of path) memo.set(alias, terminal);
  }

  const resolved = new Map<string, string>();
  for (const model of models) {
    const target = memo.get(model);
    if (target !== null && target !== undefined) resolved.set(model, target);
  }
  return resolved;
}

/** Matches original IDs, so an alias cannot pull excluded usage into a kept model. */
function keepsUsageRecord(filter: UsageModelFilter | undefined, record: UsageRecord): boolean {
  if (filter === undefined) return true;
  const model = record.model.trim();
  const matches = (selector: UsageModelSelector) =>
    selector.model === model &&
    (selector.provider === undefined || selector.provider === record.provider);
  return (filter.include?.some(matches) ?? true) && !(filter.exclude?.some(matches) ?? false);
}

const selectorKey = (selector: UsageModelSelector) =>
  JSON.stringify([selector.provider ?? null, selector.model]);

const canonicalSelectors = (selectors: readonly UsageModelSelector[]) =>
  [...new Map(selectors.map((selector) => [selectorKey(selector), selector]))]
    // Code-unit order, so servers in different locales echo the same form.
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([, selector]) => selector);

/** Equal filters get one form, so they share scans and clients can compare echoed filters. */
export function canonicalModelFilter(
  filter: UsageModelFilter | undefined,
): UsageModelFilter | undefined {
  if (filter === undefined) return undefined;
  const exclude = filter.exclude?.length ? canonicalSelectors(filter.exclude) : undefined;
  if (filter.include === undefined && exclude === undefined) return undefined;
  return {
    ...(filter.include === undefined ? {} : { include: canonicalSelectors(filter.include) }),
    ...(exclude === undefined ? {} : { exclude }),
  };
}

export interface AggregateResult {
  readonly buckets: readonly UsageBucket[];
  readonly projects: readonly UsageProjectBucket[];
  readonly topSessions: readonly UsageSessionSummary[];
  readonly duplicatesDropped: number;
  readonly outOfWindow: number;
}

/**
 * Partial copies share a billed message's key: keep each token channel's maximum and the larger
 * reported cost, and the first copy's time, model, session and speed so it stays in its bucket.
 */
export function mergeUsageCopies(held: UsageRecord, copy: UsageRecord): UsageRecord {
  const a = held.totals;
  const b = copy.totals;
  const reportedCostUsd =
    held.reportedCostUsd === null || copy.reportedCostUsd === null
      ? (held.reportedCostUsd ?? copy.reportedCostUsd)
      : Math.max(held.reportedCostUsd, copy.reportedCostUsd);
  const cwd = held.cwd ?? (held.sessionId === copy.sessionId ? copy.cwd : undefined);
  const heldModelCalls = held.modelCalls ?? 0;
  const copyModelCalls = copy.modelCalls ?? 0;
  const modelCalls = Math.max(heldModelCalls, copyModelCalls);
  if (
    b.uncachedInputTokens <= a.uncachedInputTokens &&
    b.cachedInputTokens <= a.cachedInputTokens &&
    b.cacheCreationTokens <= a.cacheCreationTokens &&
    b.outputTokens <= a.outputTokens &&
    b.reasoningTokens <= a.reasoningTokens &&
    (copy.cacheCreation1hTokens ?? 0) <= (held.cacheCreation1hTokens ?? 0) &&
    copyModelCalls <= heldModelCalls &&
    reportedCostUsd === held.reportedCostUsd &&
    cwd === held.cwd
  ) {
    return held;
  }
  const cacheCreation1hTokens = Math.max(
    held.cacheCreation1hTokens ?? 0,
    copy.cacheCreation1hTokens ?? 0,
  );
  return {
    ...held,
    ...(cwd === undefined ? {} : { cwd }),
    ...(cacheCreation1hTokens > 0 ? { cacheCreation1hTokens } : {}),
    ...(modelCalls > 1 ? { modelCalls } : {}),
    totals: {
      uncachedInputTokens: Math.max(a.uncachedInputTokens, b.uncachedInputTokens),
      cachedInputTokens: Math.max(a.cachedInputTokens, b.cachedInputTokens),
      cacheCreationTokens: Math.max(a.cacheCreationTokens, b.cacheCreationTokens),
      outputTokens: Math.max(a.outputTokens, b.outputTokens),
      reasoningTokens: Math.max(a.reasoningTokens, b.reasoningTokens),
    },
    reportedCostUsd,
  };
}

/**
 * Grok reports each turn once, complete, so real copies are equal. A larger one is a deleted
 * transcript's pre-v17 maximum over turns that shared a prompt id, whichever source it came from.
 */
function smallestGrokCopy(held: UsageRecord, copy: UsageRecord): UsageRecord {
  const a = held.totals;
  const b = copy.totals;
  const reportedCostUsd =
    held.reportedCostUsd === null || copy.reportedCostUsd === null
      ? (held.reportedCostUsd ?? copy.reportedCostUsd)
      : Math.min(held.reportedCostUsd, copy.reportedCostUsd);
  const modelCalls =
    held.modelCalls !== undefined && copy.modelCalls !== undefined
      ? Math.min(held.modelCalls, copy.modelCalls)
      : (held.modelCalls ?? copy.modelCalls);
  return {
    ...held,
    ...(modelCalls !== undefined && modelCalls > 1 ? { modelCalls } : {}),
    totals: {
      uncachedInputTokens: Math.min(a.uncachedInputTokens, b.uncachedInputTokens),
      cachedInputTokens: Math.min(a.cachedInputTokens, b.cachedInputTokens),
      cacheCreationTokens: Math.min(a.cacheCreationTokens, b.cacheCreationTokens),
      outputTokens: Math.min(a.outputTokens, b.outputTokens),
      reasoningTokens: Math.min(a.reasoningTokens, b.reasoningTokens),
    },
    reportedCostUsd,
  };
}

interface Contribution {
  record: UsageRecord;
  readonly bucket: MutableBucket;
  readonly source: string;
  readonly attribution: UsageProjectResolution | undefined;
  nativeTitle: string | undefined;
}

/** Deduplicates across the whole scan; Claude copies records into resumed/forked transcripts. */
export class UsageAggregator {
  readonly #buckets = new Map<string, MutableBucket>();
  readonly #seen = new Map<string, Contribution | null>();
  readonly #projects = new Map<string, MutableProject>();
  readonly #sessions = new Map<string, MutableSession>();
  readonly #toDay: (timestampMs: number) => string;
  readonly #exactWindow: ExactWindow | null;
  readonly #hourlyWindow: ExactWindow | null;
  readonly #options: AggregateOptions;
  #lastBucket: {
    readonly day: string;
    readonly hourIndex: number;
    readonly provider: string;
    readonly model: string;
    readonly source: string;
    readonly bucket: MutableBucket;
  } | null = null;
  #duplicatesDropped = 0;
  #outOfWindow = 0;

  constructor(options: AggregateOptions) {
    this.#options = options;
    this.#toDay = makeDayFormatter(options.timeZone);
    this.#exactWindow =
      options.sinceTimeMs === undefined || options.untilTimeMs === undefined
        ? null
        : { sinceTimeMs: options.sinceTimeMs, untilTimeMs: options.untilTimeMs };
    this.#hourlyWindow = options.resolution === "hour" ? this.#exactWindow : null;
    if (options.resolution === "hour" && this.#hourlyWindow === null) {
      throw new Error("Hourly usage aggregation requires exact time bounds");
    }
  }

  add(input: UsageRecord, sourcePath?: string, nativeTitle?: string): boolean {
    if (this.#options.providers !== undefined && !this.#options.providers.has(input.provider)) {
      return false;
    }
    if (!keepsUsageRecord(this.#options.modelFilter, input)) return false;
    const record = this.#mapModel(input);
    if (record.dedupeKey !== null) {
      const held = this.#seen.get(record.dedupeKey);
      if (held !== undefined) {
        this.#duplicatesDropped += 1;
        if (held !== null) {
          held.record =
            record.provider === "grok"
              ? smallestGrokCopy(held.record, record)
              : mergeUsageCopies(held.record, record);
          if (held.record.sessionId === record.sessionId && nativeTitle)
            held.nativeTitle ??= nativeTitle;
        }
        return false;
      }
    }

    const attribution = this.#options.resolveProject?.(record);
    if (
      this.#options.projectFilter !== undefined &&
      this.#options.projectFilter.projectKey !== attribution?.project.projectKey
    ) {
      // Forked copies cannot pull the first copy's usage into a different project.
      if (record.dedupeKey !== null) this.#seen.set(record.dedupeKey, null);
      return false;
    }
    const source = sourcePath ?? "";
    const bucket = this.#placeInWindow(record, source);
    if (bucket === null) {
      if (record.dedupeKey !== null) this.#seen.set(record.dedupeKey, null);
      this.#outOfWindow += 1;
      return false;
    }
    // Keyed usage is counted in finish(), once all its copies are merged.
    if (record.dedupeKey === null)
      this.#accumulate(bucket, record, source, attribution, nativeTitle);
    else this.#seen.set(record.dedupeKey, { record, bucket, source, attribution, nativeTitle });
    if (record.sessionId.length > 0) bucket.sessions.add(record.sessionId);
    return true;
  }

  #placeInWindow(record: UsageRecord, source: string): MutableBucket | null {
    if (
      this.#exactWindow !== null &&
      (record.timestampMs < this.#exactWindow.sinceTimeMs ||
        record.timestampMs >= this.#exactWindow.untilTimeMs)
    ) {
      return null;
    }

    const day = this.#toDay(record.timestampMs);
    if (
      this.#exactWindow === null &&
      (day < this.#options.sinceDay || day > this.#options.untilDay)
    ) {
      return null;
    }

    const hourIndex =
      this.#hourlyWindow === null
        ? -1
        : Math.floor((record.timestampMs - this.#hourlyWindow.sinceTimeMs) / HOUR_MS);
    return this.#bucketFor(day, hourIndex, record.provider, record.model, source);
  }

  #accumulate(
    bucket: MutableBucket,
    record: UsageRecord,
    source: string,
    attribution: UsageProjectResolution | undefined,
    nativeTitle: string | undefined,
  ): void {
    const priced = priceUsage(this.#options.rates, record, this.#options.priceOverrides);

    accumulateSpend(bucket, record.totals, priced);
    if (priced.categoryCostUsd !== null) {
      const sum = bucket.categoryCostUsd;
      const add = priced.categoryCostUsd;
      bucket.categoryCostUsd =
        sum === null
          ? add
          : {
              input: sum.input + add.input,
              cacheRead: sum.cacheRead + add.cacheRead,
              cacheWrite: sum.cacheWrite + add.cacheWrite,
              output: sum.output + add.output,
            };
    }
    if (record.speed === "fast") bucket.fastCostUsd += priced.costUsd;
    if (record.speed === "ultrafast") bucket.ultrafastCostUsd += priced.costUsd;
    bucket.speedPremiumUsd += priced.speedPremiumUsd;
    const savings = cacheSavingsUsd(this.#options.rates, record, this.#options.priceOverrides);
    bucket.cacheSavingsUsd += savings;
    const tokens = totalTokens(record.totals);
    if (priced.costSource === "unpriced") bucket.unpricedTokens += tokens;
    if (priced.costSource === "providerReported") bucket.providerReportedRecords += 1;
    if (attribution !== undefined) {
      this.#accumulateAttribution(
        record,
        source,
        attribution,
        nativeTitle,
        priced,
        savings,
        tokens,
      );
    }
  }

  #accumulateAttribution(
    record: UsageRecord,
    source: string,
    attribution: UsageProjectResolution,
    nativeTitle: string | undefined,
    priced: PricedUsage,
    savings: number,
    tokens: number,
  ): void {
    const { project, worktreePath } = attribution;
    const { provider, model } = record;
    const sessionId = record.sessionId.trim();
    const projectBucketKey = `${project.projectKey}\u0000${provider}\u0000${source}`;
    let bucket = this.#projects.get(projectBucketKey);
    if (bucket === undefined) {
      bucket = {
        ...emptySpend(),
        project,
        provider,
        source,
        cacheSavingsUsd: 0,
        sessions: new Set(),
        worktrees: new Set(),
        models: new Map(),
      };
      this.#projects.set(projectBucketKey, bucket);
    }
    accumulateSpend(bucket, record.totals, priced);
    bucket.cacheSavingsUsd += savings;
    accumulateModel(bucket.models, model, priced.costUsd, tokens);
    if (worktreePath !== undefined) {
      bucket.worktrees.add(worktreePath);
    }
    if (!sessionId) return;
    bucket.sessions.add(sessionId);

    const sessionKey = `${provider}\u0000${sessionId}\u0000${source}`;
    let session = this.#sessions.get(sessionKey);
    if (session === undefined) {
      session = {
        ...emptySpend(),
        sessionId,
        provider,
        source,
        models: new Map(),
        firstTimestampMs: record.timestampMs,
        lastTimestampMs: record.timestampMs,
        totalTokens: 0,
        attribution,
        nativeTitle,
      };
      this.#sessions.set(sessionKey, session);
    } else {
      session.firstTimestampMs = Math.min(session.firstTimestampMs, record.timestampMs);
      if (record.timestampMs >= session.lastTimestampMs) {
        session.lastTimestampMs = record.timestampMs;
        session.attribution = attribution;
        session.nativeTitle = nativeTitle ?? session.nativeTitle;
      } else {
        session.nativeTitle ??= nativeTitle;
      }
    }
    accumulateSpend(session, record.totals, priced);
    session.totalTokens += tokens;
    accumulateModel(session.models, model, priced.costUsd, tokens);
  }

  // Aliases use the target's rate. Only an unpriced target goes through the provider's own rate naming.
  #mapModel(record: UsageRecord): UsageRecord {
    const model = this.#options.modelAliases?.get(record.model);
    if (model === undefined) return record;
    const { rateModel: _rateModel, ...rest } = record;
    const rateModel =
      lookupRate(this.#options.rates, model) === null
        ? this.#options.rateModel?.(record.provider, model)
        : undefined;
    return rateModel === undefined ? { ...rest, model } : { ...rest, model, rateModel };
  }

  // Time-ordered records usually reuse the previous bucket; avoid rebuilding its key.
  #bucketFor(
    day: string,
    hourIndex: number,
    provider: string,
    model: string,
    source: string,
  ): MutableBucket {
    const last = this.#lastBucket;
    if (
      last !== null &&
      last.day === day &&
      last.hourIndex === hourIndex &&
      last.provider === provider &&
      last.model === model &&
      last.source === source
    ) {
      return last.bucket;
    }
    const window = this.#hourlyWindow;
    const hourStart =
      window === null ? "" : new Date(window.sinceTimeMs + hourIndex * HOUR_MS).toISOString();
    const key = `${day}\u0000${hourStart}\u0000${provider}\u0000${model}\u0000${source}`;
    let bucket = this.#buckets.get(key);
    if (bucket === undefined) {
      bucket = {
        ...emptySpend(),
        cacheSavingsUsd: 0,
        categoryCostUsd: null,
        fastCostUsd: 0,
        ultrafastCostUsd: 0,
        speedPremiumUsd: 0,
        unpricedTokens: 0,
        providerReportedRecords: 0,
        sessions: new Set<string>(),
      };
      this.#buckets.set(key, bucket);
    }
    this.#lastBucket = { day, hourIndex, provider, model, source, bucket };
    return bucket;
  }

  finish(): AggregateResult {
    for (const item of this.#seen.values()) {
      if (item !== null) {
        this.#accumulate(item.bucket, item.record, item.source, item.attribution, item.nativeTitle);
      }
    }
    this.#seen.clear();
    const buckets: UsageBucket[] = [];
    for (const [key, bucket] of this.#buckets) {
      const [day = "", hourStart = "", provider = "", model = "", sourcePath = ""] =
        key.split("\u0000");
      const category = bucket.categoryCostUsd;
      const fastCostUsd = roundUsd(bucket.fastCostUsd);
      const ultrafastCostUsd = roundUsd(bucket.ultrafastCostUsd);
      const speedPremiumUsd = roundUsd(bucket.speedPremiumUsd);
      buckets.push({
        day: day as UsageDay,
        ...(hourStart === "" ? {} : { hourStart }),
        provider: provider as UsageBucket["provider"],
        model,
        ...(sourcePath === "" ? {} : { sourcePath }),
        totals: { ...bucket.totals },
        costUsd: bucket.costUsd,
        providerReportedCostUsd: bucket.providerReportedCostUsd,
        cacheSavingsUsd: bucket.cacheSavingsUsd,
        ...(category === null
          ? {}
          : {
              categoryCostUsd: {
                input: roundUsd(category.input),
                cacheRead: roundUsd(category.cacheRead),
                cacheWrite: roundUsd(category.cacheWrite),
                output: roundUsd(category.output),
              },
            }),
        ...(fastCostUsd === 0 ? {} : { fastCostUsd }),
        ...(ultrafastCostUsd === 0 ? {} : { ultrafastCostUsd }),
        ...(speedPremiumUsd === 0 ? {} : { speedPremiumUsd }),
        costSource: resolveCostSource(bucket),
        records: bucket.records,
        unpricedRecords: bucket.unpricedRecords,
        unpricedTokens: bucket.unpricedTokens,
        sessions: bucket.sessions.size,
      });
    }
    buckets.sort(
      (a, b) =>
        a.day.localeCompare(b.day) ||
        (a.hourStart ?? "").localeCompare(b.hourStart ?? "") ||
        a.provider.localeCompare(b.provider) ||
        a.model.localeCompare(b.model),
    );

    const projects: UsageProjectBucket[] = [];
    for (const bucket of this.#projects.values()) {
      const worktreeRoots = [...bucket.worktrees].sort();
      projects.push({
        ...bucket.project,
        provider: bucket.provider,
        ...(bucket.source ? { sourcePath: bucket.source } : {}),
        worktreeCount: worktreeRoots.length,
        ...(worktreeRoots.length > 0 ? { worktreeRoots } : {}),
        totals: bucket.totals,
        costUsd: bucket.costUsd,
        providerReportedCostUsd: bucket.providerReportedCostUsd,
        cacheSavingsUsd: bucket.cacheSavingsUsd,
        records: bucket.records,
        unpricedRecords: bucket.unpricedRecords,
        sessions: bucket.sessions.size,
        topModels: rankModels(bucket.models),
      });
    }
    const topSessions: UsageSessionSummary[] = [...this.#sessions.values()]
      .sort(
        (a, b) =>
          b.costUsd - a.costUsd ||
          b.totalTokens - a.totalTokens ||
          b.lastTimestampMs - a.lastTimestampMs ||
          a.sessionId.localeCompare(b.sessionId),
      )
      .slice(0, 50)
      .map((session) => {
        const { project, t3ThreadId, t3Title, cwd } = session.attribution;
        const title = t3Title ?? session.nativeTitle;
        const models = rankModels(session.models).map(({ model }) => model);
        return {
          sessionId: session.sessionId,
          provider: session.provider,
          ...(session.source ? { sourcePath: session.source } : {}),
          ...(title ? { title } : {}),
          ...(t3ThreadId === undefined ? {} : { t3ThreadId }),
          ...(project.t3ProjectId === undefined ? {} : { t3ProjectId: project.t3ProjectId }),
          projectKey: project.projectKey,
          projectLabel: project.label,
          ...(cwd === undefined ? {} : { cwd }),
          primaryModel: models[0]!,
          models,
          totals: session.totals,
          costUsd: session.costUsd,
          providerReportedCostUsd: session.providerReportedCostUsd,
          records: session.records,
          unpricedRecords: session.unpricedRecords,
          firstTimestampMs: session.firstTimestampMs,
          lastTimestampMs: session.lastTimestampMs,
        };
      });

    return {
      buckets,
      projects,
      topSessions,
      duplicatesDropped: this.#duplicatesDropped,
      outOfWindow: this.#outOfWindow,
    };
  }
}

function roundUsd(value: number): number {
  return Math.round(value * 1e6) / 1e6;
}

function resolveCostSource(bucket: MutableBucket): UsageBucket["costSource"] {
  if (bucket.unpricedRecords === bucket.records) return "unpriced";
  if (bucket.providerReportedRecords === bucket.records) return "providerReported";
  return "modelPriced";
}
