// @effect-diagnostics nodeBuiltinImport:off - seed and inspect disposable SQLite fixtures.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeSqlite from "node:sqlite";

import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as TestClock from "effect/testing/TestClock";

import { readOmpUsage, resolveOmpDbPath } from "./omp.ts";

const NOW = Date.parse("2026-11-25T00:00:00Z");
const FETCHED_AT_ISO = "2026-11-24T23:59:00.000Z";
const FETCHED_AT = Date.parse(FETCHED_AT_ISO);
const RETAIN_UNTIL = Math.floor((FETCHED_AT + 86_400_000) / 1_000);
const RESET_AT_ISO = "2026-11-25T00:01:00.000Z";
const RESET_AT = Date.parse(RESET_AT_ISO);
const CACHE_TABLE =
  "CREATE TABLE cache (key TEXT PRIMARY KEY, value TEXT NOT NULL, expires_at INTEGER NOT NULL)";

const fixture = Effect.gen(function* () {
  const directory = yield* Effect.acquireRelease(
    Effect.sync(() => NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-omp-usage-"))),
    (path) => Effect.sync(() => NodeFS.rmSync(path, { recursive: true, force: true })),
  );
  yield* TestClock.setTime(NOW);
  return NodePath.join(directory, "agent.db");
});

function seed(dbPath: string, setup: (db: NodeSqlite.DatabaseSync) => void) {
  const db = new NodeSqlite.DatabaseSync(dbPath);
  try {
    setup(db);
  } finally {
    db.close();
  }
}

function report(provider: string, metadata: Record<string, unknown> = {}) {
  return {
    provider,
    fetchedAt: FETCHED_AT,
    metadata,
    limits: [
      {
        id: `${provider}:5h`,
        label: "5 Hours",
        scope: { provider, windowId: "5h" },
        window: { id: "5h", label: "5 Hours", durationMs: 18_000_000, resetsAt: RESET_AT },
        amount: { used: 20, limit: 100, remaining: 80, usedFraction: 0.2, unit: "credits" },
      },
    ],
  };
}

function wrapped(value: unknown, expiresAt = NOW + 60_000) {
  return JSON.stringify({ value, expiresAt });
}

it("resolves explicit paths and uses only the OMP agent directory for the default", () => {
  const home = NodePath.resolve("fixture-home");
  const piEnvironment = {
    PI_CODING_AGENT_DIR: "/wrong/agent",
    PI_CODING_AGENT_SESSION_DIR: "/wrong/sessions",
  };
  expect(resolveOmpDbPath("omp://default", piEnvironment, home)).toBe(
    NodePath.join(home, ".omp", "agent", "agent.db"),
  );
  const env = { ...piEnvironment, OMP_CODING_AGENT_DIR: " ~/custom-omp " };
  expect(resolveOmpDbPath("omp://default", env, home)).toBe(
    NodePath.join(home, "custom-omp", "agent.db"),
  );
  expect(resolveOmpDbPath("~/explicit/agent.db", env, home)).toBe(
    NodePath.join(home, "explicit", "agent.db"),
  );
  expect(resolveOmpDbPath("relative/agent.db", env, home)).toBe(
    NodePath.resolve("relative/agent.db"),
  );
});

it.effect("maps native providers and preserves distinct identities", () =>
  Effect.gen(function* () {
    const dbPath = yield* fixture;
    const drivers = [
      ["openai-codex", "codex"],
      ["cursor", "cursor"],
      ["xai-oauth", "grok"],
      ["muse-code", "muse"],
      ["opencode-go", "opencode"],
      ["google-antigravity", "antigravity"],
      ["anthropic", "claudeAgent"],
      ["claude", "claudeAgent"],
    ] as const;
    seed(dbPath, (db) => {
      db.exec(CACHE_TABLE);
      const insert = db.prepare("INSERT INTO cache VALUES (?, ?, ?)");
      for (const [provider] of drivers) {
        const email = `${provider}@example.test`;
        const accountId = `${provider}-account`;
        const orgId = `${provider}-org`;
        const identity =
          provider === "opencode-go"
            ? "api_key|secret:0123abcd"
            : `oauth|account:${accountId}|email:${email}|org:${orgId}`;
        const metadata =
          provider === "opencode-go" ? {} : { email, accountId, orgId, planType: "Pro" };
        insert.run(
          `usage_cache:report:1:${provider}:https://example.test:443/api:${identity}`,
          wrapped(report(provider, metadata)),
          RETAIN_UNTIL,
        );
      }
      insert.run(
        "usage_cache:report:cursor:default:oauth|account:second-account|email:second@example.test",
        wrapped(report("cursor", { email: "second@example.test", accountId: "second-account" })),
        RETAIN_UNTIL,
      );
    });

    const original = NodeFS.readFileSync(dbPath);
    const reading = yield* readOmpUsage(dbPath);
    expect(reading.error).toBeUndefined();
    // Email-less native-driver rows (e.g. api_key opencode-go) stay in quotaAccounts so they never
    // create unverified duplicate rows beside native accounts.
    expect(reading.quotaAccounts).toHaveLength(1);
    expect(reading.quotaAccounts?.[0]).toMatchObject({
      label: "opencode-go",
      windows: [{ id: "opencode-go:5h", kind: "session", usedPercent: 20 }],
    });
    expect(reading.accounts).toHaveLength(drivers.length);
    for (const [provider, driver] of drivers) {
      if (provider === "opencode-go") continue;
      const account = reading.accounts.find((entry) => entry.email === `${provider}@example.test`);
      expect(account).toMatchObject({
        driver,
        workspaceId: `${provider}-org`,
        plan: "Pro",
        usageLimits: {
          checkedAt: FETCHED_AT_ISO,
          planTier: "Pro",
          windows: [{ id: `${provider}:5h`, kind: "session", usedPercent: 20 }],
        },
      });
    }
    expect(
      reading.accounts.find((account) => account.email === "second@example.test"),
    ).toMatchObject({
      driver: "cursor",
      workspaceId: "second-account",
    });
    expect(new Set(reading.accounts.map((account) => account.id)).size).toBe(drivers.length);
    expect(NodeFS.readFileSync(dbPath)).toEqual(original);
    expect(NodeFS.readdirSync(NodePath.dirname(dbPath))).toEqual(["agent.db"]);
  }).pipe(Effect.scoped),
);

it.effect("maps rich quotas and balances without exposing keys or URLs", () =>
  Effect.gen(function* () {
    const dbPath = yield* fixture;
    seed(dbPath, (db) => {
      db.exec(CACHE_TABLE);
      const insert = db.prepare("INSERT INTO cache VALUES (?, ?, ?)");
      const commandCode = {
        ...report("commandcode", { accountId: "command-account", planType: "Teams" }),
        limits: [
          {
            id: "commandcode:7d",
            label: "Weekly limit",
            scope: {
              provider: "commandcode",
              accountId: "command-account",
              tier: "Team",
              windowId: "7d",
            },
            window: { id: "7d", durationMs: 604_800_000, resetsAt: RESET_AT },
            amount: { used: 45, limit: 150, remaining: 105, unit: "credits" },
          },
          {
            id: "commandcode:balance",
            label: "Credit balance",
            scope: { provider: "commandcode", windowId: "balance" },
            amount: { remaining: 25, unit: "credits" },
          },
          { id: "invalid", label: "Invalid", amount: { used: 1, limit: 0 } },
        ],
        raw: { token: "fake-raw-token" },
      };
      insert.run(
        "usage_cache:report:commandcode:https://key-in-url@example.test:api_key|secret:0123abcd",
        wrapped(commandCode),
        RETAIN_UNTIL,
      );
      insert.run(
        "usage_cache:report:2:zai:default:api_key|secret:abcd0123",
        wrapped({
          ...report("zai", { subscriptionPlan: "  GLM Coding Plus  " }),
          limits: [
            {
              id: "1w",
              label: "Weekly",
              window: { durationMs: Number.MAX_VALUE },
              amount: { usedFraction: 1.2, unit: "tokens" },
            },
            {
              id: "zai:features:zread:1mo",
              label: "Zread",
              window: { id: "1mo" },
              amount: { usedFraction: -0.2, unit: "requests" },
            },
          ],
        }),
        RETAIN_UNTIL,
      );
    });

    const reading = yield* readOmpUsage(dbPath);
    expect(reading.accounts).toEqual([]);
    expect(reading.quotaAccounts).toHaveLength(2);
    const commandcode = reading.quotaAccounts?.find((account) => account.label === "commandcode");
    expect(commandcode).toMatchObject({
      planTier: "Teams",
      windows: [
        {
          id: "commandcode:7d",
          kind: "weekly",
          label: "Weekly limit",
          usedPercent: 30,
          usedAmount: 45,
          limitAmount: 150,
          remainingAmount: 105,
          resetsAt: RESET_AT_ISO,
          windowDurationMins: 10_080,
          unit: "credits",
          category: "plan",
          scopeLabel: "Team",
        },
      ],
      balances: [
        {
          id: "commandcode:balance",
          label: "Credit balance",
          remaining: 25,
          unit: "credits",
          kind: "balance",
        },
      ],
    });
    const zai = reading.quotaAccounts?.find((account) => account.label === "zai");
    expect(zai).toMatchObject({
      planTier: "GLM Coding Plus",
      windows: [
        { kind: "weekly", usedPercent: 100 },
        { kind: "monthly", usedPercent: 0 },
      ],
    });
    expect(zai?.windows[0]?.windowDurationMins).toBeUndefined();
    const encoded = JSON.stringify(reading);
    for (const secret of ["0123abcd", "abcd0123", "key-in-url", "fake-raw-token"]) {
      expect(encoded).not.toContain(secret);
    }
  }).pipe(Effect.scoped),
);

it.effect("honors durable retention and exact-identity versions", () =>
  Effect.gen(function* () {
    const dbPath = yield* fixture;
    seed(dbPath, (db) => {
      db.exec(CACHE_TABLE);
      const insert = db.prepare("INSERT INTO cache VALUES (?, ?, ?)");
      const provider = "kimi-code";
      const first = "default:oauth|account:first";
      const rows = [
        [`2:${provider}:${first}`, wrapped(report(provider, { planType: "Old shape" }))],
        [
          `3:${provider}:${first}`,
          wrapped(report(provider, { planType: "Current shape" }), FETCHED_AT),
        ],
        [
          `3:${provider}:default:oauth|account:second`,
          wrapped(report(provider, { planType: "Second account" })),
        ],
        [
          `3:${provider}:https://other.test:oauth|account:first`,
          JSON.stringify({
            ...report(provider, { planType: "Other endpoint" }),
            fetchedAt: FETCHED_AT_ISO,
          }),
        ],
        [
          `3:${provider}:default:oauth|account:expired`,
          wrapped(report(provider, { planType: "Expired" })),
          Math.floor(NOW / 1_000),
        ],
        [
          `3:${provider}:default:oauth|account:ancient`,
          wrapped({
            ...report(provider, { planType: "Ancient" }),
            fetchedAt: NOW - 90_000_000,
          }),
        ],
        [
          `3:${provider}:default:oauth|account:conflict`,
          wrapped(report(provider, { accountId: "wrong", planType: "Identity conflict" })),
        ],
        [`3:${provider}:default:oauth|account:broken`, "{not json"],
        [`3:${provider}:default:oauth|account:other-provider`, wrapped(report("zai"))],
      ] as const;
      for (const [key, value, expiresAt = RETAIN_UNTIL] of rows) {
        insert.run(`usage_cache:report:${key}`, value, expiresAt);
      }
      insert.run(
        `usageXcache:report:3:${provider}:default:oauth|account:other-prefix`,
        wrapped(report(provider)),
        RETAIN_UNTIL,
      );
    });

    const result = yield* readOmpUsage(dbPath);
    expect(result.error).toBeUndefined();
    expect(result.quotaAccounts?.map((account) => account.planTier).sort()).toEqual([
      "Current shape",
      "Other endpoint",
      "Second account",
    ]);
    expect(new Set(result.quotaAccounts?.map((account) => account.id)).size).toBe(3);
  }).pipe(Effect.scoped),
);

it.effect("uses only metadata for accounts from unfamiliar cache keys", () =>
  Effect.gen(function* () {
    const dbPath = yield* fixture;
    seed(dbPath, (db) => {
      db.exec(CACHE_TABLE);
      const insert = db.prepare("INSERT INTO cache VALUES (?, ?, ?)");
      insert.run(
        "usage_cache:report:legacy-cache-key",
        JSON.stringify(
          report("openai-codex", {
            email: "legacy@example.test",
            accountId: "legacy-account",
            organizationId: "legacy-org",
          }),
        ),
        RETAIN_UNTIL,
      );
      insert.run(
        "usage_cache:report:cursor:default:oauth|email:not-metadata@example.test|new-field:value",
        wrapped(report("cursor")),
        RETAIN_UNTIL,
      );
    });

    const reading = yield* readOmpUsage(dbPath);
    expect(reading.accounts).toHaveLength(1);
    expect(reading.accounts.find((account) => account.driver === "codex")).toMatchObject({
      email: "legacy@example.test",
      workspaceId: "legacy-org",
    });
    // Without verified email metadata, unfamiliar cursor keys stay isolated in quotaAccounts.
    expect(reading.quotaAccounts).toHaveLength(1);
    expect(reading.quotaAccounts?.[0]?.label).toBe("cursor");
    expect(JSON.stringify(reading)).not.toContain("legacy-cache-key");
    expect(JSON.stringify(reading)).not.toContain("not-metadata@example.test");
  }).pipe(Effect.scoped),
);

it.effect(
  "skips out-of-range 64-bit expires_at rows without failing healthy rows and omits redundant percent units",
  () =>
    Effect.gen(function* () {
      const dbPath = yield* fixture;
      seed(dbPath, (db) => {
        db.exec(CACHE_TABLE);
        const insert = db.prepare("INSERT INTO cache VALUES (?, ?, ?)");
        // Corrupt INT64_MAX expiration would throw ERR_OUT_OF_RANGE if converted to JS Number.
        insert.run(
          "usage_cache:report:1:kimi-code:default:oauth|account:corrupt",
          wrapped(report("kimi-code", { planType: "Corrupt" })),
          9223372036854775807n,
        );
        insert.run(
          "usage_cache:report:1:kimi-code:default:oauth|account:healthy",
          wrapped({
            provider: "kimi-code",
            fetchedAt: FETCHED_AT,
            metadata: { planType: "Healthy" },
            limits: [
              {
                id: "kimi:5h",
                label: "5 Hours",
                window: { id: "5h", durationMs: 18_000_000, resetsAt: RESET_AT },
                amount: {
                  used: 22,
                  limit: 100,
                  remaining: 78,
                  usedFraction: 0.22,
                  unit: "percent",
                },
              },
            ],
          }),
          RETAIN_UNTIL,
        );
      });

      const reading = yield* readOmpUsage(dbPath);
      expect(reading.error).toBeUndefined();
      expect(reading.quotaAccounts).toHaveLength(1);
      expect(reading.quotaAccounts?.[0]).toMatchObject({
        planTier: "Healthy",
        windows: [{ id: "kimi:5h", usedPercent: 22 }],
      });
      const win = reading.quotaAccounts?.[0]?.windows[0];
      expect(win?.unit).toBeUndefined();
      expect(win?.usedAmount).toBeUndefined();
      expect(win?.limitAmount).toBeUndefined();
      expect(win?.remainingAmount).toBeUndefined();
    }).pipe(Effect.scoped),
);

it.effect("returns a clean error for missing or unreadable caches", () =>
  Effect.gen(function* () {
    const dbPath = yield* fixture;
    const failed = { accounts: [], error: "Could not read the OMP usage cache." };
    expect(yield* readOmpUsage(dbPath)).toEqual(failed);
    expect(NodeFS.existsSync(dbPath)).toBe(false);
    NodeFS.writeFileSync(dbPath, "not SQLite; fake-secret");
    expect(yield* readOmpUsage(dbPath)).toEqual(failed);
    NodeFS.unlinkSync(dbPath);

    seed(dbPath, (db) => {
      db.exec("CREATE TABLE auth_credentials (key TEXT, value TEXT, expires_at INTEGER)");
      db.prepare("INSERT INTO auth_credentials VALUES (?, ?, ?)").run(
        "usage_cache:report:kimi-code:default:oauth|account:must-not-appear",
        wrapped(report("kimi-code")),
        RETAIN_UNTIL,
      );
      db.exec("CREATE VIEW cache AS SELECT key, value, expires_at FROM auth_credentials");
    });
    expect(yield* readOmpUsage(dbPath)).toEqual(failed);
  }).pipe(Effect.scoped),
);
