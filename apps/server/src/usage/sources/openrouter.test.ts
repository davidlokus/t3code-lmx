import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as TestClock from "effect/testing/TestClock";

import type { ReadQuotaJson } from "../UsageLimitSources.ts";
import { readOpenRouterUsage } from "./openrouter.ts";

const TOKEN = "router-fixture-only";
const NOW = Date.UTC(2024, 1, 29, 22);

function reader(
  key: { status: number; body?: unknown },
  credits: { status: number; body?: unknown },
  readPage?: (url: URL) => ReturnType<ReadQuotaJson>,
): ReadQuotaJson {
  return (url, headers) => {
    expect(headers.Authorization).toBe(`Bearer ${TOKEN}`);
    const parsed = new URL(url);
    expect(parsed.origin).toBe("https://openrouter.ai");
    switch (parsed.pathname) {
      case "/api/v1/credits":
        return Effect.succeed(credits);
      case "/api/v1/key":
        return Effect.succeed(key);
      case "/api/v1/keys":
        if (readPage) return readPage(parsed);
    }
    return Effect.die("Unexpected OpenRouter request");
  };
}

it.effect("maps credits, scoped caps and free requests without confusing their reset periods", () =>
  Effect.gen(function* () {
    yield* TestClock.setTime(NOW);
    const usage = yield* readOpenRouterUsage(
      TOKEN,
      reader(
        {
          status: 200,
          body: {
            data: {
              limit: 20,
              limit_remaining: 6,
              limit_reset: "weekly",
              usage: 120,
              usage_daily: 0,
              usage_weekly: 3,
              usage_monthly: 12,
              is_free_tier: false,
              effective_budget: { limit_usd: 100, spend_usd: 37, reset_interval: "monthly" },
              free_model_daily_requests: { limit: 100, count: 15 },
            },
          },
        },
        { status: 200, body: { data: { total_credits: 50, total_usage: 10 } } },
      ),
    );
    expect(usage).toMatchObject({
      accounts: [],
      quotaAccounts: [
        {
          planTier: "Pay as you go",
          windows: [
            { label: "Credits", usedPercent: 20, usedAmount: 10, limitAmount: 50, unit: "USD" },
            {
              label: "Key Limit",
              usedPercent: 70,
              usedAmount: 14,
              remainingAmount: 6,
              resetsAt: "2024-03-04T00:00:00.000Z",
              windowDurationMins: 7 * 1440,
            },
            {
              label: "Budget",
              usedPercent: 37,
              resetsAt: "2024-03-01T00:00:00.000Z",
              windowDurationMins: 29 * 1440,
            },
            {
              label: "Free Requests",
              usedPercent: 15,
              unit: "requests",
              resetsAt: "2024-03-01T00:00:00.000Z",
              windowDurationMins: 1440,
            },
          ],
          balances: [
            { label: "Balance", remaining: 40, unit: "USD" },
            { label: "Today", remaining: 0, unit: "USD" },
            { label: "This Week", remaining: 3, unit: "USD" },
            { label: "This Month", remaining: 12, unit: "USD" },
          ],
        },
      ],
    });
  }),
);

it.effect.each([200, 403])("keeps spend visible without a credit cap (credits HTTP %s)", (status) =>
  Effect.gen(function* () {
    const usage = yield* readOpenRouterUsage(
      TOKEN,
      reader(
        {
          status: 200,
          body: {
            data: {
              is_management_key: false,
              is_free_tier: false,
              limit: null,
              usage_daily: 0,
              usage_weekly: 2,
              usage_monthly: 9,
            },
          },
        },
        { status, body: { data: { total_credits: 0, total_usage: 9 } } },
      ),
    );
    const account = usage.quotaAccounts?.[0];
    expect(usage.error).toBeUndefined();
    expect(account?.windows).toEqual([]);
    expect(account?.balances?.map(({ label, remaining }) => [label, remaining])).toEqual([
      ...(status === 200 ? [["Balance", 0]] : []),
      ["Today", 0],
      ["This Week", 2],
      ["This Month", 9],
    ]);
  }),
);

it.effect("sums complete management-key pages including disabled and expired keys", () =>
  Effect.gen(function* () {
    const offsets: number[] = [];
    const usage = yield* readOpenRouterUsage(
      TOKEN,
      reader(
        { status: 200, body: { data: { is_management_key: true, usage_daily: 999 } } },
        { status: 403 },
        (url) => {
          expect(url.searchParams.get("include_disabled")).toBe("true");
          expect(url.searchParams.get("include_expired")).toBe("true");
          const offset = Number(url.searchParams.get("offset"));
          offsets.push(offset);
          const entry = { usage_daily: 1, usage_weekly: 2, usage_monthly: 4 };
          return Effect.succeed({
            status: 200,
            body: { data: Array.from({ length: offset === 0 ? 100 : 2 }, () => entry) },
          });
        },
      ),
    );
    expect(offsets).toEqual([0, 100]);
    expect(
      usage.quotaAccounts?.[0]?.balances?.map(({ label, remaining }) => [label, remaining]),
    ).toEqual([
      ["Today", 102],
      ["This Week", 204],
      ["This Month", 408],
    ]);
  }),
);

it.effect.each(["malformed second page", "50 full pages"])(
  "does not publish partial management totals after %s",
  (reason) =>
    Effect.gen(function* () {
      let pages = 0;
      const entry = { usage_daily: 1, usage_weekly: 2, usage_monthly: 4 };
      const fullPage = Array.from({ length: 100 }, () => entry);
      const usage = yield* readOpenRouterUsage(
        TOKEN,
        reader(
          { status: 200, body: { data: { is_management_key: true } } },
          { status: 403 },
          () => {
            pages++;
            const data =
              reason === "malformed second page" && pages === 2 ? [{ usage_daily: 1 }] : fullPage;
            return Effect.succeed({ status: 200, body: { data } });
          },
        ),
      );
      expect(pages).toBe(reason === "malformed second page" ? 2 : 50);
      expect(usage).toEqual({
        accounts: [],
        error: "Could not read usable OpenRouter usage data.",
      });
    }),
);

it.effect("reports dual auth failure without echoing the response body", () =>
  Effect.gen(function* () {
    const result = yield* readOpenRouterUsage(
      TOKEN,
      reader({ status: 401, body: { error: TOKEN } }, { status: 403, body: { error: TOKEN } }),
    );
    expect(result).toEqual({ accounts: [], error: "OpenRouter rejected the API key (HTTP 401)." });
  }),
);

it.effect.each([
  {
    name: "/credits HTTP 503",
    key: {
      status: 200,
      body: {
        data: { is_free_tier: false, usage_daily: 1, usage_weekly: 2, usage_monthly: 3 },
      },
    },
    credits: { status: 503 },
  },
  {
    name: "/credits malformed 200 payload",
    key: {
      status: 200,
      body: {
        data: { is_free_tier: false, usage_daily: 1, usage_weekly: 2, usage_monthly: 3 },
      },
    },
    credits: { status: 200, body: { data: {} } },
  },
  {
    name: "/key HTTP 503",
    key: { status: 503 },
    credits: { status: 200, body: { data: { total_credits: 50, total_usage: 10 } } },
  },
  {
    name: "/key empty 200 data object",
    key: { status: 200, body: { data: {} } },
    credits: { status: 200, body: { data: { total_credits: 50, total_usage: 10 } } },
  },
  {
    name: "/key flag-only standard object without spend",
    key: { status: 200, body: { data: { is_management_key: false } } },
    credits: { status: 200, body: { data: { total_credits: 50, total_usage: 10 } } },
  },
  {
    name: "/key standard object missing weekly/monthly spend",
    key: { status: 200, body: { data: { is_free_tier: false, usage_daily: 1 } } },
    credits: { status: 200, body: { data: { total_credits: 50, total_usage: 10 } } },
  },
  {
    name: "/key positive cap with no usable measurement",
    key: {
      status: 200,
      body: {
        data: {
          is_free_tier: false,
          usage_daily: 0,
          usage_weekly: 0,
          usage_monthly: 0,
          limit: 20,
          limit_remaining: null,
          limit_reset: null,
        },
      },
    },
    credits: { status: 200, body: { data: { total_credits: 50, total_usage: 10 } } },
  },
  {
    name: "/key fractional free_model_daily_requests count",
    key: {
      status: 200,
      body: {
        data: {
          is_free_tier: true,
          usage_daily: 0,
          usage_weekly: 0,
          usage_monthly: 0,
          free_model_daily_requests: { limit: 100, count: 1.5 },
        },
      },
    },
    credits: { status: 200, body: { data: { total_credits: 50, total_usage: 10 } } },
  },
  {
    name: "/key malformed spend field",
    key: {
      status: 200,
      body: {
        data: { is_free_tier: false, usage_daily: "bad", usage_weekly: 0, usage_monthly: 0 },
      },
    },
    credits: { status: 200, body: { data: { total_credits: 50, total_usage: 10 } } },
  },
  {
    name: "/key management key with malformed effective_budget",
    key: {
      status: 200,
      body: {
        data: {
          is_management_key: true,
          effective_budget: { limit_usd: 100, spend_usd: "bad" },
        },
      },
    },
    credits: { status: 403 },
  },
  {
    name: "/key management key with fractional free_model_daily_requests",
    key: {
      status: 200,
      body: {
        data: {
          is_management_key: true,
          free_model_daily_requests: { limit: 100, used: 1.5 },
        },
      },
    },
    credits: { status: 403 },
  },
])(
  "returns an error instead of stripped partial data on transient endpoint outage ($name)",
  ({ key, credits }) =>
    Effect.gen(function* () {
      const result = yield* readOpenRouterUsage(
        TOKEN,
        reader(key, credits, () =>
          Effect.succeed({
            status: 200,
            body: { data: [{ usage_daily: 1, usage_weekly: 2, usage_monthly: 4 }] },
          }),
        ),
      );
      expect(result).toEqual({
        accounts: [],
        error: "Could not read usable OpenRouter usage data.",
      });
    }),
);
