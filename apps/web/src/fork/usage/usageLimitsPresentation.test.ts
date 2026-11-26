import { ProviderDriverKind } from "@t3tools/contracts";
import type {
  NormalizedLimitAccount,
  NormalizedLimitWindow,
} from "@t3tools/shared/usageLimitsIntelligence";
import { describe, expect, it } from "vite-plus/test";

import {
  accountRiskTier,
  dedupeWindowScopeLabel,
  effectiveWindowTone,
  groupAccountsByPlatformPool,
  resolveAccountHeaderMeta,
  restrainedBarClass,
  restrainedTextClass,
  sortAccountsByRisk,
} from "./usageLimitsPresentation";

const NOW = Date.parse("2099-06-15T10:00:00.000Z");

function makeWindow(overrides: Partial<NormalizedLimitWindow> = {}): NormalizedLimitWindow {
  const usedPercent = overrides.usedPercent ?? 10;
  const remainingPercent = overrides.remainingPercent ?? Math.max(0, 100 - usedPercent);
  return {
    id: "primary",
    kind: "session",
    label: "5 Hours",
    usedPercent,
    remainingPercent,
    resetsAt: "2099-06-15T15:00:00.000Z",
    resetsAtMs: Date.parse("2099-06-15T15:00:00.000Z"),
    resetsInMs: 5 * 3_600_000,
    pace: null,
    ...overrides,
  };
}

function makeAccount(overrides: Partial<NormalizedLimitAccount> = {}): NormalizedLimitAccount {
  return {
    key: "acct-1",
    driver: ProviderDriverKind.make("codex"),
    sourceKind: "omp",
    displayName: null,
    email: "dev@example.com",
    plan: "pro",
    accentColor: undefined,
    environments: [],
    sourceLabel: "OMP Local Cache",
    redeem: null,
    limits: { checkedAt: "2099-06-15T10:00:00.000Z", windows: [] },
    windows: [makeWindow()],
    manualOverride: undefined,
    ...overrides,
  };
}

describe("usageLimitsPresentation", () => {
  it("uses restrained neutral styling for healthy accounts and reserves warning/error for risk", () => {
    const healthy = makeWindow({ usedPercent: 10, remainingPercent: 90, pace: null });
    const fastBurn = makeWindow({
      usedPercent: 11,
      remainingPercent: 89,
      pace: {
        status: "will-exhaust",
        elapsedShare: 0.05,
        expectedUsedPercent: 5,
        headroomPercent: -6,
        paceRatio: 2.41,
        projectedUsedAtResetPercent: 220,
        projectedExhaustionMs: NOW + 2 * 86_400_000,
      },
    });
    const exhausted = makeWindow({ usedPercent: 100, remainingPercent: 0 });

    expect(effectiveWindowTone(healthy)).toBe("normal");
    expect(restrainedBarClass("normal")).toBe("bg-foreground/35");
    expect(restrainedTextClass("normal")).toBe("text-foreground");

    expect(effectiveWindowTone(fastBurn)).toBe("warning");
    expect(restrainedBarClass("warning")).toBe("bg-warning");

    expect(effectiveWindowTone(exhausted)).toBe("error");
    expect(restrainedBarClass("error")).toBe("bg-error");
  });

  it("deduplicates redundant source badges and repeated window scope labels", () => {
    const ompCodex = makeAccount({
      driver: ProviderDriverKind.make("codex"),
      sourceKind: "omp",
      plan: "pro",
      sourceLabel: "OMP Local Cache",
    });
    const ompMeta = resolveAccountHeaderMeta(ompCodex, "OMP cache");
    expect(ompMeta).toEqual({
      displayLabel: "Codex",
      planBadge: "pro",
      sourceBadgeKind: null,
      whereText: "OMP Local Cache",
    });

    const ollama = makeAccount({
      key: "ollama-1",
      driver: null,
      sourceKind: "ollama",
      displayName: "Ollama Cloud",
      plan: "Pro",
      sourceLabel: "Ollama Cloud",
    });
    expect(resolveAccountHeaderMeta(ollama, "Ollama Cloud")).toEqual({
      displayLabel: "Ollama Cloud",
      planBadge: "Pro",
      sourceBadgeKind: null,
      whereText: null,
    });

    const copilot = makeAccount({
      key: "copilot-1",
      driver: null,
      sourceKind: "copilot",
      displayName: "Copilot Pro",
      plan: "Pro",
      sourceLabel: "GitHub Copilot",
    });
    expect(resolveAccountHeaderMeta(copilot, "GitHub Copilot")).toEqual({
      displayLabel: "Copilot Pro",
      planBadge: "Pro",
      sourceBadgeKind: null,
      whereText: "GitHub Copilot",
    });

    expect(
      dedupeWindowScopeLabel("Muse Code Power Usage", {
        displayLabel: "Muse Code",
        plan: "Muse Code Power Usage",
        windowLabel: "5 Hours",
      }),
    ).toBeNull();
    expect(
      dedupeWindowScopeLabel("Opus models", {
        displayLabel: "Claude",
        plan: "Max",
        windowLabel: "Weekly",
      }),
    ).toBe("Opus models");

    // Substring collisions like "company" containing "omp" must NOT suppress the OMP badge.
    const companyOmp = makeAccount({
      key: "company-omp",
      sourceKind: "omp",
      sourceLabel: "Acme Company",
    });
    expect(resolveAccountHeaderMeta(companyOmp, "OMP cache").sourceBadgeKind).toBe("omp");
  });

  it("sorts accounts risk-first: critical > warning/fast-burn > active > untouched healthy, preferring scheduled resets on ties", () => {
    const unscheduled = makeAccount({
      key: "unscheduled",
      windows: [
        makeWindow({
          usedPercent: 20,
          remainingPercent: 80,
          resetsAt: undefined,
          resetsAtMs: null,
        }),
      ],
    });
    const scheduled = makeAccount({
      key: "scheduled",
      windows: [makeWindow({ usedPercent: 20, remainingPercent: 80, resetsAtMs: NOW + 3_600_000 })],
    });
    expect(sortAccountsByRisk([unscheduled, scheduled]).map((a) => a.key)).toEqual([
      "scheduled",
      "unscheduled",
    ]);
    const untouched = makeAccount({
      key: "healthy",
      windows: [makeWindow({ usedPercent: 0, remainingPercent: 100 })],
    });
    const active = makeAccount({
      key: "active",
      windows: [makeWindow({ usedPercent: 20, remainingPercent: 80 })],
    });
    const fastBurn = makeAccount({
      key: "burn",
      windows: [
        makeWindow({
          usedPercent: 11,
          remainingPercent: 89,
          pace: {
            status: "will-exhaust",
            elapsedShare: 0.05,
            expectedUsedPercent: 5,
            headroomPercent: -6,
            paceRatio: 2.41,
            projectedUsedAtResetPercent: 220,
            projectedExhaustionMs: NOW + 86_400_000,
          },
        }),
      ],
    });
    const critical = makeAccount({
      key: "critical",
      windows: [makeWindow({ usedPercent: 95, remainingPercent: 5 })],
    });

    expect(accountRiskTier(untouched)).toBe(0);
    expect(accountRiskTier(active)).toBe(1);
    expect(accountRiskTier(fastBurn)).toBe(2);
    expect(accountRiskTier(critical)).toBe(3);

    expect(sortAccountsByRisk([untouched, active, fastBurn, critical]).map((a) => a.key)).toEqual([
      "critical",
      "burn",
      "active",
      "healthy",
    ]);
  });

  it("groups multi-account providers and external quota sources into unified platform pools", () => {
    const cursor1 = makeAccount({
      key: "cursor-1",
      driver: ProviderDriverKind.make("cursor"),
      plan: undefined,
      windows: [
        makeWindow({
          id: "auto",
          kind: "monthly",
          label: "Cursor Models",
          usedPercent: 40,
          remainingPercent: 60,
          resetsAtMs: NOW + 2 * 86_400_000,
        }),
      ],
    });
    const cursor2 = makeAccount({
      key: "cursor-2",
      driver: ProviderDriverKind.make("cursor"),
      plan: undefined,
      windows: [
        makeWindow({
          id: "auto",
          kind: "monthly",
          label: "Cursor Models",
          usedPercent: 0,
          remainingPercent: 100,
          resetsAtMs: NOW + 10 * 86_400_000,
        }),
      ],
    });
    const httpPool = makeAccount({
      key: "http-1",
      driver: null,
      sourceKind: "http",
      displayName: "Shared Pool",
      plan: undefined,
      sourceLabel: "Team Gateway",
      windows: [
        makeWindow({
          id: "daily",
          kind: "other",
          label: "Daily cap",
          usedPercent: 92,
          remainingPercent: 8,
        }),
      ],
    });

    const groups = groupAccountsByPlatformPool([cursor1, cursor2, httpPool], NOW);
    expect(groups).toHaveLength(2);
    expect(groups[0]?.label).toBe("Cursor");
    expect(groups[0]?.accounts).toHaveLength(2);
    expect(groups[0]?.windows[0]).toMatchObject({
      label: "Cursor Models",
      remainingPercent: 80,
      usedPercent: 20,
      nextRefillPercent: 20,
    });
    expect(groups[1]?.label).toBe("Team Gateway");
    expect(groups[1]?.riskTier).toBe(3);

    // Distinct window IDs sharing a human label must stay separate rather than silently merging.
    const sameLabelAccount = makeAccount({
      key: "claude-split",
      driver: ProviderDriverKind.make("claudeAgent"),
      windows: [
        makeWindow({
          id: "weekly_opus",
          kind: "weekly",
          label: "Weekly",
          usedPercent: 90,
          remainingPercent: 10,
        }),
        makeWindow({
          id: "weekly_sonnet",
          kind: "weekly",
          label: "Weekly",
          usedPercent: 10,
          remainingPercent: 90,
        }),
      ],
    });
    const splitGroups = groupAccountsByPlatformPool([sameLabelAccount], NOW);
    expect(splitGroups[0]?.windows).toHaveLength(2);
    expect(splitGroups[0]?.windows.map((w) => w.remainingPercent)).toEqual([10, 90]);
  });
});
