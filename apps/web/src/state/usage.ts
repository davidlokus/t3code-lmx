import { useAtomValue } from "@effect/atom-react";
import {
  AuthProvidersManageScope,
  AuthDiagnosticsReadScope,
  USAGE_CONTRACT_VERSION,
  type EnvironmentId,
  type UsageBucket,
  type UsageAccessRequest,
  type UsageProjectFilter,
  type UsageProviderKind,
  type UsageSummary,
  type UsageSummaryInput,
} from "@t3tools/contracts";
import { refreshUsage, usageSummaryInput } from "@t3tools/client-runtime/state/usage";
import {
  resolveUsageAccess,
  unansweredUsageAccessRequests,
} from "@t3tools/client-runtime/state/usage-access";
import * as Cause from "effect/Cause";
import { AsyncResult, Atom } from "effect/reactivity";
import { msg } from "gt-react";
import { useState } from "react";

import {
  isCompatibleUsageContractVersion,
  mergeUsage,
  type EnvironmentUsage,
  type MergedUsage,
} from "@t3tools/shared/usageMerge";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { environmentPresentations } from "./presentation";
import { serverEnvironment } from "./server";
import { environmentSession, readEnvironmentScope, sessionHasScope } from "./session";
import { m } from "../i18n/messages";

export interface EnvironmentUsageStatus {
  readonly environmentId: EnvironmentId;
  readonly label: string;
  readonly isPending: boolean;
  readonly canReadDiagnostics: boolean;
  /** Agents still waiting for a usage access answer that this session may save. */
  readonly accessRequests: readonly UsageAccessRequest[];
  readonly isConnected: boolean;
  readonly error: string | null;
  readonly rejectedOversizedHourlyWindow?: boolean;
  readonly hasFreshModernSummary?: boolean;
  readonly summary: UsageSummary | null;
}

const MAX_LEGACY_HOURLY_WINDOW_MS = 24 * 60 * 60 * 1000;

function isOversizedHourlyWindow(input: UsageSummaryInput): boolean {
  if (
    input.resolution !== "hour" ||
    input.sinceTime === undefined ||
    input.untilTime === undefined
  ) {
    return false;
  }
  const sinceMs = Date.parse(input.sinceTime);
  const untilMs = Date.parse(input.untilTime);
  return (
    Number.isFinite(sinceMs) &&
    Number.isFinite(untilMs) &&
    untilMs - sinceMs > MAX_LEGACY_HOURLY_WINDOW_MS
  );
}

function isInvalidWindowFailure(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  if ("reason" in error && error.reason === "invalidWindow") return true;
  const message = "message" in error && typeof error.message === "string" ? error.message : "";
  return /invalidWindow|at most 24 hours/i.test(message);
}

const EMPTY_ENVIRONMENTS: readonly EnvironmentUsageStatus[] = [];
const emptyUsageEnvironmentsAtom = Atom.make(EMPTY_ENVIRONMENTS).pipe(
  Atom.withLabel("web-usage:empty"),
);

// fork: Include projectFilter and canonical providers in the query key so scoped scans cache independently.
function usageWindowKey(input: UsageSummaryInput): string {
  return JSON.stringify({
    sinceDay: input.sinceDay,
    untilDay: input.untilDay,
    timeZone: input.timeZone,
    resolution: input.resolution,
    sinceTime: input.sinceTime,
    untilTime: input.untilTime,
    projectFilter: input.projectFilter,
    providers: input.providers === undefined ? undefined : [...new Set(input.providers)].sort(),
  });
}

function sameProviderSet(
  left: ReadonlySet<UsageProviderKind>,
  right: ReadonlySet<UsageProviderKind>,
): boolean {
  if (left === right) return true;
  if (left.size !== right.size) return false;
  for (const item of left) {
    if (!right.has(item)) return false;
  }
  return true;
}

function sameEnvironmentIdSet(
  left: ReadonlySet<EnvironmentId>,
  right: ReadonlySet<EnvironmentId>,
): boolean {
  if (left === right) return true;
  if (left.size !== right.size) return false;
  for (const item of left) {
    if (!right.has(item)) return false;
  }
  return true;
}

const usageByWindowAtom = Atom.family((windowKey: string) =>
  Atom.make((get): readonly EnvironmentUsageStatus[] => {
    const input = JSON.parse(windowKey) as UsageSummaryInput;
    const presentations = get(environmentPresentations.presentationsAtom);

    const statuses: EnvironmentUsageStatus[] = [];
    for (const [environmentId, presentation] of presentations) {
      const isConnected = presentation.connection.phase === "connected";
      const sessionResult = get(environmentSession.sessionStateAtom(environmentId));
      const access = resolveUsageAccess(
        {
          connectionPhase: presentation.connection.phase,
          session: AsyncResult.getOrElse(sessionResult, () => null),
          hasSessionError: sessionResult._tag === "Failure",
        },
        m,
      );
      if (!access.canReadDiagnostics) {
        statuses.push({
          environmentId,
          label: presentation.entry.target.label,
          isConnected,
          ...access,
          accessRequests: [],
          summary: null,
        });
        continue;
      }
      const result = get(
        serverEnvironment.usageSummary({
          environmentId,
          input: usageSummaryInput(
            input,
            get(serverEnvironment.usageModelFilterAtom(environmentId)),
          ),
        }),
      );
      const summary = AsyncResult.getOrElse(result, () => null);
      const rejectedOversizedHourlyWindow =
        result._tag === "Failure" &&
        isOversizedHourlyWindow(input) &&
        isInvalidWindowFailure(Cause.squash(result.cause));
      const hasFreshModernSummary =
        result._tag === "Success" &&
        summary !== null &&
        (summary.projects !== undefined || summary.topSessions !== undefined);
      statuses.push({
        environmentId,
        label: presentation.entry.target.label,
        isPending: result.waiting,
        canReadDiagnostics: true,
        accessRequests: unansweredUsageAccessRequests({
          canAnswer: sessionHasScope(sessionResult, AuthProvidersManageScope),
          summary,
          config: get(serverEnvironment.configValueAtom(environmentId)),
        }),
        isConnected,
        error:
          result._tag === "Failure" ? m(msg("This environment could not report usage.")) : null,
        ...(rejectedOversizedHourlyWindow ? { rejectedOversizedHourlyWindow: true } : {}),
        ...(hasFreshModernSummary ? { hasFreshModernSummary: true } : {}),
        summary,
      });
    }
    return statuses;
  }).pipe(Atom.withLabel(`web-usage:window:${windowKey}`)),
);

export interface ExcludedUsageEnvironment {
  readonly environmentId: EnvironmentId;
  readonly label: string;
}

export interface UsageView {
  readonly merged: MergedUsage;
  readonly environments: readonly EnvironmentUsageStatus[];
  readonly selectedEnvironments: readonly EnvironmentUsageStatus[];
  readonly excludedLegacyEnvironments: readonly ExcludedUsageEnvironment[];
  readonly answeredEnvironmentIds: ReadonlySet<EnvironmentId>;
  readonly hasEligibleAnswer: boolean;
  readonly eligibleHasLegacyServer: boolean;
  readonly detectedLegacyEnvironmentIds: ReadonlySet<EnvironmentId>;
  readonly isStaleScope: boolean;
  readonly isPending: boolean;
  readonly shown: { readonly window: UsageSummaryInput; readonly merged: MergedUsage } | null;
  readonly isPartial: boolean;
  readonly refresh: (input?: UsageSummaryInput) => Promise<void>;
}

export function mergeAnsweredUsage(
  environments: readonly EnvironmentUsageStatus[],
  keepBucket?: (bucket: UsageBucket) => boolean,
): MergedUsage {
  const answered: EnvironmentUsage[] = environments.flatMap(
    ({ environmentId, label, isConnected, summary }) =>
      summary === null
        ? []
        : [
            {
              environmentId,
              label,
              isConnected,
              summary:
                keepBucket === undefined
                  ? summary
                  : { ...summary, buckets: summary.buckets.filter(keepBucket) },
            },
          ],
  );
  return mergeUsage(answered, USAGE_CONTRACT_VERSION);
}

const NO_HIDDEN_PROVIDERS: ReadonlySet<UsageProviderKind> = new Set();

// fork: Exclude pre-dashboard servers that ignored an active projectFilter BEFORE provider filtering & source dedupe.
export function filterUsageEnvironmentsForScope(
  environments: readonly EnvironmentUsageStatus[],
  hiddenProviders: ReadonlySet<UsageProviderKind>,
  projectFilter?: UsageProjectFilter | null,
): {
  readonly eligible: readonly EnvironmentUsageStatus[];
  readonly excludedLegacy: readonly ExcludedUsageEnvironment[];
} {
  const requestedProjectKey = projectFilter?.projectKey;
  const eligible: EnvironmentUsageStatus[] = [];
  const excludedLegacy: ExcludedUsageEnvironment[] = [];

  for (const environment of environments) {
    const summary = environment.summary;
    if (
      requestedProjectKey !== undefined &&
      summary !== null &&
      summary.projectFilter?.projectKey !== requestedProjectKey
    ) {
      excludedLegacy.push({
        environmentId: environment.environmentId,
        label: environment.label,
      });
      continue;
    }
    if (summary === null || hiddenProviders.size === 0) {
      eligible.push(environment);
      continue;
    }
    eligible.push({
      ...environment,
      summary: {
        ...summary,
        buckets: summary.buckets.filter((bucket) => !hiddenProviders.has(bucket.provider)),
        sources: summary.sources.filter(
          (source) => !hiddenProviders.has(source.fingerprint.provider),
        ),
        ...(summary.projects === undefined
          ? {}
          : {
              projects: summary.projects.filter(
                (project) => !hiddenProviders.has(project.provider),
              ),
            }),
        ...(summary.topSessions === undefined
          ? {}
          : {
              topSessions: summary.topSessions.filter(
                (session) => !hiddenProviders.has(session.provider),
              ),
            }),
      },
    });
  }

  return { eligible, excludedLegacy };
}

// fork: Determine whether any environment actually contributing buckets to `merged` is a legacy pre-dashboard server.
export function hasContributingLegacyServer(
  eligible: readonly EnvironmentUsageStatus[],
  merged: MergedUsage,
): boolean {
  const contributingIds = new Set(merged.contributingEnvironments);
  return eligible.some(
    (entry) =>
      contributingIds.has(entry.environmentId) &&
      entry.summary !== null &&
      isCompatibleUsageContractVersion(entry.summary.contractVersion, USAGE_CONTRACT_VERSION) &&
      entry.summary.projects === undefined &&
      entry.summary.topSessions === undefined,
  );
}

function deriveSelection(
  environments: readonly EnvironmentUsageStatus[],
  selectedEnvironmentIds: ReadonlySet<EnvironmentId> | null,
  hiddenProviders: ReadonlySet<UsageProviderKind>,
  projectFilter?: UsageProjectFilter,
) {
  const selectedEnvironments =
    selectedEnvironmentIds === null
      ? environments
      : environments.filter((environment) => selectedEnvironmentIds.has(environment.environmentId));
  const { eligible, excludedLegacy } = filterUsageEnvironmentsForScope(
    selectedEnvironments,
    hiddenProviders,
    projectFilter,
  );
  const compatibleAnswered = eligible.filter(
    (entry) =>
      entry.summary !== null &&
      isCompatibleUsageContractVersion(entry.summary.contractVersion, USAGE_CONTRACT_VERSION),
  );
  const answeredEnvironmentIds = new Set(compatibleAnswered.map((entry) => entry.environmentId));
  const hasEligibleAnswer = compatibleAnswered.length > 0;
  const merged = mergeAnsweredUsage(eligible);
  // Base MTD/export exactness strictly on actual contributing sources after dedupe.
  const eligibleHasLegacyServer = hasContributingLegacyServer(eligible, merged);
  const detectedLegacyEnvironmentIds = new Set(
    environments
      .filter(
        (entry) =>
          entry.rejectedOversizedHourlyWindow === true ||
          (entry.summary !== null &&
            entry.summary.projects === undefined &&
            entry.summary.topSessions === undefined),
      )
      .map((entry) => entry.environmentId),
  );
  return {
    environments,
    selectedEnvironmentIds,
    hiddenProviders,
    requestedProjectKey: projectFilter?.projectKey,
    selectedEnvironments,
    eligibleEnvironments: eligible,
    excludedLegacyEnvironments: excludedLegacy,
    answeredEnvironmentIds,
    hasEligibleAnswer,
    eligibleHasLegacyServer,
    detectedLegacyEnvironmentIds,
    merged,
  };
}

export function useUsage(
  input: UsageSummaryInput,
  selectedEnvironmentIds: ReadonlySet<EnvironmentId> | null = null,
  hiddenProviders: ReadonlySet<UsageProviderKind> = NO_HIDDEN_PROVIDERS,
): UsageView {
  const windowKey = usageWindowKey(input);
  const atom = usageByWindowAtom(windowKey);
  const environments = useAtomValue(atom);
  // Identity-based render sync needs a derivation retained by inputs across renders.
  const [derived, setDerived] = useState(() =>
    deriveSelection(environments, selectedEnvironmentIds, hiddenProviders, input.projectFilter),
  );
  let current = derived;
  if (
    derived.environments !== environments ||
    derived.selectedEnvironmentIds !== selectedEnvironmentIds ||
    derived.requestedProjectKey !== input.projectFilter?.projectKey ||
    !sameProviderSet(derived.hiddenProviders, hiddenProviders)
  ) {
    current = deriveSelection(
      environments,
      selectedEnvironmentIds,
      hiddenProviders,
      input.projectFilter,
    );
    setDerived(current);
  }
  const {
    selectedEnvironments,
    eligibleEnvironments,
    excludedLegacyEnvironments,
    answeredEnvironmentIds,
    hasEligibleAnswer,
    eligibleHasLegacyServer,
    detectedLegacyEnvironmentIds,
    merged,
  } = current;

  const refresh = (nextInput?: UsageSummaryInput) =>
    refreshUsage({
      registry: appAtomRegistry,
      server: serverEnvironment,
      presentations: environmentPresentations,
      environmentIds: selectedEnvironments
        .filter(
          (environment) =>
            environment.canReadDiagnostics &&
            readEnvironmentScope(environment.environmentId, AuthDiagnosticsReadScope),
        )
        .map(({ environmentId }) => environmentId),
      input: nextInput ?? (JSON.parse(windowKey) as UsageSummaryInput),
    });

  const stillReporting = eligibleEnvironments.filter(
    (environment) => environment.summary === null && environment.error === null,
  ).length;
  const isPending = !hasEligibleAnswer && stillReporting > 0;

  const [lastAnswered, setLastAnswered] = useState<
    | (NonNullable<UsageView["shown"]> & {
        readonly windowKey: string;
        readonly selection: typeof selectedEnvironmentIds;
        readonly hidden: typeof hiddenProviders;
      })
    | null
  >(null);
  if (
    hasEligibleAnswer &&
    (lastAnswered?.merged !== merged ||
      lastAnswered.windowKey !== windowKey ||
      lastAnswered.selection !== selectedEnvironmentIds ||
      !sameProviderSet(lastAnswered.hidden, hiddenProviders))
  ) {
    setLastAnswered({
      window: input,
      windowKey,
      merged,
      selection: selectedEnvironmentIds,
      hidden: hiddenProviders,
    });
  }
  const kept =
    stillReporting > 0 &&
    lastAnswered?.selection === selectedEnvironmentIds &&
    sameProviderSet(lastAnswered.hidden, hiddenProviders)
      ? lastAnswered
      : null;
  // Never synthesize a fake $0 current answer when every selected environment failed, was excluded, or is incompatible.
  const shown = hasEligibleAnswer ? { window: input, merged } : kept;
  const isStaleScope = shown !== null && usageWindowKey(shown.window) !== windowKey;

  return {
    merged,
    environments,
    selectedEnvironments,
    excludedLegacyEnvironments,
    answeredEnvironmentIds,
    hasEligibleAnswer,
    eligibleHasLegacyServer,
    detectedLegacyEnvironmentIds,
    isStaleScope,
    isPending,
    shown,
    isPartial: hasEligibleAnswer && stillReporting > 0,
    refresh,
  };
}

// fork: Lazy comparison period hook that enforces echoed projectFilter and matching environment coverage.
export function useUsageComparison(
  input: UsageSummaryInput | null,
  selectedEnvironmentIds: ReadonlySet<EnvironmentId> | null = null,
  hiddenProviders: ReadonlySet<UsageProviderKind> = NO_HIDDEN_PROVIDERS,
  requiredEnvironmentIds?: ReadonlySet<EnvironmentId> | null,
): {
  readonly merged: MergedUsage | null;
  readonly isPending: boolean;
  readonly coarseLegacySuppressed?: boolean;
} {
  const atom =
    input === null ? emptyUsageEnvironmentsAtom : usageByWindowAtom(usageWindowKey(input));
  const environments = useAtomValue(atom);
  if (input === null) {
    return { merged: null, isPending: false };
  }
  const selectedEnvironments =
    selectedEnvironmentIds === null
      ? environments
      : environments.filter((environment) => selectedEnvironmentIds.has(environment.environmentId));
  const { eligible } = filterUsageEnvironmentsForScope(
    selectedEnvironments,
    hiddenProviders,
    input.projectFilter,
  );
  const answeredIds = new Set(
    eligible
      .filter(
        (environment) =>
          environment.summary !== null &&
          isCompatibleUsageContractVersion(
            environment.summary.contractVersion,
            USAGE_CONTRACT_VERSION,
          ),
      )
      .map((e) => e.environmentId),
  );
  const stillReporting = eligible.filter(
    (environment) => environment.summary === null && environment.error === null,
  ).length;
  if (answeredIds.size === 0) {
    return { merged: null, isPending: stillReporting > 0 };
  }
  if (
    requiredEnvironmentIds !== undefined &&
    requiredEnvironmentIds !== null &&
    !sameEnvironmentIdSet(answeredIds, requiredEnvironmentIds)
  ) {
    return { merged: null, isPending: stillReporting > 0 };
  }
  const merged = mergeAnsweredUsage(eligible);
  const isExactDailyWindow =
    input.resolution !== "hour" && input.sinceTime !== undefined && input.untilTime !== undefined;
  if (isExactDailyWindow && hasContributingLegacyServer(eligible, merged)) {
    return { merged: null, isPending: stillReporting > 0, coarseLegacySuppressed: true };
  }
  return {
    merged,
    isPending: stillReporting > 0,
  };
}
