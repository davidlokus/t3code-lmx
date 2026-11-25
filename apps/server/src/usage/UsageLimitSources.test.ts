import * as NodeSqlite from "node:sqlite";

import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import {
  DEFAULT_SERVER_SETTINGS,
  ProviderDriverKind,
  SecretProviderId,
  SecretProviderKind,
  ServerConfigStreamEvent,
  UsageLimitSourceId,
  type ServerProviderUsageWindow,
  type ServerSettings as ServerSettingsModel,
  type UsageLimitSourceSnapshot,
} from "@t3tools/contracts";
import * as SecretResolver from "@t3tools/secret-provider-core/server/SecretResolver";
import { definition as onePasswordDefinition } from "@t3tools/secret-provider-onepassword/shared/definition";
import { makeLocalFileTracer, type EffectTraceRecord } from "@t3tools/shared/observability";
import { applyServerSettingsPatch } from "@t3tools/shared/serverSettings";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import { FetchHttpClient, HttpClient, HttpClientResponse } from "effect/http";

import * as BackgroundPolicy from "../background/BackgroundPolicy.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as UsageLimitSources from "./UsageLimitSources.ts";

const encodeConfigEvent = Schema.encodeSync(ServerConfigStreamEvent);

it.effect("keeps malformed source URLs encodable for config subscribers", () =>
  Effect.gen(function* () {
    const sources = yield* UsageLimitSources.make;
    yield* sources.refresh;
    const snapshots = yield* sources.current;
    expect(snapshots.map((source) => source.label)).toEqual([
      "local-hub",
      "opaque-hub",
      "Named hub",
      "hub.test:8317",
      "Usage limit source",
    ]);
    // Only an http(s) hub URL names an endpoint an agent can be sent to.
    expect(snapshots.map((source) => source.origin)).toEqual([
      undefined,
      undefined,
      undefined,
      "https://hub.test:8317",
      undefined,
    ]);
    expect(snapshots[3]?.endpoint).toBe("https://hub.test:8317/team-a");
    expect(() =>
      encodeConfigEvent({
        version: 1,
        type: "usageLimitSourcesUpdated",
        payload: { sources: snapshots },
      }),
    ).not.toThrow();
    expect(snapshots.every((source) => source.error === "No management key configured.")).toBe(
      true,
    );
  }).pipe(
    Effect.provide([
      Layer.succeed(SecretResolver.SecretResolver, {
        label: (provider) => Effect.succeed(provider),
        read: (references) => Effect.succeed(references.map(() => undefined)),
        invalidate: () => Effect.void,
      }),
      ServerSettings.layerTest({
        usageLimitSources: {
          [UsageLimitSourceId.make("local-hub")]: {
            kind: "cliproxy",
            url: "localhost:8317",
            managementKey: "",
            enabled: true,
          },
          [UsageLimitSourceId.make("opaque-hub")]: {
            kind: "cliproxy",
            url: "file:///tmp/hub",
            managementKey: "",
            enabled: true,
          },
          [UsageLimitSourceId.make("named-hub")]: {
            kind: "cliproxy",
            url: "localhost:8317",
            label: "Named hub",
            managementKey: "",
            enabled: true,
          },
          [UsageLimitSourceId.make("valid-hub")]: {
            kind: "cliproxy",
            url: "https://hub.test:8317/team-a/management.html",
            managementKey: "",
            enabled: true,
          },
          [UsageLimitSourceId.make(" ")]: {
            kind: "cliproxy",
            url: "localhost:8317",
            managementKey: "",
            enabled: true,
          },
        },
      }),
      Layer.mock(BackgroundPolicy.BackgroundPolicy)({
        shouldRunScopeWork: () => Effect.succeed(false),
      }),
      Layer.succeed(
        HttpClient.HttpClient,
        HttpClient.make(() => Effect.die("Unexpected network request")),
      ),
      NodeCrypto.layer,
    ]),
  ),
);

it.effect("publishes validated HTTP quotas as display-only accounts", () => {
  const window = { id: "monthly", kind: "monthly", label: "Monthly", usedPercent: 35 };
  const accounts = [
    { id: "account", label: "External plan", providerInstanceId: "work-codex", windows: [window] },
  ];
  let usedPercent = 35;
  let oversized = false;
  const client = HttpClient.make((request, url) =>
    Effect.sync(() => {
      expect(url.href).toBe("https://quota.test/v1");
      expect(request.headers.authorization).toBe("Bearer test-token");
      return HttpClientResponse.fromWeb(
        request,
        new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(
                new TextEncoder().encode(
                  JSON.stringify({
                    version: 1,
                    accounts: [{ ...accounts[0], windows: [{ ...window, usedPercent }] }],
                  }),
                ),
              );
              if (oversized) controller.enqueue(new Uint8Array(1024 * 1024).fill(32));
              controller.close();
            },
          }),
        ),
      );
    }),
  );
  return Effect.gen(function* () {
    const sources = yield* UsageLimitSources.make;
    yield* sources.refresh;
    const [snapshot] = yield* sources.current;
    expect(snapshot).toMatchObject({ kind: "http", accounts: [], quotaAccounts: accounts });
    expect(snapshot?.origin).toBeUndefined();
    usedPercent = 101;
    yield* sources.refresh;
    const [failed] = yield* sources.current;
    expect(failed).toMatchObject({ accounts: [], error: "Could not read the HTTP quota source." });
    expect(failed?.quotaAccounts).toEqual(accounts);
    usedPercent = 35;
    oversized = true;
    yield* sources.refresh;
    expect((yield* sources.current)[0]).toMatchObject({
      accounts: [],
      error: "Could not read the HTTP quota source.",
      quotaAccounts: accounts,
    });
  }).pipe(
    Effect.provide([
      Layer.succeed(SecretResolver.SecretResolver, {
        label: (provider) => Effect.succeed(provider),
        read: (references) => Effect.succeed(references.map(() => undefined)),
        invalidate: () => Effect.void,
      }),
      ServerSettings.layerTest({
        usageLimitSources: {
          [UsageLimitSourceId.make("quota")]: {
            kind: "http",
            url: "https://quota.test/v1",
            managementKey: "test-token",
            enabled: true,
          },
        },
      }),
      Layer.mock(BackgroundPolicy.BackgroundPolicy)({
        shouldRunScopeWork: () => Effect.succeed(false),
      }),
      Layer.succeed(HttpClient.HttpClient, client),
      NodeCrypto.layer,
    ]),
  );
});

it.effect("retains direct readings only for the same kind and effective target", () => {
  const kimiId = UsageLimitSourceId.make("kimi");
  const zaiId = UsageLimitSourceId.make("zai");
  const ompId = UsageLimitSourceId.make("omp");
  const key = "resolved-test-key";
  const kimiConfig = {
    kind: "kimi",
    url: "https://not-the-service.test",
    managementKey: { provider: SecretProviderId.make("homelab"), reference: "kimi#key" },
    enabled: true,
  } as const;
  const kimiPath = "/coding/v1/usages";
  const zaiPath = "/api/monitor/usage/quota/limit";
  let mode: "healthy" | "oversized" | "rejected" | "networkError" = "healthy";
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    const headers = new Headers(init?.headers);
    expect(init?.redirect).toBe("error");
    expect(headers.get("accept")).toBe("application/json");
    if (url.pathname === kimiPath) {
      expect(["https://api.kimi.com", "https://api.kimi.ai"]).toContain(url.origin);
      if (mode === "rejected") return new Response(key, { status: 401 });
      expect(headers.get("x-api-key")).toBe(key);
      expect(headers.has("authorization")).toBe(false);
      if (mode === "networkError") throw new Error(key);
      return Response.json({
        usage: { used: 67, limit: 100 },
        ...(mode === "oversized" ? { padding: "x".repeat(1024 * 1024) } : {}),
      });
    }
    expect(url.origin).toBe("https://open.bigmodel.cn");
    expect(headers.get("authorization")).toBe(`Bearer ${key}`);
    expect(headers.has("x-api-key")).toBe(false);
    if (url.pathname === "/api/biz/subscription/list") {
      return new Response(key, { status: 503 });
    }
    expect(url.pathname).toBe(zaiPath);
    return Response.json({
      success: true,
      data: { limits: [{ type: "TOKENS_LIMIT", unit: 3, number: 5, percentage: 23 }] },
    });
  };
  return Effect.gen(function* () {
    const settings = yield* ServerSettings.ServerSettingsService;
    const sources = yield* UsageLimitSources.make;
    const find = (id: UsageLimitSourceId) =>
      sources.current.pipe(Effect.map((snapshots) => snapshots.find((source) => source.id === id)));
    yield* sources.refresh;
    const kimi = yield* find(kimiId);
    expect(kimi).toMatchObject({
      kind: "kimi",
      label: "Kimi Code",
      quotaAccounts: [{ windows: [{ kind: "weekly", usedPercent: 67 }] }],
    });
    expect(yield* find(zaiId)).toMatchObject({
      kind: "zai",
      label: "Z.ai / BigModel",
      quotaAccounts: [{ windows: [{ kind: "session", usedPercent: 23 }] }],
    });
    expect(yield* find(ompId)).toMatchObject({
      kind: "omp",
      label: "OMP Local Cache",
      error: expect.any(String),
    });

    const refused = yield* sources
      .consumeResetCredit({ sourceId: kimiId, accountId: "account", creditId: "credit" })
      .pipe(Effect.flip);
    expect(refused._tag).toBe("UsageLimitSourceError");
    mode = "oversized";
    yield* sources.refresh;
    expect(yield* find(kimiId)).toMatchObject({
      error: expect.any(String),
      quotaAccounts: kimi?.quotaAccounts,
    });
    mode = "networkError";
    yield* sources.refresh;
    expect(yield* find(kimiId)).toMatchObject({
      error: "Could not read Kimi Code usage.",
      quotaAccounts: kimi?.quotaAccounts,
    });

    mode = "rejected";
    yield* settings.updateSettings({
      usageLimitSources: { [kimiId]: { ...kimiConfig, region: "cn", url: "ignored" } },
    });
    yield* sources.refresh;
    expect(yield* find(kimiId)).toMatchObject({
      error: expect.any(String),
      quotaAccounts: kimi?.quotaAccounts,
    });
    yield* settings.updateSettings({
      usageLimitSources: { [kimiId]: { ...kimiConfig, region: "global" } },
    });
    yield* sources.refresh;
    expect((yield* find(kimiId))?.quotaAccounts).toBeUndefined();
    expect(JSON.stringify(yield* sources.current)).not.toContain(key);

    mode = "healthy";
    yield* sources.refresh;
    expect((yield* find(kimiId))?.quotaAccounts).toEqual(kimi?.quotaAccounts);
    mode = "rejected";
    yield* settings.updateSettings({
      usageLimitSources: {
        [kimiId]: {
          kind: "http",
          url: `https://api.kimi.ai${kimiPath}`,
          managementKey: "",
          enabled: true,
        },
      },
    });
    yield* sources.refresh;
    expect(yield* find(kimiId)).toMatchObject({ kind: "http", error: expect.any(String) });
    expect((yield* find(kimiId))?.quotaAccounts).toBeUndefined();
  }).pipe(
    Effect.provide([
      ServerSettings.layerTest({
        usageLimitSources: {
          [kimiId]: kimiConfig,
          [zaiId]: {
            kind: "zai",
            region: "cn",
            url: "zai://default",
            managementKey: key,
            enabled: true,
          },
          [ompId]: { kind: "omp", url: ".", managementKey: "", enabled: true },
        },
      }),
      Layer.mock(BackgroundPolicy.BackgroundPolicy)({
        shouldRunScopeWork: () => Effect.succeed(false),
      }),
      Layer.succeed(SecretResolver.SecretResolver, {
        label: (provider) => Effect.succeed(provider),
        read: (references) =>
          Effect.succeed(references.map((ref) => (ref.reference === "kimi#key" ? key : undefined))),
        invalidate: () => Effect.void,
      }),
      FetchHttpClient.layer.pipe(Layer.provide(Layer.succeed(FetchHttpClient.Fetch, fetch))),
      NodeCrypto.layer,
    ]),
  );
});

it.effect(
  "keeps resolved API keys out of trace spans on invalid headers or transport errors",
  () => {
    const newlineSecret = "sk-kimi-newline-secret\nInjected: 1";
    const transportSecret = "sk-kimi-transport-secret";
    let currentKey = newlineSecret;
    let fetchCalls = 0;
    const records: Array<EffectTraceRecord> = [];
    const fetch: typeof globalThis.fetch = async (_input, init) => {
      fetchCalls += 1;
      // Mirror native Fetch Headers validation and a secret-bearing transport exception.
      const headers = new Headers(init?.headers);
      expect(headers.get("accept")).toBe("application/json");
      throw new Error(`transport failed with ${transportSecret}`);
    };
    return Effect.gen(function* () {
      const tracer = yield* makeLocalFileTracer({
        filePath: "unused",
        maxBytes: 1024 * 1024,
        maxFiles: 1,
        batchWindowMs: 10_000,
        sink: {
          filePath: "unused",
          push: (record) => {
            if (record.type === "effect-span") records.push(record);
          },
          flush: Effect.void,
          flushSync: () => {},
          close: () => Effect.void,
        },
      });
      const run = Effect.gen(function* () {
        const sources = yield* UsageLimitSources.make;
        yield* sources.refresh;
        expect(yield* sources.current).toMatchObject([
          { kind: "kimi", error: "Could not read Kimi Code usage." },
        ]);
        expect(fetchCalls).toBe(0);

        currentKey = transportSecret;
        yield* sources.refresh;
        expect(yield* sources.current).toMatchObject([
          { kind: "kimi", error: "Could not read Kimi Code usage." },
        ]);
        expect(fetchCalls).toBeGreaterThanOrEqual(1);
      }).pipe(Effect.withTracer(tracer), Effect.withTracerEnabled(true));

      yield* run;
      const serialized = JSON.stringify(records);
      expect(serialized).not.toContain("sk-kimi-newline-secret");
      expect(serialized).not.toContain(transportSecret);
    }).pipe(
      Effect.scoped,
      Effect.provide([
        ServerSettings.layerTest({
          usageLimitSources: {
            [UsageLimitSourceId.make("kimi")]: {
              kind: "kimi",
              region: "cn",
              url: "https://api.kimi.com/coding/v1/usages",
              managementKey: { provider: SecretProviderId.make("homelab"), reference: "kimi#key" },
              enabled: true,
            },
          },
        }),
        Layer.mock(BackgroundPolicy.BackgroundPolicy)({
          shouldRunScopeWork: () => Effect.succeed(false),
        }),
        Layer.succeed(SecretResolver.SecretResolver, {
          label: (provider) => Effect.succeed(provider),
          read: (references) => Effect.succeed(references.map(() => currentKey)),
          invalidate: () => Effect.void,
        }),
        FetchHttpClient.layer.pipe(Layer.provide(Layer.succeed(FetchHttpClient.Fetch, fetch))),
        NodeCrypto.layer,
        NodeServices.layer,
      ]),
    );
  },
);

it.effect(
  "fences stale in-flight reads after credential changes and separates anonymous from unresolved HTTP auth",
  () =>
    Effect.gen(function* () {
      const kimiId = UsageLimitSourceId.make("kimi-race");
      const httpId = UsageLimitSourceId.make("http-auth");
      const inFlightStarted = yield* Deferred.make<void>();
      const releaseInFlight = yield* Deferred.make<void>();
      let keyACalls = 0;

      const client = HttpClient.make((request, url) => {
        if (url.hostname === "api.kimi.com") {
          const apiKey = request.headers["x-api-key"];
          if (apiKey === "key-a") {
            keyACalls += 1;
            if (keyACalls === 1) {
              return Effect.succeed(
                HttpClientResponse.fromWeb(
                  request,
                  Response.json({ usage: { used: 10, limit: 100 } }),
                ),
              );
            }
            return Deferred.succeed(inFlightStarted, undefined).pipe(
              Effect.andThen(Deferred.await(releaseInFlight)),
              Effect.as(
                HttpClientResponse.fromWeb(
                  request,
                  Response.json({ usage: { used: 88, limit: 100 } }),
                ),
              ),
            );
          }
          return Effect.succeed(
            HttpClientResponse.fromWeb(request, new Response("", { status: 401 })),
          );
        }
        return Effect.succeed(
          HttpClientResponse.fromWeb(
            request,
            Response.json({
              version: 1,
              accounts: [
                {
                  id: "anon",
                  label: "Anonymous",
                  windows: [{ id: "m", kind: "monthly", label: "Monthly", usedPercent: 25 }],
                },
              ],
            }),
          ),
        );
      });

      const settings = yield* ServerSettings.ServerSettingsService;
      const sources = yield* UsageLimitSources.make.pipe(
        Effect.provideService(HttpClient.HttpClient, client),
      );
      // Wait for the initial background refresh so only our explicit refresh below is in flight.
      const initial = yield* sources.streamChanges.pipe(
        Stream.filter((snapshots) => snapshots.length === 2),
        Stream.runHead,
        Effect.flatMap(Effect.fromOption),
      );
      expect(
        initial.find((entry) => entry.id === kimiId)?.quotaAccounts?.[0]?.windows[0]?.usedPercent,
      ).toBe(10);
      expect(initial.find((entry) => entry.id === httpId)?.quotaAccounts).toHaveLength(1);

      // Start a refresh with key A (returning 88%) and swap settings to key B while A is in flight.
      const staleFiber = yield* Effect.forkChild(sources.refresh);
      yield* Deferred.await(inFlightStarted);
      yield* settings.updateSettings({
        usageLimitSources: {
          [kimiId]: {
            kind: "kimi",
            region: "cn",
            url: "https://api.kimi.com/coding/v1/usages",
            managementKey: "key-b",
            enabled: true,
          },
          [httpId]: {
            kind: "http",
            url: "https://quota.test/v1",
            managementKey: { provider: SecretProviderId.make("vault"), reference: "missing#token" },
            enabled: true,
          },
        },
      });
      yield* Deferred.succeed(releaseInFlight, undefined);
      yield* Fiber.join(staleFiber);

      // Stale 88% from key A must never be published after key B was saved.
      expect((yield* sources.current).find((entry) => entry.id === kimiId)).toBeUndefined();

      // Next refresh runs with key B (401) and unresolved HTTP secret; neither inherits prior bars.
      yield* sources.refresh;
      const after = yield* sources.current;
      expect(after.find((entry) => entry.id === kimiId)).toMatchObject({
        error: "Kimi Code rejected the API key (HTTP 401).",
      });
      expect(after.find((entry) => entry.id === kimiId)?.quotaAccounts).toBeUndefined();
      expect(after.find((entry) => entry.id === httpId)).toMatchObject({
        error: "Could not resolve the quota source token.",
      });
      expect(after.find((entry) => entry.id === httpId)?.quotaAccounts).toBeUndefined();
    }).pipe(
      Effect.provide([
        ServerSettings.layerTest({
          usageLimitSources: {
            [UsageLimitSourceId.make("kimi-race")]: {
              kind: "kimi",
              region: "cn",
              url: "https://api.kimi.com/coding/v1/usages",
              managementKey: "key-a",
              enabled: true,
            },
            [UsageLimitSourceId.make("http-auth")]: {
              kind: "http",
              url: "https://quota.test/v1",
              managementKey: "",
              enabled: true,
            },
          },
        }),
        Layer.mock(BackgroundPolicy.BackgroundPolicy)({
          shouldRunScopeWork: () => Effect.succeed(false),
        }),
        Layer.succeed(SecretResolver.SecretResolver, {
          label: (provider) => Effect.succeed(provider),
          read: (references) => Effect.succeed(references.map(() => undefined)),
          invalidate: () => Effect.void,
        }),
        NodeCrypto.layer,
      ]),
    ),
);

it.effect(
  "fences and refreshes when a referenced secret provider rebinds, while preserving last-good readings on label-only edits",
  () =>
    Effect.gen(function* () {
      const providerId = SecretProviderId.make("op-personal");
      const kimiId = UsageLimitSourceId.make("kimi-op");
      const httpId = UsageLimitSourceId.make("http-rename");
      const reference = { provider: providerId, reference: "op://Private/Kimi/credential" };
      const initialSettings: ServerSettingsModel = {
        ...DEFAULT_SERVER_SETTINGS,
        secretProviders: {
          [providerId]: {
            kind: SecretProviderKind.make("one_password"),
            label: "1Password",
            config: { account: "acct-a" },
          },
        },
        usageLimitSources: {
          [kimiId]: {
            kind: "kimi",
            region: "cn",
            url: "https://api.kimi.com/coding/v1/usages",
            managementKey: reference,
            enabled: true,
          },
          [httpId]: {
            kind: "http",
            label: "Old label",
            url: "https://quota.test/v1",
            managementKey: "",
            enabled: true,
          },
        },
      };
      const settingsRef = yield* Ref.make(initialSettings);
      const settingsPubSub = yield* Effect.acquireRelease(
        PubSub.unbounded<ServerSettingsModel>(),
        PubSub.shutdown,
      );
      const settingsService: ServerSettings.ServerSettingsService["Service"] = {
        start: Effect.void,
        ready: Effect.void,
        getSettings: Ref.get(settingsRef),
        updateSettings: (patch) =>
          Ref.updateAndGet(settingsRef, (current) => applyServerSettingsPatch(current, patch)).pipe(
            Effect.tap((next) => PubSub.publish(settingsPubSub, next)),
          ),
        updateProviderInstance: () => Effect.die("unused"),
        withSettingsSnapshot: (use) => Ref.get(settingsRef).pipe(Effect.flatMap(use)),
        streamChanges: Stream.fromPubSub(settingsPubSub),
        subscribeChanges: Effect.succeed(Stream.fromPubSub(settingsPubSub)),
      };

      const secretResolver = yield* SecretResolver.make({
        drivers: [
          {
            kind: onePasswordDefinition.kind,
            definition: onePasswordDefinition,
            read: (config, references) => {
              const account = (config as { readonly account: string }).account;
              const secret = account === "acct-a" ? "key-a" : "key-b";
              return Effect.succeed(references.map(() => secret));
            },
          },
        ],
        secretProviders: Ref.get(settingsRef).pipe(
          Effect.map((settings) => settings.secretProviders),
        ),
      });

      const inFlightStarted = yield* Deferred.make<void>();
      const releaseInFlight = yield* Deferred.make<void>();
      const keyBSeen = yield* Deferred.make<void>();
      let keyACalls = 0;
      let httpOutage = false;

      const client = HttpClient.make((request, url) => {
        if (url.hostname === "api.kimi.com") {
          const apiKey = request.headers["x-api-key"];
          if (apiKey === "key-a") {
            keyACalls += 1;
            if (keyACalls === 1) {
              return Effect.succeed(
                HttpClientResponse.fromWeb(
                  request,
                  Response.json({ usage: { used: 10, limit: 100 } }),
                ),
              );
            }
            return Deferred.succeed(inFlightStarted, undefined).pipe(
              Effect.andThen(Deferred.await(releaseInFlight)),
              Effect.as(
                HttpClientResponse.fromWeb(
                  request,
                  Response.json({ usage: { used: 88, limit: 100 } }),
                ),
              ),
            );
          }
          return Deferred.succeed(keyBSeen, undefined).pipe(
            Effect.as(HttpClientResponse.fromWeb(request, new Response("", { status: 401 }))),
          );
        }
        if (httpOutage) {
          return Effect.succeed(
            HttpClientResponse.fromWeb(request, new Response("", { status: 503 })),
          );
        }
        return Effect.succeed(
          HttpClientResponse.fromWeb(
            request,
            Response.json({
              version: 1,
              accounts: [
                {
                  id: "anon",
                  label: "Anonymous",
                  windows: [{ id: "m", kind: "monthly", label: "Monthly", usedPercent: 36 }],
                },
              ],
            }),
          ),
        );
      });

      const sources = yield* UsageLimitSources.make.pipe(
        Effect.provide([
          Layer.succeed(ServerSettings.ServerSettingsService, settingsService),
          Layer.succeed(SecretResolver.SecretResolver, secretResolver),
          Layer.succeed(HttpClient.HttpClient, client),
        ]),
      );

      const observedPercents: Array<number | undefined> = [];
      const observer = yield* sources.streamChanges.pipe(
        Stream.runForEach((snapshots) =>
          Effect.sync(() => {
            const kimi = snapshots.find((entry) => entry.id === kimiId);
            observedPercents.push(kimi?.quotaAccounts?.[0]?.windows[0]?.usedPercent);
          }),
        ),
        Effect.forkChild,
      );

      // Wait for initial poll (Kimi 10% from acct-a, HTTP 36% under "Old label").
      const initial = yield* sources.streamChanges.pipe(
        Stream.filter((snapshots) => snapshots.length === 2),
        Stream.runHead,
        Effect.flatMap(Effect.fromOption),
      );
      expect(
        initial.find((entry) => entry.id === kimiId)?.quotaAccounts?.[0]?.windows[0]?.usedPercent,
      ).toBe(10);
      expect(initial.find((entry) => entry.id === httpId)).toMatchObject({
        label: "Old label",
        quotaAccounts: [{ windows: [{ usedPercent: 36 }] }],
      });

      // Hold a second poll for acct-a (88%) + HTTP (36%).
      const inFlightFiber = yield* Effect.forkChild(sources.refresh);
      yield* Deferred.await(inFlightStarted);

      // Rebind 1Password provider to acct-b (same SecretReference text) AND rename HTTP source label.
      yield* settingsService.updateSettings({
        secretProviders: {
          [providerId]: {
            kind: SecretProviderKind.make("one_password"),
            label: "1Password",
            config: { account: "acct-b" },
          },
        },
        usageLimitSources: {
          [httpId]: {
            kind: "http",
            label: "Renamed label",
            url: "https://quota.test/v1",
            managementKey: "",
            enabled: true,
          },
        },
      });
      yield* Deferred.succeed(releaseInFlight, undefined);
      yield* Fiber.join(inFlightFiber);

      // The provider rebind must automatically schedule a refresh using acct-b (key-b -> 401).
      yield* Deferred.await(keyBSeen);
      const afterRebind = yield* sources.streamChanges.pipe(
        Stream.filter((snapshots) =>
          snapshots.some(
            (entry) =>
              entry.id === kimiId && entry.error === "Kimi Code rejected the API key (HTTP 401).",
          ),
        ),
        Stream.runHead,
        Effect.flatMap(Effect.fromOption),
      );
      expect(observedPercents).not.toContain(88);
      expect(afterRebind.find((entry) => entry.id === kimiId)?.quotaAccounts).toBeUndefined();
      // Label-only rename kept HTTP present and updated its label without losing its 36% reading.
      expect(afterRebind.find((entry) => entry.id === httpId)).toMatchObject({
        label: "Renamed label",
        quotaAccounts: [{ windows: [{ usedPercent: 36 }] }],
      });

      // A subsequent 503 outage after the label-only rename still keeps last-good 36% quotas.
      httpOutage = true;
      yield* sources.refresh;
      const afterOutage = yield* sources.current;
      expect(afterOutage.find((entry) => entry.id === httpId)).toMatchObject({
        label: "Renamed label",
        error: "Could not read the HTTP quota source.",
        quotaAccounts: [{ windows: [{ usedPercent: 36 }] }],
      });
      yield* Fiber.interrupt(observer);
    }).pipe(
      Effect.scoped,
      Effect.provide([
        Layer.mock(BackgroundPolicy.BackgroundPolicy)({
          shouldRunScopeWork: () => Effect.succeed(false),
        }),
        NodeCrypto.layer,
        NodeServices.layer,
      ]),
    ),
);

it.effect(
  "prevents stale publication when settings mutate during an async vault fence and normalizes CLIProxyAPI trailing slashes identically",
  () =>
    Effect.gen(function* () {
      const providerId = SecretProviderId.make("op-fence");
      const kimiId = UsageLimitSourceId.make("kimi-literal");
      const httpId = UsageLimitSourceId.make("http-op");
      const hubId = UsageLimitSourceId.make("cliproxy-slashes");
      const initialSettings: ServerSettingsModel = {
        ...DEFAULT_SERVER_SETTINGS,
        secretProviders: {
          [providerId]: {
            kind: SecretProviderKind.make("one_password"),
            label: "1Password",
            config: { account: "acct-a" },
          },
        },
        usageLimitSources: {
          [kimiId]: {
            kind: "kimi",
            region: "cn",
            url: "https://api.kimi.com/coding/v1/usages",
            managementKey: "key-a",
            enabled: true,
          },
          [httpId]: {
            kind: "http",
            url: "https://quota.test/v1",
            managementKey: { provider: providerId, reference: "op://Private/Http/token" },
            enabled: true,
          },
          [hubId]: {
            kind: "cliproxy",
            url: "https://fixture.test/hub///",
            managementKey: "hub-secret",
            enabled: true,
          },
        },
      };

      const settingsRef = yield* Ref.make(initialSettings);
      const writeLock = yield* Semaphore.make(1);
      const settingsService: ServerSettings.ServerSettingsService["Service"] = {
        start: Effect.void,
        ready: Effect.void,
        getSettings: Ref.get(settingsRef),
        updateSettings: (patch) =>
          writeLock.withPermits(1)(
            Ref.updateAndGet(settingsRef, (current) => applyServerSettingsPatch(current, patch)),
          ),
        updateProviderInstance: () => Effect.die("unused"),
        withSettingsSnapshot: (use) =>
          writeLock.withPermits(1)(Ref.get(settingsRef).pipe(Effect.flatMap(use))),
        streamChanges: Stream.empty,
        subscribeChanges: Effect.succeed(Stream.empty),
      };

      const vaultLookupPending = yield* Deferred.make<void>();
      const releaseVaultLookup = yield* Deferred.make<void>();
      const secretResolver = yield* SecretResolver.make({
        drivers: [
          {
            kind: onePasswordDefinition.kind,
            definition: onePasswordDefinition,
            read: (config, references) => {
              const account = (config as { readonly account: string }).account;
              if (account === "acct-b") {
                return Deferred.succeed(vaultLookupPending, undefined).pipe(
                  Effect.andThen(Deferred.await(releaseVaultLookup)),
                  Effect.as(references.map(() => "token-b")),
                );
              }
              return Effect.succeed(references.map(() => "token-a"));
            },
          },
        ],
        secretProviders: Ref.get(settingsRef).pipe(
          Effect.map((settings) => settings.secretProviders),
        ),
      });

      const httpHeld = yield* Deferred.make<void>();
      const releaseHttp = yield* Deferred.make<void>();
      let kimiCalls = 0;
      let httpCalls = 0;
      const requestedHubPaths: string[] = [];

      const client = HttpClient.make((request, url) => {
        if (url.hostname === "fixture.test") {
          requestedHubPaths.push(url.pathname);
          return Effect.succeed(HttpClientResponse.fromWeb(request, Response.json({ files: [] })));
        }
        if (url.hostname === "api.kimi.com") {
          kimiCalls += 1;
          if (request.headers["x-api-key"] === "key-a") {
            return Effect.succeed(
              HttpClientResponse.fromWeb(
                request,
                Response.json({ usage: { used: kimiCalls === 1 ? 10 : 88, limit: 100 } }),
              ),
            );
          }
          return Effect.succeed(
            HttpClientResponse.fromWeb(request, new Response("", { status: 401 })),
          );
        }
        httpCalls += 1;
        const okResponse = HttpClientResponse.fromWeb(
          request,
          Response.json({
            version: 1,
            accounts: [
              {
                id: "http-1",
                label: "HTTP",
                windows: [{ id: "m", kind: "monthly", label: "Monthly", usedPercent: 20 }],
              },
            ],
          }),
        );
        if (httpCalls === 2) {
          return Deferred.succeed(httpHeld, undefined).pipe(
            Effect.andThen(Deferred.await(releaseHttp)),
            Effect.as(okResponse),
          );
        }
        return Effect.succeed(okResponse);
      });

      const sources = yield* UsageLimitSources.make.pipe(
        Effect.provide([
          Layer.succeed(ServerSettings.ServerSettingsService, settingsService),
          Layer.succeed(SecretResolver.SecretResolver, secretResolver),
          Layer.succeed(HttpClient.HttpClient, client),
        ]),
      );

      // Wait for initial poll (Kimi 10%, HTTP 20%, CLIProxyAPI normalized to /hub/v0/management/...).
      const initial = yield* sources.streamChanges.pipe(
        Stream.filter((snapshots) => snapshots.length === 3),
        Stream.runHead,
        Effect.flatMap(Effect.fromOption),
      );
      expect(initial.find((entry) => entry.id === hubId)?.endpoint).toBe(
        "https://fixture.test/hub",
      );
      expect(requestedHubPaths).toEqual(["/hub/v0/management/auth-files"]);

      // Start poll #2: Kimi reads 88% with key-a while HTTP response is held.
      const pollFiber = yield* Effect.forkChild(sources.refresh);
      yield* Deferred.await(httpHeld);

      // Rebind HTTP's 1Password provider and release HTTP so the post-read fence blocks on acct-b lookup.
      yield* settingsService.updateSettings({
        secretProviders: {
          [providerId]: {
            kind: SecretProviderKind.make("one_password"),
            label: "1Password",
            config: { account: "acct-b" },
          },
        },
      });
      yield* Deferred.succeed(releaseHttp, undefined);
      yield* Deferred.await(vaultLookupPending);

      // While the fence's vault lookup is pending, save Kimi key-b (proves write lock is NOT held).
      yield* settingsService.updateSettings({
        usageLimitSources: {
          [kimiId]: {
            kind: "kimi",
            region: "cn",
            url: "https://api.kimi.com/coding/v1/usages",
            managementKey: "key-b",
            enabled: true,
          },
        },
      });
      yield* Deferred.succeed(releaseVaultLookup, undefined);
      yield* Fiber.join(pollFiber);

      // Kimi's 88% reading from key-a must NOT be published after key-b was committed.
      expect((yield* sources.current).find((entry) => entry.id === kimiId)).toBeUndefined();
    }).pipe(
      Effect.scoped,
      Effect.provide([
        Layer.mock(BackgroundPolicy.BackgroundPolicy)({
          shouldRunScopeWork: () => Effect.succeed(false),
        }),
        NodeCrypto.layer,
        NodeServices.layer,
      ]),
    ),
);

it.effect(
  "fences stale publication when the same secret reference rotates via fresh read while waiting for withSettingsSnapshot and rejects CLIProxyAPI userinfo URLs",
  () =>
    Effect.gen(function* () {
      const providerId = SecretProviderId.make("op-rotate");
      const kimiId = UsageLimitSourceId.make("kimi-rotate");
      const badHubId = UsageLimitSourceId.make("hub-userinfo");
      const reference = { provider: providerId, reference: "op://Private/Kimi/credential" };
      const initialSettings: ServerSettingsModel = {
        ...DEFAULT_SERVER_SETTINGS,
        secretProviders: {
          [providerId]: {
            kind: SecretProviderKind.make("one_password"),
            label: "1Password",
            config: { account: "personal" },
          },
        },
        usageLimitSources: {
          [kimiId]: {
            kind: "kimi",
            region: "cn",
            url: "https://api.kimi.com/coding/v1/usages",
            managementKey: reference,
            enabled: true,
          },
          [badHubId]: {
            kind: "cliproxy",
            url: "https://user:pass@hub.test/team",
            managementKey: "hub-secret",
            enabled: true,
          },
        },
      };

      const settingsRef = yield* Ref.make(initialSettings);
      const writeLock = yield* Semaphore.make(1);
      const waitingOnSnapshot = yield* Deferred.make<void>();
      let snapshotCalls = 0;
      const settingsService: ServerSettings.ServerSettingsService["Service"] = {
        start: Effect.void,
        ready: Effect.void,
        getSettings: Ref.get(settingsRef),
        updateSettings: (patch) =>
          writeLock.withPermits(1)(
            Ref.updateAndGet(settingsRef, (current) => applyServerSettingsPatch(current, patch)),
          ),
        updateProviderInstance: () => Effect.die("unused"),
        withSettingsSnapshot: (use) => {
          snapshotCalls += 1;
          const notify =
            snapshotCalls === 2 ? Deferred.succeed(waitingOnSnapshot, undefined) : Effect.void;
          return notify.pipe(
            Effect.andThen(
              writeLock.withPermits(1)(Ref.get(settingsRef).pipe(Effect.flatMap(use))),
            ),
          );
        },
        streamChanges: Stream.empty,
        subscribeChanges: Effect.succeed(Stream.empty),
      };

      let vaultSecret = "key-a";
      const secretResolver = yield* SecretResolver.make({
        drivers: [
          {
            kind: onePasswordDefinition.kind,
            definition: onePasswordDefinition,
            read: (_config, references) => Effect.succeed(references.map(() => vaultSecret)),
          },
        ],
        secretProviders: Ref.get(settingsRef).pipe(
          Effect.map((settings) => settings.secretProviders),
        ),
      });

      let keyACalls = 0;
      const client = HttpClient.make((request, url) => {
        if (url.hostname === "hub.test") {
          return Effect.die("Userinfo CLIProxyAPI URL must be rejected before Fetch");
        }
        if (request.headers["x-api-key"] === "key-a") {
          keyACalls += 1;
          return Effect.succeed(
            HttpClientResponse.fromWeb(
              request,
              Response.json({ usage: { used: keyACalls === 1 ? 10 : 88, limit: 100 } }),
            ),
          );
        }
        return Effect.succeed(
          HttpClientResponse.fromWeb(request, new Response("", { status: 401 })),
        );
      });

      const sources = yield* UsageLimitSources.make.pipe(
        Effect.provide([
          Layer.succeed(ServerSettings.ServerSettingsService, settingsService),
          Layer.succeed(SecretResolver.SecretResolver, secretResolver),
          Layer.succeed(HttpClient.HttpClient, client),
        ]),
      );

      // (1) Establish Kimi reference at 10% under key-a; userinfo hub is rejected cleanly.
      const initial = yield* sources.streamChanges.pipe(
        Stream.filter((snapshots) => snapshots.length === 2),
        Stream.runHead,
        Effect.flatMap(Effect.fromOption),
      );
      expect(
        initial.find((entry) => entry.id === kimiId)?.quotaAccounts?.[0]?.windows[0]?.usedPercent,
      ).toBe(10);
      expect(initial.find((entry) => entry.id === badHubId)).toMatchObject({
        error: "The hub URL is not valid.",
      });
      expect(initial.find((entry) => entry.id === badHubId)?.endpoint).toBeUndefined();

      // (2) Hold the settings write semaphore while poll #2 reads 88% under key-a and reaches withSettingsSnapshot.
      const releaseWriteLock = yield* Deferred.make<void>();
      const lockHolderReady = yield* Deferred.make<void>();
      const lockHolder = yield* writeLock
        .withPermits(1)(
          Deferred.succeed(lockHolderReady, undefined).pipe(
            Effect.andThen(Deferred.await(releaseWriteLock)),
          ),
        )
        .pipe(Effect.forkChild);
      yield* Deferred.await(lockHolderReady);

      const pollFiber = yield* Effect.forkChild(sources.refresh);
      yield* Deferred.await(waitingOnSnapshot);

      // (3) Rotate the same vault item and run a fresh read (as SecretCheck RPC does); resolver now caches key-b.
      vaultSecret = "key-b";
      expect(yield* secretResolver.read([reference], { fresh: true })).toEqual(["key-b"]);

      // (4) Release the settings semaphore: stale 88% under key-a must NOT publish after key-b was observed.
      yield* Deferred.succeed(releaseWriteLock, undefined);
      yield* Fiber.join(lockHolder);
      yield* Fiber.join(pollFiber);
      expect((yield* sources.current).find((entry) => entry.id === kimiId)).toBeUndefined();
    }).pipe(
      Effect.scoped,
      Effect.provide([
        Layer.mock(BackgroundPolicy.BackgroundPolicy)({
          shouldRunScopeWork: () => Effect.succeed(false),
        }),
        NodeCrypto.layer,
        NodeServices.layer,
      ]),
    ),
);

it.effect(
  "preserves last-good quotas across a same-key secret-cache invalidation during a 503 outage",
  () =>
    Effect.gen(function* () {
      const providerId = SecretProviderId.make("op-outage");
      const kimiId = UsageLimitSourceId.make("kimi-outage");
      const reference = { provider: providerId, reference: "op://Private/Kimi/credential" };
      const initialSettings: ServerSettingsModel = {
        ...DEFAULT_SERVER_SETTINGS,
        secretProviders: {
          [providerId]: {
            kind: SecretProviderKind.make("one_password"),
            label: "1Password",
            config: { account: "personal" },
          },
        },
        usageLimitSources: {
          [kimiId]: {
            kind: "kimi",
            region: "cn",
            url: "https://api.kimi.com/coding/v1/usages",
            managementKey: reference,
            enabled: true,
          },
        },
      };

      const settingsRef = yield* Ref.make(initialSettings);
      const writeLock = yield* Semaphore.make(1);
      const settingsService: ServerSettings.ServerSettingsService["Service"] = {
        start: Effect.void,
        ready: Effect.void,
        getSettings: Ref.get(settingsRef),
        updateSettings: (patch) =>
          writeLock.withPermits(1)(
            Ref.updateAndGet(settingsRef, (current) => applyServerSettingsPatch(current, patch)),
          ),
        updateProviderInstance: () => Effect.die("unused"),
        withSettingsSnapshot: (use) =>
          writeLock.withPermits(1)(Ref.get(settingsRef).pipe(Effect.flatMap(use))),
        streamChanges: Stream.empty,
        subscribeChanges: Effect.succeed(Stream.empty),
      };

      const secretResolver = yield* SecretResolver.make({
        drivers: [
          {
            kind: onePasswordDefinition.kind,
            definition: onePasswordDefinition,
            read: (_config, references) => Effect.succeed(references.map(() => "same-key-a")),
          },
        ],
        secretProviders: Ref.get(settingsRef).pipe(
          Effect.map((settings) => settings.secretProviders),
        ),
      });

      const outageHeld = yield* Deferred.make<void>();
      const releaseOutage = yield* Deferred.make<void>();
      let calls = 0;
      const client = HttpClient.make((request) => {
        calls += 1;
        if (calls === 1) {
          return Effect.succeed(
            HttpClientResponse.fromWeb(request, Response.json({ usage: { used: 10, limit: 100 } })),
          );
        }
        if (calls === 2) {
          return Deferred.succeed(outageHeld, undefined).pipe(
            Effect.andThen(Deferred.await(releaseOutage)),
            Effect.as(HttpClientResponse.fromWeb(request, new Response("", { status: 503 }))),
          );
        }
        return Effect.succeed(
          HttpClientResponse.fromWeb(request, new Response("", { status: 503 })),
        );
      });

      const sources = yield* UsageLimitSources.make.pipe(
        Effect.provide([
          Layer.succeed(ServerSettings.ServerSettingsService, settingsService),
          Layer.succeed(SecretResolver.SecretResolver, secretResolver),
          Layer.succeed(HttpClient.HttpClient, client),
        ]),
      );

      // (1) Establish Kimi 10% under the 1Password reference.
      const initial = yield* sources.streamChanges.pipe(
        Stream.filter((snapshots) => snapshots.length === 1),
        Stream.runHead,
        Effect.flatMap(Effect.fromOption),
      );
      expect(initial[0]?.quotaAccounts?.[0]?.windows[0]?.usedPercent).toBe(10);

      // (2) Start a poll that will fail with 503 and hold it.
      const poll2 = yield* Effect.forkChild(sources.refresh);
      yield* Deferred.await(outageHeld);

      // (3) Invalidate the same reference and queue a refresh (matching Refresh providers).
      yield* secretResolver.invalidate([reference]);
      const poll3 = yield* Effect.forkChild(sources.refresh);

      // (4) Release poll #2 and wait for both to complete: same-key 10% must survive the outage.
      yield* Deferred.succeed(releaseOutage, undefined);
      yield* Fiber.join(poll2);
      yield* Fiber.join(poll3);
      const final = (yield* sources.current)[0];
      expect(final).toMatchObject({
        error: "Kimi Code usage request failed (HTTP 503).",
        quotaAccounts: [{ windows: [{ usedPercent: 10 }] }],
      });
    }).pipe(
      Effect.scoped,
      Effect.provide([
        Layer.mock(BackgroundPolicy.BackgroundPolicy)({
          shouldRunScopeWork: () => Effect.succeed(false),
        }),
        NodeCrypto.layer,
        NodeServices.layer,
      ]),
    ),
);

it.effect(
  "retains last-good quotas when same-key invalidation lands after auth validation while waiting on withSettingsSnapshot",
  () =>
    Effect.gen(function* () {
      const providerId = SecretProviderId.make("op-late-inv");
      const kimiId = UsageLimitSourceId.make("kimi-late-inv");
      const reference = { provider: providerId, reference: "op://Private/Kimi/credential" };
      const initialSettings: ServerSettingsModel = {
        ...DEFAULT_SERVER_SETTINGS,
        secretProviders: {
          [providerId]: {
            kind: SecretProviderKind.make("one_password"),
            label: "1Password",
            config: { account: "personal" },
          },
        },
        usageLimitSources: {
          [kimiId]: {
            kind: "kimi",
            region: "cn",
            url: "https://api.kimi.com/coding/v1/usages",
            managementKey: reference,
            enabled: true,
          },
        },
      };

      const settingsRef = yield* Ref.make(initialSettings);
      const writeLock = yield* Semaphore.make(1);
      const waitingOnSnapshot = yield* Deferred.make<void>();
      let snapshotCalls = 0;
      const settingsService: ServerSettings.ServerSettingsService["Service"] = {
        start: Effect.void,
        ready: Effect.void,
        getSettings: Ref.get(settingsRef),
        updateSettings: (patch) =>
          writeLock.withPermits(1)(
            Ref.updateAndGet(settingsRef, (current) => applyServerSettingsPatch(current, patch)),
          ),
        updateProviderInstance: () => Effect.die("unused"),
        withSettingsSnapshot: (use) => {
          snapshotCalls += 1;
          const notify =
            snapshotCalls === 2 ? Deferred.succeed(waitingOnSnapshot, undefined) : Effect.void;
          return notify.pipe(
            Effect.andThen(
              writeLock.withPermits(1)(Ref.get(settingsRef).pipe(Effect.flatMap(use))),
            ),
          );
        },
        streamChanges: Stream.empty,
        subscribeChanges: Effect.succeed(Stream.empty),
      };

      const secretResolver = yield* SecretResolver.make({
        drivers: [
          {
            kind: onePasswordDefinition.kind,
            definition: onePasswordDefinition,
            read: (_config, references) => Effect.succeed(references.map(() => "same-key-a")),
          },
        ],
        secretProviders: Ref.get(settingsRef).pipe(
          Effect.map((settings) => settings.secretProviders),
        ),
      });

      let calls = 0;
      const client = HttpClient.make((request) => {
        calls += 1;
        return Effect.succeed(
          HttpClientResponse.fromWeb(
            request,
            calls === 1
              ? Response.json({ usage: { used: 10, limit: 100 } })
              : new Response("", { status: 503 }),
          ),
        );
      });

      const sources = yield* UsageLimitSources.make.pipe(
        Effect.provide([
          Layer.succeed(ServerSettings.ServerSettingsService, settingsService),
          Layer.succeed(SecretResolver.SecretResolver, secretResolver),
          Layer.succeed(HttpClient.HttpClient, client),
        ]),
      );

      // (1) Establish Kimi 10%.
      const initial = yield* sources.streamChanges.pipe(
        Stream.filter((snapshots) => snapshots.length === 1),
        Stream.runHead,
        Effect.flatMap(Effect.fromOption),
      );
      expect(initial[0]?.quotaAccounts?.[0]?.windows[0]?.usedPercent).toBe(10);

      // (2) Hold the settings write semaphore so poll #2 (503) completes auth validation and waits on withSettingsSnapshot.
      const releaseWriteLock = yield* Deferred.make<void>();
      const lockHolderReady = yield* Deferred.make<void>();
      const lockHolder = yield* writeLock
        .withPermits(1)(
          Deferred.succeed(lockHolderReady, undefined).pipe(
            Effect.andThen(Deferred.await(releaseWriteLock)),
          ),
        )
        .pipe(Effect.forkChild);
      yield* Deferred.await(lockHolderReady);

      const poll2 = yield* Effect.forkChild(sources.refresh);
      yield* Deferred.await(waitingOnSnapshot);

      // (3) Invalidate the reference without changing the key and queue poll #3.
      yield* secretResolver.invalidate([reference]);
      const poll3 = yield* Effect.forkChild(sources.refresh);

      // (4) Release write lock and let both polls settle: poll #3 proves same key and restores 10% alongside 503.
      yield* Deferred.succeed(releaseWriteLock, undefined);
      yield* Fiber.join(lockHolder);
      yield* Fiber.join(poll2);
      yield* Fiber.join(poll3);
      expect((yield* sources.current)[0]).toMatchObject({
        error: "Kimi Code usage request failed (HTTP 503).",
        quotaAccounts: [{ windows: [{ usedPercent: 10 }] }],
      });
    }).pipe(
      Effect.scoped,
      Effect.provide([
        Layer.mock(BackgroundPolicy.BackgroundPolicy)({
          shouldRunScopeWork: () => Effect.succeed(false),
        }),
        NodeCrypto.layer,
        NodeServices.layer,
      ]),
    ),
);

it.effect(
  "does not republish a hidden fenced source when redeeming a reset credit on an unrelated hub",
  () =>
    Effect.gen(function* () {
      const providerId = SecretProviderId.make("op-redeem");
      const kimiId = UsageLimitSourceId.make("kimi-hidden");
      const hubId = UsageLimitSourceId.make("hub-redeem");
      const reference = { provider: providerId, reference: "op://Private/Kimi/credential" };
      const initialSettings: ServerSettingsModel = {
        ...DEFAULT_SERVER_SETTINGS,
        secretProviders: {
          [providerId]: {
            kind: SecretProviderKind.make("one_password"),
            label: "1Password",
            config: { account: "personal" },
          },
        },
        usageLimitSources: {
          [kimiId]: {
            kind: "kimi",
            region: "cn",
            url: "https://api.kimi.com/coding/v1/usages",
            managementKey: reference,
            enabled: true,
          },
          [hubId]: {
            kind: "cliproxy",
            url: "https://hub.test",
            managementKey: "management-secret",
            enabled: true,
          },
        },
      };

      const settingsRef = yield* Ref.make(initialSettings);
      const writeLock = yield* Semaphore.make(1);
      const waitingOnSnapshot = yield* Deferred.make<void>();
      let snapshotCalls = 0;
      const settingsService: ServerSettings.ServerSettingsService["Service"] = {
        start: Effect.void,
        ready: Effect.void,
        getSettings: Ref.get(settingsRef),
        updateSettings: (patch) =>
          writeLock.withPermits(1)(
            Ref.updateAndGet(settingsRef, (current) => applyServerSettingsPatch(current, patch)),
          ),
        updateProviderInstance: () => Effect.die("unused"),
        withSettingsSnapshot: (use) => {
          snapshotCalls += 1;
          const notify =
            snapshotCalls === 2 ? Deferred.succeed(waitingOnSnapshot, undefined) : Effect.void;
          return notify.pipe(
            Effect.andThen(
              writeLock.withPermits(1)(Ref.get(settingsRef).pipe(Effect.flatMap(use))),
            ),
          );
        },
        streamChanges: Stream.empty,
        subscribeChanges: Effect.succeed(Stream.empty),
      };

      let vaultSecret = "key-a";
      const secretResolver = yield* SecretResolver.make({
        drivers: [
          {
            kind: onePasswordDefinition.kind,
            definition: onePasswordDefinition,
            read: (_config, references) => Effect.succeed(references.map(() => vaultSecret)),
          },
        ],
        secretProviders: Ref.get(settingsRef).pipe(
          Effect.map((settings) => settings.secretProviders),
        ),
      });

      let keyACalls = 0;
      let hubUsedPercent = 78;
      const client = HttpClient.make((request, url) => {
        if (url.hostname === "api.kimi.com") {
          if (request.headers["x-api-key"] === "key-a") {
            keyACalls += 1;
            return Effect.succeed(
              HttpClientResponse.fromWeb(
                request,
                Response.json({ usage: { used: keyACalls === 1 ? 10 : 88, limit: 100 } }),
              ),
            );
          }
          return Effect.succeed(
            HttpClientResponse.fromWeb(request, new Response("", { status: 401 })),
          );
        }
        const pathname = url.pathname;
        if (pathname.endsWith("/auth-files/models")) {
          return Effect.succeed(
            HttpClientResponse.fromWeb(request, Response.json({}, { status: 404 })),
          );
        }
        if (pathname.endsWith("/auth-files")) {
          return Effect.succeed(
            HttpClientResponse.fromWeb(
              request,
              Response.json({
                files: [
                  {
                    id: "first.json",
                    auth_index: "a",
                    provider: "codex",
                    email: "hub@example.com",
                  },
                ],
              }),
            ),
          );
        }
        if (pathname.endsWith("/reset-quota")) {
          return Effect.succeed(HttpClientResponse.fromWeb(request, Response.json({})));
        }
        const rawBody =
          request.body._tag === "Uint8Array" ? new TextDecoder().decode(request.body.body) : "";
        if (rawBody.includes("/consume")) {
          hubUsedPercent = 0;
          return Effect.succeed(
            HttpClientResponse.fromWeb(
              request,
              Response.json({ status_code: 200, body: JSON.stringify({ code: "reset" }) }),
            ),
          );
        }
        if (rawBody.includes("/rate-limit-reset-credits")) {
          return Effect.succeed(
            HttpClientResponse.fromWeb(
              request,
              Response.json({
                status_code: 200,
                body: JSON.stringify({
                  credits:
                    hubUsedPercent > 0
                      ? [
                          {
                            id: "credit-a",
                            status: "available",
                            reset_type: "codex_rate_limits",
                            expires_at: "2099-02-01T00:00:00Z",
                          },
                        ]
                      : [],
                }),
              }),
            ),
          );
        }
        return Effect.succeed(
          HttpClientResponse.fromWeb(
            request,
            Response.json({
              status_code: 200,
              body: JSON.stringify({
                plan_type: "pro",
                rate_limit: {
                  secondary_window: {
                    used_percent: hubUsedPercent,
                    reset_at: 4070908800,
                    limit_window_seconds: 604800,
                  },
                },
              }),
            }),
          ),
        );
      });

      const sources = yield* UsageLimitSources.make.pipe(
        Effect.provide([
          Layer.succeed(ServerSettings.ServerSettingsService, settingsService),
          Layer.succeed(SecretResolver.SecretResolver, secretResolver),
          Layer.succeed(HttpClient.HttpClient, client),
        ]),
      );

      // (1) Establish Kimi 10% (key-a) and hub at 78% with one available credit.
      const initial = yield* sources.streamChanges.pipe(
        Stream.filter((snapshots) => snapshots.length === 2),
        Stream.runHead,
        Effect.flatMap(Effect.fromOption),
      );
      expect(
        initial.find((entry) => entry.id === kimiId)?.quotaAccounts?.[0]?.windows[0]?.usedPercent,
      ).toBe(10);
      expect(
        initial.find((entry) => entry.id === hubId)?.accounts[0]?.usageLimits.windows[0]
          ?.usedPercent,
      ).toBe(78);
      expect(
        initial.find((entry) => entry.id === hubId)?.accounts[0]?.usageLimits.resetCredits
          ?.nextCreditId,
      ).toBe("credit-a");

      // (2) Hold settings lock on poll #2 (Kimi 88% under key-a) and fresh-read key-b -> Kimi hidden.
      const releaseWriteLock = yield* Deferred.make<void>();
      const lockHolderReady = yield* Deferred.make<void>();
      const lockHolder = yield* writeLock
        .withPermits(1)(
          Deferred.succeed(lockHolderReady, undefined).pipe(
            Effect.andThen(Deferred.await(releaseWriteLock)),
          ),
        )
        .pipe(Effect.forkChild);
      yield* Deferred.await(lockHolderReady);

      const poll2 = yield* Effect.forkChild(sources.refresh);
      yield* Deferred.await(waitingOnSnapshot);

      vaultSecret = "key-b";
      expect(yield* secretResolver.read([reference], { fresh: true })).toEqual(["key-b"]);

      yield* Deferred.succeed(releaseWriteLock, undefined);
      yield* Fiber.join(lockHolder);
      yield* Fiber.join(poll2);
      expect((yield* sources.current).find((entry) => entry.id === kimiId)).toBeUndefined();

      // (3) Redeem the unrelated hub credit: hub updates to 0%, and hidden Kimi must NOT reappear.
      const redemption = yield* sources.consumeResetCredit({
        sourceId: hubId,
        accountId: "first.json",
        creditId: "credit-a",
      });
      expect(redemption).toEqual({ outcome: "reset" });
      const afterRedeem = yield* sources.current;
      expect(afterRedeem.find((entry) => entry.id === kimiId)).toBeUndefined();
      expect(
        afterRedeem.find((entry) => entry.id === hubId)?.accounts[0]?.usageLimits.windows[0]
          ?.usedPercent,
      ).toBe(0);
    }).pipe(
      Effect.scoped,
      Effect.provide([
        Layer.mock(BackgroundPolicy.BackgroundPolicy)({
          shouldRunScopeWork: () => Effect.succeed(false),
        }),
        NodeCrypto.layer,
        NodeServices.layer,
      ]),
    ),
);

it.effect("a stalled Z.ai subscription yields to the request deadline without losing quotas", () =>
  Effect.gen(function* () {
    const subscriptionStarted = yield* Deferred.make<void>();
    const client = HttpClient.make((request, url) =>
      url.pathname === "/api/biz/subscription/list"
        ? Deferred.succeed(subscriptionStarted, undefined).pipe(Effect.andThen(Effect.never))
        : Effect.sync(() =>
            HttpClientResponse.fromWeb(
              request,
              Response.json({
                success: true,
                data: { limits: [{ type: "TOKENS_LIMIT", unit: 3, number: 5, percentage: 23 }] },
              }),
            ),
          ),
    );
    const sources = yield* UsageLimitSources.make.pipe(
      Effect.provideService(HttpClient.HttpClient, client),
    );
    yield* Deferred.await(subscriptionStarted);
    yield* TestClock.adjust("9 seconds");
    expect(yield* sources.current).toEqual([]);
    yield* TestClock.adjust("1 second");
    const sourcesAfterDeadline = yield* sources.streamChanges.pipe(
      Stream.filter((snapshots) => snapshots.length > 0),
      Stream.runHead,
      Effect.flatMap(Effect.fromOption),
    );
    expect(sourcesAfterDeadline).toMatchObject([
      { quotaAccounts: [{ windows: [{ usedPercent: 23 }] }] },
    ]);
    expect(sourcesAfterDeadline[0]?.error).toBeUndefined();
  }).pipe(
    Effect.provide([
      ServerSettings.layerTest({
        usageLimitSources: {
          [UsageLimitSourceId.make("zai")]: {
            kind: "zai",
            url: "zai://default",
            managementKey: "test",
            enabled: true,
          },
        },
      }),
      Layer.mock(BackgroundPolicy.BackgroundPolicy)({
        shouldRunScopeWork: () => Effect.succeed(false),
      }),
      Layer.succeed(SecretResolver.SecretResolver, {
        label: (provider) => Effect.succeed(provider),
        read: (references) => Effect.succeed(references.map(() => undefined)),
        invalidate: () => Effect.void,
      }),
      NodeCrypto.layer,
    ]),
  ),
);

it.effect("keeps cached OMP quotas after a same-path read failure but not after retargeting", () =>
  Effect.gen(function* () {
    yield* TestClock.setTime(NOW);
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const temp = yield* fs.makeTempDirectoryScoped({ prefix: "t3-omp-usage-" });
    const cachePath = path.join(temp, "agent.db");
    {
      using db = new NodeSqlite.DatabaseSync(cachePath);
      db.exec("CREATE TABLE cache (key TEXT PRIMARY KEY, value TEXT, expires_at INTEGER)");
      db.prepare("INSERT INTO cache VALUES (?, ?, ?)").run(
        "usage_cache:report:1:commandcode:default:api_key|secret:f00d",
        JSON.stringify({
          value: {
            provider: "commandcode",
            fetchedAt: NOW - 60_000,
            limits: [{ id: "weekly", label: "Weekly", amount: { usedFraction: 0.2 } }],
          },
          expiresAt: NOW + 60_000,
        }),
        NOW / 1_000 + 3_600,
      );
    }
    const settings = yield* ServerSettings.ServerSettingsService;
    const sourceId = UsageLimitSourceId.make("cache");
    const config = {
      kind: "omp",
      managementKey: "",
      enabled: true,
    } as const;
    yield* settings.updateSettings({
      usageLimitSources: { [sourceId]: { ...config, url: cachePath } },
    });
    const sources = yield* UsageLimitSources.make;
    yield* sources.refresh;
    const [good] = yield* sources.current;
    expect(good).toMatchObject({
      kind: "omp",
      quotaAccounts: [{ windows: [{ usedPercent: 20 }] }],
    });
    yield* fs.rename(cachePath, path.join(temp, "moved.db"));
    yield* sources.refresh;
    expect(yield* sources.current).toMatchObject([
      { error: expect.any(String), quotaAccounts: good?.quotaAccounts },
    ]);
    yield* settings.updateSettings({
      usageLimitSources: { [sourceId]: { ...config, url: path.join(temp, "other.db") } },
    });
    yield* sources.refresh;
    const [retargeted] = yield* sources.current;
    expect(retargeted?.error).toBeDefined();
    expect(retargeted?.quotaAccounts).toBeUndefined();
    expect(JSON.stringify(retargeted)).not.toContain(temp);
  }).pipe(
    Effect.provide([
      ServerSettings.layerTest(),
      Layer.mock(BackgroundPolicy.BackgroundPolicy)({
        shouldRunScopeWork: () => Effect.succeed(false),
      }),
      Layer.succeed(SecretResolver.SecretResolver, {
        label: (provider) => Effect.succeed(provider),
        read: () => Effect.die("Unexpected secret lookup for a local cache"),
        invalidate: () => Effect.void,
      }),
      Layer.succeed(
        HttpClient.HttpClient,
        HttpClient.make(() => Effect.die("Unexpected network request for a local cache")),
      ),
      NodeCrypto.layer,
      NodeServices.layer,
    ]),
  ),
);

it.effect("reads a management key from its secret provider", () => {
  const authorizations: Array<string | undefined> = [];
  const keySource = (reference: string) => ({
    provider: SecretProviderId.make("homelab"),
    reference,
  });
  return Effect.gen(function* () {
    const sources = yield* UsageLimitSources.make;
    const snapshots = yield* sources.streamChanges.pipe(
      Stream.filter((next) => next.length > 0),
      Stream.runHead,
      Effect.flatMap(Effect.fromOption),
    );
    expect(snapshots.map(({ id, error }) => ({ id, error }))).toEqual([
      { id: "resolved-hub", error: undefined },
      {
        id: "unresolved-hub",
        error: "Could not read the management key from its secret provider.",
      },
    ]);
    expect(authorizations).toEqual(["Bearer resolved-key"]);
  }).pipe(
    Effect.provide([
      ServerSettings.layerTest({
        usageLimitSources: {
          [UsageLimitSourceId.make("resolved-hub")]: {
            kind: "cliproxy",
            url: "https://resolved.test",
            managementKey: keySource("cliproxy#key"),
            enabled: true,
          },
          [UsageLimitSourceId.make("unresolved-hub")]: {
            kind: "cliproxy",
            url: "https://unresolved.test",
            managementKey: keySource("missing#key"),
            enabled: true,
          },
        },
      }),
      Layer.mock(BackgroundPolicy.BackgroundPolicy)({
        shouldRunScopeWork: () => Effect.succeed(false),
      }),
      Layer.succeed(SecretResolver.SecretResolver, {
        label: (provider) => Effect.succeed(provider),
        read: (references) =>
          Effect.succeed(
            references.map((reference) =>
              reference.reference === "cliproxy#key" ? "resolved-key" : undefined,
            ),
          ),
        invalidate: () => Effect.void,
      }),
      Layer.succeed(
        HttpClient.HttpClient,
        HttpClient.make((request) =>
          Effect.sync(() => {
            authorizations.push(request.headers.authorization);
            return HttpClientResponse.fromWeb(request, Response.json({ files: [] }));
          }),
        ),
      ),
      NodeCrypto.layer,
    ]),
  );
});

it.effect("keeps an account's last good reading when the hub's next read of it is refused", () => {
  let refused = true;
  let workspace = "account-a";
  let listsIdentity = true;
  const readAccount = Effect.gen(function* () {
    const sources = yield* UsageLimitSources.make;
    return Effect.gen(function* () {
      yield* sources.refresh;
      const [source] = yield* sources.current;
      return source?.accounts[0]?.usageLimits;
    });
  });
  return Effect.gen(function* () {
    const read = yield* readAccount;
    // Nothing to keep yet: the account stays listed as unreadable.
    expect(yield* read).toMatchObject({ windows: [], unavailable: { reason: "probeFailed" } });
    refused = false;
    const good = yield* read;
    expect(good?.windows.map((window) => window.usedPercent)).toEqual([78]);
    expect(good?.unavailable).toBeUndefined();
    refused = true;
    expect(yield* read).toEqual(good);
    // The same auth file now holds another login, whose reading is unknown.
    workspace = "account-b";
    expect(yield* read).toMatchObject({ windows: [], unavailable: { reason: "probeFailed" } });
    // A file that lists no login cannot show whether the next one is the same.
    listsIdentity = false;
    refused = false;
    yield* read;
    refused = true;
    expect(yield* read).toMatchObject({ windows: [], unavailable: { reason: "probeFailed" } });
  }).pipe(
    Effect.provide([
      ServerSettings.layerTest({
        usageLimitSources: {
          [UsageLimitSourceId.make("hub")]: {
            kind: "cliproxy",
            url: "http://hub.test:8317",
            managementKey: "management-secret",
            enabled: true,
          },
        },
      }),
      Layer.mock(BackgroundPolicy.BackgroundPolicy)({
        shouldRunScopeWork: () => Effect.succeed(false),
      }),
      Layer.succeed(SecretResolver.SecretResolver, {
        label: (provider) => Effect.succeed(provider),
        read: (references) => Effect.succeed(references.map(() => undefined)),
        invalidate: () => Effect.void,
      }),
      Layer.succeed(
        HttpClient.HttpClient,
        HttpClient.make((request) =>
          Effect.sync(() => {
            if (new URL(request.url).pathname.endsWith("/auth-files")) {
              return HttpClientResponse.fromWeb(
                request,
                Response.json({
                  files: [
                    {
                      id: "first.json",
                      auth_index: "a",
                      provider: "codex",
                      ...(listsIdentity
                        ? {
                            email: "first@example.com",
                            id_token: { chatgpt_account_id: workspace },
                          }
                        : {}),
                    },
                  ],
                }),
              );
            }
            const usage = {
              plan_type: "pro",
              rate_limit: {
                secondary_window: {
                  used_percent: 78,
                  reset_at: 4070908800,
                  limit_window_seconds: 604800,
                },
              },
            };
            return HttpClientResponse.fromWeb(
              request,
              Response.json(
                refused
                  ? { status_code: 429, body: "{}" }
                  : { status_code: 200, body: JSON.stringify(usage) },
              ),
            );
          }),
        ),
      ),
      NodeCrypto.layer,
    ]),
  );
});

const NOW = Date.parse("2026-11-13T12:00:00.000Z");
const at = (hours: number) => DateTime.formatIso(DateTime.makeUnsafe(NOW + hours * 3_600_000));
const spent = (id: string, hours: number): ServerProviderUsageWindow => ({
  id,
  kind: "weekly",
  label: id,
  usedPercent: 100,
  resetsAt: at(hours),
});
const hub = (
  accounts: ReadonlyArray<{
    driver?: string;
    models?: ReadonlyArray<string>;
    windows?: ReadonlyArray<ServerProviderUsageWindow>;
    unavailable?: true;
  }>,
): UsageLimitSourceSnapshot => ({
  id: UsageLimitSourceId.make("hub"),
  kind: "cliproxy",
  label: "hub",
  checkedAt: at(0),
  accounts: accounts.map((account, index) => ({
    id: `account-${index}`,
    driver: ProviderDriverKind.make(account.driver ?? "claudeAgent"),
    ...(account.models ? { models: account.models } : {}),
    usageLimits: {
      checkedAt: at(0),
      windows: account.windows ?? [],
      ...(account.unavailable ? { unavailable: { reason: "probeFailed" as const } } : {}),
    },
  })),
});

it.each([
  {
    name: "earliest refill when every account is spent, each at its latest spent window",
    accounts: [
      { windows: [spent("five_hour", 1), spent("seven_day", 3)] },
      { windows: [spent("five_hour", 2)] },
      { driver: "codex", windows: [] },
    ],
    model: "claude-haiku-5-5",
    expected: at(2),
  },
  {
    name: "unknown while an account still has room",
    accounts: [{ windows: [spent("five_hour", 1)] }, { windows: [] }],
    model: "claude-haiku-5-5",
    expected: null,
  },
  {
    name: "unknown while an account could not be read",
    accounts: [{ windows: [spent("five_hour", 1)] }, { unavailable: true as const }],
    model: "claude-haiku-5-5",
    expected: null,
  },
  {
    name: "unknown when a spent window has no reset or already reset",
    accounts: [{ windows: [{ ...spent("five_hour", 1), resetsAt: undefined }] }],
    model: "claude-haiku-5-5",
    expected: null,
  },
  {
    name: "a model-scoped weekly window blocks only its own model",
    accounts: [{ windows: [spent("seven_day_fable", 5)] }],
    model: "claude-haiku-5-5",
    expected: null,
  },
  {
    name: "a model-scoped weekly window blocks its own model",
    accounts: [{ windows: [spent("seven_day_fable", 5)] }],
    model: "claude-fable-5-2",
    expected: at(5),
  },
  {
    name: "no account of the driver",
    accounts: [{ driver: "codex", windows: [spent("five_hour", 1)] }],
    model: "claude-haiku-5-5",
    expected: null,
  },
  // regression: #30778 only the accounts the hub routes the model to can refill it
  {
    name: "an account of another driver the hub routes the model to counts",
    accounts: [
      { driver: "codex", models: ["gpt-5.6-sol"], windows: [spent("five_hour", 3)] },
      { models: ["claude-sonnet-4-6"], windows: [] },
    ],
    model: "gpt-5.6-sol",
    expected: at(3),
  },
  {
    name: "an account that lists no models is left out of an alias",
    accounts: [{ windows: [spent("five_hour", 1)] }, { models: [], windows: [] }],
    model: "opus",
    expected: at(1),
  },
  {
    name: "a spent Gemini quota does not hold back Claude on Antigravity",
    accounts: [
      {
        driver: "antigravity",
        models: ["claude-opus-4-6-thinking"],
        windows: [spent("3p-5h", 1), spent("gemini-5h", 24)],
      },
    ],
    model: "claude-opus-4-6-thinking",
    expected: at(1),
  },
  {
    name: "a hub thinking suffix routes by its base model",
    accounts: [
      { driver: "codex", models: ["gpt-5.2"], windows: [spent("five_hour", 3)] },
      { models: ["claude-sonnet-4-6"], windows: [] },
    ],
    model: "gpt-5.2(high)",
    expected: at(3),
  },
  {
    name: "a prefixed Gemini model is held back by the Gemini quota",
    accounts: [
      {
        driver: "antigravity",
        models: ["ag/gemini-3.1-pro-high"],
        windows: [spent("3p-5h", 1), spent("gemini-5h", 24)],
      },
    ],
    model: "ag/gemini-3.1-pro-high",
    expected: at(24),
  },
  {
    name: "an alias of unknown family is held back by every Antigravity quota",
    accounts: [{ driver: "antigravity", models: ["fast"], windows: [spent("gemini-5h", 24)] }],
    model: "fast",
    expected: at(24),
  },
  {
    name: "an own-driver account whose model list was unread still counts",
    accounts: [
      { windows: [spent("five_hour", 1)] },
      {
        driver: "antigravity",
        models: ["claude-sonnet-4-6"],
        windows: [spent("3p-5h", 8)],
      },
    ],
    model: "claude-sonnet-4-6",
    expected: at(1),
  },
  {
    name: "an Argon model waits only for the Argon quota",
    accounts: [
      {
        driver: "antigravity",
        models: ["gemini-4-argon-high"],
        windows: [spent("gemini-argon-5h", 2), spent("gemini-carbon-weekly", 96)],
      },
    ],
    model: "gemini-4-argon-high",
    expected: at(2),
  },
])("hub pool reset: $name", ({ accounts, model, expected }) => {
  expect(
    UsageLimitSources.hubPoolResetAt(
      [hub(accounts)],
      ProviderDriverKind.make("claudeAgent"),
      model,
      NOW,
    ),
  ).toBe(expected);
});

it.effect("the reset fallback refreshes its hub, and a stalled hub cannot hold the failure", () =>
  Effect.gen(function* () {
    yield* TestClock.setTime(NOW);
    const roomLeft = { ...hub([{ windows: [spent("five_hour", 2)] }]), origin: "http://hub.test" };
    const cached = {
      ...roomLeft,
      accounts: roomLeft.accounts.map((account) => ({
        ...account,
        usageLimits: {
          ...account.usageLimits,
          windows: account.usageLimits.windows.map((window) => ({ ...window, usedPercent: 99 })),
        },
      })),
    };
    let current: ReadonlyArray<UsageLimitSourceSnapshot> = [cached];
    let refresh: Effect.Effect<void> = Effect.sync(() => {
      current = [roomLeft];
    });
    const lookup = UsageLimitSources.UsageLimitResetFallback.pipe(
      Effect.flatMap((fallback) =>
        fallback.resetAt(ProviderDriverKind.make("claudeAgent"), "http://hub.test", null),
      ),
      Effect.provide(
        UsageLimitSources.layerResetFallback.pipe(
          Layer.provide(
            Layer.mock(UsageLimitSources.UsageLimitSources)({
              current: Effect.sync(() => current),
              refresh: Effect.suspend(() => refresh),
            }),
          ),
        ),
      ),
    );
    // The last poll saw room; the account was spent after it.
    expect(yield* lookup).toBe(at(2));
    current = [cached];
    refresh = Effect.never;
    const stalled = yield* Effect.forkChild(lookup);
    yield* TestClock.adjust("5 seconds");
    expect(yield* Fiber.join(stalled)).toBeNull();
  }),
);
