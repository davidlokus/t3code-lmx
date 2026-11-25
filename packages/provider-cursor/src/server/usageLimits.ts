import type { ServerProviderUsageWindow } from "@t3tools/contracts";
import type { CursorSettings } from "../settings.ts";
import { CURSOR_USAGE_WINDOWS } from "@t3tools/shared/usageLimits";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import {
  clampPercent,
  makeUnavailableUsageLimits,
  makeUsageLimits,
} from "@t3tools/provider-core/server/usageLimits";
import { DEFAULT_CURSOR_API_ENDPOINT, exchangeCursorApiKey } from "./apiKey.ts";

const OptionalNullableNumber = Schema.optional(Schema.NullOr(Schema.Number));
const OptionalNullableString = Schema.optional(Schema.NullOr(Schema.String));

const CursorUsageResponse = Schema.Struct({
  billingCycleStart: Schema.optional(Schema.NullOr(Schema.Union([Schema.String, Schema.Number]))),
  billingCycleEnd: Schema.optional(Schema.NullOr(Schema.Union([Schema.String, Schema.Number]))),
  membershipType: OptionalNullableString,
  planUsage: Schema.optional(
    Schema.NullOr(
      Schema.Struct({
        totalPercentUsed: OptionalNullableNumber,
        autoPercentUsed: OptionalNullableNumber,
        apiPercentUsed: OptionalNullableNumber,
        limit: OptionalNullableNumber,
        totalSpend: OptionalNullableNumber,
        remaining: OptionalNullableNumber,
        autoSpend: OptionalNullableNumber,
        apiSpend: OptionalNullableNumber,
        bonusSpend: OptionalNullableNumber,
      }),
    ),
  ),
  spendLimitUsage: Schema.optional(
    Schema.NullOr(
      Schema.Struct({
        enabled: Schema.optional(Schema.NullOr(Schema.Boolean)),
        limitType: OptionalNullableString,
        individualLimit: OptionalNullableNumber,
        individualUsed: OptionalNullableNumber,
        individualRemaining: OptionalNullableNumber,
        pooledLimit: OptionalNullableNumber,
        pooledUsed: OptionalNullableNumber,
        pooledRemaining: OptionalNullableNumber,
      }),
    ),
  ),
});

const PLAN_TIERS: Record<string, string> = {
  pro: "Pro",
  pro_plus: "Pro+",
  ultra: "Ultra",
  team: "Team",
  enterprise: "Enterprise",
};

function nonNegativeCents(cents: number | null | undefined) {
  return typeof cents === "number" && Number.isFinite(cents) && cents >= 0 ? cents : undefined;
}

function usdAmounts(
  limit: number,
  usedCents: number | null | undefined,
  remainingCents: number | null | undefined,
) {
  const used = nonNegativeCents(usedCents);
  const remaining = nonNegativeCents(remainingCents);
  const usedAmount = used ?? (remaining === undefined ? undefined : Math.max(0, limit - remaining));
  const remainingAmount = remaining ?? (used === undefined ? undefined : Math.max(0, limit - used));
  return {
    limitAmount: limit / 100,
    ...(usedAmount === undefined ? {} : { usedAmount: usedAmount / 100 }),
    ...(remainingAmount === undefined ? {} : { remainingAmount: remainingAmount / 100 }),
    unit: "USD",
  };
}

/** Cursor's dashboard percentages include bonus usage; spend / limit does not. */
export function cursorUsageResponseToLimits(
  response: typeof CursorUsageResponse.Type,
  checkedAt: string,
) {
  const cycleEnd = Number(response.billingCycleEnd);
  const reset = DateTime.make(cycleEnd);
  const resetsAt =
    cycleEnd > 0 && Option.isSome(reset) ? DateTime.formatIso(reset.value) : undefined;
  const cycleStart = Number(response.billingCycleStart);
  const windowDurationMins =
    resetsAt && cycleStart > 0 ? Math.round((cycleEnd - cycleStart) / 60_000) : 0;
  const timing = {
    ...(resetsAt ? { resetsAt } : {}),
    ...(windowDurationMins > 0 ? { windowDurationMins } : {}),
  };
  const windows: ServerProviderUsageWindow[] = [];
  const { planUsage, spendLimitUsage } = response;
  if (planUsage) {
    const planLimit = nonNegativeCents(planUsage.limit);
    for (const { id, label } of CURSOR_USAGE_WINDOWS) {
      const usedPercent = planUsage[id];
      if (typeof usedPercent !== "number" || !Number.isFinite(usedPercent)) continue;
      const amounts =
        id === "totalPercentUsed" && planLimit
          ? usdAmounts(planLimit, planUsage.totalSpend, planUsage.remaining)
          : undefined;
      windows.push({
        id,
        kind: "monthly",
        label,
        category: "plan",
        ...(id === "totalPercentUsed" ? {} : { scopeLabel: label }),
        usedPercent: clampPercent(usedPercent),
        ...timing,
        ...(amounts?.usedAmount === undefined ? {} : amounts),
      });
    }
  }
  if (spendLimitUsage && spendLimitUsage.enabled !== false) {
    const individualLimit = nonNegativeCents(spendLimitUsage.individualLimit);
    const usePooled =
      !individualLimit && spendLimitUsage.limitType?.trim().toLowerCase() !== "individual";
    const limit =
      individualLimit || (usePooled ? nonNegativeCents(spendLimitUsage.pooledLimit) : undefined);
    if (limit) {
      const amounts = usdAmounts(
        limit,
        individualLimit ? spendLimitUsage.individualUsed : spendLimitUsage.pooledUsed,
        individualLimit ? spendLimitUsage.individualRemaining : spendLimitUsage.pooledRemaining,
      );
      if (amounts.usedAmount !== undefined) {
        const usedPercent = clampPercent((amounts.usedAmount / amounts.limitAmount) * 100);
        windows.push({
          id: "on_demand",
          kind: "monthly",
          label: individualLimit ? "On-demand" : "Team spend",
          category: "overage",
          usedPercent,
          ...amounts,
          ...timing,
        });
      }
    }
  }
  if (windows.length === 0) {
    return makeUnavailableUsageLimits({ checkedAt, reason: "unsupported" });
  }
  const membership = response.membershipType?.trim() || undefined;
  const tierKey = membership?.toLowerCase();
  return makeUsageLimits({
    checkedAt,
    windows,
    planTier: tierKey && Object.hasOwn(PLAN_TIERS, tierKey) ? PLAN_TIERS[tierKey] : membership,
    subscriptionExpiresAt:
      windowDurationMins === 0 || windowDurationMins >= 28 * 24 * 60 ? resetsAt : undefined,
  });
}

export const readCursorUsageLimits = Effect.fn("readCursorUsageLimits")(function* (
  settings: Pick<CursorSettings, "apiEndpoint">,
  environment: NodeJS.ProcessEnv = process.env,
) {
  const checkedAt = DateTime.formatIso(yield* DateTime.now);
  return yield* Effect.gen(function* () {
    const endpoint = (
      settings.apiEndpoint?.trim() ||
      environment.CURSOR_API_ENDPOINT?.trim() ||
      DEFAULT_CURSOR_API_ENDPOINT
    ).replace(/\/$/, "");
    let token = environment.CURSOR_AUTH_TOKEN?.trim();
    const apiKey = environment.CURSOR_API_KEY?.trim();
    if (!token && apiKey) {
      if (endpoint !== DEFAULT_CURSOR_API_ENDPOINT) {
        return makeUnavailableUsageLimits({
          checkedAt,
          reason: "unsupported",
          message: "Cursor usage for an API key requires the default Cursor endpoint.",
        });
      }
      token = yield* exchangeCursorApiKey(apiKey);
    }
    if (!token) return makeUnavailableUsageLimits({ checkedAt, reason: "unsupported" });
    const client = yield* HttpClient.HttpClient;
    const response = yield* client.execute(
      HttpClientRequest.post(`${endpoint}/aiserver.v1.DashboardService/GetCurrentPeriodUsage`).pipe(
        HttpClientRequest.bearerToken(token),
        HttpClientRequest.setHeaders({
          "connect-protocol-version": "1",
          "x-cursor-client-type": "cli",
        }),
        HttpClientRequest.bodyJsonUnsafe({}),
      ),
    );
    const body = yield* HttpClientResponse.schemaBodyJson(CursorUsageResponse)(
      yield* HttpClientResponse.filterStatusOk(response),
    );
    return cursorUsageResponseToLimits(body, checkedAt);
  }).pipe(
    Effect.timeout("10 seconds"),
    Effect.orElseSucceed(() =>
      makeUnavailableUsageLimits({
        checkedAt,
        reason: "probeFailed",
        message: "Cursor could not read usage limits.",
      }),
    ),
  );
});
