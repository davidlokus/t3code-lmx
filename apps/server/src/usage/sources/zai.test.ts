import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import type { ReadQuotaJson } from "../UsageLimitSources.ts";
import { readZaiUsage, zaiUsageOrigin } from "./zai.ts";

const key = "fixture-private-key";
const quotaPath = "/api/monitor/usage/quota/limit";
const subscriptionPath = "/api/biz/subscription/list";
const globalOrigin = "https://api.z.ai";
const cnOrigin = "https://open.bigmodel.cn";

const ok =
  (body: unknown): ReadQuotaJson =>
  () =>
    Effect.succeed({ status: 200, body });
const httpError =
  (status: number): ReadQuotaJson =>
  () =>
    Effect.succeed({ status });
const transportFailure: ReadQuotaJson = () => Effect.undefined;
const routingReader =
  (
    origin: string,
    quota: ReadQuotaJson,
    subscription: ReadQuotaJson = httpError(404),
  ): ReadQuotaJson =>
  (url, headers) => {
    expect(headers).toEqual({ Authorization: `Bearer ${key}` });
    if (url === `${origin}${quotaPath}`) return quota(url, headers);
    if (url === `${origin}${subscriptionPath}`) return subscription(url, headers);
    return Effect.die("Unexpected Z.ai request");
  };

const legacyQuota = {
  code: 200,
  success: true,
  data: {
    limits: [
      { type: "TOKENS_LIMIT", unit: 3, number: 5, percentage: 17 },
      {
        type: "TOKENS_LIMIT",
        unit: 6,
        number: 1,
        percentage: 3,
        nextResetTime: Date.UTC(2026, 6, 6, 4, 30),
      },
      {
        type: "TIME_LIMIT",
        unit: 5,
        number: 1,
        usage: 1_000,
        currentValue: 125,
        percentage: 99,
        nextResetTime: Date.UTC(2026, 6, 29),
      },
    ],
  },
};

it.effect("maps legacy quota and the active global subscription", () =>
  Effect.gen(function* () {
    expect(zaiUsageOrigin("global")).toBe(globalOrigin);
    const subscription = {
      code: 200,
      success: true,
      data: [
        { productName: "Cancelled", status: "CANCELLED", inCurrentPeriod: true },
        { productName: "Other valid plan", status: "VALID" },
        {
          productName: " GLM Coding Pro ",
          status: "valid",
          inCurrentPeriod: true,
          nextRenewTime: " 2026-07-29 ",
        },
      ],
    };
    const snapshot = yield* readZaiUsage(
      zaiUsageOrigin(undefined),
      key,
      routingReader(globalOrigin, ok(legacyQuota), ok(subscription)),
    );
    expect(snapshot).toStrictEqual({
      accounts: [],
      quotaAccounts: [
        {
          id: "zai",
          label: "Z.ai / BigModel",
          planTier: "GLM Coding Pro",
          subscriptionExpiresAt: "2026-07-29",
          windows: [
            {
              id: "session_tokens_300",
              kind: "session",
              label: "Session",
              usedPercent: 17,
              windowDurationMins: 300,
              category: "plan",
            },
            {
              id: "weekly_tokens_10080",
              kind: "weekly",
              label: "Weekly",
              usedPercent: 3,
              windowDurationMins: 10_080,
              resetsAt: "2026-07-06T04:30:00.000Z",
              category: "plan",
            },
            {
              id: "web_searches",
              kind: "monthly",
              label: "Web Searches",
              usedPercent: 12.5,
              usedAmount: 125,
              limitAmount: 1_000,
              remainingAmount: 875,
              unit: "searches",
              category: "plan",
              windowDurationMins: 43_200,
              resetsAt: "2026-07-29T00:00:00.000Z",
            },
          ],
        },
      ],
    });
  }),
);

it.effect("maps CN credit amounts and uses the calendar date from a timezone-less renewal", () =>
  Effect.gen(function* () {
    const quota = {
      limits: [
        { name: "CREDIT_LIMIT", unit: 3, number: 5, usage: 2_000, currentValue: 0, percentage: 0 },
        {
          type: "CREDIT_LIMIT",
          unit: 4,
          number: 7,
          usage: "10000",
          currentValue: "9855",
          percentage: 98,
          nextResetTime: 1e20,
        },
        { type: "CREDIT_LIMIT", unit: 5, number: 1, usage: 10, currentValue: 15, percentage: 150 },
        { name: "TIME_LIMIT", usage: 0, currentValue: 0 },
        { type: "TOKENS_LIMIT", unit: 3, number: 5, percentage: false },
        { type: "CREDIT_LIMIT", unit: 99, number: 1, percentage: 3 },
        { type: "FUTURE_METER", percentage: 99 },
      ],
    };
    const subscription = {
      data: [
        { status: "expired", inCurrentPeriod: true, productName: "Expired" },
        {
          status: "VALID",
          productName: "GLM Coding Lite",
          nextRenewTime: "2026-12-31 23:58:00",
        },
        { status: "VALID", productName: "Other valid plan" },
      ],
    };
    const snapshot = yield* readZaiUsage(
      zaiUsageOrigin("cn"),
      key,
      routingReader(cnOrigin, ok(quota), ok(subscription)),
    );
    const account = snapshot.quotaAccounts?.[0];
    expect(snapshot.error).toBeUndefined();
    expect(account).toMatchObject({
      planTier: "GLM Coding Lite",
      subscriptionExpiresAt: "2026-12-31",
      windows: [
        {
          id: "session_credit_300",
          usedPercent: 0,
          usedAmount: 0,
          limitAmount: 2_000,
          remainingAmount: 2_000,
          unit: "credits",
        },
        {
          id: "weekly_credit_10080",
          kind: "weekly",
          usedPercent: 98,
          usedAmount: 9_855,
          limitAmount: 10_000,
          remainingAmount: 145,
          unit: "credits",
          windowDurationMins: 10_080,
        },
        {
          id: "monthly_credit_43200",
          kind: "monthly",
          usedPercent: 100,
          usedAmount: 15,
          limitAmount: 10,
          remainingAmount: 0,
          unit: "credits",
          windowDurationMins: 43_200,
        },
        { id: "web_searches", usedPercent: 0, usedAmount: 0, limitAmount: 0, remainingAmount: 0 },
      ],
    });
    expect(account?.windows[1]?.resetsAt).toBeUndefined();
  }),
);

it.effect("assigns distinct identities to competing meters of the same cadence", () =>
  Effect.gen(function* () {
    const quota = {
      limits: [
        { type: "TOKENS_LIMIT", unit: 3, number: 5, percentage: 15 },
        { type: "CREDIT_LIMIT", unit: 3, number: 5, percentage: 100 },
        { type: "CREDIT_LIMIT", unit: 3, number: 5, percentage: 55 },
        { type: "CREDIT_LIMIT", unit: 3, number: 3, percentage: 20 },
        { type: "CREDIT_LIMIT", unit: 6, number: 1, percentage: -2 },
      ],
    };
    const snapshot = yield* readZaiUsage(globalOrigin, key, routingReader(globalOrigin, ok(quota)));
    const windows = snapshot.quotaAccounts?.[0]?.windows ?? [];
    expect(windows.map(({ kind, usedPercent }) => [kind, usedPercent])).toEqual([
      ["session", 15],
      ["session", 100],
      ["session", 55],
      ["session", 20],
      ["weekly", 0],
    ]);
    expect(new Set(windows.map(({ id }) => id)).size).toBe(5);
    expect(new Set(windows.map(({ label }) => label)).size).toBe(5);
    // Meter IDs remain invariant whether peers of the same cadence are present or absent.
    expect(windows[0]?.id).toBe("session_tokens_300");
    expect(windows[1]?.id).toBe("session_credit_300");
    expect(windows[2]?.id).toBe("session_credit_300_2");
    expect(windows[3]?.id).toBe("session_credit_180");
    expect(windows[4]?.id).toBe("weekly_credit_10080");
  }),
);

it.effect.each([
  {
    name: "credentials rejected inside an HTTP 200 response",
    quota: ok({ ...legacyQuota, success: false, code: 401, msg: key }),
    error: "Z.ai rejected the API key.",
  },
  {
    name: "no active plan inside an HTTP 200 response",
    quota: ok({ success: false, code: 500, msg: `No GLM CODING PLAN for ${key}` }),
    error: "No active GLM Coding Plan.",
  },
  {
    name: "an unrecognized business error with quota-like data",
    quota: ok({ ...legacyQuota, code: 500, success: false, msg: key }),
    error: "Z.ai rejected the quota request.",
  },
  {
    name: "HTTP forbidden",
    quota: httpError(403),
    error: "Z.ai rejected the API key.",
  },
  {
    name: "rate limiting",
    quota: httpError(429),
    error: "Z.ai quota request failed (HTTP 429).",
  },
  {
    name: "a transport or JSON parsing failure",
    quota: transportFailure,
    error: "Could not read Z.ai usage quota.",
  },
  {
    name: "a malformed quota envelope",
    quota: ok({ data: { limits: { message: key } } }),
    error: "Invalid Z.ai quota response.",
  },
  {
    name: "recognized meters with missing counts or percentages",
    quota: ok({
      limits: [
        { type: "TIME_LIMIT", usage: 1_000 },
        { type: "TOKENS_LIMIT", unit: 3, number: 5, percentage: true },
      ],
    }),
    error: "Invalid Z.ai quota response.",
  },
])("fails without credentials or enrichment on $name", ({ quota, error }) =>
  Effect.gen(function* () {
    const snapshot = yield* readZaiUsage(
      globalOrigin,
      key,
      routingReader(globalOrigin, quota, () => Effect.die("Unexpected subscription read")),
    );
    expect(snapshot).toStrictEqual({ accounts: [], error });
  }),
);

it.effect.each([
  { name: "a transport failure or timeout", subscription: transportFailure },
  { name: "a non-success status", subscription: httpError(404) },
  { name: "a malformed data list", subscription: ok({ data: { message: key } }) },
  {
    name: "a failed business result carrying apparent subscriptions",
    subscription: ok({
      success: false,
      data: [{ status: "VALID", productName: key, nextRenewTime: "2026-12-31" }],
    }),
  },
])("keeps all quota meters when subscription returns $name", ({ subscription }) =>
  Effect.gen(function* () {
    const snapshot = yield* readZaiUsage(
      globalOrigin,
      key,
      routingReader(globalOrigin, ok(legacyQuota), subscription),
    );
    expect(snapshot.error).toBeUndefined();
    const account = snapshot.quotaAccounts?.[0];
    expect(account?.windows.map(({ id }) => id)).toEqual([
      "session_tokens_300",
      "weekly_tokens_10080",
      "web_searches",
    ]);
    expect(account?.planTier).toBeUndefined();
    expect(account?.subscriptionExpiresAt).toBeUndefined();
  }),
);

it.effect.each([
  { name: "no limits", limits: [] },
  { name: "only future quota types", limits: [{ type: "FUTURE_METER" }] },
])("does not fabricate usage when Z.ai reports $name", ({ limits }) =>
  Effect.gen(function* () {
    const snapshot = yield* readZaiUsage(
      globalOrigin,
      key,
      routingReader(globalOrigin, ok({ data: { limits } })),
    );
    expect(snapshot).toStrictEqual({ accounts: [], quotaAccounts: [] });
  }),
);
