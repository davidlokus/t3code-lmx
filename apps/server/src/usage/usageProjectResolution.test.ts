import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { ProjectId, UNATTRIBUTED_USAGE_PROJECT_KEY } from "@t3tools/contracts";
import { EMPTY_TOTALS, type UsageRecord } from "@t3tools/provider-core/server/usage";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import { UsageMetadataIndex } from "./UsageMetadataIndex.ts";
import { makeUsageProjectResolver } from "./usageProjectResolution.ts";

const record = (cwd?: string): UsageRecord => ({
  provider: "omp",
  timestampMs: 0,
  model: "test-model",
  sessionId: "session-a",
  ...(cwd === undefined ? {} : { cwd }),
  totals: EMPTY_TOTALS,
  reportedCostUsd: null,
  speed: "standard",
  dedupeKey: null,
});

it.effect("merges absolute and relative gitdir links without touching protected paths", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const home = yield* fs.makeTempDirectoryScoped({ prefix: "usage-worktrees-" });
    const repo = path.join(home, "repo");
    const first = path.join(home, "a");
    const second = path.join(home, "b");
    const protectedPaths = ["Desktop", "Documents", "Downloads"].map((part) =>
      path.join(home, part, "repo"),
    );
    yield* fs.makeDirectory(path.join(repo, ".git"), { recursive: true });
    for (const cwd of [first, second, ...protectedPaths]) {
      const gitdir = path.join(repo, ".git", "worktrees", path.basename(cwd));
      yield* fs.makeDirectory(cwd, { recursive: true });
      yield* fs.writeFileString(
        path.join(cwd, ".git"),
        `gitdir: ${cwd === second ? path.relative(cwd, gitdir) : gitdir}\n`,
      );
    }

    const prepare = yield* makeUsageProjectResolver.pipe(
      Effect.provideService(HostProcess.HomeDirectory, home),
      Effect.provideService(HostProcess.Platform, "darwin"),
    );
    const metadata = yield* (yield* UsageMetadataIndex).snapshot();
    const paths = [repo, first, second, ...protectedPaths];
    const resolve = yield* prepare(metadata, [[{ records: paths.map(record) }]]);
    for (const cwd of [repo, first, second]) {
      const result = resolve(record(cwd));
      assert.deepStrictEqual(result.project, {
        projectKey: `path:${repo}`,
        label: "repo",
        workspaceRoot: repo,
      });
      assert.strictEqual(result.worktreePath, cwd === repo ? undefined : cwd);
    }
    for (const cwd of protectedPaths) {
      assert.strictEqual(resolve(record(cwd)).project.workspaceRoot, cwd);
    }
    assert.strictEqual(resolve(record()).project.projectKey, UNATTRIBUTED_USAGE_PROJECT_KEY);
    assert.strictEqual(
      resolve(record("relative/path")).project.projectKey,
      UNATTRIBUTED_USAGE_PROJECT_KEY,
    );
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect(
  "prefers the matched T3 thread and normalizes a known checkout for external sessions",
  () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const home = path.resolve("/home/test");
      const projectId = ProjectId.make("project-a");
      const checkout = path.join(home, "checkout");
      const thread = {
        threadId: "thread-a",
        projectId,
        title: "Live title",
        worktreePath: checkout,
        deletedAt: null,
      };
      const metadata = {
        projects: [
          {
            projectId,
            title: "T3 Project",
            workspaceRoot: path.join(home, "repo"),
            deletedAt: null,
          },
        ],
        byNativeId: new Map(),
        bySessionUuid: new Map([["omp" as const, new Map([["session-a", thread]])]]),
        byWorktreePath: new Map([[checkout, thread]]),
      };
      const prepare = yield* makeUsageProjectResolver.pipe(
        Effect.provideService(HostProcess.HomeDirectory, home),
        Effect.provideService(HostProcess.Platform, "linux"),
      );
      const external = { ...record(`${checkout}${path.sep}.`), sessionId: "external" };
      const resolve = yield* prepare(metadata, [[{ records: [record(), external] }]]);
      const linked = resolve(record());
      assert.strictEqual(linked.t3ThreadId, "thread-a");
      assert.strictEqual(linked.t3Title, "Live title");
      assert.strictEqual(linked.worktreePath, checkout);
      assert.strictEqual(linked.project.projectKey, `t3:${projectId}`);
      assert.strictEqual(resolve(external).t3ThreadId, undefined);
      assert.deepStrictEqual(resolve(external).project, linked.project);
    }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect(
  "resolves nested subdirectories inside main repos, linked worktrees, and skips macOS symlink traversal into protected dirs",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const home = yield* fs.makeTempDirectoryScoped({ prefix: "usage-nested-" });
      const repo = path.join(home, "repo");
      const mainSubdir = path.join(repo, "packages", "web");
      const linkedWt = path.join(home, "repo-wt");
      const linkedSubdir = path.join(linkedWt, "apps", "server");
      const docsRepo = path.join(home, "Documents", "secret-repo");
      const symlinkAlias = path.join(home, "safe-alias");

      yield* fs.makeDirectory(path.join(repo, ".git"), { recursive: true });
      yield* fs.makeDirectory(mainSubdir, { recursive: true });
      yield* fs.makeDirectory(linkedSubdir, { recursive: true });
      yield* fs.writeFileString(
        path.join(linkedWt, ".git"),
        `gitdir: ${path.join(repo, ".git", "worktrees", "repo-wt")}\n`,
      );
      yield* fs.makeDirectory(path.join(docsRepo, ".git"), { recursive: true });
      yield* fs.symlink(docsRepo, symlinkAlias);

      const prepare = yield* makeUsageProjectResolver.pipe(
        Effect.provideService(HostProcess.HomeDirectory, home),
        Effect.provideService(HostProcess.Platform, "darwin"),
      );
      const metadata = yield* (yield* UsageMetadataIndex).snapshot();
      const resolve = yield* prepare(metadata, [
        [{ records: [record(mainSubdir), record(linkedSubdir), record(symlinkAlias)] }],
      ]);

      const mainRes = resolve(record(mainSubdir));
      assert.strictEqual(mainRes.project.projectKey, `path:${repo}`);
      assert.strictEqual(mainRes.worktreePath, undefined);

      const wtRes = resolve(record(linkedSubdir));
      assert.strictEqual(wtRes.project.projectKey, `path:${repo}`);
      assert.strictEqual(wtRes.worktreePath, linkedWt);

      const symlinkRes = resolve(record(symlinkAlias));
      assert.strictEqual(symlinkRes.project.workspaceRoot, symlinkAlias);
    }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect(
  "vets the full macOS ancestor chain outermost-first above 12 levels and revalidates across scans when a directory becomes a symlink",
  () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const home = "/Users/tester";
      const alias = path.join(home, "alias-dir");
      const mutableDir = path.join(home, "mutable-dir");
      const deepSegments = Array.from({ length: 16 }, (_, index) => `lvl-${index}`);
      const deepAliasCwd = path.join(alias, ...deepSegments);
      const mutableChild1 = path.join(mutableDir, "sub-a");
      const mutableChild2 = path.join(mutableDir, "sub-b");
      let mutableIsSymlink = false;
      const readLinkCalls: string[] = [];
      const statCalls: string[] = [];

      const mockFs = FileSystem.makeNoop({
        readLink: (target) =>
          Effect.sync(() => {
            readLinkCalls.push(target);
            if (target === alias) return path.join(home, "Documents", "secret");
            if (target === mutableDir && mutableIsSymlink) {
              return path.join(home, "Documents", "moved");
            }
            return null;
          }).pipe(
            Effect.filterOrFail(
              (value): value is string => value !== null,
              () => ({ _tag: "SystemError" }) as never,
            ),
          ),
        stat: (target) =>
          Effect.sync(() => {
            statCalls.push(target);
          }).pipe(Effect.flatMap(() => Effect.fail({ _tag: "SystemError" } as never))),
      });

      const prepare = yield* makeUsageProjectResolver.pipe(
        Effect.provideService(FileSystem.FileSystem, mockFs),
        Effect.provideService(HostProcess.HomeDirectory, home),
        Effect.provideService(HostProcess.Platform, "darwin"),
      );
      const metadata = yield* (yield* UsageMetadataIndex).snapshot();

      // Scan 1: deep alias is blocked outermost-first before stat; mutableDir is still a normal dir.
      const resolve1 = yield* prepare(metadata, [
        [{ records: [record(deepAliasCwd), record(mutableChild1)] }],
      ]);
      assert.strictEqual(resolve1(record(deepAliasCwd)).project.workspaceRoot, deepAliasCwd);
      assert.strictEqual(
        statCalls.some((target) => target.startsWith(alias)),
        false,
      );
      assert.strictEqual(
        readLinkCalls.some((target) => target.startsWith(alias + path.sep)),
        false,
      );

      // Scan 2: mutableDir is replaced with a symlink into Documents; a new nested cwd MUST revalidate and never stat below it.
      mutableIsSymlink = true;
      statCalls.length = 0;
      readLinkCalls.length = 0;
      const resolve2 = yield* prepare(metadata, [[{ records: [record(mutableChild2)] }]]);
      assert.strictEqual(resolve2(record(mutableChild2)).project.workspaceRoot, mutableChild2);
      assert.deepStrictEqual(statCalls, []);
      assert.deepStrictEqual(readLinkCalls, ["/Users", "/Users/tester", mutableDir]);
    }).pipe(Effect.provide(NodeServices.layer)),
);
