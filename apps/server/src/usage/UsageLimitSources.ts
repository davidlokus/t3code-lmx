import {
  DEFAULT_PROVIDER_HEALTH_REFRESH_INTERVAL,
  HttpQuotaResponse,
  UsageLimitSourceError,
  type UsageLimitSourceConsumeResetCreditInput,
  type ProviderConsumeResetCreditResult,
  type ProviderDriverKind,
  type ServerSettings,
  UsageLimitSourceConfig,
  settingsSecretLiteral,
  type UsageLimitSourceId,
  type UsageLimitSourceSnapshot,
} from "@t3tools/contracts";
import { resolveServerBackgroundActivitySettings } from "@t3tools/shared/backgroundActivitySettings";
import { antigravityWindowLimitsModel, hubRoutes } from "@t3tools/shared/usageLimits";
import * as Context from "effect/Context";
import * as Digest from "effect/crypto/Digest";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Equal from "effect/Equal";
import * as Hex from "effect/encoding/Hex";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as HttpClientError from "effect/http/HttpClientError";
import { FetchHttpClient, HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http";

import * as BackgroundPolicy from "../background/BackgroundPolicy.ts";
import * as SecretResolver from "@t3tools/secret-provider-core/server/SecretResolver";
import * as SecretResolverLayer from "../secrets/SecretResolver.ts";
import { resolveSettingsSecrets } from "../secrets/settingsSecretValue.ts";
import * as Settings from "../serverSettings.ts";
import { windowLimitsModel } from "../provider/claudeUsageLimits.ts";
import { makeCliproxyApi, normalizeCliproxyHubUrl } from "./cliproxyApi.ts";
import { kimiUsageEndpoint, readKimiUsage } from "./sources/kimi.ts";
import { readOmpUsage, resolveOmpDbPath } from "./sources/omp.ts";
import { readZaiUsage, zaiUsageOrigin } from "./sources/zai.ts";

export type ReadQuotaJson = (
  url: string,
  headers: Readonly<Record<string, string>>,
) => Effect.Effect<{ readonly status: number; readonly body?: unknown } | undefined>;

const decodeHttpQuota = Schema.decodeUnknownEffect(HttpQuotaResponse);
const decodeQuotaJson = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Unknown));
const readQuotaBody = Effect.fn("UsageLimitSources.readQuotaBody")(function* (
  response: HttpClientResponse.HttpClientResponse,
) {
  let bytes = 0;
  const text = yield* response.stream.pipe(
    Stream.mapEffect((chunk) => {
      bytes += chunk.byteLength;
      return bytes > 1024 * 1024
        ? Effect.fail(
            new HttpClientError.DecodeError({
              request: response.request,
              response,
              description: "Usage quota response exceeds 1 MiB.",
            }),
          )
        : Effect.succeed(chunk);
    }),
    Stream.decodeText(),
    Stream.runFold(
      () => "",
      (text, chunk) => text + chunk,
    ),
  );
  return yield* decodeQuotaJson(text);
});

export class UsageLimitSources extends Context.Service<
  UsageLimitSources,
  {
    readonly current: Effect.Effect<ReadonlyArray<UsageLimitSourceSnapshot>>;
    readonly streamChanges: Stream.Stream<ReadonlyArray<UsageLimitSourceSnapshot>>;
    readonly refresh: Effect.Effect<void>;
    readonly consumeResetCredit: (
      input: UsageLimitSourceConsumeResetCreditInput,
    ) => Effect.Effect<ProviderConsumeResetCreditResult, UsageLimitSourceError>;
  }
>()("t3/usage/UsageLimitSources") {}

function sourceLabel(id: string, config: UsageLimitSourceConfig): string {
  if (config.label) return config.label;
  switch (config.kind) {
    case "omp":
      return "OMP Local Cache";
    case "kimi":
      return "Kimi Code";
    case "zai":
      return "Z.ai / BigModel";
  }
  const fallback = id.trim() || "Usage limit source";
  try {
    return new URL(config.url).host || fallback;
  } catch {
    return fallback;
  }
}

interface SourceReading {
  // HTTP query strings, credential digests, and local paths belong to cache identity, not wire snapshots.
  readonly target: string;
  readonly snapshot: UsageLimitSourceSnapshot;
}

/**
 * A refused read of one account keeps its last good reading, as provider probes keep their bars
 * (see ServerProviderUsageLimits); a reading with none to keep stays listed as unreadable.
 */
function keepLastGoodReadings(
  previous: readonly SourceReading[],
  next: readonly SourceReading[],
): readonly SourceReading[] {
  return next.map((reading) => {
    const source = reading.snapshot;
    const before = previous.find(
      (candidate) =>
        candidate.snapshot.id === source.id &&
        candidate.snapshot.kind === source.kind &&
        candidate.target === reading.target,
    )?.snapshot;
    if (!before) return reading;
    if (
      source.error &&
      source.quotaAccounts === undefined &&
      source.accounts.length === 0 &&
      (before.quotaAccounts?.length || (source.kind === "omp" && before.accounts.length > 0))
    ) {
      return {
        ...reading,
        snapshot: {
          ...source,
          ...(source.kind === "omp" && before.accounts.length > 0
            ? { accounts: before.accounts }
            : {}),
          ...(before.quotaAccounts?.length ? { quotaAccounts: before.quotaAccounts } : {}),
        },
      };
    }
    if (source.kind !== "cliproxy" || source.accounts.length === 0) return reading;
    const accounts = source.accounts.map((account) => {
      if (account.usageLimits.unavailable?.reason !== "probeFailed") return account;
      // Without a listed login, a reused auth file name cannot be told apart from the old one.
      if (account.email === undefined && account.workspaceId === undefined) return account;
      const last = before.accounts.find(
        (candidate) =>
          candidate.id === account.id &&
          candidate.driver === account.driver &&
          // Fingerprinted Antigravity readings omit the listed identity, so they are never lent.
          candidate.usageLimits.credentialFingerprint === undefined &&
          candidate.email === account.email &&
          candidate.workspaceId === account.workspaceId,
      );
      if (!last || last.usageLimits.unavailable) return account;
      // Only the reading is lent; an unread model list stays unknown.
      return { ...last, models: account.models };
    });
    return { ...reading, snapshot: { ...source, accounts } };
  });
}

function missingManagementKey(config: UsageLimitSourceConfig): string {
  const label = config.kind === "cliproxy" ? "management key" : "API key";
  return typeof config.managementKey === "string"
    ? `No ${label} configured.`
    : `Could not read the ${label} from its secret provider.`;
}

// Reject control characters and non-ISO-8859-1 bytes before Fetch Headers validation can throw with raw secrets.
function hasValidHttpHeaderValues(headers: Readonly<Record<string, string>>): boolean {
  for (const [name, value] of Object.entries(headers)) {
    if (!/^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/.test(name)) return false;
    if (/[\u0000-\u001f\u007f]|[^\u0000-\u00ff]/.test(value)) return false;
  }
  return true;
}

function sameSecretField(
  left: UsageLimitSourceConfig["managementKey"],
  right: UsageLimitSourceConfig["managementKey"],
): boolean {
  if (typeof left === "string" || typeof right === "string") return left === right;
  return left.provider === right.provider && left.reference === right.reference;
}

function sameSourceConfig(left: UsageLimitSourceConfig, right: UsageLimitSourceConfig): boolean {
  return (
    left.kind === right.kind &&
    left.url === right.url &&
    left.label === right.label &&
    left.region === right.region &&
    left.enabled === right.enabled &&
    sameSecretField(left.managementKey, right.managementKey)
  );
}

function sameJsonValue(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (typeof left !== typeof right || left === null || right === null || typeof left !== "object") {
    return false;
  }
  if (Array.isArray(left) || Array.isArray(right)) {
    return (
      Array.isArray(left) &&
      Array.isArray(right) &&
      left.length === right.length &&
      left.every((item, index) => sameJsonValue(item, right[index]))
    );
  }
  const leftObj = left as Record<string, unknown>;
  const rightObj = right as Record<string, unknown>;
  const leftKeys = Object.keys(leftObj);
  const rightKeys = Object.keys(rightObj);
  return (
    leftKeys.length === rightKeys.length &&
    leftKeys.every(
      (key) => Object.hasOwn(rightObj, key) && sameJsonValue(leftObj[key], rightObj[key]),
    )
  );
}

function sameUsageSourcesAndReferencedProviders(
  before: Pick<ServerSettings, "usageLimitSources" | "secretProviders">,
  after: Pick<ServerSettings, "usageLimitSources" | "secretProviders">,
): boolean {
  const beforeEntries = Object.entries(before.usageLimitSources);
  const afterEntries = Object.entries(after.usageLimitSources);
  if (beforeEntries.length !== afterEntries.length) return false;
  const referencedProviders = new Set<string>();
  for (const [id, afterConfig] of afterEntries) {
    const beforeConfig = before.usageLimitSources[id as UsageLimitSourceId];
    if (!beforeConfig || !sameSourceConfig(beforeConfig, afterConfig)) return false;
    if (afterConfig.enabled && typeof afterConfig.managementKey !== "string") {
      referencedProviders.add(afterConfig.managementKey.provider);
    }
  }
  for (const providerId of referencedProviders) {
    const beforeProvider =
      before.secretProviders[providerId as keyof ServerSettings["secretProviders"]];
    const afterProvider =
      after.secretProviders[providerId as keyof ServerSettings["secretProviders"]];
    if (!sameJsonValue(beforeProvider, afterProvider)) return false;
  }
  return true;
}

function sameEffectiveSourceIdentity(
  left: UsageLimitSourceConfig,
  right: UsageLimitSourceConfig,
): boolean {
  return (
    left.kind === right.kind &&
    resolveSourceEndpoint(left).target === resolveSourceEndpoint(right).target &&
    sameSecretField(left.managementKey, right.managementKey)
  );
}

function resolveSourceEndpoint(config: UsageLimitSourceConfig): {
  readonly webUrl: URL | null;
  readonly hubOrigin: string | undefined;
  readonly hubEndpoint: string | undefined;
  readonly target: string;
} {
  if (config.kind === "cliproxy") {
    const normalized = normalizeCliproxyHubUrl(config.url);
    const url = URL.parse(config.url);
    if (url) url.hash = "";
    return {
      webUrl: normalized ? url : null,
      hubOrigin: normalized?.origin,
      hubEndpoint: normalized?.endpoint,
      target: normalized?.endpoint ?? url?.href ?? config.url,
    };
  }
  const url = config.kind === "http" ? URL.parse(config.url) : null;
  const webUrl = url && /^https?:$/.test(url.protocol) ? url : null;
  if (url) url.hash = "";
  const target = (() => {
    switch (config.kind) {
      case "omp":
        return resolveOmpDbPath(config.url);
      case "kimi":
        return kimiUsageEndpoint(config.region);
      case "zai":
        return zaiUsageOrigin(config.region);
      case "http":
        return url?.href ?? config.url;
    }
  })();
  return { webUrl, hubOrigin: undefined, hubEndpoint: undefined, target };
}

/** @public */
export const make = Effect.gen(function* () {
  const api = yield* makeCliproxyApi;
  const digest = yield* Digest.Digest;
  const http = yield* HttpClient.HttpClient;
  const settingsService = yield* Settings.ServerSettingsService;
  const secrets = yield* SecretResolver.SecretResolver;
  const backgroundPolicy = yield* BackgroundPolicy.BackgroundPolicy;
  const readSecretRevision = (
    managementKey: UsageLimitSourceConfig["managementKey"],
  ): Effect.Effect<string | undefined> =>
    typeof managementKey === "string" || secrets.revision === undefined
      ? Effect.undefined
      : secrets.revision(managementKey);
  const readManagementKey = Effect.fn("UsageLimitSources.readManagementKey")(function* (
    config: UsageLimitSourceConfig,
  ) {
    const resolved = yield* resolveSettingsSecrets(secrets, UsageLimitSourceConfig, config);
    return settingsSecretLiteral(resolved.managementKey);
  });
  const resolveAuthIdentity = Effect.fn("UsageLimitSources.resolveAuthIdentity")(function* (
    config: UsageLimitSourceConfig,
    managementKey: string,
  ) {
    return managementKey.length > 0
      ? `key:${yield* digest
          .digest(Digest.sha256, new TextEncoder().encode(managementKey))
          .pipe(Effect.map(Hex.encode), Effect.orDie)}`
      : typeof config.managementKey === "string"
        ? "none"
        : "unresolved";
  });
  const resolveCacheTarget = Effect.fn("UsageLimitSources.resolveCacheTarget")(function* (
    config: UsageLimitSourceConfig,
  ) {
    const { target } = resolveSourceEndpoint(config);
    if (config.kind === "omp") return target;
    const managementKey = yield* readManagementKey(config);
    const authIdentity = yield* resolveAuthIdentity(config, managementKey);
    return `${target}\0${authIdentity}`;
  });
  const requestQuotaJson = Effect.fn("UsageLimitSources.requestQuotaJson")(function* (
    url: string,
    headers: Readonly<Record<string, string>>,
  ) {
    if (!hasValidHttpHeaderValues(headers)) return undefined;
    return yield* http
      .execute(
        HttpClientRequest.get(url).pipe(
          HttpClientRequest.setHeaders({ Accept: "application/json", ...headers }),
        ),
      )
      .pipe(
        Effect.flatMap((response) =>
          response.status >= 200 && response.status < 300
            ? readQuotaBody(response).pipe(
                Effect.map((body) => ({ status: response.status, body })),
              )
            : Effect.succeed({ status: response.status, body: undefined }),
        ),
        Effect.provideService(FetchHttpClient.RequestInit, { redirect: "error" }),
        Effect.timeout("10 seconds"),
        // Suppress raw HTTP child spans so transport exceptions cannot export secret-bearing causes.
        Effect.withTracerEnabled(false),
        Effect.orElseSucceed(() => undefined),
      );
  });
  const stateRef = yield* Ref.make<{
    readonly readings: readonly SourceReading[];
    readonly snapshots: readonly UsageLimitSourceSnapshot[];
  }>({ readings: [], snapshots: [] });
  const changes = yield* Effect.acquireRelease(
    PubSub.unbounded<ReadonlyArray<UsageLimitSourceSnapshot>>(),
    PubSub.shutdown,
  );

  const readSource = Effect.fn("UsageLimitSources.readSource")(function* (
    id: UsageLimitSourceId,
    config: UsageLimitSourceConfig,
  ) {
    const checkedAt = DateTime.formatIso(yield* DateTime.now);
    const { webUrl, hubOrigin, hubEndpoint, target } = resolveSourceEndpoint(config);
    const base = {
      id,
      kind: config.kind,
      label: sourceLabel(id, config),
      ...(hubOrigin !== undefined && hubEndpoint !== undefined
        ? { origin: hubOrigin, endpoint: hubEndpoint }
        : {}),
      checkedAt,
    } as const;
    const finish = (
      result: Pick<UsageLimitSourceSnapshot, "accounts" | "quotaAccounts" | "error">,
      cacheTarget = target,
    ): SourceReading => ({ target: cacheTarget, snapshot: { ...base, ...result } });
    if (config.kind === "omp") return finish(yield* readOmpUsage(target));
    const managementKey = yield* readManagementKey(config);
    const authIdentity = yield* resolveAuthIdentity(config, managementKey);
    const credentialedTarget = `${target}\0${authIdentity}`;
    if (config.kind === "http") {
      if (!webUrl || webUrl.username || webUrl.password) {
        return finish(
          { accounts: [], error: "Invalid HTTP quota source URL." },
          credentialedTarget,
        );
      }
      if (typeof config.managementKey !== "string" && !managementKey) {
        return finish(
          { accounts: [], error: "Could not resolve the quota source token." },
          credentialedTarget,
        );
      }
      const result = yield* requestQuotaJson(
        target,
        managementKey ? { Authorization: `Bearer ${managementKey}` } : {},
      ).pipe(
        Effect.flatMap((response) => decodeHttpQuota(response?.body)),
        Effect.result,
      );
      return finish(
        result._tag === "Success"
          ? { accounts: [], quotaAccounts: result.success.accounts }
          : { accounts: [], error: "Could not read the HTTP quota source." },
        credentialedTarget,
      );
    }
    if (managementKey.length === 0) {
      return finish({ accounts: [], error: missingManagementKey(config) }, credentialedTarget);
    }
    if (config.kind === "kimi") {
      return finish(
        yield* readKimiUsage(target, managementKey, requestQuotaJson),
        credentialedTarget,
      );
    }
    if (config.kind === "zai") {
      return finish(
        yield* readZaiUsage(target, managementKey, requestQuotaJson),
        credentialedTarget,
      );
    }
    const accounts = yield* api
      .readAccounts({ url: config.url, managementKey })
      .pipe(Effect.result);
    if (accounts._tag === "Failure") {
      yield* Effect.logDebug("usage limit source read failed", { id, cause: accounts.failure });
      return finish({ accounts: [], error: accounts.failure.detail }, credentialedTarget);
    }
    return finish({ accounts: accounts.success }, credentialedTarget);
  });

  const publish = Effect.fn("UsageLimitSources.publish")(function* (
    snapshots: readonly UsageLimitSourceSnapshot[],
    retained: readonly SourceReading[],
  ) {
    const changed = yield* Ref.modify(stateRef, (previous) => [
      !Equal.equals(previous.snapshots, snapshots),
      { readings: retained, snapshots },
    ]);
    if (changed) yield* PubSub.publish(changes, snapshots);
  });

  // Serialize refreshes so slow old-settings reads cannot resurrect removed sources after newer refreshes.
  const refreshLock = yield* Semaphore.make(1);
  const refresh = Effect.gen(function* () {
    const settings = yield* settingsService.getSettings.pipe(
      Effect.orElseSucceed((): ServerSettings | null => null),
    );
    const entries = Object.entries(settings?.usageLimitSources ?? {}).filter(
      ([, config]) => config.enabled,
    );
    const results = yield* Effect.forEach(
      entries,
      ([id, config]) =>
        readSource(id as UsageLimitSourceId, config).pipe(
          Effect.map((reading) => ({ id, config, reading })),
        ),
      { concurrency: 4 },
    );
    // Resolve latest effective auth identity outside the settings write lock so vault lookups
    // never block settings writes, then revalidate configs/provider bindings and publish atomically.
    const latest = yield* settingsService.getSettings.pipe(
      Effect.orElseSucceed((): ServerSettings | null => null),
    );
    if (latest === null) return;
    const candidates = (yield* Effect.forEach(results, ({ id, reading }) =>
      Effect.gen(function* () {
        const sourceId = id as UsageLimitSourceId;
        const checkedConfig = latest.usageLimitSources[sourceId];
        if (
          !checkedConfig ||
          !checkedConfig.enabled ||
          checkedConfig.kind !== reading.snapshot.kind
        ) {
          return undefined;
        }
        const checkedProvider =
          typeof checkedConfig.managementKey === "string"
            ? undefined
            : latest.secretProviders[checkedConfig.managementKey.provider];
        let checkedRevision = yield* readSecretRevision(checkedConfig.managementKey);
        let latestTarget = yield* resolveCacheTarget(checkedConfig);
        let afterRevision = yield* readSecretRevision(checkedConfig.managementKey);
        // A same-key refill after invalidate bumps the cache revision once; recheck on the warm
        // cache so checkedRevision pairs with the resolved target without dropping last-good data.
        if (afterRevision !== checkedRevision && latestTarget === reading.target) {
          checkedRevision = afterRevision;
          latestTarget = yield* resolveCacheTarget(checkedConfig);
          afterRevision = yield* readSecretRevision(checkedConfig.managementKey);
        }
        if (latestTarget !== reading.target) {
          return undefined;
        }
        return {
          id: sourceId,
          checkedConfig,
          checkedProvider,
          checkedRevision,
          revisionStable: afterRevision === checkedRevision,
          reading,
        };
      }),
    )).filter((candidate) => candidate !== undefined);

    yield* settingsService
      .withSettingsSnapshot((committed) =>
        Effect.gen(function* () {
          const previous = (yield* Ref.get(stateRef)).readings;
          const visible: SourceReading[] = [];
          const visibleIds = new Set<UsageLimitSourceId>();
          const unverifiedSecretIds = new Set<UsageLimitSourceId>();
          for (const candidate of candidates) {
            const current = committed.usageLimitSources[candidate.id];
            if (!current || !current.enabled) continue;
            if (!sameEffectiveSourceIdentity(candidate.checkedConfig, current)) continue;
            if (typeof current.managementKey !== "string") {
              const committedProvider = committed.secretProviders[current.managementKey.provider];
              if (!sameJsonValue(committedProvider, candidate.checkedProvider)) continue;
              const committedRevision = yield* readSecretRevision(current.managementKey);
              if (!candidate.revisionStable || committedRevision !== candidate.checkedRevision) {
                // Keep publication fail-closed, but keep the prior reading keyed by target+digest
                // so a subsequent refresh can restore last-good only if it proves the same key.
                unverifiedSecretIds.add(candidate.id);
                continue;
              }
            }
            const latestLabel = sourceLabel(candidate.id, current);
            visibleIds.add(candidate.id);
            visible.push(
              latestLabel === candidate.reading.snapshot.label
                ? candidate.reading
                : {
                    ...candidate.reading,
                    snapshot: { ...candidate.reading.snapshot, label: latestLabel },
                  },
            );
          }
          const nextVisible = keepLastGoodReadings(previous, visible);
          const retained = [
            ...nextVisible,
            ...previous.filter(
              (entry) =>
                !visibleIds.has(entry.snapshot.id) && unverifiedSecretIds.has(entry.snapshot.id),
            ),
          ];
          yield* publish(
            nextVisible.map((reading) => reading.snapshot),
            retained,
          );
        }),
      )
      .pipe(Effect.ignoreCause({ log: true }));
  }).pipe(refreshLock.withPermits(1), Effect.ignoreCause({ log: true }));

  // Shares the refresh lock so a stale in-flight read cannot overwrite a redemption.
  const consumeResetCredit = Effect.fn("UsageLimitSources.consumeResetCredit")(function* (
    input: UsageLimitSourceConsumeResetCreditInput,
  ) {
    const settings = yield* settingsService.getSettings.pipe(
      Effect.mapError(() => new UsageLimitSourceError({ detail: "Could not read hub settings." })),
    );
    const config = settings.usageLimitSources[input.sourceId];
    if (!config?.enabled || config.kind !== "cliproxy") {
      return yield* new UsageLimitSourceError({
        detail: "The usage limit source is missing or disabled.",
      });
    }
    const managementKey = yield* readManagementKey(config);
    if (managementKey.length === 0) {
      return yield* new UsageLimitSourceError({ detail: missingManagementKey(config) });
    }
    const result = yield* api.consume(
      { url: config.url, managementKey },
      input.accountId,
      input.creditId,
    );
    // A redemption changes the reading, so a refused re-read must not bring back the one before it.
    // Update visible snapshots and retained cache independently so hidden fenced sources stay hidden.
    const reading = yield* readSource(input.sourceId, config);
    const previous = yield* Ref.get(stateRef);
    yield* publish(
      previous.snapshots.map((snapshot) =>
        snapshot.id === input.sourceId ? reading.snapshot : snapshot,
      ),
      previous.readings.map((entry) => (entry.snapshot.id === input.sourceId ? reading : entry)),
    );
    return result;
  }, refreshLock.withPermits(1));

  yield* settingsService.streamChanges.pipe(
    Stream.map((settings) => ({
      usageLimitSources: settings.usageLimitSources,
      secretProviders: settings.secretProviders,
    })),
    Stream.changesWith(sameUsageSourcesAndReferencedProviders),
    Stream.runForEach(() => refresh),
    Effect.forkScoped,
  );

  const interval = settingsService.getSettings.pipe(
    Effect.map(
      (settings) => resolveServerBackgroundActivitySettings(settings).providerHealthRefreshInterval,
    ),
    Effect.orElseSucceed(() => DEFAULT_PROVIDER_HEALTH_REFRESH_INTERVAL),
  );
  yield* Effect.forever(
    interval.pipe(
      Effect.flatMap((wait) => Effect.sleep(Duration.isPositive(wait) ? wait : "60 seconds")),
      Effect.andThen(interval),
      Effect.flatMap((current) =>
        Duration.isPositive(current)
          ? backgroundPolicy.shouldRunScopeWork({ type: "provider-status" })
          : Effect.succeed(false),
      ),
      Effect.flatMap((shouldRun) => (shouldRun ? refresh : Effect.void)),
      Effect.ignoreCause({ log: true }),
    ),
  ).pipe(Effect.forkScoped);

  yield* refresh.pipe(Effect.forkScoped);

  return {
    current: Ref.get(stateRef).pipe(Effect.map((state) => state.snapshots)),
    consumeResetCredit,
    refresh,
    get streamChanges() {
      return Stream.unwrap(
        Effect.gen(function* () {
          const subscription = yield* PubSub.subscribe(changes);
          const { snapshots: snapshot } = yield* Ref.get(stateRef);
          return Stream.concat(Stream.make(snapshot), Stream.fromSubscription(subscription)).pipe(
            Stream.changes,
          );
        }),
      );
    },
  } satisfies UsageLimitSources["Service"];
});

export const layer = Layer.effect(UsageLimitSources, make).pipe(
  Layer.provide(SecretResolverLayer.layer),
);

/** A hub returns a usage limit only when every account it routes the model to is spent. */
export function hubPoolResetAt(
  sources: ReadonlyArray<UsageLimitSourceSnapshot>,
  driver: ProviderDriverKind,
  model: string | null,
  now: number,
): string | null {
  let earliest: number | null = null;
  const routes = hubRoutes(sources, driver, model);
  for (const account of sources.flatMap((source) => source.accounts).filter(routes)) {
    // An unread account may be the one still blocked, so its refill is unknown.
    if (account.usageLimits.unavailable) return null;
    const spent = account.usageLimits.windows.filter(
      (window) =>
        window.usedPercent >= 100 &&
        windowLimitsModel(window, model) &&
        (account.driver !== "antigravity" || antigravityWindowLimitsModel(window, model)),
    );
    if (spent.length === 0) return null;
    const resets = spent.map((window) => Date.parse(window.resetsAt ?? ""));
    if (resets.some((reset) => !Number.isFinite(reset))) return null;
    const recoversAt = Math.max(...resets);
    if (recoversAt <= now) return null;
    earliest = earliest === null ? recoversAt : Math.min(earliest, recoversAt);
  }
  return earliest === null ? null : DateTime.formatIso(DateTime.makeUnsafe(earliest));
}

export class UsageLimitResetFallback extends Context.Reference<{
  readonly resetAt: (
    driver: ProviderDriverKind,
    endpoint: string,
    model: string | null,
  ) => Effect.Effect<string | null>;
}>("t3/usage/UsageLimitResetFallback", {
  defaultValue: () => ({ resetAt: () => Effect.succeed(null) }),
}) {}

export const layerResetFallback = Layer.effect(
  UsageLimitResetFallback,
  Effect.gen(function* () {
    const sources = yield* UsageLimitSources;
    return {
      resetAt: Effect.fn("UsageLimitResetFallback.resetAt")(function* (driver, endpoint, model) {
        // Only the hub at the instance's endpoint serves its turns.
        const atEndpoint = Effect.map(sources.current, (current) =>
          current.filter((source) => source.origin === endpoint),
        );
        if ((yield* atEndpoint).length === 0) return null;
        // The pool usually ran out after the last poll, so the cached accounts still show room.
        yield* sources.refresh.pipe(Effect.timeout("5 seconds"), Effect.ignore);
        return hubPoolResetAt(
          yield* atEndpoint,
          driver,
          model,
          DateTime.toEpochMillis(yield* DateTime.now),
        );
      }),
    };
  }),
);
