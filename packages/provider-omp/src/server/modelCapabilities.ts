import {
  type ModelCapabilities,
  type ProviderOptionChoice,
  type ProviderOptionDescriptor,
} from "@t3tools/contracts";
import { createModelCapabilities } from "@t3tools/shared/model";
import * as Predicate from "effect/Predicate";

const THINKING_LEVELS = [
  "off",
  "auto",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const;
export const OMP_THINKING_LEVELS: ReadonlySet<string> = new Set(THINKING_LEVELS);

type OmpThinkingLevel = (typeof THINKING_LEVELS)[number];

const LABELS: Record<OmpThinkingLevel, string> = {
  off: "Off",
  auto: "Auto",
  minimal: "Minimal",
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "Extra High",
  max: "Max",
};

export const EMPTY_OMP_MODEL_CAPABILITIES: ModelCapabilities = createModelCapabilities({
  optionDescriptors: [],
});

const isOmpThinkingLevel = (value: unknown): value is OmpThinkingLevel =>
  typeof value === "string" && OMP_THINKING_LEVELS.has(value);

const field = (input: unknown, key: string): unknown =>
  Predicate.isObject(input) ? input[key] : undefined;

// Native RPC wraps efforts in an object; `omp models --json` returns the array directly.
export function ompModelCapabilities(
  model: unknown,
  currentThinkingLevel: unknown,
): ModelCapabilities {
  if (field(model, "reasoning") !== true) return EMPTY_OMP_MODEL_CAPABILITIES;
  const thinking = field(model, "thinking");
  const efforts = Array.isArray(thinking) ? thinking : field(thinking, "efforts");
  if (!Array.isArray(efforts)) return EMPTY_OMP_MODEL_CAPABILITIES;
  const supported = new Set<OmpThinkingLevel>(["off", "auto"]);
  for (const level of efforts) {
    if (isOmpThinkingLevel(level)) supported.add(level);
  }
  const levels = THINKING_LEVELS.filter((level) => supported.has(level));
  const defaultLevel = levels.find((level) => level === currentThinkingLevel);
  const descriptor: ProviderOptionDescriptor = {
    id: "thinking",
    label: "Thinking",
    type: "select",
    options: levels.map((level): ProviderOptionChoice => ({
      id: level,
      label: LABELS[level],
      ...(level === defaultLevel ? { isDefault: true } : {}),
    })),
  };
  return createModelCapabilities({ optionDescriptors: [descriptor] });
}
