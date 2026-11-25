import type {
  ProviderUsageLimitsUpdate,
  ServerProviderUsageLimits,
  ServerProviderUsageWindow,
} from "@t3tools/contracts";

const WINDOW_KIND_ORDER: Record<ServerProviderUsageWindow["kind"], number> = {
  session: 0,
  weekly: 1,
  monthly: 2,
  other: 3,
};

export function clampPercent(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.min(100, value)) : 0;
}

function sortWindows(
  windows: Iterable<ServerProviderUsageWindow>,
): ReadonlyArray<ServerProviderUsageWindow> {
  return [...windows].toSorted(
    (left, right) =>
      WINDOW_KIND_ORDER[left.kind] - WINDOW_KIND_ORDER[right.kind] ||
      left.id.localeCompare(right.id),
  );
}

export function makeUsageLimits(input: {
  readonly checkedAt: string;
  readonly windows: Iterable<ServerProviderUsageWindow>;
  // fork: Complete streamed reports may carry optional account-level metadata.
  readonly subscriptionExpiresAt?: ServerProviderUsageLimits["subscriptionExpiresAt"];
  readonly planTier?: ServerProviderUsageLimits["planTier"];
  readonly balances?: ServerProviderUsageLimits["balances"];
  readonly serviceNotice?: ServerProviderUsageLimits["serviceNotice"];
}): ServerProviderUsageLimits {
  return {
    checkedAt: input.checkedAt,
    windows: sortWindows(input.windows),
    ...(input.subscriptionExpiresAt === undefined
      ? {}
      : { subscriptionExpiresAt: input.subscriptionExpiresAt }),
    ...(input.planTier === undefined ? {} : { planTier: input.planTier }),
    ...(input.balances === undefined ? {} : { balances: input.balances }),
    ...(input.serviceNotice === undefined ? {} : { serviceNotice: input.serviceNotice }),
  };
}

export function makeUnavailableUsageLimits(input: {
  readonly checkedAt: string;
  readonly reason: "unsupported" | "probeFailed";
  readonly message?: string;
}): ServerProviderUsageLimits {
  return {
    checkedAt: input.checkedAt,
    windows: [],
    unavailable: {
      reason: input.reason,
      ...(input.message ? { message: input.message } : {}),
    },
  };
}

export function applyUsageLimitsUpdate(input: {
  readonly previous: ServerProviderUsageLimits | undefined;
  readonly update: ProviderUsageLimitsUpdate;
  readonly checkedAt: string;
}): ServerProviderUsageLimits | undefined {
  const { previous, update, checkedAt } = input;
  const { subscriptionExpiresAt, planTier, balances, serviceNotice } = update;
  // fork: Sparse account metadata can update independently of the windows.
  const metadataChanged =
    (subscriptionExpiresAt !== undefined &&
      subscriptionExpiresAt !== previous?.subscriptionExpiresAt) ||
    (planTier !== undefined && planTier !== previous?.planTier) ||
    (balances !== undefined && balances !== previous?.balances) ||
    (serviceNotice !== undefined &&
      (serviceNotice.message !== previous?.serviceNotice?.message ||
        serviceNotice.severity !== previous?.serviceNotice?.severity));
  if (
    previous?.unavailable?.reason === "unsupported" ||
    (update.windows.length === 0 && !metadataChanged)
  ) {
    return previous;
  }
  let windows = previous?.windows ?? [];
  if (update.windows.length > 0) {
    const merged = new Map(windows.map((window) => [window.id, window] as const));
    // Codex repeats unchanged limits on token ticks; avoid allocating snapshots for no-ops.
    let changed = false;
    for (const window of update.windows) {
      const existing = merged.get(window.id);
      const normalized: ServerProviderUsageWindow = {
        ...window,
        usedPercent: clampPercent(window.usedPercent),
      };
      // fork: Inherit omitted clock/quantity fields only when kind, duration, unit, capacity,
      // scope, and category are compatible so sparse updates never relabel quantities or borrow
      // clocks from a different plan cadence.
      const next = mergeCompatibleWindowMetadata(normalized, existing, {
        allowAmountsOnPercentDelta: true,
      });
      if (existing === undefined || !usageWindowEquals(existing, next)) {
        merged.set(window.id, next);
        changed = true;
      }
    }
    if (changed) windows = sortWindows(merged.values());
  }
  if (windows === previous?.windows && !metadataChanged) return previous;
  return {
    ...previous,
    checkedAt,
    windows,
    ...(previous === undefined ? { unavailable: { reason: "probeFailed" } } : {}),
    ...(subscriptionExpiresAt === undefined ? {} : { subscriptionExpiresAt }),
    ...(planTier === undefined ? {} : { planTier }),
    ...(balances === undefined ? {} : { balances }),
    ...(serviceNotice === undefined ? {} : { serviceNotice }),
  };
}

function usageWindowEquals(a: ServerProviderUsageWindow, b: ServerProviderUsageWindow): boolean {
  return (
    a.id === b.id &&
    a.kind === b.kind &&
    a.label === b.label &&
    a.usedPercent === b.usedPercent &&
    (a.modelIds === b.modelIds ||
      (a.modelIds !== undefined &&
        b.modelIds !== undefined &&
        a.modelIds.length === b.modelIds.length &&
        a.modelIds.every((id, index) => id === b.modelIds?.[index]))) &&
    (a.providerIds === b.providerIds ||
      (a.providerIds !== undefined &&
        b.providerIds !== undefined &&
        a.providerIds.length === b.providerIds.length &&
        a.providerIds.every((id, index) => id === b.providerIds?.[index]))) &&
    a.resetsAt === b.resetsAt &&
    a.windowDurationMins === b.windowDurationMins &&
    // fork: Rich metadata can change even when the usage percentage does not.
    a.usedAmount === b.usedAmount &&
    a.limitAmount === b.limitAmount &&
    a.remainingAmount === b.remainingAmount &&
    a.unit === b.unit &&
    a.category === b.category &&
    a.scopeLabel === b.scopeLabel
  );
}

function mergeCompatibleWindowMetadata(
  newer: ServerProviderUsageWindow,
  fallback: ServerProviderUsageWindow | undefined,
  options?: { readonly allowAmountsOnPercentDelta?: boolean },
): ServerProviderUsageWindow {
  if (!fallback) return newer;
  const durationCompatible =
    newer.windowDurationMins === undefined ||
    fallback.windowDurationMins === undefined ||
    newer.windowDurationMins === fallback.windowDurationMins;
  // fork: Codex reuses `primary` across 5-hour and monthly plans; reject clock/quantity carryover
  // when window kind or duration disagree.
  const clockCompatible = newer.kind === fallback.kind && durationCompatible;
  if (!clockCompatible) return newer;

  const newerHasAmounts =
    newer.usedAmount !== undefined ||
    newer.limitAmount !== undefined ||
    newer.remainingAmount !== undefined;
  // Never stitch a currency/unit from one partial report onto unitless amounts from another.
  const unitBundleCompatible =
    newer.unit === fallback.unit ||
    (newer.unit === undefined && fallback.unit !== undefined && !newerHasAmounts);
  const limitCompatible =
    newer.limitAmount === undefined ||
    fallback.limitAmount === undefined ||
    newer.limitAmount === fallback.limitAmount;
  const scopeCompatible =
    newer.scopeLabel === undefined ||
    fallback.scopeLabel === undefined ||
    newer.scopeLabel === fallback.scopeLabel;
  const categoryCompatible =
    newer.category === undefined ||
    fallback.category === undefined ||
    newer.category === fallback.category;
  const quantityCompatible =
    unitBundleCompatible && limitCompatible && scopeCompatible && categoryCompatible;
  const inheritAmounts =
    quantityCompatible &&
    (options?.allowAmountsOnPercentDelta === true || newer.usedPercent === fallback.usedPercent);
  return {
    ...newer,
    ...(newer.resetsAt === undefined && fallback.resetsAt !== undefined
      ? { resetsAt: fallback.resetsAt }
      : {}),
    ...(newer.windowDurationMins === undefined && fallback.windowDurationMins !== undefined
      ? { windowDurationMins: fallback.windowDurationMins }
      : {}),
    ...(newer.category === undefined && fallback.category !== undefined
      ? { category: fallback.category }
      : {}),
    ...(newer.scopeLabel === undefined && fallback.scopeLabel !== undefined
      ? { scopeLabel: fallback.scopeLabel }
      : {}),
    ...(quantityCompatible && newer.limitAmount === undefined && fallback.limitAmount !== undefined
      ? { limitAmount: fallback.limitAmount }
      : {}),
    ...(quantityCompatible && newer.unit === undefined && fallback.unit !== undefined
      ? { unit: fallback.unit }
      : {}),
    ...(inheritAmounts && newer.usedAmount === undefined && fallback.usedAmount !== undefined
      ? { usedAmount: fallback.usedAmount }
      : {}),
    ...(inheritAmounts &&
    newer.remainingAmount === undefined &&
    fallback.remainingAmount !== undefined
      ? { remainingAmount: fallback.remainingAmount }
      : {}),
  };
}

export function resolveUsageLimitsAfterProbe(input: {
  readonly published: ServerProviderUsageLimits | undefined;
  readonly probed: ServerProviderUsageLimits | undefined;
}): ServerProviderUsageLimits | undefined {
  const { published, probed } = input;
  if (probed?.unavailable?.reason === "probeFailed" && published && !published.unavailable) {
    return published;
  }
  if (
    published &&
    probed &&
    !published.unavailable &&
    !probed.unavailable &&
    Date.parse(published.checkedAt) > Date.parse(probed.checkedAt)
  ) {
    const probedById = new Map(probed.windows.map((window) => [window.id, window] as const));
    return {
      ...probed,
      // fork: Newer streamed account metadata (including explicit clears like `balances: []`) wins;
      // only omitted fields fall back to the older probe.
      ...(published.subscriptionExpiresAt !== undefined
        ? { subscriptionExpiresAt: published.subscriptionExpiresAt }
        : {}),
      ...(published.planTier !== undefined ? { planTier: published.planTier } : {}),
      ...(published.balances !== undefined ? { balances: published.balances } : {}),
      ...(published.serviceNotice !== undefined ? { serviceNotice: published.serviceNotice } : {}),
      checkedAt: published.checkedAt,
      windows: published.windows.map((window) =>
        mergeCompatibleWindowMetadata(window, probedById.get(window.id)),
      ),
    };
  }
  return probed;
}
