import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import { cursorUsageResponseToLimits, readCursorUsageLimits } from "./usageLimits.ts";

describe("Cursor usage limits", () => {
  const checkedAt = "2026-09-16T00:00:00.000Z";

  it("uses the advertised percentages and billing-cycle reset", () => {
    const limits = cursorUsageResponseToLimits(
      {
        billingCycleEnd: "1789876386000",
        planUsage: { totalPercentUsed: 72.4, autoPercentUsed: 69.5, apiPercentUsed: 100 },
      },
      checkedAt,
    );
    expect(limits.windows).toEqual(
      expect.arrayContaining([
        {
          id: "totalPercentUsed",
          kind: "monthly",
          label: "Overall",
          category: "plan",
          usedPercent: 72.4,
          resetsAt: "2026-09-20T03:53:06.000Z",
        },
        {
          id: "autoPercentUsed",
          kind: "monthly",
          label: "Cursor Models",
          category: "plan",
          scopeLabel: "Cursor Models",
          usedPercent: 69.5,
          resetsAt: "2026-09-20T03:53:06.000Z",
        },
        {
          id: "apiPercentUsed",
          kind: "monthly",
          label: "Other Models",
          category: "plan",
          scopeLabel: "Other Models",
          usedPercent: 100,
          resetsAt: "2026-09-20T03:53:06.000Z",
        },
      ]),
    );
    expect(limits.subscriptionExpiresAt).toBe("2026-09-20T03:53:06.000Z");
  });

  it("reports the billing-cycle length so pace can be computed", () => {
    const planUsage = { totalPercentUsed: 40, autoPercentUsed: 30, apiPercentUsed: 20 };
    const durations = (billingCycleStart: string | number | undefined, billingCycleEnd: string) =>
      cursorUsageResponseToLimits(
        { billingCycleStart, billingCycleEnd, planUsage },
        checkedAt,
      ).windows.map((window) => window.windowDurationMins);
    expect(durations("1794045847072", "1796637847072")).toEqual([43_200, 43_200, 43_200]);
    expect(durations(1_796_637_847_072, "1799316247072")).toEqual([44_640, 44_640, 44_640]);
  });

  it("omits the cycle length when the start is missing or invalid", () => {
    for (const billingCycleStart of [undefined, "", "0", "not-a-number", "1796637847072"]) {
      expect(
        cursorUsageResponseToLimits(
          {
            billingCycleStart,
            billingCycleEnd: "1796637847072",
            planUsage: { totalPercentUsed: 40 },
          },
          checkedAt,
        ).windows,
      ).toEqual([
        {
          id: "totalPercentUsed",
          kind: "monthly",
          label: "Overall",
          category: "plan",
          usedPercent: 40,
          resetsAt: "2026-12-07T10:04:07.072Z",
        },
      ]);
    }
  });

  it("retains unified totals for account aggregation", () => {
    const windows = cursorUsageResponseToLimits(
      { planUsage: { totalPercentUsed: 1.77, autoPercentUsed: 1.77 } },
      checkedAt,
    ).windows;
    expect(windows.map((window) => window.id)).toEqual(["autoPercentUsed", "totalPercentUsed"]);
    expect(
      cursorUsageResponseToLimits(
        { planUsage: { totalPercentUsed: 100, apiPercentUsed: 100 } },
        checkedAt,
      ).windows.map((window) => window.id),
    ).toEqual(["apiPercentUsed", "totalPercentUsed"]);
  });

  it("does not invent unused allowance for absent buckets", () => {
    expect(cursorUsageResponseToLimits({ planUsage: {} }, checkedAt).unavailable?.reason).toBe(
      "unsupported",
    );
    expect(
      cursorUsageResponseToLimits({ planUsage: { totalPercentUsed: 0 } }, checkedAt).windows,
    ).toEqual([
      {
        id: "totalPercentUsed",
        kind: "monthly",
        label: "Overall",
        category: "plan",
        usedPercent: 0,
      },
    ]);
    expect(
      cursorUsageResponseToLimits({ planUsage: { totalPercentUsed: 150 } }, checkedAt).windows,
    ).toEqual([
      {
        id: "totalPercentUsed",
        kind: "monthly",
        label: "Overall",
        category: "plan",
        usedPercent: 100,
      },
    ]);
  });

  it.each([
    { days: 7, expires: false },
    { days: 27, expires: false },
    { days: 28, expires: true },
    { days: 31, expires: true },
  ])("distinguishes $days-day cycles from subscription renewals", ({ days, expires }) => {
    const resetsAt = "2026-12-07T10:04:07.072Z";
    const billingCycleEnd = Date.parse(resetsAt);
    const limits = cursorUsageResponseToLimits(
      {
        billingCycleStart: billingCycleEnd - days * 24 * 60 * 60_000,
        billingCycleEnd,
        planUsage: { totalPercentUsed: 40 },
      },
      checkedAt,
    );
    expect(limits.windows[0]?.resetsAt).toBe(resetsAt);
    expect(limits.subscriptionExpiresAt).toBe(expires ? resetsAt : undefined);
  });

  it.each([
    { totalSpend: 1_250, remaining: undefined, expectedUsed: 12.5, expectedRemaining: 37.5 },
    { totalSpend: undefined, remaining: 3_700, expectedUsed: 13, expectedRemaining: 37 },
  ])("uses a reported plan amount when the other is absent", (amounts) => {
    const limits = cursorUsageResponseToLimits(
      {
        planUsage: {
          totalPercentUsed: 45,
          limit: 5_000,
          totalSpend: amounts.totalSpend,
          remaining: amounts.remaining,
        },
      },
      checkedAt,
    );
    expect(limits.windows[0]).toMatchObject({
      usedPercent: 45,
      usedAmount: amounts.expectedUsed,
      remainingAmount: amounts.expectedRemaining,
      limitAmount: 50,
      unit: "USD",
    });
    expect(limits).not.toHaveProperty("subscriptionExpiresAt");
  });

  it.each([
    { limit: 0, totalSpend: 1_250 },
    { limit: Infinity, totalSpend: 1_250 },
    { limit: 5_000 },
    { limit: 5_000, totalSpend: -1, remaining: NaN },
  ])("keeps the plan percentage without unusable spend amounts (%j)", (amounts) => {
    const limits = cursorUsageResponseToLimits(
      { planUsage: { totalPercentUsed: 45, ...amounts } },
      checkedAt,
    );
    expect(limits.windows[0]).toEqual({
      id: "totalPercentUsed",
      kind: "monthly",
      label: "Overall",
      category: "plan",
      usedPercent: 45,
    });
  });

  it("uses the team cap when no positive individual cap is set", () => {
    const limits = cursorUsageResponseToLimits(
      {
        membershipType: "  enterprise_custom  ",
        spendLimitUsage: {
          individualLimit: 0,
          individualUsed: 999,
          pooledLimit: 10_000,
          pooledRemaining: 7_500,
        },
      },
      checkedAt,
    );
    expect(limits.planTier).toBe("enterprise_custom");
    expect(limits.windows).toEqual([
      {
        id: "on_demand",
        kind: "monthly",
        label: "Team spend",
        category: "overage",
        usedPercent: 25,
        usedAmount: 25,
        limitAmount: 100,
        remainingAmount: 75,
        unit: "USD",
      },
    ]);
  });

  it("omits an overage cap when spend figures are unusable instead of fabricating 0%", () => {
    const limits = cursorUsageResponseToLimits(
      {
        planUsage: { totalPercentUsed: 30 },
        spendLimitUsage: {
          individualLimit: 2_500,
          individualUsed: NaN,
          individualRemaining: -1,
        },
      },
      checkedAt,
    );
    expect(limits.windows.map(({ id }) => id)).toEqual(["totalPercentUsed"]);
  });

  it("does not fall back to pooledLimit when limitType is explicitly individual with a $0 cap", () => {
    const limits = cursorUsageResponseToLimits(
      {
        planUsage: { totalPercentUsed: 30 },
        spendLimitUsage: {
          limitType: "individual",
          individualLimit: 0,
          pooledLimit: 10_000,
          pooledRemaining: 7_500,
        },
      },
      checkedAt,
    );
    expect(limits.windows.map(({ id }) => id)).toEqual(["totalPercentUsed"]);
  });

  it("does not attach subscription expiry or tier to an unsupported empty response", () => {
    const limits = cursorUsageResponseToLimits(
      {
        billingCycleEnd: "1796637847072",
        membershipType: "pro",
        planUsage: {},
      },
      checkedAt,
    );
    expect(limits.unavailable?.reason).toBe("unsupported");
    expect(limits).not.toHaveProperty("subscriptionExpiresAt");
    expect(limits).not.toHaveProperty("planTier");
  });

  it.effect("tolerates JSON null on optional metadata fields without failing the probe", () =>
    Effect.gen(function* () {
      const limits = yield* readCursorUsageLimits(
        { apiEndpoint: "" },
        { CURSOR_AUTH_TOKEN: "explicit-token" },
      ).pipe(
        Effect.provideService(
          HttpClient.HttpClient,
          HttpClient.make((request) =>
            Effect.succeed(
              HttpClientResponse.fromWeb(
                request,
                Response.json({
                  billingCycleStart: null,
                  billingCycleEnd: "1796637847072",
                  membershipType: null,
                  planUsage: {
                    totalPercentUsed: 25,
                    limit: null,
                    totalSpend: null,
                    remaining: null,
                  },
                  spendLimitUsage: null,
                }),
              ),
            ),
          ),
        ),
      );
      expect(limits.unavailable).toBeUndefined();
      expect(limits.windows).toMatchObject([{ id: "totalPercentUsed", usedPercent: 25 }]);
      expect(limits.subscriptionExpiresAt).toBe("2026-12-07T10:04:07.072Z");
    }),
  );

  it.each([
    { enabled: false, individualLimit: 2_500, pooledLimit: 10_000 },
    { enabled: true, individualLimit: 0, pooledLimit: 0 },
    { individualLimit: -1, pooledLimit: Infinity },
  ])("omits a disabled or unusable overage cap (%j)", (spendLimitUsage) => {
    const limits = cursorUsageResponseToLimits(
      { membershipType: "  ", planUsage: { totalPercentUsed: 30 }, spendLimitUsage },
      checkedAt,
    );
    expect(limits.windows.map(({ id }) => id)).toEqual(["totalPercentUsed"]);
    expect(limits).not.toHaveProperty("planTier");
  });

  it.effect("decodes dashboard spend without replacing the advertised plan percentage", () =>
    Effect.gen(function* () {
      const limits = yield* readCursorUsageLimits(
        { apiEndpoint: "" },
        { CURSOR_AUTH_TOKEN: "explicit-token" },
      ).pipe(
        Effect.provideService(
          HttpClient.HttpClient,
          HttpClient.make((request) =>
            Effect.succeed(
              HttpClientResponse.fromWeb(
                request,
                Response.json({
                  billingCycleStart: "1794045847072",
                  billingCycleEnd: "1796637847072",
                  membershipType: " pro_plus ",
                  planUsage: {
                    totalPercentUsed: 54,
                    autoPercentUsed: 43,
                    apiPercentUsed: 55,
                    limit: 7_000,
                    totalSpend: 3_025,
                    remaining: 4_100,
                    autoSpend: 1_000,
                    apiSpend: 2_025,
                    bonusSpend: 1_200,
                  },
                  spendLimitUsage: {
                    enabled: true,
                    limitType: "individual",
                    individualLimit: 4_000,
                    individualUsed: 3_200,
                    individualRemaining: 800,
                    pooledLimit: 15_000,
                    pooledUsed: 100,
                    pooledRemaining: 14_900,
                  },
                }),
              ),
            ),
          ),
        ),
      );
      expect(limits.planTier).toBe("Pro+");
      expect(limits.subscriptionExpiresAt).toBe("2026-12-07T10:04:07.072Z");
      const byId = new Map(limits.windows.map((window) => [window.id, window]));
      expect(byId.get("totalPercentUsed")).toMatchObject({
        usedPercent: 54,
        usedAmount: 30.25,
        limitAmount: 70,
        remainingAmount: 41,
        unit: "USD",
      });
      expect(byId.get("autoPercentUsed")).not.toHaveProperty("unit");
      expect(byId.get("apiPercentUsed")).not.toHaveProperty("unit");
      expect(byId.get("on_demand")).toEqual({
        id: "on_demand",
        kind: "monthly",
        label: "On-demand",
        category: "overage",
        usedPercent: 80,
        usedAmount: 32,
        limitAmount: 40,
        remainingAmount: 8,
        unit: "USD",
        resetsAt: "2026-12-07T10:04:07.072Z",
        windowDurationMins: 43_200,
      });
    }),
  );

  it.effect("requires explicit credentials and accepts an auth token", () =>
    Effect.gen(function* () {
      for (const token of [undefined, "explicit-token"]) {
        const limits = yield* readCursorUsageLimits(
          { apiEndpoint: "" },
          token ? { CURSOR_AUTH_TOKEN: token } : {},
        ).pipe(
          Effect.provideService(
            HttpClient.HttpClient,
            HttpClient.make((request) => {
              expect(token).toBe("explicit-token");
              expect(request.headers.authorization).toBe("Bearer explicit-token");
              return Effect.succeed(
                HttpClientResponse.fromWeb(
                  request,
                  Response.json({ planUsage: { totalPercentUsed: 10 } }),
                ),
              );
            }),
          ),
        );
        if (token) expect(limits.windows[0]?.usedPercent).toBe(10);
        else expect(limits.unavailable?.reason).toBe("unsupported");
      }
    }),
  );

  it.effect("reports failed requests without exposing credentials or response bodies", () =>
    Effect.gen(function* () {
      const limits = yield* readCursorUsageLimits(
        { apiEndpoint: "" },
        { CURSOR_AUTH_TOKEN: "private-token" },
      ).pipe(
        Effect.provideService(
          HttpClient.HttpClient,
          HttpClient.make((request) =>
            Effect.succeed(
              HttpClientResponse.fromWeb(
                request,
                new Response("private response", { status: 401 }),
              ),
            ),
          ),
        ),
      );
      expect(limits.unavailable).toEqual({
        reason: "probeFailed",
        message: "Cursor could not read usage limits.",
      });
    }),
  );

  it.effect("exchanges an API key to read its account limits", () =>
    Effect.gen(function* () {
      const requests: Array<readonly [string, string | undefined]> = [];
      const limits = yield* readCursorUsageLimits(
        { apiEndpoint: "" },
        { CURSOR_API_KEY: "api-key" },
      ).pipe(
        Effect.provideService(
          HttpClient.HttpClient,
          HttpClient.make((request) => {
            requests.push([request.url, request.headers.authorization]);
            return Effect.succeed(
              HttpClientResponse.fromWeb(
                request,
                Response.json(
                  request.url.endsWith("/auth/exchange_user_api_key")
                    ? { accessToken: "api-key-access-token" }
                    : { planUsage: { totalPercentUsed: 37 } },
                ),
              ),
            );
          }),
        ),
      );
      expect(requests).toEqual([
        ["https://api2.cursor.sh/auth/exchange_user_api_key", "Bearer api-key"],
        [
          "https://api2.cursor.sh/aiserver.v1.DashboardService/GetCurrentPeriodUsage",
          "Bearer api-key-access-token",
        ],
      ]);
      expect(limits.windows[0]?.usedPercent).toBe(37);
    }),
  );

  it.effect("does not send an API key to a custom endpoint", () =>
    Effect.gen(function* () {
      for (const [apiEndpoint, environment] of [
        ["http://localhost:3000", { CURSOR_API_KEY: "api-key" }],
        ["", { CURSOR_API_ENDPOINT: "http://localhost:3000", CURSOR_API_KEY: "api-key" }],
        ["", { CURSOR_API_ENDPOINT: "https://cursor-proxy.example", CURSOR_API_KEY: "api-key" }],
        ["https://cursor-proxy.example", { CURSOR_API_KEY: "api-key" }],
      ] as const) {
        const limits = yield* readCursorUsageLimits({ apiEndpoint }, environment).pipe(
          Effect.provideService(
            HttpClient.HttpClient,
            HttpClient.make(() => Effect.die("must not send an API key to a proxy")),
          ),
        );
        expect(limits.unavailable?.reason).toBe("unsupported");
        expect(limits.unavailable?.message).toContain("default Cursor endpoint");
      }
    }),
  );
});
