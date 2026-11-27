import * as Schema from "effect/Schema";
import * as Struct from "effect/Struct";

import {
  ForwardCompatibleArray,
  IsoDateTime,
  NonNegativeInt,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";
import { ProviderDriverKind, ProviderInstanceId } from "./providerInstance.ts";
import { UsageLimitSourceId } from "./usageLimitSourceId.ts";

/** Stable per-provider ids let sparse updates merge with full probes. */
export const ServerProviderUsageWindow = Schema.Struct({
  id: TrimmedNonEmptyString,
  kind: Schema.Literals(["session", "weekly", "monthly", "other"]),
  label: TrimmedNonEmptyString,
  /** When present, this limit applies only to these provider model IDs. */
  modelIds: Schema.optional(Schema.Array(TrimmedNonEmptyString)),
  providerIds: Schema.optional(Schema.Array(TrimmedNonEmptyString)),
  usedPercent: Schema.Number.check(Schema.isBetween({ minimum: 0, maximum: 100 })),
  resetsAt: Schema.optional(IsoDateTime),
  windowDurationMins: Schema.optional(NonNegativeInt),
  // fork: A window may expose absolute quota amounts as well as percentages.
  usedAmount: Schema.optional(Schema.Finite),
  limitAmount: Schema.optional(Schema.Finite),
  remainingAmount: Schema.optional(Schema.Finite),
  unit: Schema.optional(TrimmedNonEmptyString),
  category: Schema.optional(Schema.Literals(["plan", "balance", "overage", "bonus"])),
  scopeLabel: Schema.optional(TrimmedNonEmptyString),
});
export type ServerProviderUsageWindow = typeof ServerProviderUsageWindow.Type;

/** One kind of banked reset, such as Claude's weekly reset or its Fable-only reset. */
export const ServerProviderResetCreditOption = Schema.Struct({
  creditId: TrimmedNonEmptyString,
  label: TrimmedNonEmptyString,
  description: TrimmedNonEmptyString,
  availableCount: NonNegativeInt,
  expiresAt: Schema.optional(IsoDateTime),
});
export type ServerProviderResetCreditOption = typeof ServerProviderResetCreditOption.Type;

export const ServerProviderResetCredits = Schema.Struct({
  availableCount: NonNegativeInt,
  nextExpiresAt: Schema.optional(IsoDateTime),
  /** Pins hub redemption to the displayed credit, including retries from another client. */
  nextCreditId: Schema.optional(TrimmedNonEmptyString),
  /** Present when resets differ in what they refill; redeem one by its `creditId`. */
  options: Schema.optional(ForwardCompatibleArray(ServerProviderResetCreditOption)),
});
export type ServerProviderResetCredits = typeof ServerProviderResetCredits.Type;

// fork: Balances can expire independently of quota windows and the subscription.
export const ServerProviderUsageBalance = Schema.Struct({
  id: TrimmedNonEmptyString,
  label: TrimmedNonEmptyString,
  remaining: Schema.Finite,
  limit: Schema.optional(Schema.Finite),
  used: Schema.optional(Schema.Finite),
  unit: TrimmedNonEmptyString,
  expiresAt: Schema.optional(IsoDateTime),
  kind: Schema.optional(TrimmedNonEmptyString),
});
export type ServerProviderUsageBalance = typeof ServerProviderUsageBalance.Type;

const usageLimitAccountMetadata = {
  subscriptionExpiresAt: Schema.optional(IsoDateTime),
  planTier: Schema.optional(TrimmedNonEmptyString),
  balances: Schema.optional(Schema.Array(ServerProviderUsageBalance)),
  serviceNotice: Schema.optional(
    Schema.Struct({
      message: TrimmedNonEmptyString,
      severity: Schema.optional(Schema.Literals(["critical", "warning", "info"])),
    }),
  ),
};

/** Clear bars for unavailable accounts; retain last good bars after a failed probe. */
export const ServerProviderUsageLimits = Schema.Struct({
  checkedAt: IsoDateTime,
  windows: ForwardCompatibleArray(ServerProviderUsageWindow),
  /** A $0 monthly spend cap has no percentage, so it cannot be a window. */
  zeroSpendCap: Schema.optional(Schema.Boolean),
  credentialFingerprint: Schema.optional(TrimmedNonEmptyString),
  resetCredits: Schema.optional(ServerProviderResetCredits),
  externalUsage: Schema.optional(
    Schema.Struct({
      label: TrimmedNonEmptyString,
      url: TrimmedNonEmptyString,
    }),
  ),
  unavailable: Schema.optional(
    Schema.Struct({
      reason: Schema.Literals(["unsupported", "probeFailed"]),
      message: Schema.optional(TrimmedNonEmptyString),
    }),
  ),
  // fork: Older probes may omit all subscription metadata.
  ...usageLimitAccountMetadata,
});
export type ServerProviderUsageLimits = typeof ServerProviderUsageLimits.Type;

/** Partial updates merge windows by id; omitted windows remain unchanged. */
export const ProviderUsageLimitsUpdate = Schema.Struct({
  windows: Schema.Array(ServerProviderUsageWindow),
  // fork: Omitted account metadata is inherited from the previous snapshot.
  ...usageLimitAccountMetadata,
});
export type ProviderUsageLimitsUpdate = typeof ProviderUsageLimitsUpdate.Type;

export const UsageLimitSourceAccount = Schema.Struct({
  id: TrimmedNonEmptyString,
  driver: ProviderDriverKind,
  email: Schema.optional(TrimmedNonEmptyString),
  plan: Schema.optional(TrimmedNonEmptyString),
  workspaceId: Schema.optional(TrimmedNonEmptyString),
  /** The models the hub routes to this account. */
  models: Schema.optional(Schema.Array(TrimmedNonEmptyString)),
  usageLimits: ServerProviderUsageLimits,
});
export type UsageLimitSourceAccount = typeof UsageLimitSourceAccount.Type;

export const HttpQuotaAccount = Schema.Struct({
  id: TrimmedNonEmptyString,
  label: TrimmedNonEmptyString,
  providerInstanceId: Schema.optional(ProviderInstanceId),
  windows: Schema.Array(
    ServerProviderUsageWindow.mapFields(Struct.omit(["modelIds", "providerIds"])),
  ),
  ...usageLimitAccountMetadata,
});
export type HttpQuotaAccount = typeof HttpQuotaAccount.Type;

export const HttpQuotaResponse = Schema.Struct({
  version: Schema.Literal(1),
  accounts: Schema.Array(HttpQuotaAccount),
});

export const UsageLimitSourceKind = Schema.Literals([
  "cliproxy",
  "http",
  "omp",
  "kimi",
  "zai",
  // fork: Wave 3 external quota source kinds (OpenRouter, GitHub Copilot, Ollama Cloud, OpenAI API)
  "openrouter",
  "copilot",
  "ollama",
  "openaiApi",
]);
export type UsageLimitSourceKind = typeof UsageLimitSourceKind.Type;

// fork: Virtual read-only snapshot kinds (e.g. opt-in local claude-swap cache) stay forward-compatible
// via UsageLimitSourceSnapshots without expanding configurable ServerSettings.usageLimitSources kinds.
export const UsageLimitSourceSnapshotKind = Schema.Literals([
  ...UsageLimitSourceKind.literals,
  "claudeSwap",
]);
export type UsageLimitSourceSnapshotKind = typeof UsageLimitSourceSnapshotKind.Type;

export const UsageLimitSourceSnapshot = Schema.Struct({
  id: UsageLimitSourceId,
  kind: UsageLimitSourceSnapshotKind,
  label: TrimmedNonEmptyString,
  /** Origin of the hub, which also serves the agents sent through it. */
  origin: Schema.optional(TrimmedNonEmptyString),
  /** Origin and base path of the hub, which tell apart hubs served from one origin. */
  endpoint: Schema.optional(TrimmedNonEmptyString),
  checkedAt: IsoDateTime,
  accounts: ForwardCompatibleArray(UsageLimitSourceAccount),
  quotaAccounts: Schema.optional(ForwardCompatibleArray(HttpQuotaAccount)),
  /** Hub provider names of enabled accounts that T3 Code cannot read. */
  unreadProviders: Schema.optional(Schema.Array(TrimmedNonEmptyString)),
  error: Schema.optional(TrimmedNonEmptyString),
});
export type UsageLimitSourceSnapshot = typeof UsageLimitSourceSnapshot.Type;

export const UsageLimitSourceSnapshots = ForwardCompatibleArray(UsageLimitSourceSnapshot);
export type UsageLimitSourceSnapshots = typeof UsageLimitSourceSnapshots.Type;

export const UsageLimitSourceConsumeResetCreditInput = Schema.Struct({
  sourceId: UsageLimitSourceId,
  accountId: TrimmedNonEmptyString,
  creditId: TrimmedNonEmptyString,
});
export type UsageLimitSourceConsumeResetCreditInput =
  typeof UsageLimitSourceConsumeResetCreditInput.Type;

export const ProviderConsumeResetCreditInput = Schema.Union([
  Schema.Struct({
    instanceId: ProviderInstanceId,
    creditId: Schema.optional(TrimmedNonEmptyString),
  }),
  UsageLimitSourceConsumeResetCreditInput,
]);
export type ProviderConsumeResetCreditInput = typeof ProviderConsumeResetCreditInput.Type;

export class UsageLimitSourceError extends Schema.TaggedError<UsageLimitSourceError>()(
  "UsageLimitSourceError",
  { detail: Schema.String },
) {
  override get message(): string {
    return this.detail;
  }
}

export const ProviderConsumeResetCreditOutcome = Schema.Literals([
  "reset",
  "nothingToReset",
  "noCredit",
  "alreadyRedeemed",
]);
export type ProviderConsumeResetCreditOutcome = typeof ProviderConsumeResetCreditOutcome.Type;

export const ProviderConsumeResetCreditResult = Schema.Struct({
  outcome: ProviderConsumeResetCreditOutcome,
  warning: Schema.optional(TrimmedNonEmptyString),
});
export type ProviderConsumeResetCreditResult = typeof ProviderConsumeResetCreditResult.Type;

export const UsageLimitsReport = Schema.Struct({
  createdAt: IsoDateTime,
  accounts: Schema.Array(
    Schema.Struct({
      id: TrimmedNonEmptyString,
      driver: ProviderDriverKind,
      label: TrimmedNonEmptyString,
      plan: Schema.optional(TrimmedNonEmptyString),
      email: Schema.optional(TrimmedNonEmptyString),
      sourceLabel: Schema.optional(TrimmedNonEmptyString),
      instanceId: Schema.optional(ProviderInstanceId),
      resetCreditInput: Schema.optional(ProviderConsumeResetCreditInput),
      displayName: Schema.optional(Schema.String),
      accentColor: Schema.optional(Schema.String),
      limits: ServerProviderUsageLimits,
    }),
  ),
  notices: Schema.Array(Schema.String),
});
export type UsageLimitsReport = typeof UsageLimitsReport.Type;
