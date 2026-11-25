// @effect-diagnostics nodeBuiltinImport:off -- Ollama signs with an OpenSSH Ed25519 key and checks file generation via node:fs.
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import type {
  HttpQuotaAccount,
  ServerProviderUsageWindow,
  UsageLimitSourceSnapshot,
} from "@t3tools/contracts";
import { expandHomePath } from "@t3tools/provider-core/server/pathExpansion";
import { clampPercent } from "@t3tools/provider-core/server/usageLimits";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";

import type { ReadQuotaJson } from "../UsageLimitSources.ts";

const OLLAMA_ORIGIN = "https://ollama.com";
const MAX_KEY_BYTES = 16 * 1024;
const MAGIC = Buffer.from("openssh-key-v1\0");
const NONE = Buffer.from("none");
const ED25519 = Buffer.from("ssh-ed25519");
const ED25519_PKCS8_PREFIX = Buffer.from("302e020100300506032b657004220420", "hex");
const LEGACY_WINDOWS = [
  { id: "session", kind: "session", label: "Session", minutes: 5 * 60 },
  { id: "weekly", kind: "weekly", label: "Weekly", minutes: 7 * 24 * 60 },
] as const;

type Reading = Pick<UsageLimitSourceSnapshot, "accounts" | "quotaAccounts" | "error">;
interface SigningKey {
  readonly privateKey: NodeCrypto.KeyObject;
  readonly publicKeyBase64: string;
  readonly identity: string;
}

export function resolveOllamaKeyPath(url: string, home = NodeOS.homedir()): string {
  return url === "ollama://default"
    ? NodePath.resolve(home, ".ollama", "id_ed25519")
    : NodePath.resolve(expandHomePath(url, home));
}

class SshReader {
  private readonly data: Buffer;
  private offset = 0;

  constructor(data: Buffer) {
    this.data = data;
  }

  uint32(): number {
    const value = this.data.readUInt32BE(this.offset);
    this.offset += 4;
    return value;
  }

  string(): Buffer {
    const length = this.uint32();
    const start = this.offset;
    this.offset += length;
    if (this.offset > this.data.length) throw new Error("Truncated OpenSSH key field.");
    return this.data.subarray(start, this.offset);
  }

  rest(): Buffer {
    return this.data.subarray(this.offset);
  }
}

function parseOpenSshEd25519Key(pem: string): SigningKey | undefined {
  const match =
    /^-----BEGIN OPENSSH PRIVATE KEY-----\r?\n([A-Za-z0-9+/=\r\n]+)\r?\n-----END OPENSSH PRIVATE KEY-----$/.exec(
      pem.trim(),
    );
  if (!match?.[1]) return undefined;
  const base64 = match[1].replace(/[\r\n]/g, "");
  const data = Buffer.from(base64, "base64");
  if (data.toString("base64") !== base64 || !data.subarray(0, MAGIC.length).equals(MAGIC))
    return undefined;
  try {
    const outer = new SshReader(data.subarray(MAGIC.length));
    if (
      !outer.string().equals(NONE) ||
      !outer.string().equals(NONE) ||
      outer.string().length !== 0 ||
      outer.uint32() !== 1
    ) {
      return undefined;
    }
    const publicBlob = outer.string();
    const privateBlob = outer.string();
    if (outer.rest().length !== 0 || privateBlob.length % 8 !== 0) return undefined;

    const publicFields = new SshReader(publicBlob);
    if (!publicFields.string().equals(ED25519)) return undefined;
    const outerPublic = publicFields.string();
    if (publicFields.rest().length !== 0) return undefined;

    const privateFields = new SshReader(privateBlob);
    if (
      privateFields.uint32() !== privateFields.uint32() ||
      !privateFields.string().equals(ED25519)
    )
      return undefined;
    const innerPublic = privateFields.string();
    const privateBytes = privateFields.string();
    if (privateBytes.length !== 64) return undefined;
    privateFields.string(); // OpenSSH comment; it is not part of the key identity.
    const padding = privateFields.rest();
    if (padding.length >= 8 || !padding.every((byte, index) => byte === index + 1))
      return undefined;

    const privateKey = NodeCrypto.createPrivateKey({
      key: Buffer.concat([ED25519_PKCS8_PREFIX, privateBytes.subarray(0, 32)]),
      format: "der",
      type: "pkcs8",
    });
    const derived = NodeCrypto.createPublicKey(privateKey)
      .export({ format: "der", type: "spki" })
      .subarray(-32);
    if (
      !derived.equals(innerPublic) ||
      !derived.equals(outerPublic) ||
      !derived.equals(privateBytes.subarray(32))
    ) {
      return undefined;
    }
    return {
      privateKey,
      publicKeyBase64: publicBlob.toString("base64"),
      identity: NodeCrypto.createHash("sha256").update(publicBlob).digest("hex"),
    };
  } catch {
    return undefined;
  }
}

const readKey = Effect.fn("UsageLimitSources.readOllamaKey")(
  function* (keyPath: string) {
    const fs = yield* FileSystem.FileSystem;
    const info = yield* fs.stat(keyPath);
    if (info.type !== "File" || info.size > MAX_KEY_BYTES) return undefined;
    const pem = yield* fs
      .stream(keyPath, { bytesToRead: MAX_KEY_BYTES + 1, chunkSize: MAX_KEY_BYTES + 1 })
      .pipe(
        Stream.decodeText(),
        Stream.runFold(
          () => "",
          (text, chunk) => text + chunk,
        ),
      );
    return pem.length > MAX_KEY_BYTES ? undefined : parseOpenSshEd25519Key(pem);
  },
  Effect.orElseSucceed(() => undefined),
);

export function readOllamaKeyGenerationSync(keyPath: string): string | undefined {
  try {
    const info = NodeFS.statSync(keyPath, { bigint: true });
    if (!info.isFile() || info.size > BigInt(MAX_KEY_BYTES)) return undefined;
    return `${info.dev}:${info.ino}:${info.size}:${info.mtimeNs}:${info.ctimeNs}`;
  } catch {
    return undefined;
  }
}

export const readOllamaKeyIdentity = Effect.fn("UsageLimitSources.readOllamaKeyIdentity")(
  function* (keyPath: string) {
    return (yield* readKey(keyPath))?.identity;
  },
);

const readSigned = Effect.fn("UsageLimitSources.readOllamaSignedJson")(function* (
  key: SigningKey,
  readJson: ReadQuotaJson,
  method: "GET" | "POST",
  path: string,
) {
  const ts = Math.floor((yield* Clock.currentTimeMillis) / 1000);
  const uri = `${path}?ts=${ts}`;
  const signature = NodeCrypto.sign(null, Buffer.from(`${method},${uri}`), key.privateKey).toString(
    "base64",
  );
  return yield* readJson(
    `${OLLAMA_ORIGIN}${uri}`,
    { Authorization: `${key.publicKeyBase64}:${signature}` },
    { method },
  );
});

function record(value: unknown): Readonly<Record<string, unknown>> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : undefined;
}

function finite(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function timestamp(value: unknown): DateTime.Utc | undefined {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}T/.test(value)
    ? Option.getOrUndefined(DateTime.make(value))
    : undefined;
}

function monthlyWindow(
  included: Readonly<Record<string, unknown>>,
): ServerProviderUsageWindow | undefined {
  const allowance = finite(included.allowance_usd);
  const balance = finite(included.balance_usd);
  if (allowance === undefined || allowance <= 0 || balance === undefined) return undefined;
  const remaining = Math.max(0, Math.min(allowance, balance));
  const used = allowance - remaining;
  const period = record(included.period);
  const from = timestamp(period?.from);
  const until = timestamp(period?.until);
  const durationMins =
    from && until
      ? (DateTime.toEpochMillis(until) - DateTime.toEpochMillis(from)) / 60_000
      : undefined;
  return {
    id: "monthly",
    kind: "monthly",
    label: "Monthly",
    category: "plan",
    unit: "USD",
    usedPercent: (used / allowance) * 100,
    usedAmount: used,
    limitAmount: allowance,
    remainingAmount: remaining,
    ...(until === undefined ? {} : { resetsAt: DateTime.formatIso(until) }),
    ...(durationMins !== undefined && durationMins > 0
      ? { windowDurationMins: Math.floor(durationMins) }
      : {}),
  };
}

function quotaAccount(body: unknown): HttpQuotaAccount | undefined {
  const root = record(body);
  const included = record(root?.included);
  if (included === undefined) return undefined;
  const monthly = monthlyWindow(included);
  const windows: ServerProviderUsageWindow[] = [];
  if (monthly) {
    windows.push(monthly);
  } else {
    for (const { id, kind, label, minutes } of LEGACY_WINDOWS) {
      const legacy = record(included[id]);
      const remainingPercent = finite(legacy?.remaining_percent);
      if (remainingPercent === undefined) continue;
      const reset = timestamp(legacy?.resets_at);
      windows.push({
        id,
        kind,
        label,
        category: "plan",
        usedPercent: clampPercent(100 - remainingPercent),
        ...(reset === undefined
          ? {}
          : { resetsAt: DateTime.formatIso(reset), windowDurationMins: minutes }),
      });
    }
  }
  const purchased = finite(record(root?.purchased)?.balance_usd);
  if (windows.length === 0 && purchased === undefined) return undefined;
  return {
    id: "ollama",
    label: "Ollama Cloud",
    windows,
    ...(purchased === undefined
      ? {}
      : {
          balances: [
            {
              id: "purchased-credits",
              label: "Purchased Credits",
              remaining: Math.max(0, purchased),
              unit: "USD",
              kind: "balance",
            },
          ],
        }),
  };
}

export const readOllamaUsage = Effect.fn("UsageLimitSources.readOllamaUsage")(function* (
  keyPath: string,
  readJson: ReadQuotaJson,
): Effect.fn.Return<
  { readonly keyIdentity: string | undefined; readonly result: Reading },
  never,
  FileSystem.FileSystem
> {
  const key = yield* readKey(keyPath);
  if (!key) {
    return {
      keyIdentity: undefined,
      result: { accounts: [], error: "Could not load an unencrypted Ollama Ed25519 key." },
    };
  }
  const balance = yield* readSigned(key, readJson, "GET", "/api/balance");
  const account =
    balance && balance.status >= 200 && balance.status < 300
      ? quotaAccount(balance.body)
      : undefined;
  if (!account) {
    return {
      keyIdentity: key.identity,
      result: {
        accounts: [],
        error:
          balance?.status === 401 || balance?.status === 403
            ? "Ollama Cloud rejected the signing key. Run ollama signin and try again."
            : "Could not read usable Ollama Cloud balance data.",
      },
    };
  }
  const me = yield* readSigned(key, readJson, "POST", "/api/me");
  const profile = me && me.status >= 200 && me.status < 300 ? record(me.body) : undefined;
  const plan = profile?.Plan ?? profile?.plan;
  const planName = typeof plan === "string" ? plan.trim() : "";
  return {
    keyIdentity: key.identity,
    result: {
      accounts: [],
      quotaAccounts: [
        planName
          ? { ...account, planTier: planName.charAt(0).toUpperCase() + planName.slice(1) }
          : account,
      ],
    },
  };
});
