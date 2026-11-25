import {
  EnvironmentId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
  ServerProviderUsageLimits,
  type ServerProviderUsageWindow,
  UsageLimitSourceId,
  type UsageLimitSourceSnapshot,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import { collectLimitsIntelligence, computeWindowBurnPace } from "./usageLimitsIntelligence.ts";

const decodeUsageLimits = Schema.decodeSync(ServerProviderUsageLimits);
const checkedAt = "2026-09-03T12:00:00.000Z";
const now = Date.parse(checkedAt);
const minute = 60_000;
const day = 24 * 60 * minute;
const at = (delta: number) => DateTime.formatIso(DateTime.makeUnsafe(now + delta));

function window(id: string, usedPercent: number, resetsAt?: string): ServerProviderUsageWindow {
  return {
    id,
    usedPercent,
    kind: "session",
    label: id,
    ...(resetsAt === undefined ? {} : { resetsAt }),
  };
}

function provider(
  id: string,
  limits: ServerProviderUsageLimits,
  overrides?: Partial<ServerProvider>,
): ServerProvider {
  return {
    instanceId: ProviderInstanceId.make(id),
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
    usageLimits: limits,
    ...overrides,
  };
}

function source(
  id: string,
  overrides: Partial<UsageLimitSourceSnapshot>,
): UsageLimitSourceSnapshot {
  return {
    id: UsageLimitSourceId.make(id),
    kind: "cliproxy",
    label: id,
    checkedAt,
    accounts: [],
    ...overrides,
  };
}

function presentation(
  label: string,
  providers: readonly ServerProvider[],
  usageLimitSources: readonly UsageLimitSourceSnapshot[] = [],
) {
  return {
    entry: { target: { label } },
    serverConfig: { providers, usageLimitSources },
  };
}

const halfElapsed = { windowDurationMins: 300, resetsAt: at(150 * minute), usedPercent: 75 };

describe("computeWindowBurnPace", () => {
  it.each([
    { windowDurationMins: undefined },
    { windowDurationMins: 0 },
    { windowDurationMins: -60 },
    { resetsAt: undefined },
    { resetsAt: "not a timestamp" },
    { resetsAt: checkedAt },
    { resetsAt: at(-minute) },
  ])("does not invent a pace when the window clock is unavailable: %j", (patch) => {
    expect(computeWindowBurnPace({ ...halfElapsed, ...patch }, now)).toBeNull();
  });

  it("suppresses only early samples and zero use, allowing either minimum sample boundary", () => {
    for (const sample of [
      { ...halfElapsed, resetsAt: at(296 * minute) },
      { ...halfElapsed, usedPercent: 0 },
    ]) {
      expect(computeWindowBurnPace(sample, now)).toMatchObject({
        status: "insufficient-data",
        paceRatio: null,
        projectedUsedAtResetPercent: null,
        projectedExhaustionMs: null,
      });
    }
    expect(computeWindowBurnPace({ ...halfElapsed, resetsAt: at(295 * minute) }, now)?.status).toBe(
      "will-exhaust",
    );
    expect(
      computeWindowBurnPace(
        { ...halfElapsed, windowDurationMins: 60, resetsAt: at(57 * minute) },
        now,
      )?.status,
    ).toBe("will-exhaust");
  });

  it("projects exhaustion before the reset, not when use would hit 100% at the reset", () => {
    expect(computeWindowBurnPace(halfElapsed, now)).toEqual({
      status: "will-exhaust",
      elapsedShare: 0.5,
      expectedUsedPercent: 50,
      headroomPercent: -25,
      paceRatio: 1.5,
      projectedUsedAtResetPercent: 150,
      projectedExhaustionMs: now + 50 * minute,
    });
    expect(computeWindowBurnPace({ ...halfElapsed, usedPercent: 50 }, now)).toMatchObject({
      status: "on-pace",
      projectedUsedAtResetPercent: 100,
      projectedExhaustionMs: null,
    });
    expect(computeWindowBurnPace({ ...halfElapsed, usedPercent: 25 }, now)?.status).toBe(
      "under-pace",
    );
  });

  it("reports an actually exhausted window even when there is not enough time to estimate pace", () => {
    expect(
      computeWindowBurnPace({ ...halfElapsed, resetsAt: at(300 * minute), usedPercent: 100 }, now),
    ).toMatchObject({
      status: "exhausted",
      elapsedShare: 0,
      paceRatio: null,
      projectedUsedAtResetPercent: 100,
      projectedExhaustionMs: now,
    });
  });
});

describe("collectLimitsIntelligence", () => {
  const environment = EnvironmentId.make("host");

  it("decodes legacy payloads, preserves real zeroes, and groups past, future, and unknown resets", () => {
    const limits = decodeUsageLimits({
      checkedAt,
      windows: [
        window("unknown", 15, "invalid"),
        window("later", 95, at(7 * day + 1)),
        window("pending-refresh", 100, at(-minute)),
        window("next-week", 50, at(7 * day)),
        window("tomorrow", 0, at(day)),
        window("not-started", 0),
      ],
    });
    const snapshot = collectLimitsIntelligence({
      presentations: new Map([[environment, presentation("Host", [provider("legacy", limits)])]]),
      now,
    });
    expect(
      snapshot.resets.map(({ window, group, resetsInMs }) => [window.id, group, resetsInMs]),
    ).toEqual([
      ["pending-refresh", "next24h", 0],
      ["tomorrow", "next24h", day],
      ["next-week", "next7d", 7 * day],
      ["later", "later", 7 * day + 1],
      ["unknown", "unscheduled", null],
      ["not-started", "unscheduled", null],
    ]);
    const tomorrow = snapshot.resets.find(({ window }) => window.id === "tomorrow")?.window;
    expect(tomorrow).toMatchObject({ usedPercent: 0, remainingPercent: 100, pace: null });
    expect(tomorrow).not.toHaveProperty("usedAmount");
    expect(tomorrow).not.toHaveProperty("limitAmount");
    expect(snapshot.alerts.map(({ kind, window }) => [kind, window?.id])).toEqual([
      ["window-low", "later"],
    ]);
    expect(snapshot.expiries).toEqual([]);
    expect(snapshot.accountsWithoutExpiry.map(({ key }) => key)).toEqual([
      JSON.stringify(["native", "host", "legacy"]),
    ]);
    expect(snapshot.monthlySpendByCurrency).toEqual({});
  });

  it("deduplicates native/CLIProxyAPI identities with stable keys and evaluates HTTP accounts alongside them", () => {
    const native = provider(
      "native",
      { checkedAt, windows: [window("session", 30)] },
      {
        auth: { status: "authenticated", email: "member@example.com", workspaceId: "work" },
      },
    );
    const hub = source("hub", {
      accounts: [
        {
          id: "member.json",
          driver: native.driver,
          email: "Member@example.com",
          workspaceId: "work",
          usageLimits: { checkedAt: at(minute), windows: [window("session", 100, at(2 * day))] },
        },
      ],
    });
    const http = source("quota", {
      kind: "http",
      quotaAccounts: [
        {
          id: "west",
          label: "West",
          providerInstanceId: native.instanceId,
          windows: [window("day", 85, at(day)), window("day", 85, at(day))],
        },
      ],
    });
    const canonicalKey = JSON.stringify([
      "identity",
      "email",
      "codex",
      "member@example.com",
      "work",
    ]);
    const httpKey = JSON.stringify(["http", "host", "quota", "west"]);
    const snapshot = collectLimitsIntelligence({
      presentations: new Map([
        [environment, presentation("Host", [native], [http])],
        [EnvironmentId.make("remote"), presentation("Remote", [], [hub])],
      ]),
      now,
    });
    expect(
      snapshot.accounts.map(({ key, driver, sourceKind }) => [key, driver, sourceKind]),
    ).toEqual([
      [canonicalKey, native.driver, "native"],
      [httpKey, null, "http"],
    ]);
    expect(snapshot.resets.map(({ account, window }) => [account.key, window.pace])).toEqual([
      [httpKey, null],
      [canonicalKey, null],
    ]);
    expect(
      snapshot.alerts.map(({ severity, kind, account }) => [severity, kind, account?.key]),
    ).toEqual([
      ["critical", "window-exhausted", canonicalKey],
      ["warning", "window-low", httpKey],
    ]);
  });

  it("keeps canonical manual-override keys stable across environment filters, login swaps, and colon HTTP ids", () => {
    const desktop = provider(
      "codex-a",
      { checkedAt, windows: [window("session", 20)] },
      { auth: { status: "authenticated", email: "user@example.com", workspaceId: "ws-1" } },
    );
    const hub = source("hub", {
      accounts: [
        {
          id: "user.json",
          driver: desktop.driver,
          email: "USER@example.com",
          workspaceId: "ws-1",
          usageLimits: { checkedAt, windows: [window("session", 20)] },
        },
      ],
    });
    const both = collectLimitsIntelligence({
      presentations: new Map([
        [environment, presentation("Host", [desktop])],
        [EnvironmentId.make("remote"), presentation("Remote", [], [hub])],
      ]),
      now,
    });
    const savedKey = both.accounts[0]!.key;
    const manualOverrides = {
      [savedKey]: { expiresAt: at(5 * day), monthlyCost: 20, currency: "USD" },
    };

    // Filtering to only the hub keeps the exact same canonical key and override attached.
    const hubOnly = collectLimitsIntelligence({
      presentations: new Map([[EnvironmentId.make("remote"), presentation("Remote", [], [hub])]]),
      now,
      manualOverrides,
    });
    expect(hubOnly.accounts[0]?.key).toBe(savedKey);
    expect(hubOnly.expiries.map((item) => [item.kind, item.source])).toEqual([
      ["subscription", "manual"],
    ]);

    // Swapping the desktop instance to another email produces a distinct key so the override never leaks.
    const swappedDesktop = provider(
      "codex-a",
      { checkedAt, windows: [window("session", 20)] },
      { auth: { status: "authenticated", email: "other@example.com", workspaceId: "ws-1" } },
    );
    const afterSwap = collectLimitsIntelligence({
      presentations: new Map([[environment, presentation("Host", [swappedDesktop])]]),
      now,
      manualOverrides,
    });
    expect(afterSwap.accounts[0]?.key).not.toBe(savedKey);
    expect(afterSwap.expiries).toEqual([]);

    // HTTP sources with colons in source/account ids must never collide.
    const httpA = source("a", {
      kind: "http",
      quotaAccounts: [{ id: "b:c", label: "First", windows: [window("day", 40)] }],
    });
    const httpB = source("a:b", {
      kind: "http",
      quotaAccounts: [{ id: "c", label: "Second", windows: [window("day", 50)] }],
    });
    const colonSnapshot = collectLimitsIntelligence({
      presentations: new Map([[environment, presentation("Host", [], [httpA, httpB])]]),
      now,
    });
    expect(colonSnapshot.accounts).toHaveLength(2);
    expect(new Set(colonSnapshot.accounts.map((account) => account.key)).size).toBe(2);
  });

  it("preserves provider metadata and compatible rich window fields across mixed-fleet dedup", () => {
    const rich = provider(
      "upgraded",
      {
        checkedAt,
        subscriptionExpiresAt: at(10 * day),
        planTier: "Pro Team",
        balances: [
          { id: "extra", label: "Extra", remaining: 12, unit: "USD", expiresAt: at(4 * day) },
        ],
        windows: [
          {
            ...window("session", 40, at(3 * 60 * minute)),
            windowDurationMins: 300,
            usedAmount: 4,
            limitAmount: 10,
            remainingAmount: 6,
            unit: "USD",
            category: "plan",
            scopeLabel: "Workspace",
          },
        ],
      },
      { auth: { status: "authenticated", email: "fleet@example.com", workspaceId: "w" } },
    );
    // Fresher legacy hub omits all optional fields and reports newer utilization.
    const fresherLegacy = source("legacy-hub", {
      accounts: [
        {
          id: "fleet.json",
          driver: rich.driver,
          email: "fleet@example.com",
          workspaceId: "w",
          usageLimits: {
            checkedAt: at(minute),
            windows: [window("session", 55)],
          },
        },
      ],
    });
    // Metadata-only report on a third host carries a service notice.
    const noticeHost = provider(
      "notice-only",
      {
        checkedAt: at(2 * minute),
        windows: [],
        serviceNotice: { severity: "warning", message: "Degraded quota API" },
      },
      { auth: { status: "authenticated", email: "fleet@example.com", workspaceId: "w" } },
    );
    const fleetKey = JSON.stringify(["identity", "email", "codex", "fleet@example.com", "w"]);
    const snapshot = collectLimitsIntelligence({
      presentations: new Map([
        [environment, presentation("Upgraded", [rich])],
        [EnvironmentId.make("legacy"), presentation("Legacy", [], [fresherLegacy])],
        [EnvironmentId.make("meta"), presentation("Meta", [noticeHost])],
      ]),
      now,
      manualOverrides: { [fleetKey]: { expiresAt: at(2 * day) } },
    });
    expect(snapshot.accounts).toHaveLength(1);
    const account = snapshot.accounts[0]!;
    // Fresher utilization wins, while compatible structural fields & provider metadata survive.
    expect(account.windows[0]).toMatchObject({
      usedPercent: 55,
      windowDurationMins: 300,
      limitAmount: 10,
      unit: "USD",
      category: "plan",
      scopeLabel: "Workspace",
    });
    expect(account.windows[0]?.usedAmount).toBeUndefined();
    expect(account.limits.subscriptionExpiresAt).toBe(at(10 * day));
    expect(account.limits.balances).toHaveLength(1);
    expect(account.limits.serviceNotice?.message).toBe("Degraded quota API");
    // Provider expiry must still beat the manual override even when the freshest host was legacy.
    const subExpiry = snapshot.expiries.find((item) => item.kind === "subscription");
    expect(subExpiry).toMatchObject({ source: "provider", expiresAtMs: Date.parse(at(10 * day)) });
    expect(snapshot.alerts.some((alert) => alert.kind === "service-notice")).toBe(true);
  });

  it("suppresses the duplicate Cursor totalPercentUsed alias alongside autoPercentUsed", () => {
    const cursor = provider(
      "cursor-main",
      {
        checkedAt,
        windows: [
          {
            id: "totalPercentUsed",
            kind: "monthly",
            label: "Overall",
            usedPercent: 90,
            resetsAt: at(day),
          },
          {
            id: "autoPercentUsed",
            kind: "monthly",
            label: "Auto",
            usedPercent: 90,
            resetsAt: at(day),
          },
        ],
      },
      { driver: ProviderDriverKind.make("cursor") },
    );
    const snapshot = collectLimitsIntelligence({
      presentations: new Map([[environment, presentation("Host", [cursor])]]),
      now,
    });
    expect(snapshot.accounts[0]?.windows.map((w) => w.id)).toEqual(["autoPercentUsed"]);
    expect(snapshot.resets).toHaveLength(1);
    expect(snapshot.alerts).toHaveLength(1);
  });

  it("keeps workspace-less hub overrides stable via identityPresentations, guards conflicting units, respects empty balance clears, and retains manual overrides on unsupported accounts", () => {
    const desktop = provider(
      "codex-org",
      { checkedAt, windows: [window("session", 20)] },
      { auth: { status: "authenticated", email: "shared@example.com", workspaceId: "org" } },
    );
    // Hub omits workspaceId (allowed by CLIProxyAPI) while reporting the same login email.
    const hubNoWs = source("hub", {
      accounts: [
        {
          id: "shared.json",
          driver: desktop.driver,
          email: "shared@example.com",
          usageLimits: { checkedAt, windows: [window("session", 20)] },
        },
      ],
    });
    const fullFleet = new Map([
      [environment, presentation("Desktop", [desktop])],
      [EnvironmentId.make("hub-env"), presentation("Hub", [], [hubNoWs])],
    ]);
    const allView = collectLimitsIntelligence({ presentations: fullFleet, now });
    const savedKey = allView.accounts[0]!.key;
    expect(savedKey).toBe(
      JSON.stringify(["identity", "email", "codex", "shared@example.com", "org"]),
    );
    const manualOverrides = {
      [savedKey]: { expiresAt: at(10 * day), monthlyCost: 20, currency: "USD" },
    };

    // Filtering to only the workspace-less hub route still resolves the same key when identityPresentations is passed.
    const hubFiltered = collectLimitsIntelligence({
      presentations: new Map([[EnvironmentId.make("hub-env"), presentation("Hub", [], [hubNoWs])]]),
      identityPresentations: fullFleet,
      now,
      manualOverrides,
    });
    expect(hubFiltered.accounts[0]?.key).toBe(savedKey);
    expect(hubFiltered.monthlySpendByCurrency).toEqual({ USD: 20 });
    expect(hubFiltered.expiries.map((item) => [item.kind, item.source])).toEqual([
      ["subscription", "manual"],
    ]);

    // Conflicting units must never inherit credits amounts onto a USD window, and an explicit fresh
    // `balances: []` must not resurrect an older expiring balance.
    const olderCredits = provider(
      "older",
      {
        checkedAt,
        balances: [{ id: "old-bal", label: "Old", remaining: 5, unit: "USD", expiresAt: at(day) }],
        windows: [
          {
            ...window("session", 50, at(3 * 60 * minute)),
            usedAmount: 100,
            limitAmount: 200,
            remainingAmount: 100,
            unit: "credits",
          },
        ],
      },
      { auth: { status: "authenticated", email: "unit@example.com", workspaceId: "w" } },
    );
    const newerUsdCleared = provider(
      "newer",
      {
        checkedAt: at(minute),
        balances: [],
        windows: [{ ...window("session", 50, at(3 * 60 * minute)), unit: "USD" }],
      },
      { auth: { status: "authenticated", email: "unit@example.com", workspaceId: "w" } },
    );
    const conflictSnapshot = collectLimitsIntelligence({
      presentations: new Map([
        [environment, presentation("A", [olderCredits])],
        [EnvironmentId.make("b"), presentation("B", [newerUsdCleared])],
      ]),
      now,
    });
    expect(conflictSnapshot.accounts[0]?.windows[0]).toMatchObject({
      usedPercent: 50,
      unit: "USD",
    });
    expect(conflictSnapshot.accounts[0]?.windows[0]?.usedAmount).toBeUndefined();
    expect(conflictSnapshot.accounts[0]?.windows[0]?.limitAmount).toBeUndefined();
    expect(conflictSnapshot.accounts[0]?.limits.balances).toEqual([]);
    expect(conflictSnapshot.expiries).toEqual([]);
    expect(conflictSnapshot.alerts.some((a) => a.kind === "balance-expiring")).toBe(false);

    // An identifiable account that later reports `unsupported` still exposes its saved manual renewal
    // without making its quota readable or raising probe-failed alerts.
    const unsupportedKey = JSON.stringify(["identity", "email", "codex", "gone@example.com", null]);
    const gone = provider(
      "gone",
      { checkedAt, windows: [], unavailable: { reason: "unsupported" } },
      { auth: { status: "authenticated", email: "gone@example.com" } },
    );
    const unsupportedSnap = collectLimitsIntelligence({
      presentations: new Map([[environment, presentation("Host", [gone])]]),
      now,
      manualOverrides: {
        [unsupportedKey]: { expiresAt: at(15 * day), monthlyCost: 30, currency: "USD" },
      },
    });
    expect(unsupportedSnap.accounts).toHaveLength(1);
    expect(unsupportedSnap.accounts[0]?.windows).toEqual([]);
    expect(unsupportedSnap.resets).toEqual([]);
    expect(unsupportedSnap.alerts).toEqual([]);
    expect(unsupportedSnap.monthlySpendByCurrency).toEqual({ USD: 30 });
    expect(unsupportedSnap.expiries.map((e) => [e.kind, e.source, e.account.key])).toEqual([
      ["subscription", "manual", unsupportedKey],
    ]);
  });

  it("rejects cross-cadence clock borrowing, refuses unit/unitless stitching, and avoids local hub key collisions", () => {
    // Codex reuses `primary` for 5-hour session and monthly plans. A fresh 100% monthly `primary`
    // without resetsAt must keep its window-exhausted alert instead of borrowing a passed 5-hour reset.
    const olderSession = provider(
      "old-session",
      {
        checkedAt,
        windows: [
          {
            id: "primary",
            kind: "session",
            label: "Session",
            usedPercent: 40,
            resetsAt: at(-minute),
            windowDurationMins: 300,
          },
        ],
      },
      { auth: { status: "authenticated", email: "cadence@example.com", workspaceId: "w" } },
    );
    const fresherMonthly = provider(
      "new-monthly",
      {
        checkedAt: at(minute),
        windows: [{ id: "primary", kind: "monthly", label: "Monthly", usedPercent: 100 }],
      },
      { auth: { status: "authenticated", email: "cadence@example.com", workspaceId: "w" } },
    );
    const cadenceSnap = collectLimitsIntelligence({
      presentations: new Map([
        [environment, presentation("Old", [olderSession])],
        [EnvironmentId.make("fresh"), presentation("Fresh", [fresherMonthly])],
      ]),
      now,
    });
    expect(cadenceSnap.accounts[0]?.windows[0]?.resetsAt).toBeUndefined();
    expect(cadenceSnap.accounts[0]?.windows[0]?.windowDurationMins).toBeUndefined();
    expect(cadenceSnap.alerts.map((a) => [a.severity, a.kind])).toEqual([
      ["critical", "window-exhausted"],
    ]);

    // Never stitch a currency from a unit-only report onto unitless amounts from another report.
    const unitlessOlder = provider(
      "unitless",
      {
        checkedAt,
        windows: [{ ...window("session", 50, at(day)), usedAmount: 100, limitAmount: 200 }],
      },
      { auth: { status: "authenticated", email: "stitch@example.com", workspaceId: "w" } },
    );
    const unitOnlyNewer = provider(
      "unit-only",
      {
        checkedAt: at(minute),
        windows: [{ ...window("session", 50, at(day)), unit: "USD" }],
      },
      { auth: { status: "authenticated", email: "stitch@example.com", workspaceId: "w" } },
    );
    const stitchSnap = collectLimitsIntelligence({
      presentations: new Map([
        [environment, presentation("Unitless", [unitlessOlder])],
        [EnvironmentId.make("unit-only"), presentation("UnitOnly", [unitOnlyNewer])],
      ]),
      now,
    });
    expect(stitchSnap.accounts[0]?.windows[0]?.unit).toBe("USD");
    expect(stitchSnap.accounts[0]?.windows[0]?.usedAmount).toBeUndefined();
    expect(stitchSnap.accounts[0]?.windows[0]?.limitAmount).toBeUndefined();

    // Local CLIProxyAPI fallback keys encode (environmentId, sourceId) as a nested tuple so colons never collide.
    const localHubA = source("hub", {
      endpoint: "http://127.0.0.1:8317",
      accounts: [
        {
          id: "codex.json",
          driver: ProviderDriverKind.make("codex"),
          usageLimits: { checkedAt, windows: [window("session", 30)] },
        },
      ],
    });
    const localHubB = source("west:hub", {
      endpoint: "http://127.0.0.1:8317",
      accounts: [
        {
          id: "codex.json",
          driver: ProviderDriverKind.make("codex"),
          usageLimits: { checkedAt, windows: [window("session", 40)] },
        },
      ],
    });
    const localCollisionSnap = collectLimitsIntelligence({
      presentations: new Map([
        [EnvironmentId.make("desk:west"), presentation("Desk West", [], [localHubA])],
        [EnvironmentId.make("desk"), presentation("Desk", [], [localHubB])],
      ]),
      now,
    });
    expect(localCollisionSnap.accounts).toHaveLength(2);
    expect(new Set(localCollisionSnap.accounts.map((a) => a.key)).size).toBe(2);
  });

  it("keeps separate workspaces and environment-local HTTP sources apart", () => {
    const limits = { checkedAt, windows: [window("weekly", 90)] };
    const first = provider("first", limits, {
      auth: { status: "authenticated", email: "same@example.com", workspaceId: "one" },
    });
    const second = provider("second", limits, {
      auth: { status: "authenticated", email: "same@example.com", workspaceId: "two" },
    });
    const http = source("quota", {
      kind: "http",
      quotaAccounts: [{ id: "same", label: "Same", windows: [window("day", 85)] }],
    });
    const snapshot = collectLimitsIntelligence({
      presentations: new Map([
        [environment, presentation("Host", [first], [http])],
        [EnvironmentId.make("remote"), presentation("Remote", [second], [http])],
      ]),
      now,
    });
    expect(snapshot.alerts.map(({ account }) => account?.key)).toEqual([
      JSON.stringify(["identity", "email", "codex", "same@example.com", "one"]),
      JSON.stringify(["identity", "email", "codex", "same@example.com", "two"]),
      JSON.stringify(["http", "host", "quota", "same"]),
      JSON.stringify(["http", "remote", "quota", "same"]),
    ]);
  });

  it("merges burn and threshold alerts and ranks severity before remaining quota", () => {
    const p = provider("pace", {
      checkedAt,
      windows: [
        { ...window("fast", 85, halfElapsed.resetsAt), windowDurationMins: 300 },
        window("healthy", 30),
        window("warning", 85),
        window("emptied", 100),
        window("extra-warning", 81),
        window("under-threshold", 79),
      ],
      serviceNotice: { message: "Scheduled maintenance" },
    });
    const presentations = new Map([[environment, presentation("Host", [p])]]);
    const snapshot = collectLimitsIntelligence({ presentations, now, alertThresholdPercent: 80 });
    expect(
      snapshot.alerts.map(({ severity, kind, window }) => [severity, kind, window?.id]),
    ).toEqual([
      ["critical", "window-exhausted", "emptied"],
      ["critical", "burn-exhaustion", "fast"],
      ["warning", "window-low", "warning"],
      ["warning", "window-low", "extra-warning"],
      ["info", "service-notice", undefined],
    ]);
    expect(snapshot.alerts[1]?.window?.pace?.projectedExhaustionMs).toBeLessThan(
      Date.parse(halfElapsed.resetsAt),
    );
    expect(snapshot.summary).toMatchObject({
      criticalAlertCount: 2,
      warningAlertCount: 2,
      infoAlertCount: 1,
    });
    expect(
      collectLimitsIntelligence({ presentations, now, alertThresholdPercent: 500 }).alerts.filter(
        ({ severity }) => severity === "warning",
      ),
    ).toEqual([]);
  });

  it("sorts real expiries, gives the provider precedence, and sums only visible positive costs in known currencies", () => {
    const credits = {
      availableCount: 2,
      nextExpiresAt: at(2 * day),
      options: [
        {
          creditId: "a",
          label: "Weekly credits",
          description: "Weekly allowance",
          availableCount: 1,
          expiresAt: at(2 * day),
        },
        {
          creditId: "b",
          label: "Monthly credits",
          description: "Monthly allowance",
          availableCount: 1,
          expiresAt: at(7 * day),
        },
        {
          creditId: "c",
          label: "Unbanked",
          description: "No credits",
          availableCount: 0,
          expiresAt: at(day),
        },
      ],
    };
    const paid = provider("paid", {
      checkedAt,
      windows: [window("weekly", 30)],
      subscriptionExpiresAt: at(-day),
      planTier: "Provider plan",
      resetCredits: credits,
    });
    const prepaid = provider("prepaid", {
      checkedAt,
      windows: [],
      balances: [
        {
          id: "retired",
          label: "Past balance",
          unit: "USD",
          remaining: 0,
          expiresAt: at(-2 * day),
        },
        {
          id: "upcoming",
          label: "Expiring balance",
          unit: "credits",
          remaining: 7.5,
          expiresAt: at(5 * day),
        },
        { id: "undated", label: "Undated balance", unit: "USD", remaining: 9 },
      ],
    });
    const manual = provider("manual", { checkedAt, windows: [window("weekly", 30)] });
    const missing = provider("missing", { checkedAt, windows: [window("weekly", 30)] });
    const common = {
      presentations: new Map([
        [environment, presentation("Host", [paid, prepaid, manual, missing])],
      ]),
      now,
    };
    const paidKey = JSON.stringify(["native", "host", "paid"]);
    const manualKey = JSON.stringify(["native", "host", "manual"]);
    const prepaidKey = JSON.stringify(["native", "host", "prepaid"]);
    const missingKey = JSON.stringify(["native", "host", "missing"]);
    const hiddenKey = JSON.stringify(["native", "host", "hidden"]);
    const snapshot = collectLimitsIntelligence({
      ...common,
      manualOverrides: {
        [paidKey]: {
          expiresAt: at(day),
          monthlyCost: 10,
          currency: "USD",
          planLabel: "Manual plan",
        },
        [manualKey]: {
          expiresAt: at(day),
          monthlyCost: 25,
          currency: "EUR",
          planLabel: "Manual plan",
        },
        [prepaidKey]: { monthlyCost: 5, currency: "USD" },
        [missingKey]: { expiresAt: "not a timestamp", monthlyCost: 12 },
        [hiddenKey]: { monthlyCost: 100, currency: "USD" },
      },
    });
    expect(
      snapshot.expiries.map(({ kind, source, account, expiresAtMs }) => [
        kind,
        source,
        account.key,
        expiresAtMs - now,
      ]),
    ).toEqual([
      ["balance", "provider", prepaidKey, -2 * day],
      ["subscription", "provider", paidKey, -day],
      ["subscription", "manual", manualKey, day],
      ["reset-credit", "provider", paidKey, 2 * day],
      ["balance", "provider", prepaidKey, 5 * day],
      ["reset-credit", "provider", paidKey, 7 * day],
    ]);
    expect(snapshot.expiries[1]?.label).toBe("Provider plan");
    expect(snapshot.expiries[2]?.label).toBe("Manual plan");
    expect(snapshot.alerts.map(({ severity, kind }) => [severity, kind])).toEqual([
      ["critical", "subscription-expiring"],
      ["critical", "subscription-expiring"],
      ["critical", "credit-expiring"],
      ["warning", "balance-expiring"],
      ["warning", "credit-expiring"],
    ]);
    expect(snapshot.accountsWithoutExpiry.map(({ key }) => key)).toEqual([prepaidKey, missingKey]);
    expect(snapshot.monthlySpendByCurrency).toEqual({ USD: 15, EUR: 25 });
    expect(
      collectLimitsIntelligence(common).expiries.some(({ account }) => account.key === manualKey),
    ).toBe(false);
  });

  it("surfaces probe and service notices without fabricating quota for failed accounts", () => {
    const failure = {
      checkedAt,
      windows: [],
      unavailable: { reason: "probeFailed", message: "Read failed" },
    } as const;
    const native = provider("native-failure", failure);
    const notice = provider("service", {
      checkedAt,
      windows: [],
      serviceNotice: { severity: "critical", message: "Quota service down" },
    });
    const unsupported = provider("not-subscribed", {
      checkedAt,
      windows: [],
      unavailable: { reason: "unsupported" },
    });
    const hub = source("hub", {
      accounts: [{ id: "hub-failure.json", driver: native.driver, usageLimits: failure }],
    });
    const http = source("quota", { kind: "http", error: "Timed out" });
    const working = provider(
      "working",
      { checkedAt, windows: [window("session", 40)] },
      {
        auth: { status: "authenticated", email: "shared@example.com", workspaceId: "work" },
      },
    );
    const otherRead = source("other-route", {
      accounts: [
        {
          id: "other.json",
          driver: working.driver,
          email: "shared@example.com",
          usageLimits: failure,
        },
      ],
    });
    const snapshot = collectLimitsIntelligence({
      presentations: new Map([
        [
          environment,
          presentation("Host", [native, notice, unsupported, working], [hub, http, otherRead]),
        ],
      ]),
      now,
    });
    expect(snapshot.resets.map(({ account }) => account.key)).toEqual([
      JSON.stringify(["identity", "email", "codex", "shared@example.com", "work"]),
    ]);
    expect(
      snapshot.alerts.map(({ severity, kind, account, sourceLabel, message }) => [
        severity,
        kind,
        account?.key ?? sourceLabel,
        message,
      ]),
    ).toEqual([
      [
        "critical",
        "service-notice",
        JSON.stringify(["native", "host", "service"]),
        "Quota service down",
      ],
      ["warning", "probe-failed", "quota", "Timed out"],
      [
        "warning",
        "probe-failed",
        JSON.stringify(["native", "host", "native-failure"]),
        "Read failed",
      ],
      [
        "warning",
        "probe-failed",
        JSON.stringify(["cliproxy", ["local", "host", "hub"], "hub-failure.json", null]),
        "Read failed",
      ],
    ]);
  });
});
