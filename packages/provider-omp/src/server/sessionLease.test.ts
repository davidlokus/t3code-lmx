// @effect-diagnostics nodeBuiltinImport:off - simulate another process replacing a stale lease during the PID probe.
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { symlinksSupported } from "@t3tools/shared/testing/symlinks";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import { acquireOmpSessionLease, OmpSessionLeaseConflictError } from "./sessionLease.ts";

const acquiredAt = "2026-11-25T00:00:00.000Z";
const now = () => Date.parse(acquiredAt);
const lockJson = Schema.fromJsonString(Schema.Unknown);
const decodeJson = Schema.decodeUnknownSync(lockJson);
const encodeJson = Schema.encodeSync(lockJson);
const previousOwner = { token: "old-token", pid: 12_345, host: NodeOS.hostname() };

const makeFixture = Effect.fnUntraced(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const agentDir = yield* fileSystem.makeTempDirectoryScoped();
  const sessionsDir = path.join(agentDir, "sessions");
  yield* fileSystem.makeDirectory(sessionsDir);
  const session = path.join(sessionsDir, "session.jsonl");
  yield* fileSystem.writeFileString(session, "");
  const sessionPath = yield* fileSystem.realPath(session);
  const leaseDir = path.join(agentDir, "t3-session-leases");
  const lockPath = path.join(
    leaseDir,
    `${NodeCrypto.createHash("sha256").update(sessionPath).digest("hex")}.lock.json`,
  );
  return {
    fileSystem,
    path,
    lockPath,
    leaseDir,
    sessionsDir,
    input: { agentDir, sessionPath, threadId: "omp-thread", now },
  };
});

it.layer(NodeServices.layer)("OMP session lease", (it) => {
  it.effect("holds one private lease outside sessions until the owning scope closes", () =>
    Effect.gen(function* () {
      const { fileSystem, input, lockPath, sessionsDir } = yield* makeFixture();
      yield* Effect.scoped(
        Effect.gen(function* () {
          yield* acquireOmpSessionLease(input);
          expect(decodeJson(yield* fileSystem.readFileString(lockPath))).toMatchObject({
            token: expect.any(String),
            pid: process.pid,
            host: NodeOS.hostname(),
            acquiredAt,
            sessionPath: input.sessionPath,
            threadId: "omp-thread",
          });
          if ((yield* HostProcess.Platform) !== "win32") {
            expect((yield* fileSystem.stat(lockPath)).mode & 0o777).toBe(0o600);
          }
          expect(yield* fileSystem.readDirectory(sessionsDir)).toEqual(["session.jsonl"]);
          const conflict = yield* acquireOmpSessionLease({
            ...input,
            threadId: "same-process-contender",
            checkPid: () => {
              throw Object.assign(new Error("No such process"), { code: "ESRCH" });
            },
          }).pipe(Effect.flip);
          expect(conflict).toBeInstanceOf(OmpSessionLeaseConflictError);
        }),
      );
      expect(yield* fileSystem.exists(lockPath)).toBe(false);
      yield* acquireOmpSessionLease(input);
      expect(yield* fileSystem.exists(lockPath)).toBe(true);
    }).pipe(Effect.scoped),
  );

  it.effect.skipIf(!symlinksSupported)("treats a symlinked session path as the same lease", () =>
    Effect.gen(function* () {
      const { fileSystem, input, path, sessionsDir } = yield* makeFixture();
      const alias = path.join(sessionsDir, "alias.jsonl");
      yield* fileSystem.symlink(input.sessionPath, alias);
      yield* acquireOmpSessionLease(input);
      const conflict = yield* acquireOmpSessionLease({ ...input, sessionPath: alias }).pipe(
        Effect.flip,
      );
      expect(conflict).toMatchObject({
        _tag: "OmpSessionLeaseConflictError",
        sessionPath: input.sessionPath,
      });
    }).pipe(Effect.scoped),
  );

  it.effect.each(["live", "permission denied", "other host"] as const)(
    "never removes a lease with a %s owner",
    (state) =>
      Effect.gen(function* () {
        const { fileSystem, input, lockPath, leaseDir } = yield* makeFixture();
        yield* fileSystem.makeDirectory(leaseDir);
        const contents = encodeJson(
          state === "other host" ? { host: `${NodeOS.hostname()}-other` } : previousOwner,
        );
        yield* fileSystem.writeFileString(lockPath, contents);
        const staleTime = now() / 1_000 - 10;
        yield* fileSystem.utimes(lockPath, staleTime, staleTime);
        const probed: number[] = [];
        const result = yield* acquireOmpSessionLease({
          ...input,
          checkPid: (pid) => {
            probed.push(pid);
            if (state === "permission denied") {
              throw Object.assign(new Error("Permission denied"), { code: "EPERM" });
            }
          },
        }).pipe(Effect.flip);
        expect(result).toBeInstanceOf(OmpSessionLeaseConflictError);
        expect(probed).toEqual(state === "other host" ? [] : [previousOwner.pid]);
        expect(yield* fileSystem.readFileString(lockPath)).toBe(contents);
      }).pipe(Effect.scoped),
  );

  it.effect("reclaims a lease only after its local PID is confirmed dead", () =>
    Effect.gen(function* () {
      const { fileSystem, input, lockPath, leaseDir } = yield* makeFixture();
      yield* fileSystem.makeDirectory(leaseDir);
      yield* fileSystem.writeFileString(lockPath, encodeJson(previousOwner));
      yield* acquireOmpSessionLease({
        ...input,
        checkPid: (pid) => {
          expect(pid).toBe(previousOwner.pid);
          throw Object.assign(new Error("No such process"), { code: "ESRCH" });
        },
      });
      expect(decodeJson(yield* fileSystem.readFileString(lockPath))).toMatchObject({
        token: expect.not.stringMatching(/^old-token$/),
        pid: process.pid,
      });
    }).pipe(Effect.scoped),
  );

  it.effect("gives a partial lock time to publish before reclaiming it", () =>
    Effect.gen(function* () {
      const { fileSystem, input, lockPath, leaseDir } = yield* makeFixture();
      yield* fileSystem.makeDirectory(leaseDir);
      yield* fileSystem.writeFileString(lockPath, "{");
      const time = now() / 1_000;
      yield* fileSystem.utimes(lockPath, time, time);
      const conflict = yield* acquireOmpSessionLease({ ...input, graceMs: 100 }).pipe(Effect.flip);
      expect(conflict).toBeInstanceOf(OmpSessionLeaseConflictError);
      expect(yield* fileSystem.readFileString(lockPath)).toBe("{");
      yield* acquireOmpSessionLease({ ...input, graceMs: 100, now: () => now() + 101 });
      expect(decodeJson(yield* fileSystem.readFileString(lockPath))).toMatchObject({
        pid: process.pid,
      });
    }).pipe(Effect.scoped),
  );

  it.effect("does not reclaim a replacement published during the stale PID probe", () =>
    Effect.gen(function* () {
      const { fileSystem, input, lockPath, leaseDir } = yield* makeFixture();
      yield* fileSystem.makeDirectory(leaseDir);
      yield* fileSystem.writeFileString(lockPath, encodeJson(previousOwner));
      const replacement = encodeJson({ ...previousOwner, token: "replacement" });
      const conflict = yield* acquireOmpSessionLease({
        ...input,
        checkPid: () => {
          NodeFS.writeFileSync(lockPath, replacement);
          throw Object.assign(new Error("No such process"), { code: "ESRCH" });
        },
      }).pipe(Effect.flip);
      expect(conflict).toBeInstanceOf(OmpSessionLeaseConflictError);
      expect(yield* fileSystem.readFileString(lockPath)).toBe(replacement);
    }).pipe(Effect.scoped),
  );

  it.effect("blocks same-process overlap even across distinct agent directories", () =>
    Effect.gen(function* () {
      const { fileSystem, input } = yield* makeFixture();
      const otherAgentDir = yield* fileSystem.makeTempDirectoryScoped();
      yield* acquireOmpSessionLease(input);
      const conflict = yield* acquireOmpSessionLease({
        ...input,
        agentDir: otherAgentDir,
        threadId: "other-instance-thread",
      }).pipe(Effect.flip);
      expect(conflict).toBeInstanceOf(OmpSessionLeaseConflictError);
    }).pipe(Effect.scoped),
  );

  it.effect("does not unlink a replacement token when an old scope closes", () =>
    Effect.gen(function* () {
      const { fileSystem, input, lockPath } = yield* makeFixture();
      const replacement = encodeJson({ ...previousOwner, token: "replacement" });
      yield* Effect.scoped(
        Effect.gen(function* () {
          yield* acquireOmpSessionLease(input);
          yield* fileSystem.writeFileString(lockPath, replacement);
        }),
      );
      expect(yield* fileSystem.readFileString(lockPath)).toBe(replacement);
    }).pipe(Effect.scoped),
  );
});
