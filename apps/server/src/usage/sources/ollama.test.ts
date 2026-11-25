// @effect-diagnostics nodeBuiltinImport:off -- Generate and verify isolated Ed25519 fixtures.
import * as NodeCrypto from "node:crypto";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as TestClock from "effect/testing/TestClock";

import { readOllamaKeyIdentity, readOllamaUsage, resolveOllamaKeyPath } from "./ollama.ts";

const NOW = Date.UTC(2026, 10, 25, 17);
const INVALID_KEYS = [
  "bad magic",
  "encrypted cipher",
  "encrypted kdf",
  "wrong key count",
  "wrong key type",
  "wrong checkint",
  "wrong inner public key",
  "wrong outer public key",
  "wrong embedded public key",
  "truncated container",
] as const;

function encodedString(data: string | Buffer): Buffer {
  const bytes = Buffer.from(data);
  const size = Buffer.alloc(4);
  size.writeUInt32BE(bytes.length);
  return Buffer.concat([size, bytes]);
}

function signingFixture(invalid?: (typeof INVALID_KEYS)[number]) {
  const pair = NodeCrypto.generateKeyPairSync("ed25519");
  const seed = pair.privateKey.export({ format: "der", type: "pkcs8" }).subarray(-32);
  const rawPublic = pair.publicKey.export({ format: "der", type: "spki" }).subarray(-32);
  const wrongPublic = Buffer.from(rawPublic);
  wrongPublic.writeUInt8(wrongPublic.readUInt8(0) ^ 1, 0);
  const outerPublic = Buffer.concat([
    encodedString("ssh-ed25519"),
    encodedString(invalid === "wrong outer public key" ? wrongPublic : rawPublic),
  ]);
  const privateFields = Buffer.concat([
    Buffer.alloc(4, 9),
    Buffer.alloc(4, invalid === "wrong checkint" ? 8 : 9),
    encodedString(invalid === "wrong key type" ? "ssh-rsa" : "ssh-ed25519"),
    encodedString(invalid === "wrong inner public key" ? wrongPublic : rawPublic),
    encodedString(
      Buffer.concat([seed, invalid === "wrong embedded public key" ? wrongPublic : rawPublic]),
    ),
    encodedString("ollama fixture"),
  ]);
  const padding = Buffer.from(
    Array.from({ length: (8 - (privateFields.length % 8)) % 8 }, (_, i) => i + 1),
  );
  let container = Buffer.concat([
    Buffer.from(invalid === "bad magic" ? "invalid-key-v1\0" : "openssh-key-v1\0"),
    encodedString(invalid === "encrypted cipher" ? "aes256-ctr" : "none"),
    encodedString(invalid === "encrypted kdf" ? "bcrypt" : "none"),
    encodedString(""),
    Buffer.from([0, 0, 0, invalid === "wrong key count" ? 2 : 1]),
    encodedString(outerPublic),
    encodedString(Buffer.concat([privateFields, padding])),
  ]);
  if (invalid === "truncated container") container = container.subarray(0, -1);
  const encoded = container
    .toString("base64")
    .match(/.{1,70}/g)
    ?.join("\n");
  const pem = `-----BEGIN OPENSSH PRIVATE KEY-----\n${encoded}\n-----END OPENSSH PRIVATE KEY-----\n`;
  return { pem, publicKey: pair.publicKey, outerPublic };
}

const saveKey = Effect.fn("OllamaTest.saveKey")(function* (pem: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const directory = yield* fs.makeTempDirectoryScoped({ prefix: "t3-ollama-usage-" });
  const keyPath = path.join(directory, "id_ed25519");
  yield* fs.writeFileString(keyPath, pem, { mode: 0o600 });
  return keyPath;
});

it.effect("resolves default and explicit home-relative keys on the server host", () =>
  Effect.gen(function* () {
    const path = yield* Path.Path;
    const home = path.resolve("test-home");
    expect(resolveOllamaKeyPath("ollama://default", home)).toBe(
      path.join(home, ".ollama", "id_ed25519"),
    );
    expect(resolveOllamaKeyPath("~/other-key", home)).toBe(path.join(home, "other-key"));
    const explicit = path.resolve("fixtures", "custom-key");
    expect(resolveOllamaKeyPath(explicit, home)).toBe(explicit);
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect(
  "signs both exact request URIs, fingerprints the public blob and maps the USD allowance",
  () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(NOW);
      const fixture = signingFixture();
      const keyPath = yield* saveKey(fixture.pem.replaceAll("\n", "\r\n"));
      const expectedIdentity = NodeCrypto.createHash("sha256")
        .update(fixture.outerPublic)
        .digest("hex");
      expect(yield* readOllamaKeyIdentity(keyPath)).toBe(expectedIdentity);
      const methods: string[] = [];
      const usage = yield* readOllamaUsage(keyPath, (url, headers, options) => {
        const parsed = new URL(url);
        expect(parsed.origin).toBe("https://ollama.com");
        const method = parsed.pathname === "/api/balance" ? "GET" : "POST";
        expect(parsed.pathname).toBe(method === "GET" ? "/api/balance" : "/api/me");
        expect(options?.method ?? "GET").toBe(method);
        expect(parsed.search).toBe(`?ts=${NOW / 1000}`);
        const [publicBlob, signature] = headers.Authorization?.split(":") ?? [];
        expect(publicBlob).toBe(fixture.outerPublic.toString("base64"));
        expect(
          NodeCrypto.verify(
            null,
            Buffer.from(`${method},${parsed.pathname}${parsed.search}`),
            fixture.publicKey,
            Buffer.from(signature ?? "", "base64"),
          ),
        ).toBe(true);
        methods.push(method);
        return Effect.succeed({
          status: 200,
          body:
            method === "GET"
              ? {
                  included: {
                    allowance_usd: 100,
                    balance_usd: 72.5,
                    period: { from: "2026-11-15T09:30:00Z", until: "2026-12-15T09:30:00Z" },
                  },
                  purchased: { balance_usd: 25 },
                }
              : { Plan: "pro", plan: "fallback" },
        });
      });
      expect(methods).toEqual(["GET", "POST"]);
      expect(usage.keyIdentity).toBe(expectedIdentity);
      expect(usage.result.quotaAccounts).toMatchObject([
        {
          planTier: "Pro",
          windows: [
            {
              kind: "monthly",
              usedPercent: expect.closeTo(27.5, 8),
              usedAmount: 27.5,
              remainingAmount: 72.5,
              limitAmount: 100,
              unit: "USD",
              resetsAt: "2026-12-15T09:30:00.000Z",
              windowDurationMins: 30 * 1440,
            },
          ],
          balances: [{ label: "Purchased Credits", remaining: 25, unit: "USD" }],
        },
      ]);
    }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect(
  "retains legacy windows when the optional account request fails and does not invent a reset",
  () =>
    Effect.gen(function* () {
      const keyPath = yield* saveKey(signingFixture().pem);
      const { result } = yield* readOllamaUsage(keyPath, (_url, _headers, options) =>
        options?.method === "POST"
          ? Effect.succeed({ status: 503, body: { Plan: "invalid-on-error" } })
          : Effect.succeed({
              status: 200,
              body: {
                included: {
                  session: { remaining_percent: 75 },
                  weekly: { remaining_percent: 20, resets_at: "2026-12-05T00:00:00Z" },
                },
                purchased: { balance_usd: 0 },
              },
            }),
      );
      const account = result.quotaAccounts?.[0];
      expect(result.error).toBeUndefined();
      expect(account?.planTier).toBeUndefined();
      expect(account?.windows).toEqual([
        { id: "session", kind: "session", label: "Session", category: "plan", usedPercent: 25 },
        {
          id: "weekly",
          kind: "weekly",
          label: "Weekly",
          category: "plan",
          usedPercent: 80,
          resetsAt: "2026-12-05T00:00:00.000Z",
          windowDurationMins: 7 * 1440,
        },
      ]);
      expect(account?.balances).toMatchObject([{ label: "Purchased Credits", remaining: 0 }]);
    }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("requires the included object even when the purchased balance looks valid", () =>
  Effect.gen(function* () {
    const keyPath = yield* saveKey(signingFixture().pem);
    const { result } = yield* readOllamaUsage(keyPath, (_url, _headers, options) => {
      expect(options?.method ?? "GET").toBe("GET");
      return Effect.succeed({
        status: 200,
        body: { included: [], purchased: { balance_usd: 20 } },
      });
    });
    expect(result).toEqual({
      accounts: [],
      error: "Could not read usable Ollama Cloud balance data.",
    });
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect.each(INVALID_KEYS)("does not sign or fingerprint an unusable key (%s)", (invalid) =>
  Effect.gen(function* () {
    const keyPath = yield* saveKey(signingFixture(invalid).pem);
    expect(yield* readOllamaKeyIdentity(keyPath)).toBeUndefined();
    const usage = yield* readOllamaUsage(keyPath, () =>
      Effect.die("Unexpected Ollama network request"),
    );
    expect(usage).toEqual({
      keyIdentity: undefined,
      result: { accounts: [], error: "Could not load an unencrypted Ollama Ed25519 key." },
    });
  }).pipe(Effect.provide(NodeServices.layer)),
);
