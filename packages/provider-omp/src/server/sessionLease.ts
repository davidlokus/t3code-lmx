// @effect-diagnostics nodeBuiltinImport:off - leases need exclusive open and descriptor identity.
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

export class OmpSessionLeaseConflictError extends Schema.TaggedError<
  OmpSessionLeaseConflictError,
  { readonly brand: unique symbol }
>()("OmpSessionLeaseConflictError", { sessionPath: Schema.String }) {
  override get message(): string {
    return "This omp session is locked. Close the other session, then retry.";
  }
}

class OmpSessionLeaseIoError extends Schema.TaggedError<
  OmpSessionLeaseIoError,
  { readonly brand: unique symbol }
>()("OmpSessionLeaseIoError", {
  operation: Schema.Literals(["acquire", "release"]),
  cause: Schema.Defect(),
}) {
  override get message(): string {
    return `Could not ${this.operation} the omp session lease.`;
  }
}

const isConflict = Schema.is(OmpSessionLeaseConflictError);
const encodeLock = Schema.encodeSync(
  Schema.fromJsonString(
    Schema.Struct({
      token: Schema.String,
      pid: Schema.Int,
      host: Schema.String,
      acquiredAt: Schema.String,
      sessionPath: Schema.String,
      threadId: Schema.String,
    }),
  ),
);
const decodeOwner = Schema.decodeUnknownOption(
  Schema.fromJsonString(
    Schema.Struct({
      token: Schema.optional(Schema.Unknown),
      pid: Schema.optional(Schema.Unknown),
      host: Schema.optional(Schema.Unknown),
    }),
  ),
);
const activeLocks = new Set<string>();
const CORRUPT_LOCK_GRACE_MS = 5_000;

interface LeaseInput {
  readonly agentDir: string;
  readonly sessionPath: string;
  readonly threadId: string;
  readonly checkPid?: (pid: number) => void;
  readonly now?: () => number;
  readonly graceMs?: number;
}

function hasCode(cause: unknown, code: string): boolean {
  return cause instanceof Error && "code" in cause && cause.code === code;
}

function canonicalPath(path: string): string {
  try {
    return NodeFS.realpathSync(path);
  } catch {
    return NodePath.resolve(path);
  }
}

async function readLock(lockPath: string) {
  try {
    const file = await NodeFSP.open(lockPath, "r");
    try {
      const owner = Option.getOrUndefined(decodeOwner(await file.readFile("utf8")));
      return { owner, stat: await file.stat({ bigint: true }) };
    } finally {
      await file.close();
    }
  } catch (cause) {
    if (!hasCode(cause, "ENOENT")) throw cause;
    return undefined;
  }
}

async function unlinkLock(lockPath: string): Promise<void> {
  try {
    await NodeFSP.unlink(lockPath);
  } catch (cause) {
    if (!hasCode(cause, "ENOENT")) throw cause;
  }
}

async function tryCreateLock(lockPath: string, contents: string): Promise<boolean> {
  let file;
  try {
    file = await NodeFSP.open(lockPath, "wx", 0o600);
  } catch (cause) {
    if (hasCode(cause, "EEXIST")) return false;
    throw cause;
  }
  try {
    await file.writeFile(contents);
  } finally {
    await file.close();
  }
  return true;
}

async function recoverLock(lockPath: string, contents: string, host: string, input: LeaseInput) {
  const existing = await readLock(lockPath);
  if (existing === undefined) return tryCreateLock(lockPath, contents);
  const { owner, stat } = existing;
  const ownerHost = owner?.host;
  const pid = owner?.pid;
  if (typeof ownerHost === "string" && ownerHost !== "" && ownerHost !== host) return false;
  if (ownerHost !== host || typeof pid !== "number" || !Number.isSafeInteger(pid) || pid <= 0) {
    const ageMs = (input.now ?? Date.now)() - Number(stat.mtimeMs);
    if (ageMs <= (input.graceMs ?? CORRUPT_LOCK_GRACE_MS)) {
      return false;
    }
  } else {
    try {
      if (input.checkPid === undefined) process.kill(pid, 0);
      else input.checkPid(pid);
      return false;
    } catch (cause) {
      if (!hasCode(cause, "ESRCH")) return false;
    }
  }

  // Only one process may unlink this stale inode. A delayed reclaimer must not unlink its successor.
  const reclaimPath = `${lockPath}.${stat.dev}-${stat.ino}-${stat.birthtimeNs}.reclaim`;
  try {
    await NodeFSP.mkdir(reclaimPath, { mode: 0o700 });
  } catch (cause) {
    if (hasCode(cause, "EEXIST")) return false;
    throw cause;
  }
  try {
    const current = await readLock(lockPath);
    if (current !== undefined) {
      if (
        current.stat.dev !== stat.dev ||
        current.stat.ino !== stat.ino ||
        current.stat.birthtimeNs !== stat.birthtimeNs ||
        current.stat.ctimeNs !== stat.ctimeNs ||
        current.owner?.token !== owner?.token
      ) {
        return false;
      }
      await unlinkLock(lockPath);
    }
  } finally {
    await NodeFSP.rmdir(reclaimPath);
  }
  return tryCreateLock(lockPath, contents);
}

export const acquireOmpSessionLease = Effect.fn("OmpSessionLease.acquire")(function* (
  input: LeaseInput,
) {
  const sessionPath = canonicalPath(input.sessionPath);
  const leaseDir = NodePath.join(canonicalPath(input.agentDir), "t3-session-leases");
  const lockPath = NodePath.join(
    leaseDir,
    `${NodeCrypto.createHash("sha256").update(sessionPath).digest("hex")}.lock.json`,
  );

  yield* Effect.acquireRelease(
    Effect.tryPromise({
      try: async () => {
        if (activeLocks.has(sessionPath)) throw new OmpSessionLeaseConflictError({ sessionPath });
        activeLocks.add(sessionPath);
        try {
          const token = NodeCrypto.randomUUID();
          const host = NodeOS.hostname();
          const contents = encodeLock({
            token,
            pid: process.pid,
            host,
            acquiredAt: DateTime.formatIso(DateTime.makeUnsafe((input.now ?? Date.now)())),
            sessionPath,
            threadId: input.threadId,
          });
          await NodeFSP.mkdir(leaseDir, { recursive: true, mode: 0o700 });
          if (
            !(await tryCreateLock(lockPath, contents)) &&
            !(await recoverLock(lockPath, contents, host, input))
          ) {
            throw new OmpSessionLeaseConflictError({ sessionPath });
          }
          return token;
        } catch (cause) {
          activeLocks.delete(sessionPath);
          throw cause;
        }
      },
      catch: (cause) =>
        isConflict(cause) ? cause : new OmpSessionLeaseIoError({ operation: "acquire", cause }),
    }),
    (token) =>
      Effect.tryPromise({
        try: async () => {
          activeLocks.delete(sessionPath);
          const current = await readLock(lockPath);
          if (current?.owner?.token === token) await unlinkLock(lockPath);
        },
        catch: (cause) => new OmpSessionLeaseIoError({ operation: "release", cause }),
      }).pipe(Effect.catch((cause) => Effect.logWarning(cause.message, { cause }))),
  );
});
