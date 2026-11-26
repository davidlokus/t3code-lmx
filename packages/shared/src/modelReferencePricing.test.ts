import { describe, expect, it } from "vite-plus/test";
import { estimateModelReferenceCost } from "./modelReferencePricing.ts";

const split = {
  inputTokens: 100_000,
  cachedInputTokens: 90_000,
  cacheCreationTokens: 5_000,
  outputTokens: 2_000,
};
const tokens = { inputTokens: 1_000_000, outputTokens: 1_000_000 };

describe("model reference pricing", () => {
  it("prices exactly one input class per token, even with a separate cache-write rate", () => {
    const estimate = estimateModelReferenceCost("Anthropic/Claude-Sonnet-4.6[1m]", split);
    expect(estimate).toMatchObject({ currency: "USD", source: "reference" });
    expect(estimate?.amount).toBeCloseTo(0.005 * 3 + 0.09 * 0.3 + 0.005 * 3.75 + 0.002 * 15);
    expect(estimateModelReferenceCost("gpt-4.1-2025-04-14", tokens)?.amount).toBe(10);
  });

  it("prefers explicit requested-model and resolved overrides, then reference rates", () => {
    const settings = {
      usageModelAliases: { "custom/gateway": "my-model", "my-model": "OpenAI/GPT-5" },
      usagePriceOverrides: {
        "custom/gateway": { inputCostPerMillionTokens: 10, outputCostPerMillionTokens: 15 },
        "gpt-5": { inputCostPerMillionTokens: 7, outputCostPerMillionTokens: 9 },
      },
    };
    expect(estimateModelReferenceCost("custom/gateway", tokens, settings)).toEqual({
      amount: 25,
      currency: "USD",
      source: "override",
    });
    expect(estimateModelReferenceCost("my-model", tokens, settings)).toMatchObject({
      amount: 16,
      source: "override",
    });
    expect(estimateModelReferenceCost("gpt-5", tokens)).toMatchObject({
      amount: 11.25,
      source: "reference",
    });
    expect(estimateModelReferenceCost("my-model", split, settings)?.amount).toBeCloseTo(0.718);
  });

  it("stops alias cycles and rejects a fifth hop without guessing a fallback", () => {
    const aliases = { a: "b", b: "c", c: "d", d: "gpt-5" };
    expect(estimateModelReferenceCost("a", tokens, { usageModelAliases: aliases })?.amount).toBe(
      11.25,
    );
    expect(
      estimateModelReferenceCost("e", tokens, { usageModelAliases: { ...aliases, e: "a" } }),
    ).toBeNull();
    expect(
      estimateModelReferenceCost("gpt-5", tokens, {
        usageModelAliases: { "gpt-5": "a", a: "GPT-5" },
      }),
    ).toBeNull();
  });

  it("does not guess a price for unknown variants, malformed counts, or inherited keys", () => {
    for (const model of [
      "gemini-4-invented",
      "gpt-5.3-codex-spark",
      "glm-5.4",
      "constructor",
      " ",
    ]) {
      expect(estimateModelReferenceCost(model, tokens)).toBeNull();
    }
    expect(estimateModelReferenceCost("gpt-5", { ...tokens, inputTokens: -1 })).toBeNull();
    expect(estimateModelReferenceCost("gpt-5", { ...tokens, outputTokens: Infinity })).toBeNull();
  });
});
