import * as DateTime from "effect/DateTime";
import { ProviderDriverKind, ProviderInstanceId } from "@t3tools/contracts";
import { exhaustedUsageWindow } from "@t3tools/shared/usageLimits";
import * as CodexErrors from "effect-codex-app-server/errors";
import { describe, expect, it } from "vite-plus/test";

import {
  codexMessageResetAt,
  codexRateLimitsFailureMessage,
  codexRateLimitsToLimits,
  codexRateLimitsToUpdate,
  codexTimeZone,
  mergeCodexRateLimits,
} from "./codexUsageLimits.ts";

const checkedAt = "2026-07-18T10:00:00.000Z";

describe("codexRateLimitsToLimits", () => {
  it("shows an Enterprise monthly credit allowance in reads and notifications without a duration", () => {
    const snapshot = {
      limitId: "codex",
      planType: "enterprise_cbp_usage_based",
      primary: null,
      secondary: null,
      individualLimit: { remainingPercent: 99, resetsAt: 1_784_500_000, used: "5", limit: "500" },
    };
    const windows = [
      {
        id: "individual",
        kind: "monthly",
        label: "Monthly credit limit",
        category: "balance",
        usedAmount: 5,
        limitAmount: 500,
        remainingAmount: 495,
        unit: "credits",
        usedPercent: 1,
        resetsAt: "2026-07-19T22:26:40.000Z",
      },
    ];

    expect(
      codexRateLimitsToLimits({
        checkedAt,
        snapshot: { limitId: "spark" },
        rateLimitsByLimitId: { codex: snapshot },
      }),
    ).toEqual({ checkedAt, windows, planTier: "Enterprise" });
    expect(codexRateLimitsToUpdate(snapshot)).toEqual({ windows, planTier: "Enterprise" });
  });

  it.each([
    { used: "", limit: "500" },
    { used: "-1", limit: "500" },
    { used: "5 credits", limit: "500" },
    { used: "5", limit: "0" },
    { used: "5", limit: "Infinity" },
  ])("keeps only the percentage for invalid individual amounts %j", (amounts) => {
    const { windows } = codexRateLimitsToLimits({
      checkedAt,
      snapshot: {
        individualLimit: { remainingPercent: 99, resetsAt: 1_784_500_000, ...amounts },
      },
    });
    expect(windows).toEqual([
      {
        id: "individual",
        kind: "monthly",
        label: "Monthly credit limit",
        category: "balance",
        usedPercent: 1,
        resetsAt: "2026-07-19T22:26:40.000Z",
      },
    ]);
  });

  it("keeps a seat-based workspace with a zero credit cap usable while its plan windows have room", () => {
    const usageLimits = codexRateLimitsToLimits({
      checkedAt,
      snapshot: {
        limitId: "codex",
        planType: "team",
        rateLimitReachedType: null,
        primary: { usedPercent: 0, resetsAt: 1_784_000_000, windowDurationMins: 300 },
        secondary: { usedPercent: 14, resetsAt: 1_784_500_000, windowDurationMins: 10080 },
        individualLimit: { remainingPercent: 0, resetsAt: 1_796_083_200 },
      },
    });
    expect(
      exhaustedUsageWindow(
        {
          instanceId: ProviderInstanceId.make("codex"),
          driver: ProviderDriverKind.make("codex"),
          enabled: true,
          installed: true,
          version: null,
          status: "ready",
          auth: { status: "authenticated" },
          checkedAt,
          models: [],
          slashCommands: [],
          skills: [],
          usageLimits,
        },
        Date.parse(checkedAt),
        "gpt-6.1-sol",
      ),
    ).toBeUndefined();
  });

  it("maps primary and secondary onto the session and weekly windows", () => {
    expect(
      codexRateLimitsToLimits({
        checkedAt,
        snapshot: {
          planType: "plus",
          primary: { usedPercent: 12, resetsAt: 1_784_000_000, windowDurationMins: 300 },
          secondary: { usedPercent: 47, resetsAt: 1_784_500_000, windowDurationMins: 10080 },
        },
      }),
    ).toEqual({
      checkedAt,
      planTier: "Plus",
      windows: [
        {
          id: "primary",
          kind: "session",
          label: "Session",
          category: "plan",
          usedPercent: 12,
          windowDurationMins: 300,
          resetsAt: "2026-07-14T03:33:20.000Z",
        },
        {
          id: "secondary",
          kind: "weekly",
          label: "Weekly",
          category: "plan",
          usedPercent: 47,
          windowDurationMins: 10080,
          resetsAt: "2026-07-19T22:26:40.000Z",
        },
      ],
    });
  });

  it("treats a lone duration-less primary as monthly on Free and Go", () => {
    expect(
      codexRateLimitsToLimits({
        checkedAt,
        snapshot: { planType: "free", primary: { usedPercent: 80, resetsAt: null } },
      }).windows,
    ).toEqual([
      {
        id: "primary",
        kind: "monthly",
        label: "Monthly",
        category: "plan",
        usedPercent: 80,
        windowDurationMins: 43_200,
      },
    ]);
  });

  it("selects the main Codex allowance and leaves Spark out", () => {
    const spark = {
      limitId: "codex_bengalfox",
      individualLimit: { remainingPercent: 99, resetsAt: 1_784_500_000 },
      primary: { usedPercent: 0, windowDurationMins: 300 },
      secondary: { usedPercent: 90, windowDurationMins: 10080 },
    };
    expect(
      codexRateLimitsToLimits({
        checkedAt,
        snapshot: spark,
        rateLimitsByLimitId: {
          codex_bengalfox: spark,
          codex: { secondary: { usedPercent: 42, windowDurationMins: 10080 } },
        },
      }).windows,
    ).toEqual([
      {
        id: "secondary",
        kind: "weekly",
        label: "Weekly",
        category: "plan",
        usedPercent: 42,
        windowDurationMins: 10080,
      },
    ]);
  });

  it.each([undefined, null, {}])(
    "supports legacy reads with no bucket map: %j",
    (rateLimitsByLimitId) => {
      const snapshot = { primary: { usedPercent: 12, windowDurationMins: 300 } };
      expect(codexRateLimitsToLimits({ checkedAt, snapshot, rateLimitsByLimitId })).toEqual(
        codexRateLimitsToLimits({ checkedAt, snapshot }),
      );
    },
  );

  it.each([
    ["2026-07-19T23:26:40+01:00", "2026-07-19T22:26:40.000Z"],
    [1_784_500_000, "2026-07-19T22:26:40.000Z"],
    ["2026-02-30T00:00:00Z", undefined],
    ["July 19, 2026", undefined],
    [0, undefined],
    [Number.MAX_VALUE, undefined],
  ])("normalizes subscription expiry %s without guessing", (subscriptionActiveUntil, expiry) => {
    const limits = codexRateLimitsToLimits({
      checkedAt,
      snapshot: { planType: "  unknown ", subscriptionActiveUntil },
    });
    expect(limits).toEqual({
      checkedAt,
      windows: [],
      ...(expiry ? { subscriptionExpiresAt: expiry } : {}),
    });
  });

  it.each([
    { credits: { hasCredits: true, unlimited: false, balance: "12.5" }, remaining: 12.5 },
    { credits: { hasCredits: true, unlimited: false, balance: "-3" }, remaining: 0 },
    { credits: { hasCredits: false, unlimited: false, balance: "12.5" }, remaining: null },
    { credits: { hasCredits: false, unlimited: true, balance: "12.5" } },
    { credits: { hasCredits: true, unlimited: true, balance: "12.5" } },
    { credits: { hasCredits: true, unlimited: false, balance: " " } },
    { credits: { hasCredits: true, unlimited: false, balance: "NaN" } },
    { credits: null },
  ])(
    "emits only measured finite credits or an explicit clear: $credits",
    ({ credits, remaining }) => {
      const limits = codexRateLimitsToLimits({ checkedAt, snapshot: { credits } });
      expect(limits).toEqual({
        checkedAt,
        windows: [],
        ...(remaining === undefined
          ? {}
          : {
              balances:
                remaining === null
                  ? []
                  : [
                      {
                        id: "codex-credits",
                        label: "Credits",
                        remaining,
                        unit: "credits",
                        kind: "credits",
                      },
                    ],
            }),
      });
    },
  );
});

describe("codexRateLimitsToUpdate", () => {
  it("does not republish cached windows over a newer account probe", () => {
    const cached = {
      primary: { usedPercent: 0, resetsAt: 1_784_000_000, windowDurationMins: 300 },
      secondary: { usedPercent: 20, resetsAt: 1_784_500_000, windowDurationMins: 10080 },
    };
    expect(codexRateLimitsToUpdate(cached)?.windows).toHaveLength(2);
    expect(codexRateLimitsToUpdate(structuredClone(cached), cached)).toBeUndefined();

    const changed = { ...cached, secondary: { ...cached.secondary, usedPercent: 21 } };
    expect(codexRateLimitsToUpdate(changed, cached)?.windows.map((window) => window.id)).toEqual([
      "secondary",
    ]);
    expect(codexRateLimitsToUpdate({ primary: cached.primary }, cached)).toBeUndefined();
    expect(
      codexRateLimitsToUpdate({ primary: { ...cached.primary, resetsAt: 1_784_001_000 } }, cached)
        ?.windows,
    ).toHaveLength(1);
    expect(
      codexRateLimitsToUpdate({ primary: { ...cached.primary, usedPercent: 76 } }, cached)
        ?.windows[0]?.usedPercent,
    ).toBe(76);
  });

  it("carries only the windows the notification names", () => {
    expect(
      codexRateLimitsToUpdate({
        secondary: { usedPercent: 51, windowDurationMins: 10080 },
      }),
    ).toEqual({
      windows: [
        {
          id: "secondary",
          kind: "weekly",
          label: "Weekly",
          category: "plan",
          usedPercent: 51,
          windowDurationMins: 10080,
        },
      ],
    });
    expect(codexRateLimitsToUpdate({ planType: "plus" })).toBeUndefined();
  });

  it("publishes changed credit amounts even when the percentage did not change", () => {
    const priorLimit = { remainingPercent: 99, resetsAt: 1_784_500_000, used: "5", limit: "500" };
    const previous = { individualLimit: priorLimit };
    expect(
      codexRateLimitsToUpdate({ individualLimit: { ...priorLimit, used: "6.5" } }, previous)
        ?.windows,
    ).toMatchObject([{ usedAmount: 6.5, remainingAmount: 493.5, unit: "credits" }]);
    expect(
      codexRateLimitsToUpdate({ individualLimit: { ...priorLimit, used: "5.0" } }, previous),
    ).toBeUndefined();
  });

  it("publishes a credit clear without replaying cached windows and suppresses repeated clears", () => {
    const primary = { usedPercent: 12 };
    const previous = { primary, credits: { hasCredits: true, unlimited: false, balance: "12.5" } };
    const cleared = { primary, credits: { hasCredits: false, unlimited: false } };
    expect(codexRateLimitsToUpdate(cleared, previous)).toEqual({ windows: [], balances: [] });
    expect(codexRateLimitsToUpdate(cleared, cleared)).toBeUndefined();
    expect(codexRateLimitsToUpdate({ primary }, previous)).toBeUndefined();
  });

  it("ignores Spark notifications so they cannot overwrite the main allowance", () => {
    expect(
      codexRateLimitsToUpdate({
        limitId: "codex_bengalfox",
        individualLimit: { remainingPercent: 99, resetsAt: 1_784_500_000 },
        primary: { usedPercent: 0, windowDurationMins: 300 },
        secondary: { usedPercent: 90, windowDurationMins: 10080 },
      }),
    ).toBeUndefined();
    expect(
      codexRateLimitsToUpdate({
        limitId: "codex",
        secondary: { usedPercent: 42, windowDurationMins: 10080 },
      })?.windows,
    ).toEqual([
      {
        id: "secondary",
        kind: "weekly",
        label: "Weekly",
        category: "plan",
        usedPercent: 42,
        windowDurationMins: 10080,
      },
    ]);
  });
});

describe("codexRateLimitsFailureMessage", () => {
  it("keeps the JSON-RPC code and nothing else from a request failure", () => {
    expect(
      codexRateLimitsFailureMessage(
        new CodexErrors.CodexAppServerRequestError({
          code: -32603,
          errorMessage:
            "failed to fetch codex rate limits: GET https://chatgpt.com/backend-api/wham/usage failed: 401 Unauthorized",
        }),
      ),
    ).toBe("Codex could not read usage (JSON-RPC -32603).");
  });
});

describe("mergeCodexRateLimits", () => {
  it("updates monthly credit usage, retains it when omitted, and clears an explicit null", () => {
    const snapshot = {
      limitId: "codex",
      primary: { usedPercent: 12 },
      individualLimit: { remainingPercent: 99, resetsAt: 1_784_500_000 },
    };
    const individualLimit = { remainingPercent: 75, resetsAt: 1_787_000_000 };
    const changed = mergeCodexRateLimits(snapshot, { individualLimit });
    expect(changed).toEqual({ ...snapshot, individualLimit });
    expect(codexRateLimitsToUpdate(changed!)).toEqual({
      windows: [
        {
          id: "primary",
          kind: "session",
          label: "Session",
          category: "plan",
          usedPercent: 12,
          windowDurationMins: 300,
        },
        {
          id: "individual",
          kind: "monthly",
          label: "Monthly credit limit",
          category: "balance",
          usedPercent: 25,
          resetsAt: "2026-08-17T20:53:20.000Z",
        },
      ],
    });

    const retained = mergeCodexRateLimits(changed, { primary: null });
    expect(retained).toEqual({ ...snapshot, primary: null, individualLimit });
    const cleared = mergeCodexRateLimits(retained, { individualLimit: null });
    expect(cleared).toEqual({ ...snapshot, primary: null, individualLimit: null });
    expect(codexRateLimitsToLimits({ checkedAt, snapshot: cleared! }).windows).toEqual([]);
  });

  it("retains omitted balance and expiry data and replaces explicitly supplied values", () => {
    const previous = {
      credits: { hasCredits: true, unlimited: false, balance: "12.5" },
      subscriptionActiveUntil: 1_784_500_000,
    };
    const primary = { usedPercent: 12 };
    const withWindow = mergeCodexRateLimits(previous, { primary });
    expect(withWindow).toEqual({ ...previous, primary });
    const changed = {
      credits: { hasCredits: false, unlimited: false },
      subscriptionActiveUntil: null,
    };
    expect(mergeCodexRateLimits(withWindow, changed)).toEqual({ ...changed, primary });
  });

  it("ignores non-main Spark snapshots for metadata and accepts bare YYYY-MM-DD subscription dates", () => {
    const sparkOnly = codexRateLimitsToLimits({
      checkedAt,
      snapshot: {
        limitId: "codex_bengalfox",
        planType: "pro",
        credits: { hasCredits: true, unlimited: false, balance: "99" },
        subscriptionActiveUntil: "2026-12-31",
        primary: { usedPercent: 50, windowDurationMins: 300 },
      },
    });
    expect(sparkOnly).toEqual({ checkedAt, windows: [] });

    const bareDate = codexRateLimitsToLimits({
      checkedAt,
      snapshot: {
        planType: "plus",
        subscriptionActiveUntil: "2026-12-31",
        primary: { usedPercent: 10, windowDurationMins: 300 },
      },
    });
    expect(bareDate.subscriptionExpiresAt).toBe("2026-12-31");
    expect(
      codexRateLimitsToLimits({
        checkedAt,
        snapshot: { subscriptionActiveUntil: "2026-02-30" },
      }).subscriptionExpiresAt,
    ).toBeUndefined();
  });

  it("ignores a model-specific snapshot so it cannot replace the main allowance", () => {
    const main = {
      limitId: "codex",
      primary: { usedPercent: 100, resetsAt: 1_800_000_000, windowDurationMins: 300 },
    };
    expect(
      mergeCodexRateLimits(main, {
        limitId: "spark",
        individualLimit: { remainingPercent: 99, resetsAt: 1_784_500_000 },
        primary: { usedPercent: 3, resetsAt: 1_800_000_000, windowDurationMins: 300 },
      }),
    ).toBe(main);
  });
});

import { codexUsageLimitResetAt } from "./codexUsageLimits.ts";

describe("codexUsageLimitResetAt", () => {
  it("waits for every exhausted window and never invents an unknown reset", () => {
    expect(
      codexUsageLimitResetAt({
        primary: { usedPercent: 100, resetsAt: 2000000000 },
        secondary: { usedPercent: 100, resetsAt: 2000100000 },
      }),
    ).toBe("2033-05-19T07:20:00.000Z");
    expect(codexUsageLimitResetAt({ primary: { usedPercent: 100 } })).toBeNull();
    expect(
      codexUsageLimitResetAt({ primary: { usedPercent: 50, resetsAt: 2000000000 } }),
    ).toBeNull();
  });
});

describe("codexMessageResetAt", () => {
  const dhaka = DateTime.zoneMakeNamedUnsafe("Asia/Dhaka");
  const at = (iso: string) => DateTime.makeUnsafe(iso);
  const failedAt = at("2026-11-07T03:00:00Z"); // 09:00 in Dhaka

  // Codex prints local time without seconds, so the parsed reset is the minute after.
  it("reads Codex's same-day and dated reset text in Codex's zone", () => {
    expect(
      codexMessageResetAt("You’ve hit your usage limit. Try again at 3:37 PM.", failedAt, dhaka),
    ).toBe("2026-11-07T09:38:00.000Z");
    expect(
      codexMessageResetAt("Upgrade, or try again at Dec 1st, 2026 12:05 AM.", failedAt, dhaka),
    ).toBe("2026-11-30T18:06:00.000Z");
    expect(codexMessageResetAt("Try again at 12:30 PM.", failedAt, dhaka)).toBe(
      "2026-11-07T06:31:00.000Z",
    );
  });

  it("dates today's form by when Codex failed, across local midnight", () => {
    expect(codexMessageResetAt("Try again at 11:59 PM.", at("2026-11-07T17:59:59Z"), dhaka)).toBe(
      "2026-11-07T18:00:00.000Z",
    );
  });

  it("takes the later instant of a repeated DST hour", () => {
    // 1:30 AM occurs twice in New York on Nov 1st, 2026: 05:30Z (EDT) and 06:30Z (EST).
    const newYork = DateTime.zoneMakeNamedUnsafe("America/New_York");
    for (const iso of ["2026-11-01T05:15:00Z", "2026-11-01T06:15:00Z"]) {
      expect(codexMessageResetAt("Try again at 1:30 AM.", at(iso), newYork)).toBe(
        "2026-11-01T06:31:00.000Z",
      );
    }
  });

  it("leaves the reset unknown without reset text or once it has passed", () => {
    expect(
      codexMessageResetAt("You’ve hit your usage limit. Try again later.", failedAt, dhaka),
    ).toBeNull();
    expect(
      codexMessageResetAt(
        "exceeded retry limit, last status: 429 Too Many Requests",
        failedAt,
        dhaka,
      ),
    ).toBeNull();
    expect(codexMessageResetAt("Try again at 8:15 AM.", failedAt, dhaka)).toBeNull();
  });
});

describe("codexTimeZone", () => {
  it("uses Codex's TZ and falls back to the server's zone", () => {
    const local = DateTime.zoneToString(DateTime.zoneMakeLocal());
    expect(DateTime.zoneToString(codexTimeZone({ TZ: ":Asia/Dhaka" }))).toBe("Asia/Dhaka");
    expect(DateTime.zoneToString(codexTimeZone({ TZ: "not/a-zone" }))).toBe(local);
    expect(DateTime.zoneToString(codexTimeZone({}))).toBe(local);
  });
});
