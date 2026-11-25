import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { kimiUsageEndpoint, readKimiUsage } from "./kimi.ts";

const endpoint = kimiUsageEndpoint(undefined);
const key = "kimi-test-key";

function readPayload(body: unknown) {
  return readKimiUsage(endpoint, key, () => Effect.succeed({ status: 200, body }));
}

it.effect("uses the selected Kimi host and API key header", () =>
  Effect.gen(function* () {
    expect(endpoint).toBe("https://api.kimi.com/coding/v1/usages");
    expect(kimiUsageEndpoint("cn")).toBe(endpoint);
    const globalEndpoint = kimiUsageEndpoint("global");
    expect(globalEndpoint).toBe("https://api.kimi.ai/coding/v1/usages");
    const result = yield* readKimiUsage(globalEndpoint, key, (url, headers) => {
      expect(url).toBe(globalEndpoint);
      expect(headers).toEqual({ "x-api-key": key });
      return Effect.succeed({
        status: 200,
        body: { usages: { limit_5h: { used_ratio: 0.2 } } },
      });
    });
    expect(result.error).toBeUndefined();
  }),
);

it.effect("publishes all modern quotas, separate monthly pools and the USD booster balance", () =>
  Effect.gen(function* () {
    const result = yield* readPayload({
      data: {
        quota: {
          usages: {
            limit_5h: { used_ratio: 0.4929, reset_time: "2026-10-17T19:25:50Z" },
            limit_7d: { used_ratio: 0.25, reset_time: "2026-10-21T01:00:00Z" },
            limit_month_total: { used_ratio: 0.875, reset_time: "2026-10-21T00:00:00Z" },
            limit_month_code: { used_ratio: 0.75, reset_time: "2026-10-21T08:00:00+08:00" },
          },
          limits: [
            {
              window: { duration: 300, timeUnit: "TIME_UNIT_MINUTE" },
              detail: { limit: "100", used: "49" },
            },
          ],
          booster_wallet: { balance: { amount: "125000000", amountLeft: "75000000" } },
          user: { membership: { level: "LEVEL_ADVANCED" } },
        },
      },
    });
    expect(result.accounts).toEqual([]);
    expect(result.error).toBeUndefined();
    expect(result.quotaAccounts).toHaveLength(1);
    const account = result.quotaAccounts?.[0];
    expect(account).toMatchObject({
      id: "kimi-code",
      label: "Kimi Code",
      planTier: "Advanced",
      balances: [
        { id: "kimi-booster", label: "Booster", remaining: 0.75, unit: "USD", kind: "balance" },
      ],
    });
    expect(account?.windows).toEqual([
      {
        id: "session",
        kind: "session",
        label: "Session",
        category: "plan",
        usedPercent: expect.closeTo(49.29),
        resetsAt: "2026-10-17T19:25:50.000Z",
        windowDurationMins: 300,
      },
      {
        id: "weekly",
        kind: "weekly",
        label: "Weekly",
        category: "plan",
        usedPercent: 25,
        resetsAt: "2026-10-21T01:00:00.000Z",
        windowDurationMins: 10_080,
      },
      {
        id: "monthly_total",
        kind: "monthly",
        label: "Monthly Total",
        category: "plan",
        usedPercent: 87.5,
        resetsAt: "2026-10-21T00:00:00.000Z",
      },
      {
        id: "monthly_coding",
        kind: "monthly",
        label: "Monthly Coding",
        category: "plan",
        usedPercent: 75,
        resetsAt: "2026-10-21T00:00:00.000Z",
      },
    ]);
  }),
);

it.effect("prefers nonzero legacy counters over stale summary zeros", () =>
  Effect.gen(function* () {
    const sessionReset = "2026-10-18T01:00:00.000Z";
    const weeklyReset = "2026-10-21T01:00:00.000Z";
    const result = yield* readPayload({
      usages: { limit_5h: { used_ratio: 0 }, limit_7d: { used_ratio: 0 } },
      usage: { used: 18, limit: "40", resetTime: Date.parse(weeklyReset) },
      limits: [
        { window: { duration: 24, timeUnit: "TIME_UNIT_HOUR" }, detail: { used: 99, limit: 100 } },
        {
          window: { duration: "5", timeUnit: "TIME_UNIT_HOUR" },
          detail: { used: "3", limit: "40", reset_at: Date.parse(sessionReset) / 1_000 },
        },
      ],
    });
    expect(result.quotaAccounts?.[0]?.windows).toMatchObject([
      { id: "session", usedPercent: 7.5, windowDurationMins: 300, resetsAt: sessionReset },
      { id: "weekly", usedPercent: 45, windowDurationMins: 10_080, resetsAt: weeklyReset },
    ]);
  }),
);

it.effect("accepts camel-case ratios and falls back to a fresh legacy counter", () =>
  Effect.gen(function* () {
    const result = yield* readPayload({
      usages: {
        limit5h: { usedRatio: 2 },
        limit7d: { usedRatio: 0, resetAt: "2026-10-21T01:00:00Z" },
        limit_month_total: { used_ratio: -1 },
        limit_month_code: { reset_time: "2026-10-21T01:00:00Z" },
      },
      limits: [
        {
          window: { duration: 300, timeUnit: "TIME_UNIT_MINUTE" },
          detail: { limit: "100", remaining: "100", resetTime: "2026-10-18T01:00:00.123456Z" },
        },
      ],
      boosterWallet: { balance: { amountLeft: 0 } },
    });
    const account = result.quotaAccounts?.[0];
    expect(account?.windows).toMatchObject([
      { id: "session", usedPercent: 0, resetsAt: "2026-10-18T01:00:00.123Z" },
      { id: "weekly", usedPercent: 0, resetsAt: "2026-10-21T01:00:00.000Z" },
    ]);
    expect(account?.balances?.[0]?.remaining).toBe(0);
  }),
);

it.effect(
  "derives usage from remaining when used is absent and keeps compatible summary resets",
  () =>
    Effect.gen(function* () {
      const sessionReset = "2026-10-18T01:00:00.000Z";
      const result = yield* readPayload({
        usages: {
          limit_5h: { used_ratio: 0, reset_time: sessionReset },
          limit_7d: { used_ratio: 0, reset_time: "2026-10-21T01:00:00Z" },
        },
        // Legacy session counter omits `reset_time`, so fallback keeps the compatible summary reset.
        limits: [
          {
            window: { duration: 300, timeUnit: "TIME_UNIT_MINUTE" },
            detail: { limit: "100", used: "40" },
          },
        ],
        // Legacy weekly counter omits `used` and reports only `limit` + `remaining`.
        usage: { limit: "100", remaining: "20" },
      });
      expect(result.quotaAccounts?.[0]?.windows).toMatchObject([
        { id: "session", usedPercent: 40, windowDurationMins: 300, resetsAt: sessionReset },
        {
          id: "weekly",
          usedPercent: 80,
          windowDurationMins: 10_080,
          resetsAt: "2026-10-21T01:00:00.000Z",
        },
      ]);

      // Negative remaining without explicit `used` must not fabricate 0%.
      const invalidRemaining = yield* readPayload({
        usage: { limit: "100", remaining: "-5" },
      });
      expect(invalidRemaining).toEqual({
        accounts: [],
        error: "Kimi Code returned no usable quota data.",
      });
    }),
);

it.effect("keeps a wallet-only account without inventing quota windows", () =>
  Effect.gen(function* () {
    const result = yield* readPayload({ booster_wallet: { balance: { amountLeft: 100_000_000 } } });
    expect(result.error).toBeUndefined();
    expect(result.quotaAccounts?.[0]).toMatchObject({ windows: [], balances: [{ remaining: 1 }] });
  }),
);

it.effect("reports sanitized failures instead of publishing empty quota accounts", () =>
  Effect.gen(function* () {
    const privateData = `untrusted detail containing ${key}`;
    for (const [status, error] of [
      [401, "Kimi Code rejected the API key (HTTP 401)."],
      [403, "Kimi Code rejected the API key (HTTP 403)."],
      [503, "Kimi Code usage request failed (HTTP 503)."],
    ] as const) {
      const result = yield* readKimiUsage(endpoint, key, () =>
        Effect.succeed({ status, body: { error: privateData } }),
      );
      expect(result).toEqual({ accounts: [], error });
    }
    const transport = yield* readKimiUsage(endpoint, key, () => Effect.undefined);
    expect(transport).toEqual({ accounts: [], error: "Could not read Kimi Code usage." });
    const malformed = yield* readPayload({
      message: privateData,
      usage: { used: "0", limit: "0" },
      booster_wallet: { status: "STATUS_DISABLED", balance: { type: "BOOSTER" } },
    });
    expect(malformed).toEqual({ accounts: [], error: "Kimi Code returned no usable quota data." });
  }),
);
