import type { UsageModelPriceOverride } from "@t3tools/contracts";

export interface ReferenceCostTokenCounts {
  readonly inputTokens: number;
  readonly cachedInputTokens?: number | undefined;
  readonly cacheCreationTokens?: number | undefined;
  readonly outputTokens: number;
}

export interface ReferenceCostEstimate {
  readonly amount: number;
  readonly currency: "USD";
  readonly source: "override" | "reference";
}

type PricingSettings = {
  readonly usageModelAliases?: Readonly<Record<string, string>> | undefined;
  readonly usagePriceOverrides?: Readonly<Record<string, UsageModelPriceOverride>> | undefined;
};

type Rates = readonly [input: number, output: number, cacheRead?: number, cacheWrite?: number];

const CLAUDE_OPUS: Rates = [5, 25, 0.5, 6.25];
const CLAUDE_OPUS_4: Rates = [15, 75, 1.5, 18.75];
const CLAUDE_SONNET: Rates = [3, 15, 0.3, 3.75];
const GPT_5: Rates = [1.25, 10, 0.125];
const GPT_5_2: Rates = [1.75, 14, 0.175];
const GEMINI_4: Rates = [4, 20, 0.2];
const GEMINI_3_PRO: Rates = [2, 12, 0.2];
const KIMI_K2: Rates = [0.6, 2.5, 0.15];
const GLM_4: Rates = [0.6, 2.2, 0.11];
const GLM_5: Rates = [1.4, 4.4, 0.26];
const GROK_4_FAST: Rates = [0.2, 0.5, 0.05];

// Standard USD per million tokens: base context tier, shortest cache-write tier, no promotions.
// Retired IDs retain their historical reference; this catalog does not predict vendor routing or invoices.
const REFERENCE_RATES: Readonly<Record<string, Rates>> = {
  // platform.claude.com/docs/en/about-claude/pricing
  "claude-opus-4-6": CLAUDE_OPUS,
  "claude-opus-4-5": CLAUDE_OPUS,
  "claude-opus-4-1": CLAUDE_OPUS_4,
  "claude-opus-4": CLAUDE_OPUS_4,
  "claude-sonnet-4-6": CLAUDE_SONNET,
  "claude-sonnet-4-5": CLAUDE_SONNET,
  "claude-sonnet-4": CLAUDE_SONNET,
  "claude-haiku-4-5": [1, 5, 0.1, 1.25],
  "claude-3-7-sonnet": CLAUDE_SONNET,
  "claude-3-5-sonnet": CLAUDE_SONNET,
  "claude-3-5-haiku": [0.8, 4, 0.08, 1],
  // developers.openai.com/api/docs/pricing
  "gpt-5.6": [5, 30, 0.5, 6.25],
  "gpt-5.6-sol": [5, 30, 0.5, 6.25],
  "gpt-5.6-terra": [2, 12, 0.2, 2.5],
  "gpt-5.6-luna": [0.2, 1.2, 0.02, 0.25],
  "gpt-5.5": [5, 30, 0.5],
  "gpt-5.5-pro": [30, 180],
  "gpt-5.4": [2.5, 15, 0.25],
  "gpt-5.4-pro": [30, 180],
  "gpt-5.4-mini": [0.75, 4.5, 0.075],
  "gpt-5.4-nano": [0.2, 1.25, 0.02],
  "gpt-5.3-codex": GPT_5_2,
  "gpt-5.2": GPT_5_2,
  "gpt-5.2-codex": GPT_5_2,
  "gpt-5.2-pro": [21, 168],
  "gpt-5.1": GPT_5,
  "gpt-5": GPT_5,
  "gpt-5-pro": [15, 120],
  "gpt-5-mini": [0.25, 2, 0.025],
  "gpt-5-nano": [0.05, 0.4, 0.005],
  "gpt-4.1": [2, 8, 0.5],
  "gpt-4.1-mini": [0.4, 1.6, 0.1],
  "gpt-4.1-nano": [0.1, 0.4, 0.025],
  "gpt-4o": [2.5, 10, 1.25],
  "gpt-4o-mini": [0.15, 0.6, 0.075],
  o3: [2, 8, 0.5],
  "o3-pro": [20, 80],
  "o4-mini": [1.1, 4.4, 0.275],
  // aistudio.google.com/docs/pricing
  "gemini-4-carbon": GEMINI_4,
  "gemini-4-argon": GEMINI_4,
  "gemini-4-neon": [3, 15, 0.15],
  "gemini-4-hydrogen": [1.5, 7.5, 0.075],
  "gemini-3-pro-preview": GEMINI_3_PRO,
  "gemini-3.1-pro-preview": GEMINI_3_PRO,
  "gemini-3-flash-preview": [0.5, 3, 0.05],
  "gemini-3.5-flash-lite": [0.3, 2.5, 0.03],
  "gemini-2.5-pro": [1.25, 10, 0.125],
  "gemini-2.5-flash": [0.3, 2.5, 0.03],
  "gemini-2.5-flash-lite": [0.1, 0.4, 0.01],
  // api-docs.deepseek.com/news/news250120/ and /news/news1226/
  "deepseek-r1": [0.55, 2.19, 0.14],
  "deepseek-v3": [0.27, 1.1, 0.07],
  "deepseek-v3.2": [0.28, 0.42, 0.028],
  // Historical Moonshot rows in LiteLLM's model_prices_and_context_window.json.
  "kimi-k2-0711-preview": KIMI_K2,
  "kimi-k2-0905-preview": KIMI_K2,
  "kimi-k2-thinking": KIMI_K2,
  "kimi-k2-turbo-preview": [1.15, 8, 0.15],
  "kimi-k2-thinking-turbo": [1.15, 8, 0.15],
  "kimi-k2.5": [0.6, 3, 0.1],
  // docs.z.ai/guides/overview/pricing
  "glm-4.5": GLM_4,
  "glm-4.6": GLM_4,
  "glm-4.7": GLM_4,
  "glm-5": [1, 3.2, 0.2],
  "glm-5.1": GLM_5,
  "glm-5.2": GLM_5,
  "glm-5.3": GLM_5,
  "glm-5.3-flash": [0.15, 0.5, 0.03],
  // alibabacloud.com/help/en/model-studio/model-pricing (International)
  "qwen3-coder-flash": [0.3, 1.5, 0.03, 0.375],
  "qwen3-coder-plus": [1, 5, 0.1],
  "qwen3-vl-plus": [0.2, 1.6, 0.02, 0.25],
  "qwen3-max": [1.2, 6],
  "qwen3.5-plus": [0.4, 2.4, 0.04, 0.5],
  // docs.x.ai/developers/pricing and historical xAI rows in LiteLLM's catalog.
  "grok-3": [3, 15, 0.75],
  "grok-3-mini": [0.3, 0.5, 0.075],
  "grok-4": [3, 15],
  "grok-4-0709": [3, 15],
  "grok-4-fast-reasoning": GROK_4_FAST,
  "grok-4-fast-non-reasoning": GROK_4_FAST,
  "grok-4-1-fast-reasoning": GROK_4_FAST,
  "grok-4-1-fast-non-reasoning": GROK_4_FAST,
  "grok-4.3": [1.25, 2.5, 0.2],
  "grok-4.5": [2, 6, 0.3],
  "grok-4.6": [2, 6, 0.5],
  // minimax.io/news/minimax-m2; cache tiers from LiteLLM's MiniMax-M2 row.
  "minimax-m2": [0.3, 1.2, 0.03, 0.375],
};

function modelSlug(model: string): string {
  return model
    .slice(model.lastIndexOf("/") + 1)
    .toLowerCase()
    .replace(/^(?:anthropic|openai)\./u, "")
    .replace(/\[\d+[km]\]$/u, "")
    .replace(/^(claude-(?:opus|sonnet|haiku)-\d+)\.(\d+)/u, "$1-$2")
    .replace(/^kimi-k2-5$/u, "kimi-k2.5");
}

function modelSetting<T>(
  settings: Readonly<Record<string, T>> | undefined,
  model: string,
  slug: string,
) {
  if (settings === undefined) return undefined;
  if (Object.hasOwn(settings, model)) return settings[model];
  const lower = model.toLowerCase();
  if (Object.hasOwn(settings, lower)) return settings[lower];
  if (Object.hasOwn(settings, slug)) return settings[slug];
  for (const key of Object.keys(settings)) {
    if (key.trim().toLowerCase() === lower) return settings[key];
  }
  return undefined;
}

function referenceRates(model: string, settings?: PricingSettings) {
  let seen: Set<string> | undefined;
  for (let depth = 0; model.length > 0; depth++) {
    const slug = modelSlug(model);
    const override = modelSetting(settings?.usagePriceOverrides, model, slug);
    if (override !== undefined) {
      const base = override.inputCostPerMillionTokens;
      return {
        rates: [
          base,
          override.outputCostPerMillionTokens,
          override.cacheReadCostPerMillionTokens ?? base,
          override.cacheWriteCostPerMillionTokens ?? base,
        ] satisfies Rates,
        source: "override" as const,
      };
    }
    const alias = modelSetting(settings?.usageModelAliases, model, slug);
    if (alias === undefined) {
      const baseSlug = slug.replace(/-(?:\d{8}|\d{4}-\d{2}-\d{2})$/u, "");
      const key = Object.hasOwn(REFERENCE_RATES, slug) ? slug : baseSlug;
      return Object.hasOwn(REFERENCE_RATES, key)
        ? { rates: REFERENCE_RATES[key]!, source: "reference" as const }
        : null;
    }
    const key = model.toLowerCase();
    if (depth === 4 || seen?.has(key)) return null;
    (seen ??= new Set()).add(key);
    model = alias.trim();
  }
  return null;
}

export function estimateModelReferenceCost(
  model: string | null | undefined,
  tokens: ReferenceCostTokenCounts,
  settings?: PricingSettings,
): ReferenceCostEstimate | null {
  if (!model?.trim()) return null;
  const read = tokens.cachedInputTokens ?? 0;
  const write = tokens.cacheCreationTokens ?? 0;
  if (
    ![tokens.inputTokens, read, write, tokens.outputTokens].every(
      (count) => Number.isSafeInteger(count) && count >= 0,
    )
  ) {
    return null;
  }
  const reference = referenceRates(model.trim(), settings);
  if (reference === null) return null;
  const [inputRate, outputRate, readRate = inputRate, writeRate = inputRate] = reference.rates;
  if (
    ![inputRate, outputRate, readRate, writeRate].every(
      (rate) => Number.isFinite(rate) && rate >= 0,
    )
  )
    return null;
  const uncached = Math.max(0, tokens.inputTokens - read - write);
  const amount =
    (uncached * inputRate +
      read * readRate +
      write * writeRate +
      tokens.outputTokens * outputRate) /
    1_000_000;
  return Number.isFinite(amount) ? { amount, currency: "USD", source: reference.source } : null;
}
