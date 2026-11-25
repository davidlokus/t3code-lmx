import type { UsageLimitSourceSnapshot } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";

import type { ReadQuotaJson } from "../UsageLimitSources.ts";

export const OPENAI_API_COSTS_ENDPOINT = "https://api.openai.com/v1/organization/costs";
const DAY_SECONDS = 86_400;
const MAX_PAGES = 10;
const INVALID_COSTS = "OpenAI API returned invalid organization costs data.";
const UNSUPPORTED_CURRENCY = "OpenAI API organization costs must be in USD.";
const INVALID_PAGINATION = "OpenAI API costs pagination could not be completed.";

type Reading = Pick<UsageLimitSourceSnapshot, "accounts" | "quotaAccounts" | "error">;

function record(value: unknown): Readonly<Record<string, unknown>> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : undefined;
}

function costBucket(value: unknown): { start: number; cost: number } | string {
  const bucket = record(value);
  if (bucket?.object !== "bucket" || !Array.isArray(bucket.results)) return INVALID_COSTS;
  const start = bucket.start_time;
  const end = bucket.end_time;
  if (
    typeof start !== "number" ||
    !Number.isSafeInteger(start) ||
    start < 0 ||
    typeof end !== "number" ||
    !Number.isSafeInteger(end) ||
    end <= start
  ) {
    return INVALID_COSTS;
  }
  let cost = 0;
  for (const value of bucket.results) {
    const result = record(value);
    if (result?.object !== "organization.costs.result") return INVALID_COSTS;
    const amount = record(result.amount);
    if (
      typeof amount?.value !== "number" ||
      !Number.isFinite(amount.value) ||
      typeof amount.currency !== "string" ||
      !/^[a-zA-Z]{3}$/.test(amount.currency)
    ) {
      return INVALID_COSTS;
    }
    if (amount.currency.toLowerCase() !== "usd") return UNSUPPORTED_CURRENCY;
    cost += amount.value;
    if (!Number.isFinite(cost)) return INVALID_COSTS;
  }
  return { start, cost };
}

export const readOpenAiApiUsage = Effect.fn("UsageLimitSources.readOpenAiApiUsage")(function* (
  managementKey: string,
  readJson: ReadQuotaJson,
): Effect.fn.Return<Reading> {
  if (managementKey.length === 0) {
    return { accounts: [], error: "No OpenAI organization Admin API key configured." };
  }
  const now = yield* DateTime.now;
  const end = Math.floor(DateTime.toEpochMillis(now) / 1000);
  const today = Math.floor(end / DAY_SECONDS) * DAY_SECONDS;
  const yesterday = today - DAY_SECONDS;
  const trailingStart = today - 29 * DAY_SECONDS;
  const monthStart = DateTime.toEpochMillis(DateTime.startOf(now, "month")) / 1000;
  const start = Math.max(0, Math.min(trailingStart, monthStart));
  const url = new URL(OPENAI_API_COSTS_ENDPOINT);
  url.searchParams.set("start_time", String(start));
  url.searchParams.set("end_time", String(end));
  url.searchParams.set("bucket_width", "1d");
  url.searchParams.set("limit", "180");
  url.searchParams.append("group_by", "project_id");
  url.searchParams.append("group_by", "api_key_id");
  const headers = { Authorization: `Bearer ${managementKey}` };
  const seenCursors = new Set<string>();
  let todayCost = 0;
  let yesterdayCost = 0;
  let monthCost = 0;
  let trailingCost = 0;

  for (let page = 0; page < MAX_PAGES; page++) {
    const response = yield* readJson(url.href, headers);
    if (!response) return { accounts: [], error: "Could not read OpenAI API organization costs." };
    if (response.status === 401 || response.status === 403) {
      return {
        accounts: [],
        error: `OpenAI API costs require an organization Admin API key with costs access (HTTP ${response.status}).`,
      };
    }
    if (response.status < 200 || response.status >= 300) {
      return { accounts: [], error: `OpenAI API costs request failed (HTTP ${response.status}).` };
    }
    const body = record(response.body);
    if (
      !Array.isArray(body?.data) ||
      typeof body.has_more !== "boolean" ||
      (body.object !== undefined && body.object !== "page")
    ) {
      return { accounts: [], error: INVALID_COSTS };
    }
    for (const value of body.data) {
      const bucket = costBucket(value);
      if (typeof bucket === "string") return { accounts: [], error: bucket };
      if (bucket.start < start || bucket.start >= end) continue;
      if (bucket.start >= today) todayCost += bucket.cost;
      else if (bucket.start >= yesterday) yesterdayCost += bucket.cost;
      if (bucket.start >= monthStart) monthCost += bucket.cost;
      if (bucket.start >= trailingStart) trailingCost += bucket.cost;
    }
    if (!body.has_more) {
      if (![todayCost, yesterdayCost, monthCost, trailingCost].every(Number.isFinite)) {
        return { accounts: [], error: INVALID_COSTS };
      }
      return {
        accounts: [],
        quotaAccounts: [
          {
            id: "openai-api",
            label: "OpenAI API",
            windows: [],
            balances: [
              { id: "today", label: "Today", remaining: todayCost, unit: "USD", kind: "spend" },
              {
                id: "yesterday",
                label: "Yesterday",
                remaining: yesterdayCost,
                unit: "USD",
                kind: "spend",
              },
              {
                id: "this-month",
                label: "This Month",
                remaining: monthCost,
                unit: "USD",
                kind: "spend",
              },
              {
                id: "30-day-spend",
                label: "30-Day Spend",
                remaining: trailingCost,
                unit: "USD",
                kind: "spend",
              },
            ],
          },
        ],
      };
    }
    const cursor = body.next_page;
    if (
      typeof cursor !== "string" ||
      cursor === "" ||
      /[\s\u0000-\u001f\u007f]/.test(cursor) ||
      seenCursors.has(cursor)
    )
      break;
    seenCursors.add(cursor);
    url.searchParams.set("page", cursor);
  }
  return { accounts: [], error: INVALID_PAGINATION };
});
