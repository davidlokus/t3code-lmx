import {
  USAGE_MERGE_COMPATIBLE_SINCE,
  type EnvironmentId,
  type UsageBucket,
  type UsageProjectBucket,
  type UsageProviderKind,
  type UsageProjectTopModel,
  type UsageSessionSummary,
  type UsageSource,
  type UsageSourceFingerprint,
  type UsageSummary,
  type UsageTokenTotals,
} from "@t3tools/contracts";

export interface EnvironmentUsage {
  readonly environmentId: EnvironmentId;
  readonly label: string;
  readonly summary: UsageSummary;
  readonly isConnected?: boolean;
}

export interface ProviderTotals {
  readonly provider: UsageProviderKind;
  readonly costUsd: number;
  readonly totalTokens: number;
  readonly records: number;
  readonly sessions: number;
  readonly costShare: number;
  readonly tokenShare: number;
}

export interface ModelTotals {
  readonly model: string;
  readonly provider: UsageProviderKind;
  readonly costUsd: number;
  readonly totalTokens: number;
  readonly tokens: UsageTokenTotals;
  readonly records: number;
  readonly unpricedRecords: number;
  readonly unpricedTokens: number;
  readonly costShare: number;
  readonly tokenShare: number;
}

/** When every record lacks rates, costUsd is unknown and must not be displayed as a dollar figure. */
export function isModelCostUnknown(model: ModelTotals): boolean {
  return model.records > 0 && model.unpricedRecords >= model.records;
}

export interface DailyTotals {
  readonly day: string;
  readonly costUsd: number;
  readonly totalTokens: number;
  readonly byProvider: ReadonlyMap<UsageProviderKind, { costUsd: number; totalTokens: number }>;
}

export interface HourlyTotals {
  readonly day: string;
  readonly hourStart: string;
  readonly costUsd: number;
  readonly totalTokens: number;
  readonly byProvider: ReadonlyMap<UsageProviderKind, { costUsd: number; totalTokens: number }>;
}

export interface CostQuality {
  readonly providerReportedShare: number;
  readonly modelPricedShare: number;
  readonly unpricedShare: number;
  readonly cacheSavingsUsd: number;
}

export interface CategoryCost {
  readonly input: number;
  readonly cacheRead: number;
  readonly cacheWrite: number;
  readonly output: number;
  readonly unsplit: number;
}

export interface SpeedCost {
  readonly standard: number;
  readonly fast: number;
  readonly ultrafast: number;
  readonly premium: number;
}

export interface UsageContractMismatch {
  readonly environmentId: EnvironmentId;
  readonly direction: "serverBehind" | "clientBehind";
  readonly contractVersion: number;
}

export interface MergedProjectTotals extends Omit<
  UsageProjectBucket,
  "provider" | "sourcePath" | "topModels" | "providerReportedCostUsd" | "worktreeRoots"
> {
  readonly totalTokens: number;
  readonly providerReportedCostUsd: number;
  readonly providers: readonly UsageProviderKind[];
  readonly topModel: string | null;
  readonly modelContributions: readonly (typeof UsageProjectTopModel.Type & {
    readonly provider: UsageProviderKind;
  })[];
  readonly costShare: number;
  readonly tokenShare: number;
}

export interface MergedSessionTotals extends UsageSessionSummary {
  readonly environmentId: EnvironmentId;
  readonly totalTokens: number;
}

export interface MergedUsage {
  readonly costUsd: number;
  readonly providerReportedCostUsd: number;
  readonly uncachedInputTokens: number;
  readonly cachedInputTokens: number;
  readonly cacheCreationTokens: number;
  readonly outputTokens: number;
  readonly reasoningTokens: number;
  readonly totalTokens: number;
  readonly records: number;
  readonly sessions: number;
  readonly providers: readonly ProviderTotals[];
  readonly models: readonly ModelTotals[];
  readonly projects: readonly MergedProjectTotals[];
  readonly topSessions: readonly MergedSessionTotals[];
  readonly hasProjectAttribution: boolean;
  readonly hasSessionAttribution: boolean;
  readonly partialProjectAttribution: boolean;
  readonly partialSessionAttribution: boolean;
  readonly daily: readonly DailyTotals[];
  readonly hourly: readonly HourlyTotals[];
  readonly costQuality: CostQuality;
  readonly categoryCost: CategoryCost;
  readonly speedCost: SpeedCost;
  readonly duplicateSources: readonly string[];
  readonly contributingEnvironments: readonly EnvironmentId[];
  readonly contractMismatches: readonly UsageContractMismatch[];
}

// volumeId distinguishes machines sharing a hostname and home path.
function fingerprintKey(fingerprint: UsageSourceFingerprint): string {
  return [
    fingerprint.hostId,
    fingerprint.provider,
    fingerprint.resolvedHomePath,
    fingerprint.volumeId,
  ].join(" ");
}

// Sources are one directory when either their legacy key or their physicalSourceId matches.
// physicalSourceId joins a directory read natively by Windows and through a WSL mount (path
// and dev:ino both differ); the legacy key still joins installs whose host scopes differ.
export function sourceIdentity(
  fingerprints: Iterable<UsageSourceFingerprint>,
): (fingerprint: UsageSourceFingerprint) => string {
  const parent = new Map<string, string>();
  const find = (key: string): string => {
    const next = parent.get(key);
    if (next === undefined || next === key) return key;
    const root = find(next);
    parent.set(key, root);
    return root;
  };
  for (const fingerprint of fingerprints) {
    if (fingerprint.physicalSourceId === undefined) continue;
    const legacy = find(fingerprintKey(fingerprint));
    const physical = find(`\u0000${fingerprint.provider}\u0000${fingerprint.physicalSourceId}`);
    if (legacy !== physical) parent.set(legacy, physical);
  }
  return (fingerprint) => find(fingerprintKey(fingerprint));
}

function bucketsForSource(summary: UsageSummary, source: UsageSource): readonly UsageBucket[] {
  const providerSources = summary.sources.filter(
    (entry) => entry.fingerprint.provider === source.fingerprint.provider,
  );
  return summary.buckets.filter(
    (bucket) =>
      bucket.provider === source.fingerprint.provider &&
      (bucket.sourcePath === source.fingerprint.resolvedHomePath ||
        (bucket.sourcePath === undefined && providerSources.length === 1)),
  );
}

function bucketKey(bucket: UsageBucket): string {
  return JSON.stringify([bucket.day, bucket.hourStart ?? null, bucket.provider, bucket.model]);
}

interface OwnedUsageSource {
  readonly environment: EnvironmentUsage;
  readonly source: UsageSource;
}

function claimSources(
  environments: readonly EnvironmentUsage[],
  sourceKey: (fingerprint: UsageSourceFingerprint) => string,
): {
  readonly ownerScanByFingerprint: ReadonlyMap<string, OwnedUsageSource>;
  readonly supplementalBucketsByEnvironment: ReadonlyMap<EnvironmentId, ReadonlySet<UsageBucket>>;
  readonly sessionsByFingerprint: ReadonlyMap<string, number>;
  readonly duplicates: readonly string[];
} {
  const ownerScanByFingerprint = new Map<string, OwnedUsageSource>();
  const seenBucketKeysByFingerprint = new Map<string, Set<string>>();
  const supplementalBucketsByEnvironment = new Map<EnvironmentId, Set<UsageBucket>>();
  const sessionsByFingerprint = new Map<string, number>();
  const duplicates: string[] = [];

  const ordered = [...environments].sort(
    (a, b) =>
      (Date.parse(b.summary.readAt) || 0) - (Date.parse(a.summary.readAt) || 0) ||
      a.environmentId.localeCompare(b.environmentId),
  );

  for (const status of ["ok", "partial", "failed"] as const) {
    for (const environment of ordered) {
      for (const source of environment.summary.sources) {
        if (source.status !== status) continue;
        const key = sourceKey(source.fingerprint);
        if (ownerScanByFingerprint.has(key)) {
          duplicates.push(`${environment.label}: ${source.fingerprint.resolvedHomePath}`);
          continue;
        }
        ownerScanByFingerprint.set(key, { environment, source });
        sessionsByFingerprint.set(key, source.distinctSessions);
      }
    }
  }

  // Keep cells unique to newer partial scans; aggregates cannot reconcile overlapping records without double-counting.
  for (const environment of ordered) {
    for (const source of environment.summary.sources) {
      if (source.status !== "partial") continue;
      const key = sourceKey(source.fingerprint);
      const owner = ownerScanByFingerprint.get(key);
      // A scan under another model filter counts different records, so its cells are not missing ones.
      if (
        owner?.source.status !== "ok" ||
        Date.parse(environment.summary.readAt) <= Date.parse(owner.environment.summary.readAt) ||
        environment.summary.projectFilter?.projectKey !==
          owner.environment.summary.projectFilter?.projectKey ||
        JSON.stringify(environment.summary.modelFilter) !==
          JSON.stringify(owner.environment.summary.modelFilter)
      ) {
        continue;
      }
      let seen = seenBucketKeysByFingerprint.get(key);
      if (seen === undefined) {
        seen = new Set(bucketsForSource(owner.environment.summary, owner.source).map(bucketKey));
        seenBucketKeysByFingerprint.set(key, seen);
      }
      const supplemental =
        supplementalBucketsByEnvironment.get(environment.environmentId) ?? new Set<UsageBucket>();
      let added = false;
      for (const bucket of bucketsForSource(environment.summary, source)) {
        const cell = bucketKey(bucket);
        if (seen.has(cell)) continue;
        seen.add(cell);
        supplemental.add(bucket);
        added = true;
      }
      if (!added) continue;
      supplementalBucketsByEnvironment.set(environment.environmentId, supplemental);
      sessionsByFingerprint.set(
        key,
        Math.max(sessionsByFingerprint.get(key) ?? 0, source.distinctSessions),
      );
    }
  }

  return {
    ownerScanByFingerprint,
    supplementalBucketsByEnvironment,
    sessionsByFingerprint,
    duplicates,
  };
}

function ownedContribution(
  environment: EnvironmentUsage,
  ownerScanByFingerprint: ReadonlyMap<string, OwnedUsageSource>,
  supplementalBuckets: ReadonlySet<UsageBucket>,
  sessionsByFingerprint: ReadonlyMap<string, number>,
  sourceKey: (fingerprint: UsageSourceFingerprint) => string,
): {
  readonly buckets: readonly UsageBucket[];
  readonly sessionsByProvider: ReadonlyMap<UsageProviderKind, number>;
  readonly owns: (entry: Pick<UsageBucket, "provider" | "sourcePath">) => boolean;
} {
  const ownedProviders = new Set<UsageProviderKind>();
  const ownedSources = new Set<string>();
  const sessionsByProvider = new Map<UsageProviderKind, number>();
  for (const source of environment.summary.sources) {
    if (source.status === "missing") continue;
    const key = sourceKey(source.fingerprint);
    // One environment can reach a directory through two mounts; only the winning source counts.
    const owner = ownerScanByFingerprint.get(key);
    if (owner?.environment === environment && owner.source === source) {
      const provider = source.fingerprint.provider;
      ownedProviders.add(provider);
      ownedSources.add(`${provider}\u0000${source.fingerprint.resolvedHomePath}`);
      // Count distinct sessions per directory; bucket sums overcount sessions spanning days/models.
      sessionsByProvider.set(
        provider,
        (sessionsByProvider.get(provider) ?? 0) +
          (sessionsByFingerprint.get(key) ?? source.distinctSessions),
      );
    }
  }
  const owns = ({ provider, sourcePath }: Pick<UsageBucket, "provider" | "sourcePath">) =>
    sourcePath === undefined
      ? ownedProviders.has(provider)
      : ownedSources.has(`${provider}\u0000${sourcePath}`);
  return {
    buckets: environment.summary.buckets.filter(
      (bucket) => supplementalBuckets.has(bucket) || owns(bucket),
    ),
    owns,
    sessionsByProvider,
  };
}

function countTokens(totals: UsageTokenTotals): number {
  return (
    totals.uncachedInputTokens +
    totals.cachedInputTokens +
    totals.cacheCreationTokens +
    totals.outputTokens
  );
}

type ProjectModel = {
  -readonly [
    Key in keyof MergedProjectTotals["modelContributions"][number]
  ]: MergedProjectTotals["modelContributions"][number][Key];
};

function accumulateProject(projects: Map<string, ProjectContribution>, bucket: UsageProjectBucket) {
  let project = projects.get(bucket.projectKey);
  if (project === undefined) {
    project = {
      label: bucket.label,
      projectKey: bucket.projectKey,
      ...(bucket.workspaceRoot === undefined ? {} : { workspaceRoot: bucket.workspaceRoot }),
      ...(bucket.t3ProjectId === undefined ? {} : { t3ProjectId: bucket.t3ProjectId }),
      ...(bucket.unattributed === undefined ? {} : { unattributed: bucket.unattributed }),
      totals: {
        uncachedInputTokens: 0,
        cachedInputTokens: 0,
        cacheCreationTokens: 0,
        outputTokens: 0,
        reasoningTokens: 0,
      },
      costUsd: 0,
      providerReportedCostUsd: 0,
      cacheSavingsUsd: 0,
      records: 0,
      unpricedRecords: 0,
      sessions: 0,
      worktreeCount: 0,
      worktreeRoots: new Set(),
      providers: new Set(),
      models: new Map(),
    };
    projects.set(bucket.projectKey, project);
  }
  const totals = project.totals;
  totals.uncachedInputTokens += bucket.totals.uncachedInputTokens;
  totals.cachedInputTokens += bucket.totals.cachedInputTokens;
  totals.cacheCreationTokens += bucket.totals.cacheCreationTokens;
  totals.outputTokens += bucket.totals.outputTokens;
  totals.reasoningTokens += bucket.totals.reasoningTokens;
  project.costUsd += bucket.costUsd;
  project.providerReportedCostUsd += bucket.providerReportedCostUsd ?? 0;
  project.cacheSavingsUsd += bucket.cacheSavingsUsd;
  project.records += bucket.records;
  project.unpricedRecords += bucket.unpricedRecords;
  project.sessions += bucket.sessions;
  if (bucket.worktreeRoots !== undefined) {
    for (const root of bucket.worktreeRoots) project.worktreeRoots.add(root);
  } else {
    project.worktreeCount = Math.max(project.worktreeCount, bucket.worktreeCount);
  }
  project.providers.add(bucket.provider);
  for (const model of bucket.topModels ?? []) {
    const key = `${bucket.provider}\u0000${model.model}`;
    const held = project.models.get(key);
    if (held === undefined) {
      project.models.set(key, { ...model, provider: bucket.provider });
    } else {
      held.costUsd += model.costUsd;
      held.totalTokens += model.totalTokens;
    }
  }
}

type ProjectContribution = Omit<
  {
    -readonly [Key in keyof MergedProjectTotals]: MergedProjectTotals[Key];
  },
  | "topModel"
  | "modelContributions"
  | "providers"
  | "totalTokens"
  | "costShare"
  | "tokenShare"
  | "totals"
> & {
  totals: { -readonly [Key in keyof UsageTokenTotals]: number };
  worktreeRoots: Set<string>;
  providers: Set<UsageProviderKind>;
  models: Map<string, ProjectModel>;
};

function compareUsageRank(
  a: { readonly costUsd: number; readonly totalTokens: number },
  b: { readonly costUsd: number; readonly totalTokens: number },
) {
  return b.costUsd - a.costUsd || b.totalTokens - a.totalTokens;
}

function finishProjects(
  projects: ReadonlyMap<string, ProjectContribution>,
  costUsd: number,
  totalTokens: number,
): readonly MergedProjectTotals[] {
  return [...projects.values()]
    .map(({ models, providers, worktreeRoots, ...project }) => {
      const modelContributions = [...models.values()].sort(compareUsageRank);
      const tokens = countTokens(project.totals);
      return {
        ...project,
        worktreeCount: Math.max(project.worktreeCount, worktreeRoots.size),
        providers: [...providers].sort(),
        modelContributions,
        topModel: modelContributions[0]?.model ?? null,
        totalTokens: tokens,
        costShare: costUsd === 0 ? 0 : project.costUsd / costUsd,
        tokenShare: totalTokens === 0 ? 0 : tokens / totalTokens,
      };
    })
    .sort((a, b) => compareUsageRank(a, b) || a.projectKey.localeCompare(b.projectKey));
}

function compareSessions(a: MergedSessionTotals, b: MergedSessionTotals): number {
  return (
    compareUsageRank(a, b) ||
    b.lastTimestampMs - a.lastTimestampMs ||
    a.provider.localeCompare(b.provider) ||
    a.sessionId.localeCompare(b.sessionId)
  );
}

function preferSessionCopy(candidate: MergedSessionTotals, held: MergedSessionTotals): boolean {
  // Aggregated copies can overlap; adding both cannot safely reconstruct the original records.
  return (
    (held.records - candidate.records ||
      held.lastTimestampMs - candidate.lastTimestampMs ||
      Number(held.t3ThreadId !== undefined) - Number(candidate.t3ThreadId !== undefined) ||
      compareSessions(candidate, held) ||
      candidate.environmentId.localeCompare(held.environmentId)) < 0
  );
}

export function isCompatibleUsageContractVersion(version: number, expected: number): boolean {
  return version >= USAGE_MERGE_COMPATIBLE_SINCE && version <= expected;
}

const EMPTY_MERGED: MergedUsage = {
  costUsd: 0,
  providerReportedCostUsd: 0,
  uncachedInputTokens: 0,
  cachedInputTokens: 0,
  cacheCreationTokens: 0,
  outputTokens: 0,
  reasoningTokens: 0,
  totalTokens: 0,
  records: 0,
  sessions: 0,
  providers: [],
  models: [],
  projects: [],
  topSessions: [],
  hasProjectAttribution: false,
  hasSessionAttribution: false,
  partialProjectAttribution: false,
  partialSessionAttribution: false,
  daily: [],
  hourly: [],
  costQuality: {
    providerReportedShare: 0,
    modelPricedShare: 0,
    unpricedShare: 0,
    cacheSavingsUsd: 0,
  },
  categoryCost: { input: 0, cacheRead: 0, cacheWrite: 0, output: 0, unsplit: 0 },
  speedCost: { standard: 0, fast: 0, ultrafast: 0, premium: 0 },
  duplicateSources: [],
  contributingEnvironments: [],
  contractMismatches: [],
};

export function mergeUsage(
  environments: readonly EnvironmentUsage[],
  expectedContractVersion: number,
): MergedUsage {
  if (environments.length === 0) return EMPTY_MERGED;

  const current: EnvironmentUsage[] = [];
  const contractMismatches: UsageContractMismatch[] = [];
  for (const environment of environments) {
    if (
      isCompatibleUsageContractVersion(environment.summary.contractVersion, expectedContractVersion)
    ) {
      current.push(environment);
    } else {
      contractMismatches.push({
        environmentId: environment.environmentId,
        direction:
          environment.summary.contractVersion < expectedContractVersion
            ? "serverBehind"
            : "clientBehind",
        contractVersion: environment.summary.contractVersion,
      });
    }
  }

  const sourceKey = sourceIdentity(
    current.flatMap((environment) =>
      environment.summary.sources.map((source) => source.fingerprint),
    ),
  );
  const {
    ownerScanByFingerprint,
    supplementalBucketsByEnvironment,
    sessionsByFingerprint,
    duplicates,
  } = claimSources(current, sourceKey);

  let costUsd = 0;
  let providerReportedCostUsd = 0;
  let uncachedInputTokens = 0;
  let cachedInputTokens = 0;
  let cacheCreationTokens = 0;
  let outputTokens = 0;
  let reasoningTokens = 0;
  let records = 0;
  let sessions = 0;
  let cacheSavingsUsd = 0;
  let providerReportedRecords = 0;
  let unpricedRecords = 0;
  const categoryCost = { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 };
  const speedCost = { fast: 0, ultrafast: 0, premium: 0 };

  const providerAccumulator = new Map<
    UsageProviderKind,
    { costUsd: number; totalTokens: number; records: number; sessions: number }
  >();
  const modelAccumulator = new Map<
    string,
    {
      provider: UsageProviderKind;
      costUsd: number;
      totalTokens: number;
      tokens: UsageTokenTotals;
      records: number;
      unpricedRecords: number;
      unpricedTokens: number;
    }
  >();
  const dailyAccumulator = new Map<
    string,
    {
      costUsd: number;
      totalTokens: number;
      byProvider: Map<UsageProviderKind, { costUsd: number; totalTokens: number }>;
    }
  >();
  const hourlyAccumulator = new Map<
    string,
    {
      day: string;
      hourStart: string;
      costUsd: number;
      totalTokens: number;
      byProvider: Map<UsageProviderKind, { costUsd: number; totalTokens: number }>;
    }
  >();
  const projectAccumulator = new Map<string, ProjectContribution>();
  const sessionAccumulator = new Map<string, MergedSessionTotals>();
  const linkedSessionMetadata = new Map<
    string,
    {
      readonly environmentId: EnvironmentId;
      readonly t3ThreadId: string;
      readonly t3ProjectId?: string;
      readonly title?: string;
      readonly isConnected: boolean;
      readonly readAtMs: number;
    }
  >();
  let projectAttributionCount = 0;
  let sessionAttributionCount = 0;
  const contributingEnvironments: EnvironmentId[] = [];

  for (const environment of current) {
    const readAtMs = Date.parse(environment.summary.readAt) || 0;
    const isConnected = environment.isConnected !== false;
    for (const session of environment.summary.topSessions ?? []) {
      if (session.t3ThreadId === undefined) continue;
      const key = `${session.provider}\u0000${session.sessionId}`;
      const existing = linkedSessionMetadata.get(key);
      const preferCandidate =
        existing === undefined ||
        (isConnected && !existing.isConnected) ||
        (isConnected === existing.isConnected &&
          (readAtMs > existing.readAtMs ||
            (readAtMs === existing.readAtMs &&
              environment.environmentId.localeCompare(existing.environmentId) < 0)));
      if (preferCandidate) {
        linkedSessionMetadata.set(key, {
          environmentId: environment.environmentId,
          t3ThreadId: session.t3ThreadId,
          ...(session.t3ProjectId === undefined ? {} : { t3ProjectId: session.t3ProjectId }),
          ...(session.title === undefined ? {} : { title: session.title }),
          isConnected,
          readAtMs,
        });
      }
    }
  }

  for (const environment of current) {
    const ownerConnected = environment.isConnected !== false;
    const { buckets, owns, sessionsByProvider } = ownedContribution(
      environment,
      ownerScanByFingerprint,
      supplementalBucketsByEnvironment.get(environment.environmentId) ?? new Set(),
      sessionsByFingerprint,
      sourceKey,
    );
    if (buckets.length > 0) contributingEnvironments.push(environment.environmentId);
    const { projects, topSessions } = environment.summary;
    if (projects !== undefined) {
      projectAttributionCount += 1;
      for (const project of projects) {
        if (owns(project)) accumulateProject(projectAccumulator, project);
      }
    }
    if (topSessions !== undefined) {
      sessionAttributionCount += 1;
      for (const session of topSessions) {
        if (!owns(session)) continue;
        const key = `${session.provider}\u0000${session.sessionId}`;
        const bestLinked = linkedSessionMetadata.get(key);
        const shouldBorrowLink =
          bestLinked !== undefined &&
          (session.t3ThreadId === undefined || (!ownerConnected && bestLinked.isConnected));
        const linked = shouldBorrowLink ? bestLinked : undefined;
        const candidate: MergedSessionTotals = {
          ...session,
          ...(linked === undefined
            ? {}
            : {
                t3ThreadId: linked.t3ThreadId,
                ...(linked.t3ProjectId === undefined ? {} : { t3ProjectId: linked.t3ProjectId }),
                // Prefer the live T3 thread title over an unlinked scanner's native CLI title.
                ...(linked.title !== undefined ? { title: linked.title } : {}),
              }),
          totalTokens: countTokens(session.totals),
          environmentId: linked?.environmentId ?? environment.environmentId,
        };
        const held = sessionAccumulator.get(key);
        if (held === undefined || preferSessionCopy(candidate, held)) {
          sessionAccumulator.set(key, candidate);
        }
      }
    }

    for (const [providerKind, providerSessions] of sessionsByProvider) {
      sessions += providerSessions;
      if (providerSessions === 0) continue;
      const provider = providerAccumulator.get(providerKind) ?? {
        costUsd: 0,
        totalTokens: 0,
        records: 0,
        sessions: 0,
      };
      provider.sessions += providerSessions;
      providerAccumulator.set(providerKind, provider);
    }

    for (const bucket of buckets) {
      const tokens = countTokens(bucket.totals);

      costUsd += bucket.costUsd;
      providerReportedCostUsd +=
        bucket.providerReportedCostUsd ??
        (bucket.costSource === "providerReported" ? bucket.costUsd : 0);
      cacheSavingsUsd += bucket.cacheSavingsUsd;
      uncachedInputTokens += bucket.totals.uncachedInputTokens;
      cachedInputTokens += bucket.totals.cachedInputTokens;
      cacheCreationTokens += bucket.totals.cacheCreationTokens;
      outputTokens += bucket.totals.outputTokens;
      reasoningTokens += bucket.totals.reasoningTokens;
      records += bucket.records;
      unpricedRecords += bucket.unpricedRecords;
      if (bucket.costSource === "providerReported") providerReportedRecords += bucket.records;
      if (bucket.categoryCostUsd !== undefined) {
        categoryCost.input += bucket.categoryCostUsd.input;
        categoryCost.cacheRead += bucket.categoryCostUsd.cacheRead;
        categoryCost.cacheWrite += bucket.categoryCostUsd.cacheWrite;
        categoryCost.output += bucket.categoryCostUsd.output;
      }
      speedCost.fast += bucket.fastCostUsd ?? 0;
      speedCost.ultrafast += bucket.ultrafastCostUsd ?? 0;
      speedCost.premium += bucket.speedPremiumUsd ?? 0;

      const provider = providerAccumulator.get(bucket.provider) ?? {
        costUsd: 0,
        totalTokens: 0,
        records: 0,
        sessions: 0,
      };
      provider.costUsd += bucket.costUsd;
      provider.totalTokens += tokens;
      provider.records += bucket.records;
      providerAccumulator.set(bucket.provider, provider);

      const modelKey = `${bucket.provider} ${bucket.model}`;
      const model = modelAccumulator.get(modelKey) ?? {
        provider: bucket.provider,
        costUsd: 0,
        totalTokens: 0,
        tokens: {
          uncachedInputTokens: 0,
          cachedInputTokens: 0,
          cacheCreationTokens: 0,
          outputTokens: 0,
          reasoningTokens: 0,
        },
        records: 0,
        unpricedRecords: 0,
        unpricedTokens: 0,
      };
      model.costUsd += bucket.costUsd;
      model.totalTokens += tokens;
      model.tokens = {
        uncachedInputTokens: model.tokens.uncachedInputTokens + bucket.totals.uncachedInputTokens,
        cachedInputTokens: model.tokens.cachedInputTokens + bucket.totals.cachedInputTokens,
        cacheCreationTokens: model.tokens.cacheCreationTokens + bucket.totals.cacheCreationTokens,
        outputTokens: model.tokens.outputTokens + bucket.totals.outputTokens,
        reasoningTokens: model.tokens.reasoningTokens + bucket.totals.reasoningTokens,
      };
      model.records += bucket.records;
      model.unpricedRecords += bucket.unpricedRecords;
      if (bucket.unpricedTokens !== undefined) {
        model.unpricedTokens += bucket.unpricedTokens;
      } else if (bucket.records > 0) {
        model.unpricedTokens += (tokens * bucket.unpricedRecords) / bucket.records;
      }
      modelAccumulator.set(modelKey, model);

      const day = dailyAccumulator.get(bucket.day) ?? {
        costUsd: 0,
        totalTokens: 0,
        byProvider: new Map<UsageProviderKind, { costUsd: number; totalTokens: number }>(),
      };
      day.costUsd += bucket.costUsd;
      day.totalTokens += tokens;
      const dayProvider = day.byProvider.get(bucket.provider) ?? { costUsd: 0, totalTokens: 0 };
      dayProvider.costUsd += bucket.costUsd;
      dayProvider.totalTokens += tokens;
      day.byProvider.set(bucket.provider, dayProvider);
      dailyAccumulator.set(bucket.day, day);

      if (bucket.hourStart !== undefined) {
        const hour = hourlyAccumulator.get(bucket.hourStart) ?? {
          day: bucket.day,
          hourStart: bucket.hourStart,
          costUsd: 0,
          totalTokens: 0,
          byProvider: new Map<UsageProviderKind, { costUsd: number; totalTokens: number }>(),
        };
        hour.costUsd += bucket.costUsd;
        hour.totalTokens += tokens;
        const hourProvider = hour.byProvider.get(bucket.provider) ?? {
          costUsd: 0,
          totalTokens: 0,
        };
        hourProvider.costUsd += bucket.costUsd;
        hourProvider.totalTokens += tokens;
        hour.byProvider.set(bucket.provider, hourProvider);
        hourlyAccumulator.set(bucket.hourStart, hour);
      }
    }
  }

  const totalTokens = uncachedInputTokens + cachedInputTokens + cacheCreationTokens + outputTokens;

  const providers: ProviderTotals[] = [...providerAccumulator.entries()]
    .map(([provider, totals]) => ({
      provider,
      costUsd: totals.costUsd,
      totalTokens: totals.totalTokens,
      records: totals.records,
      sessions: totals.sessions,
      costShare: costUsd === 0 ? 0 : totals.costUsd / costUsd,
      tokenShare: totalTokens === 0 ? 0 : totals.totalTokens / totalTokens,
    }))
    .sort((a, b) => b.costUsd - a.costUsd);

  const models: ModelTotals[] = [...modelAccumulator.entries()]
    .map(([key, totals]) => ({
      model: key.slice(key.indexOf(" ") + 1),
      provider: totals.provider,
      costUsd: totals.costUsd,
      totalTokens: totals.totalTokens,
      tokens: totals.tokens,
      records: totals.records,
      unpricedRecords: totals.unpricedRecords,
      unpricedTokens: totals.unpricedTokens,
      costShare: costUsd === 0 ? 0 : totals.costUsd / costUsd,
      tokenShare: totalTokens === 0 ? 0 : totals.totalTokens / totalTokens,
    }))
    .sort((a, b) => b.costUsd - a.costUsd || b.totalTokens - a.totalTokens);

  const daily: DailyTotals[] = [...dailyAccumulator.entries()]
    .map(([day, totals]) => ({
      day,
      costUsd: totals.costUsd,
      totalTokens: totals.totalTokens,
      byProvider: totals.byProvider,
    }))
    .sort((a, b) => a.day.localeCompare(b.day));

  const hourly: HourlyTotals[] = [...hourlyAccumulator.values()].sort((a, b) =>
    a.hourStart.localeCompare(b.hourStart),
  );

  const unpricedShare = records === 0 ? 0 : unpricedRecords / records;
  const pricedRecords = Math.max(0, records - unpricedRecords);
  // Keep spend provenance (fraction of priced USD) on its own denominator, separate from unpriced record share.
  const providerReportedShare =
    costUsd > 0
      ? Math.min(1, Math.max(0, providerReportedCostUsd / costUsd))
      : pricedRecords > 0
        ? providerReportedRecords / pricedRecords
        : 0;
  const modelPricedShare =
    costUsd > 0 || pricedRecords > 0 ? Math.max(0, 1 - providerReportedShare) : 0;

  return {
    costUsd,
    providerReportedCostUsd,
    uncachedInputTokens,
    cachedInputTokens,
    cacheCreationTokens,
    outputTokens,
    reasoningTokens,
    totalTokens,
    records,
    sessions,
    providers,
    models,
    projects: finishProjects(projectAccumulator, costUsd, totalTokens),
    topSessions: [...sessionAccumulator.values()].sort(compareSessions).slice(0, 50),
    hasProjectAttribution: projectAttributionCount > 0,
    hasSessionAttribution: sessionAttributionCount > 0,
    partialProjectAttribution:
      projectAttributionCount > 0 && projectAttributionCount < current.length,
    partialSessionAttribution:
      sessionAttributionCount > 0 && sessionAttributionCount < current.length,
    daily,
    hourly,
    costQuality: {
      providerReportedShare,
      unpricedShare,
      modelPricedShare,
      cacheSavingsUsd,
    },
    categoryCost: {
      ...categoryCost,
      unsplit: Math.max(
        0,
        costUsd -
          categoryCost.input -
          categoryCost.cacheRead -
          categoryCost.cacheWrite -
          categoryCost.output,
      ),
    },
    speedCost: {
      ...speedCost,
      standard: Math.max(0, costUsd - speedCost.fast - speedCost.ultrafast),
    },
    duplicateSources: duplicates,
    contributingEnvironments,
    contractMismatches,
  };
}
