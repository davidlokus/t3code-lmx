import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import { GrokUsageResponse, grokUsageResponseToLimits } from "./usageLimits.ts";

const checkedAt = "2026-09-16T00:00:00.000Z";
const decodeBilling = Schema.decodeUnknownSync(GrokUsageResponse);

describe("grokUsageResponseToLimits", () => {
  it.each([
    { tier: { subscription_tier_display: "  SuperGrok " }, planTier: "SuperGrok" },
    { tier: { subscription_tier_display: " " } },
    { tier: {} },
  ])("maps billing with optional tier metadata: $tier", ({ tier, planTier }) => {
    const response = decodeBilling({ ...tier, config: { creditUsagePercent: 37 } });
    expect(grokUsageResponseToLimits(response, checkedAt)).toEqual({
      checkedAt,
      windows: [
        {
          id: "subscription",
          kind: "other",
          label: "Subscription",
          category: "plan",
          usedPercent: 37,
        },
      ],
      ...(planTier ? { planTier } : {}),
    });
  });

  it("keeps a reported tier when billing does not report a quota", () => {
    const response = decodeBilling({ subscription_tier_display: "SuperGrok" });
    expect(grokUsageResponseToLimits(response, checkedAt)).toEqual({
      checkedAt,
      windows: [],
      planTier: "SuperGrok",
    });
  });
});
