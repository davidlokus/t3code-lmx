import type {
  NormalizedLimitAccount,
  WindowBurnPace,
} from "@t3tools/shared/usageLimitsIntelligence";
import { formatDuration } from "@t3tools/shared/usageLimitsCopy";
import { T, useGT, useMessages } from "gt-react";
import { FlameIcon, GlobeIcon } from "lucide-react";

import { OllamaIcon, OpenAI, OpenRouterIcon } from "~/components/Icons";
import { ProviderInstanceIcon } from "~/components/chat/ProviderInstanceIcon";
import { cn } from "~/lib/utils";
import type { UsageRiskTone } from "./usageDashboard.logic";
import { restrainedBarClass } from "./usageLimitsPresentation";

function CopilotMark({ className }: { readonly className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden
    >
      <path d="M5 10a7 7 0 0 1 14 0" />
      <rect x="3" y="10" width="18" height="8" rx="4" />
      <circle cx="9.25" cy="14" r="1.25" fill="currentColor" stroke="none" />
      <circle cx="14.75" cy="14" r="1.25" fill="currentColor" stroke="none" />
    </svg>
  );
}

export function useSourceKindLabel() {
  const gt = useGT();
  return (sourceKind: NormalizedLimitAccount["sourceKind"] | null): string | null => {
    switch (sourceKind) {
      case null:
      case "native":
      case "cliproxy":
        return null;
      case "http":
        return gt("HTTP source");
      case "omp":
        return gt("OMP cache");
      case "kimi":
        return gt("Kimi Code");
      case "zai":
        return gt("Z.ai");
      case "openrouter":
        return gt("OpenRouter");
      case "copilot":
        return gt("GitHub Copilot");
      case "ollama":
        return gt("Ollama Cloud");
      case "openaiApi":
        return gt("OpenAI API");
      case "claudeSwap":
        return "claude-swap";
    }
  };
}

export function LimitSourceIcon({
  driver,
  sourceKind,
  label,
  accentColor,
  size = "md",
}: {
  readonly driver: NormalizedLimitAccount["driver"];
  readonly sourceKind: NormalizedLimitAccount["sourceKind"];
  readonly label: string;
  readonly accentColor?: string | undefined;
  readonly size?: "sm" | "md";
}) {
  const boxClass = size === "sm" ? "size-5" : "size-6";
  const iconClass = size === "sm" ? "size-3.5" : "size-4";

  if (driver) {
    return (
      <ProviderInstanceIcon
        driverKind={driver}
        displayName={label}
        accentColor={accentColor}
        indicatorBackground="var(--card)"
        className={cn(boxClass, "shrink-0")}
        iconClassName={cn(iconClass, "text-foreground/85")}
      />
    );
  }

  return (
    <span
      data-testid={`usage-source-icon-${sourceKind}`}
      className={cn(
        boxClass,
        "inline-flex shrink-0 items-center justify-center rounded-md bg-muted/80 text-muted-foreground",
      )}
    >
      {sourceKind === "openrouter" ? (
        <OpenRouterIcon className="size-3.5 text-foreground/85" aria-hidden />
      ) : sourceKind === "copilot" ? (
        <CopilotMark className="size-3.5 text-foreground/85" />
      ) : sourceKind === "ollama" ? (
        <OllamaIcon className="size-3.5 text-foreground/85" aria-hidden />
      ) : sourceKind === "openaiApi" ? (
        <OpenAI className="size-3.5 text-foreground/85" aria-hidden />
      ) : (
        <GlobeIcon className="size-3.5" aria-hidden />
      )}
    </span>
  );
}

export function RestrainedQuotaBar({
  percent,
  tone,
  tickPercent = null,
  height = "sm",
}: {
  readonly percent: number;
  readonly tone: UsageRiskTone;
  readonly tickPercent?: number | null;
  readonly height?: "xs" | "sm";
}) {
  const clamped = Math.max(0, Math.min(100, percent));
  const trackHeight = height === "xs" ? "h-1" : "h-1.5";
  const tickHeight = height === "xs" ? "h-2 -top-0.5" : "h-2.5 -top-0.5";

  return (
    <div className={cn("relative w-full rounded-full bg-muted/80", trackHeight)}>
      {clamped > 0 ? (
        <div
          className={cn("absolute inset-y-0 left-0 rounded-full", restrainedBarClass(tone))}
          style={{ width: `max(${clamped}%, 3px)` }}
        />
      ) : null}
      {tickPercent !== null ? (
        <span
          aria-hidden
          className={cn(
            "pointer-events-none absolute w-0.5 -translate-x-1/2 rounded-full bg-foreground/70",
            tickHeight,
          )}
          style={{ left: `clamp(1px, ${tickPercent}%, calc(100% - 1px))` }}
        />
      ) : null}
    </div>
  );
}

/**
 * Surfaces burn-pace signals only when actionable (exhausted, will-exhaust, or ahead of pace),
 * keeping healthy accounts free of badge clutter.
 */
export function BurnPaceTag({
  pace,
  remainingPercent,
  now,
  compact = false,
}: {
  readonly pace: WindowBurnPace | null;
  readonly remainingPercent: number;
  readonly now: number;
  readonly compact?: boolean;
}) {
  const gt = useGT();
  const m = useMessages();
  if (!pace) return null;

  if (pace.status === "exhausted") {
    return (
      <span
        data-testid="usage-matrix-pace-badge"
        data-pace="exhausted"
        className="inline-flex shrink-0 items-center rounded bg-error/15 px-1.5 py-0.5 text-3xs font-medium text-error-foreground tabular-nums"
      >
        <T>Exhausted</T>
      </span>
    );
  }

  if (pace.status === "will-exhaust") {
    const eta =
      pace.projectedExhaustionMs !== null
        ? formatDuration(Math.max(0, pace.projectedExhaustionMs - now), m)
        : null;
    const toneClass =
      remainingPercent <= 15
        ? "bg-error/15 text-error-foreground"
        : "bg-warning/12 text-warning-foreground";
    return (
      <span
        data-testid="usage-matrix-pace-badge"
        data-pace="will-exhaust"
        className={cn(
          "inline-flex shrink-0 items-center gap-1 rounded px-1.5 py-0.5 text-3xs font-medium tabular-nums",
          toneClass,
        )}
      >
        <FlameIcon className="size-2.5 shrink-0" aria-hidden />
        <span>
          {compact || !eta
            ? gt("{ratio}× pace", { ratio: pace.paceRatio ?? "-" })
            : gt("{ratio}× empty in {eta}", { ratio: pace.paceRatio ?? "-", eta })}
        </span>
      </span>
    );
  }

  if (pace.status === "ahead") {
    return (
      <span
        data-testid="usage-matrix-pace-badge"
        data-pace="ahead"
        className="inline-flex shrink-0 items-center rounded bg-warning/12 px-1.5 py-0.5 text-3xs font-medium text-warning-foreground tabular-nums"
      >
        {gt("{ratio}× pace", { ratio: pace.paceRatio ?? "-" })}
      </span>
    );
  }

  return null;
}
