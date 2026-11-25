import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as TestClock from "effect/testing/TestClock";
import { vi } from "vite-plus/test";

import { readOpenAiApiUsage } from "./openaiApi.ts";

const ADMIN = "admin-fixture-only";
const TODAY = Date.UTC(2026, 0, 31) / 1000;
const NOW = Date.UTC(2026, 0, 31, 1, 30);
const DAY = 86_400;

function money(value: number, currency = "usd") {
  return { object: "organization.costs.result", amount: { value, currency } };
}

function bucket(start: number, ...results: unknown[]) {
  return { object: "bucket", start_time: start, end_time: start + DAY, results };
}

function costPage(data: readonly unknown[], cursor?: string) {
  return {
    status: 200,
    body: { object: "page", data, has_more: cursor !== undefined, next_page: cursor ?? null },
  };
}

it.effect(
  "uses the explicit Admin Key and sums cursor-paged UTC buckets without a quota meter",
  () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(NOW);
      const cursors: Array<string | null> = [];
      const usage = yield* readOpenAiApiUsage(ADMIN, (url, headers) => {
        const request = new URL(url);
        expect(request.origin + request.pathname).toBe(
          "https://api.openai.com/v1/organization/costs",
        );
        expect(headers.Authorization).toBe(`Bearer ${ADMIN}`);
        expect(request.searchParams.get("start_time")).toBe(String(TODAY - 30 * DAY));
        expect(request.searchParams.get("end_time")).toBe(String(NOW / 1000));
        expect(request.searchParams.get("bucket_width")).toBe("1d");
        const cursor = request.searchParams.get("page");
        cursors.push(cursor);
        if (cursor === null) {
          return Effect.succeed(
            costPage(
              [
                bucket(TODAY - 31 * DAY, money(999)),
                bucket(TODAY - 30 * DAY, money(4)),
                bucket(TODAY - 29 * DAY, money(2)),
              ],
              "opaque+next/=cursor",
            ),
          );
        }
        return Effect.succeed(
          costPage([
            bucket(TODAY - DAY, money(3, "USD")),
            bucket(TODAY, money(1.5, "Usd"), money(3.5, "usd")),
            bucket(TODAY + DAY, money(900)),
          ]),
        );
      });
      expect(cursors).toEqual([null, "opaque+next/=cursor"]);
      expect(usage.quotaAccounts).toMatchObject([
        {
          windows: [],
          balances: [
            { label: "Today", remaining: 5, unit: "USD" },
            { label: "Yesterday", remaining: 3, unit: "USD" },
            { label: "This Month", remaining: 14, unit: "USD" },
            { label: "30-Day Spend", remaining: 10, unit: "USD" },
          ],
        },
      ]);
    }),
);

it.effect("shows actual zero spend without inventing quota", () =>
  Effect.gen(function* () {
    yield* TestClock.setTime(NOW);
    const usage = yield* readOpenAiApiUsage(ADMIN, () =>
      Effect.succeed(costPage([bucket(TODAY - DAY), bucket(TODAY, money(0))])),
    );
    expect(usage.error).toBeUndefined();
    expect(usage.quotaAccounts?.[0]?.windows).toEqual([]);
    expect(usage.quotaAccounts?.[0]?.balances?.map(({ remaining }) => remaining)).toEqual([
      0, 0, 0, 0,
    ]);
  }),
);

it.effect("does not substitute an environment token for the configured Admin Key", () =>
  Effect.gen(function* () {
    vi.stubEnv("OPENAI_API_KEY", "environment-fixture-only");
    const result = yield* readOpenAiApiUsage("", () => Effect.die("Unexpected OpenAI API request"));
    expect(result).toEqual({
      accounts: [],
      error: "No OpenAI organization Admin API key configured.",
    });
  }).pipe(Effect.ensuring(Effect.sync(() => vi.unstubAllEnvs()))),
);

it.effect.each([
  {
    name: "bad bucket object",
    value: { ...bucket(TODAY), object: "usage.bucket" },
    error: "invalid organization costs data",
  },
  {
    name: "bad result object",
    value: bucket(TODAY, { ...money(3), object: "organization.usage.result" }),
    error: "invalid organization costs data",
  },
  {
    name: "nonfinite value",
    value: bucket(TODAY, money(Number.POSITIVE_INFINITY)),
    error: "invalid organization costs data",
  },
  {
    name: "non-USD currency code",
    value: bucket(TODAY, money(7), money(3, "EUR")),
    error: "must be in USD",
  },
  {
    name: "malformed currency payload",
    value: bucket(TODAY, money(7), money(3, "untrusted currency payload")),
    error: "invalid organization costs data",
  },
])("rejects a page containing $name without returning partial or raw values", ({ value, error }) =>
  Effect.gen(function* () {
    yield* TestClock.setTime(NOW);
    const result = yield* readOpenAiApiUsage(ADMIN, () =>
      Effect.succeed(costPage([bucket(TODAY, money(8)), value])),
    );
    expect(result.error).toContain(error);
    expect(result.error).not.toContain("untrusted currency payload");
    expect(result.quotaAccounts).toBeUndefined();
  }),
);

it.effect.each(["cycle", "page cap"])("discards partial costs on a cursor %s", (mode) =>
  Effect.gen(function* () {
    yield* TestClock.setTime(NOW);
    const cursors: Array<string | null> = [];
    const result = yield* readOpenAiApiUsage(ADMIN, (url) => {
      const page = new URL(url).searchParams.get("page");
      cursors.push(page);
      const cursor = mode === "cycle" ? (page === "a" ? "b" : "a") : `page-${cursors.length}`;
      return Effect.succeed(costPage([bucket(TODAY, money(5))], cursor));
    });
    expect(cursors).toEqual(
      mode === "cycle"
        ? [null, "a", "b"]
        : [null, ...Array.from({ length: 9 }, (_, i) => `page-${i + 1}`)],
    );
    expect(result).toEqual({
      accounts: [],
      error: "OpenAI API costs pagination could not be completed.",
    });
  }),
);

it.effect.each([401, 403])(
  "guides HTTP %s failures to Admin Keys without leaking provider text",
  (status) =>
    Effect.gen(function* () {
      const result = yield* readOpenAiApiUsage(ADMIN, () =>
        Effect.succeed({ status, body: { error: ADMIN } }),
      );
      expect(result).toEqual({
        accounts: [],
        error: `OpenAI API costs require an organization Admin API key with costs access (HTTP ${status}).`,
      });
    }),
);
