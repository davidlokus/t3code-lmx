import {
  type UnifiedSettings,
  UsageLimitSourceId,
  type UsageLimitSourceKind,
  type UsageLimitSourceRegion,
} from "@t3tools/contracts";

export const OMP_DEFAULT_SOURCE_URL = "omp://default";

export function defaultUsageLimitSourceRegion(
  kind: UsageLimitSourceKind,
): UsageLimitSourceRegion | undefined {
  if (kind === "kimi") return "cn";
  if (kind === "zai") return "global";
  return undefined;
}

export function defaultUsageLimitSourceUrl(
  kind: UsageLimitSourceKind,
  region?: UsageLimitSourceRegion,
): string {
  switch (kind) {
    case "omp":
      return OMP_DEFAULT_SOURCE_URL;
    case "kimi":
      return (region ?? "cn") === "global"
        ? "https://api.kimi.ai/coding/v1/usages"
        : "https://api.kimi.com/coding/v1/usages";
    case "zai":
      return (region ?? "global") === "cn" ? "https://open.bigmodel.cn" : "https://api.z.ai";
    case "cliproxy":
    case "http":
      return "";
  }
}

export function displayUsageLimitSourceTarget(source: {
  readonly kind: UsageLimitSourceKind;
  readonly url: string;
  readonly region?: UsageLimitSourceRegion | undefined;
}): string {
  if (source.kind === "omp") {
    return source.url === OMP_DEFAULT_SOURCE_URL ? "~/.omp/agent/agent.db" : source.url;
  }
  if (source.kind === "kimi") {
    return (source.region ?? "cn") === "global" ? "api.kimi.ai" : "api.kimi.com";
  }
  if (source.kind === "zai") {
    return (source.region ?? "global") === "cn" ? "open.bigmodel.cn" : "api.z.ai";
  }
  return source.url;
}

function randomSourceSuffix(): string {
  const raw =
    typeof globalThis.crypto?.randomUUID === "function"
      ? // @effect-diagnostics-next-line cryptoRandomUUID:off -- Sync form submission allocates a collision-free ID outside Effect.
        globalThis.crypto.randomUUID().replaceAll("-", "").slice(0, 8)
      : Math.random().toString(36).slice(2, 10);
  return raw || "1";
}

export function sourceIdFromUrl(
  url: string,
  sources: UnifiedSettings["usageLimitSources"],
  kind: UsageLimitSourceKind = "cliproxy",
  region?: UsageLimitSourceRegion,
): UsageLimitSourceId {
  // Kimi and Z.ai share fixed regional endpoints across independent accounts, so allocate
  // non-reusable IDs to avoid concurrent-tab overwrites and stale renewal override inheritance.
  if (kind === "kimi" || kind === "zai") {
    const effectiveRegion = region ?? defaultUsageLimitSourceRegion(kind) ?? "global";
    const base = `${kind}-${effectiveRegion}`;
    let id = `${base}-${randomSourceSuffix()}`;
    while (id in sources) {
      id = `${base}-${randomSourceSuffix()}`;
    }
    return UsageLimitSourceId.make(id);
  }
  const saved = Object.entries(sources).find(
    ([, source]) => source.kind === kind && source.url === url,
  );
  if (saved) return UsageLimitSourceId.make(saved[0]);
  let host = url;
  if (kind === "omp") {
    host = url === OMP_DEFAULT_SOURCE_URL ? "default" : url;
  } else {
    try {
      host = new URL(url).host;
    } catch {}
  }
  const slug = host
    .toLowerCase()
    .replace(/[^a-z0-9.-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  // Settings merge by ID, so adding a different hub must not replace an existing entry.
  const base = `${kind}-${slug || "source"}`;
  let id = base;
  for (let suffix = 2; id in sources; suffix += 1) {
    id = `${base}-${suffix}`;
  }
  return UsageLimitSourceId.make(id);
}
