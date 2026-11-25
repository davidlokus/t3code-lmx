import { ServerProviderUsageLimits } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import {
  applyUsageLimitsUpdate,
  makeUsageLimits,
  resolveUsageLimitsAfterProbe,
} from "./usageLimits.ts";

const checkedAt = "2026-09-03T12:00:00.000Z";
const session = {
  id: "five_hour",
  kind: "session",
  label: "Session",
  usedPercent: 40,
  windowDurationMins: 300,
  resetsAt: "2026-09-03T14:00:00.000Z",
} as const;
const weekly = {
  id: "seven_day",
  kind: "weekly",
  label: "Weekly",
  usedPercent: 20,
  windowDurationMins: 10_080,
} as const;
const published = { checkedAt, windows: [session, weekly] };

const richWindow = {
  ...session,
  usedAmount: 4,
  limitAmount: 10,
  remainingAmount: 6,
  unit: "USD",
  category: "plan",
  scopeLabel: "Workspace",
} as const;
const decodeUsageLimits = Schema.decodeSync(ServerProviderUsageLimits);
const richAccount = decodeUsageLimits({
  checkedAt,
  windows: [richWindow, weekly],
  credentialFingerprint: "account-identity",
  subscriptionExpiresAt: "2026-10-01T00:00:00.000Z",
  planTier: "Pro",
  balances: [{ id: "prepaid", label: "Prepaid", remaining: 6.25, unit: "USD" }],
  serviceNotice: { severity: "info", message: "Maintenance scheduled" },
});

describe("applyUsageLimitsUpdate", () => {
  it("returns the published object itself when no window moved", () => {
    const next = applyUsageLimitsUpdate({
      previous: published,
      checkedAt: "2026-09-03T12:00:05.000Z",
      update: {
        windows: [
          { ...weekly },
          { id: "five_hour", kind: "session", label: "Session", usedPercent: 40 },
        ],
      },
    });
    expect(next).toBe(published);
    const scoped = { checkedAt, windows: [{ ...weekly, modelIds: ["opencode/a"] }] };
    const providerScoped = { checkedAt, windows: [{ ...weekly, providerIds: ["opencode"] }] };
    expect(
      applyUsageLimitsUpdate({
        previous: providerScoped,
        checkedAt,
        update: { windows: [{ ...weekly, providerIds: ["console-custom"] }] },
      })?.windows[0]?.providerIds,
    ).toEqual(["console-custom"]);
    expect(
      applyUsageLimitsUpdate({
        previous: scoped,
        checkedAt,
        update: { windows: [{ ...weekly, modelIds: ["opencode/a"] }] },
      }),
    ).toBe(scoped);
    expect(
      applyUsageLimitsUpdate({
        previous: scoped,
        checkedAt,
        update: { windows: [{ ...weekly, modelIds: ["opencode/b"] }] },
      })?.windows[0]?.modelIds,
    ).toEqual(["opencode/b"]);
  });

  it("upserts by id and keeps the reset a percent-only update omits", () => {
    const next = applyUsageLimitsUpdate({
      previous: published,
      checkedAt: "2026-09-03T12:00:05.000Z",
      update: {
        windows: [{ id: "five_hour", kind: "session", label: "Session", usedPercent: 55 }],
      },
    });
    expect(next).not.toBe(published);
    expect(next).toEqual({
      checkedAt: "2026-09-03T12:00:05.000Z",
      windows: [{ ...session, usedPercent: 55 }, weekly],
    });
  });

  it("leaves an unsupported account and an empty update alone", () => {
    const unsupported = { checkedAt, windows: [], unavailable: { reason: "unsupported" as const } };
    expect(
      applyUsageLimitsUpdate({ previous: unsupported, checkedAt, update: { windows: [session] } }),
    ).toBe(unsupported);
    expect(
      applyUsageLimitsUpdate({ previous: published, checkedAt, update: { windows: [] } }),
    ).toBe(published);
  });

  it("marks a first sparse update as unavailable", () => {
    expect(
      applyUsageLimitsUpdate({ previous: undefined, checkedAt, update: { windows: [weekly] } }),
    ).toEqual({ checkedAt, windows: [weekly], unavailable: { reason: "probeFailed" } });
  });

  it("preserves reset credits and a $0 cap when a streamed window update changes usage", () => {
    const resetCredits = { availableCount: 2, nextExpiresAt: "2026-10-01T00:00:00.000Z" };
    const next = applyUsageLimitsUpdate({
      previous: { ...published, resetCredits, zeroSpendCap: true },
      checkedAt: "2026-09-03T12:00:05.000Z",
      update: { windows: [{ ...session, usedPercent: 55 }] },
    });

    expect(next).toEqual({
      checkedAt: "2026-09-03T12:00:05.000Z",
      windows: [{ ...session, usedPercent: 55 }, weekly],
      resetCredits,
      zeroSpendCap: true,
    });
  });

  it("retains rich probe metadata and the account identity on sparse stream ticks", () => {
    const updatedAt = "2026-09-03T12:00:05.000Z";
    const sparse = {
      id: "five_hour",
      kind: "session",
      label: "Session",
      usedPercent: 55,
      resetsAt: "2026-09-03T15:00:00.000Z",
    } as const;
    const next = applyUsageLimitsUpdate({
      previous: richAccount,
      checkedAt: updatedAt,
      update: { windows: [sparse] },
    });
    expect(next).toEqual({
      ...richAccount,
      checkedAt: updatedAt,
      windows: [{ ...richWindow, ...sparse }, weekly],
      credentialFingerprint: "account-identity",
      subscriptionExpiresAt: "2026-10-01T00:00:00.000Z",
      planTier: "Pro",
      balances: [{ id: "prepaid", label: "Prepaid", remaining: 6.25, unit: "USD" }],
      serviceNotice: { severity: "info", message: "Maintenance scheduled" },
    });
    expect(
      applyUsageLimitsUpdate({
        previous: next,
        checkedAt: "2026-09-03T12:00:06.000Z",
        update: { windows: [sparse] },
      }),
    ).toBe(next);
  });

  it.each([
    { usedAmount: 0, unit: "USD" },
    { remainingAmount: 0, unit: "USD" },
  ])("publishes a compatible metadata-only change to a window: %j", (patch) => {
    const next = applyUsageLimitsUpdate({
      previous: richAccount,
      checkedAt,
      update: { windows: [{ ...session, ...patch }] },
    });
    expect(next?.windows).toEqual([{ ...richWindow, ...patch }, weekly]);
  });

  it("drops incompatible inherited quantities and clocks on sparse stream ticks", () => {
    // Changing unit from USD to credits must never relabel prior 4/10 USD as 4/10 credits.
    const unitChanged = applyUsageLimitsUpdate({
      previous: richAccount,
      checkedAt,
      update: { windows: [{ ...session, unit: "credits" }] },
    });
    expect(unitChanged?.windows[0]).toEqual({
      ...session,
      unit: "credits",
      category: richWindow.category,
      scopeLabel: richWindow.scopeLabel,
    });

    // Changing capacity or scope must not carry over stale amounts from the prior limit/scope.
    const limitChanged = applyUsageLimitsUpdate({
      previous: richAccount,
      checkedAt,
      update: { windows: [{ ...session, limitAmount: 20, unit: "USD" }] },
    });
    expect(limitChanged?.windows[0]?.usedAmount).toBeUndefined();
    expect(limitChanged?.windows[0]?.remainingAmount).toBeUndefined();
    expect(limitChanged?.windows[0]?.limitAmount).toBe(20);

    const scopeChanged = applyUsageLimitsUpdate({
      previous: richAccount,
      checkedAt,
      update: { windows: [{ ...session, scopeLabel: "Models" }] },
    });
    expect(scopeChanged?.windows[0]?.usedAmount).toBeUndefined();
    expect(scopeChanged?.windows[0]?.limitAmount).toBeUndefined();
    expect(scopeChanged?.windows[0]?.scopeLabel).toBe("Models");

    // Changing window kind (e.g. Codex reusing `primary` across session vs monthly) must not borrow
    // the older window's reset clock or duration.
    const cadenceChanged = applyUsageLimitsUpdate({
      previous: richAccount,
      checkedAt,
      update: {
        windows: [{ id: "five_hour", kind: "monthly", label: "Monthly", usedPercent: 100 }],
      },
    });
    expect(cadenceChanged?.windows.find((window) => window.id === "five_hour")).toEqual({
      id: "five_hour",
      kind: "monthly",
      label: "Monthly",
      usedPercent: 100,
    });

    // Unitless amounts must never have a currency stitched onto them from a unit-only previous window.
    const unitOnlyPrev = {
      checkedAt,
      windows: [{ ...session, unit: "USD" }],
    };
    const unitlessTick = applyUsageLimitsUpdate({
      previous: unitOnlyPrev,
      checkedAt: "2026-09-03T12:00:05.000Z",
      update: { windows: [{ ...session, usedAmount: 100, limitAmount: 200 }] },
    });
    expect(unitlessTick?.windows[0]?.unit).toBeUndefined();
    expect(unitlessTick?.windows[0]?.usedAmount).toBe(100);
  });

  it("replaces explicitly supplied account metadata without replacing windows", () => {
    const patch = {
      subscriptionExpiresAt: "2026-11-01T00:00:00.000Z",
      planTier: "Max",
      balances: [],
      serviceNotice: { severity: "warning", message: "Quota maintenance" },
    } as const;
    const next = applyUsageLimitsUpdate({
      previous: richAccount,
      checkedAt,
      update: { windows: [], ...patch },
    });
    expect(next).toEqual({ ...richAccount, ...patch });
    expect(next?.windows).toBe(richAccount.windows);
  });
});

describe("resolveUsageLimitsAfterProbe", () => {
  it("uses read order for windows while taking metadata from the successful probe", () => {
    const live = {
      checkedAt: "2026-09-03T12:00:05.000Z",
      windows: [
        { ...session, usedPercent: 95 },
        { ...weekly, usedPercent: 70 },
      ],
      resetCredits: { availableCount: 2 },
      externalUsage: { label: "Old dashboard", url: "https://example.com/old" },
    };
    const probed = {
      ...published,
      windows: [{ ...session, usedPercent: 0 }],
      resetCredits: { availableCount: 1 },
      externalUsage: { label: "Usage dashboard", url: "https://example.com/usage" },
    };

    expect(resolveUsageLimitsAfterProbe({ published: live, probed })).toEqual({
      ...probed,
      checkedAt: live.checkedAt,
      windows: live.windows,
    });

    const sameTime = { ...probed, checkedAt: live.checkedAt };
    const newer = { ...probed, checkedAt: "2026-09-03T12:00:06.000Z" };
    expect(resolveUsageLimitsAfterProbe({ published: live, probed: sameTime })).toEqual(sameTime);
    expect(resolveUsageLimitsAfterProbe({ published: live, probed: newer })).toEqual(newer);
  });

  it("keeps the last good windows through a failed probe but not an unsupported one", () => {
    const failed = { checkedAt, windows: [], unavailable: { reason: "probeFailed" as const } };
    const unsupported = { checkedAt, windows: [], unavailable: { reason: "unsupported" as const } };
    expect(resolveUsageLimitsAfterProbe({ published: richAccount, probed: failed })).toBe(
      richAccount,
    );
    expect(resolveUsageLimitsAfterProbe({ published, probed: unsupported })).toBe(unsupported);
    expect(resolveUsageLimitsAfterProbe({ published: undefined, probed: failed })).toBe(failed);
  });

  it("preserves rich account fields on complete reports and merges compatible probe window metadata across a race", () => {
    const complete = makeUsageLimits({
      checkedAt,
      windows: [richWindow, weekly],
      subscriptionExpiresAt: "2026-10-01T00:00:00.000Z",
      planTier: "Pro",
      balances: [{ id: "prepaid", label: "Prepaid", remaining: 6.25, unit: "USD" }],
      serviceNotice: { severity: "info", message: "Maintenance scheduled" },
    });
    expect(complete).toMatchObject({
      subscriptionExpiresAt: "2026-10-01T00:00:00.000Z",
      planTier: "Pro",
      balances: [{ id: "prepaid", label: "Prepaid", remaining: 6.25, unit: "USD" }],
      serviceNotice: { severity: "info", message: "Maintenance scheduled" },
    });

    const fresherSparseTick = {
      checkedAt: "2026-09-03T12:00:05.000Z",
      windows: [
        { id: "five_hour", kind: "session" as const, label: "Session", usedPercent: 55 },
        { id: "seven_day", kind: "weekly" as const, label: "Weekly", usedPercent: 20 },
      ],
      serviceNotice: { severity: "warning" as const, message: "Live notice" },
    };
    const resolved = resolveUsageLimitsAfterProbe({
      published: fresherSparseTick,
      probed: {
        ...richAccount,
        serviceNotice: undefined,
      },
    });
    expect(resolved).toMatchObject({
      checkedAt: "2026-09-03T12:00:05.000Z",
      subscriptionExpiresAt: "2026-10-01T00:00:00.000Z",
      planTier: "Pro",
      serviceNotice: { severity: "warning", message: "Live notice" },
    });
    // Newer utilization wins; structural probe metadata survives without copying stale consumption amounts.
    expect(resolved?.windows[0]).toEqual({
      id: "five_hour",
      kind: "session",
      label: "Session",
      usedPercent: 55,
      resetsAt: richWindow.resetsAt,
      windowDurationMins: richWindow.windowDurationMins,
      limitAmount: richWindow.limitAmount,
      unit: richWindow.unit,
      category: richWindow.category,
      scopeLabel: richWindow.scopeLabel,
    });
    // When utilization matches, point-in-time consumption amounts also carry over.
    const samePercentResolved = resolveUsageLimitsAfterProbe({
      published: {
        checkedAt: "2026-09-03T12:00:05.000Z",
        windows: [{ id: "five_hour", kind: "session", label: "Session", usedPercent: 40 }],
      },
      probed: richAccount,
    });
    expect(samePercentResolved?.windows[0]).toEqual(richWindow);

    // Conflicting units must never inherit dependent amounts, and newer explicit clears / metadata must win.
    const clearedAndUnitChanged = resolveUsageLimitsAfterProbe({
      published: {
        checkedAt: "2026-09-03T12:00:05.000Z",
        subscriptionExpiresAt: "2026-12-01T00:00:00.000Z",
        balances: [],
        windows: [
          {
            id: "five_hour",
            kind: "session",
            label: "Session",
            usedPercent: 40,
            unit: "credits",
          },
        ],
      },
      probed: richAccount,
    });
    expect(clearedAndUnitChanged?.subscriptionExpiresAt).toBe("2026-12-01T00:00:00.000Z");
    expect(clearedAndUnitChanged?.balances).toEqual([]);
    expect(clearedAndUnitChanged?.windows[0]?.unit).toBe("credits");
    expect(clearedAndUnitChanged?.windows[0]?.usedAmount).toBeUndefined();
    expect(clearedAndUnitChanged?.windows[0]?.limitAmount).toBeUndefined();
    expect(clearedAndUnitChanged?.windows[0]?.remainingAmount).toBeUndefined();

    // Cross-cadence probe race must never borrow a stale reset from a different kind/duration.
    const crossCadenceRace = resolveUsageLimitsAfterProbe({
      published: {
        checkedAt: "2026-09-03T12:00:05.000Z",
        windows: [{ id: "five_hour", kind: "monthly", label: "Monthly", usedPercent: 100 }],
      },
      probed: {
        checkedAt,
        windows: [
          {
            id: "five_hour",
            kind: "session",
            label: "Session",
            usedPercent: 40,
            resetsAt: "2026-09-03T11:00:00.000Z",
            windowDurationMins: 300,
          },
        ],
      },
    });
    expect(crossCadenceRace?.windows[0]).toEqual({
      id: "five_hour",
      kind: "monthly",
      label: "Monthly",
      usedPercent: 100,
    });

    // Unit-only fresher report must never inherit unitless amounts from an older probe.
    const unitStitchRace = resolveUsageLimitsAfterProbe({
      published: {
        checkedAt: "2026-09-03T12:00:05.000Z",
        windows: [{ ...session, usedPercent: 50, unit: "USD" }],
      },
      probed: {
        checkedAt,
        windows: [{ ...session, usedPercent: 50, usedAmount: 100, limitAmount: 200 }],
      },
    });
    expect(unitStitchRace?.windows[0]?.unit).toBe("USD");
    expect(unitStitchRace?.windows[0]?.usedAmount).toBeUndefined();
    expect(unitStitchRace?.windows[0]?.limitAmount).toBeUndefined();
  });
});
