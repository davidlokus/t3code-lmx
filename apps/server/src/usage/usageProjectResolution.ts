import { UNATTRIBUTED_USAGE_PROJECT_KEY, type UsageProjectBucket } from "@t3tools/contracts";
import type { UsageRecord } from "@t3tools/provider-core/server/usage";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";

import type { UsageMetadataSnapshot } from "./UsageMetadataIndex.ts";

type UsageProject = Pick<
  UsageProjectBucket,
  "projectKey" | "label" | "workspaceRoot" | "t3ProjectId" | "unattributed"
>;

export interface UsageProjectResolution {
  readonly project: UsageProject;
  readonly cwd?: string;
  readonly worktreePath?: string;
  readonly t3ThreadId?: string;
  readonly t3Title?: string;
}

interface GitProbeResult {
  readonly root: string;
  readonly worktreeRoot?: string;
}

const UNATTRIBUTED: UsageProjectResolution = {
  project: {
    projectKey: UNATTRIBUTED_USAGE_PROJECT_KEY,
    label: "Unattributed",
    unattributed: true,
  },
};

const MAX_GIT_SEARCH_DEPTH = 12;
const MAX_ANCESTOR_COMPONENTS = 128;

export const makeUsageProjectResolver = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const platform = yield* HostProcess.Platform;
  const home = yield* HostProcess.HomeDirectory;
  const normalizedHome = path.resolve(home);
  const protectedRoots =
    platform === "darwin"
      ? ["Desktop", "Documents", "Downloads"].map((name) =>
          path.join(normalizedHome, name).toLowerCase(),
        )
      : [];

  const isProtectedPath = (candidate: string): boolean => {
    if (protectedRoots.length === 0) return false;
    const relativeToHome = candidate.replace(/^\/System\/Volumes\/Data(?=\/)/i, "").toLowerCase();
    return protectedRoots.some(
      (root) => relativeToHome === root || relativeToHome.startsWith(root + path.sep),
    );
  };

  const isBenignDarwinRootLink = (candidate: string, linkTarget: string): boolean =>
    (candidate === "/var" && (linkTarget === "private/var" || linkTarget === "/private/var")) ||
    (candidate === "/tmp" && (linkTarget === "private/tmp" || linkTarget === "/private/tmp"));

  // On macOS, vet the entire ancestor chain outermost-first via readLink (per-scan cache only so replaced links are always caught).
  const hasSymlinkComponent = Effect.fn("UsageService.hasSymlinkComponent")(function* (
    target: string,
    symlinkStatusCache: Map<string, boolean>,
  ): Effect.fn.Return<boolean> {
    if (platform !== "darwin") return false;
    const chain: string[] = [];
    let cursor = target;
    for (let depth = 0; depth < MAX_ANCESTOR_COMPONENTS; depth += 1) {
      if (isProtectedPath(cursor)) return true;
      const parent = path.dirname(cursor);
      if (parent === cursor) break;
      chain.push(cursor);
      cursor = parent;
    }
    // Fail closed if the path exceeds the bounded ancestor check without reaching filesystem root.
    if (path.dirname(cursor) !== cursor) return true;

    for (const candidate of chain.toReversed()) {
      if (isProtectedPath(candidate)) return true;
      const cached = symlinkStatusCache.get(candidate);
      if (cached !== undefined) {
        if (cached) return true;
        continue;
      }
      const linkTarget = yield* fileSystem.readLink(candidate).pipe(Effect.option);
      const unsafeSymlink =
        Option.isSome(linkTarget) && !isBenignDarwinRootLink(candidate, linkTarget.value);
      symlinkStatusCache.set(candidate, unsafeSymlink);
      if (unsafeSymlink) return true;
    }
    return false;
  });

  const probeGitRoot = Effect.fn("UsageService.readGitWorktreeRoot")(
    function* (
      cwd: string,
      symlinkStatusCache: Map<string, boolean>,
    ): Effect.fn.Return<GitProbeResult> {
      if (isProtectedPath(cwd)) return { root: cwd };
      if (yield* hasSymlinkComponent(cwd, symlinkStatusCache)) return { root: cwd };

      let cursor = cwd;
      for (let depth = 0; depth <= MAX_GIT_SEARCH_DEPTH; depth += 1) {
        if (isProtectedPath(cursor)) return { root: cwd };
        const dotGit = path.join(cursor, ".git");
        const dotGitLink = yield* fileSystem.readLink(dotGit).pipe(Effect.option);
        if (Option.isSome(dotGitLink)) {
          // Never follow a symlinked .git entry on macOS/any platform.
          return { root: cwd };
        }
        const info = yield* fileSystem.stat(dotGit).pipe(Effect.option);
        if (Option.isSome(info)) {
          if (info.value.type === "Directory") {
            return { root: cursor };
          }
          if (info.value.type === "File" && info.value.size <= 4096) {
            const content = yield* fileSystem.readFileString(dotGit).pipe(Effect.option);
            const pointer = Option.isSome(content)
              ? /^gitdir:\s+([^\r\n]+)$/.exec(content.value.trim())?.[1]
              : undefined;
            if (pointer && !pointer.includes("\0")) {
              const resolvedGitDir = path.resolve(cursor, pointer.trim());
              if (isProtectedPath(resolvedGitDir)) return { root: cwd };
              const worktrees = path.dirname(resolvedGitDir);
              const commonDir = path.dirname(worktrees);
              if (path.basename(worktrees) === "worktrees" && path.basename(commonDir) === ".git") {
                return { root: path.dirname(commonDir), worktreeRoot: cursor };
              }
            }
            return { root: cursor };
          }
        }
        if (cursor === normalizedHome) break;
        const parent = path.dirname(cursor);
        if (parent === cursor) break;
        cursor = parent;
      }
      return { root: cwd };
    },
    (read, cwd) =>
      read.pipe(
        Effect.option,
        Effect.timeoutOption("250 millis"),
        Effect.map((result) =>
          Option.flatten(result).pipe(Option.getOrElse(() => ({ root: cwd }))),
        ),
      ),
  );

  const matchLongestPrefix = <T>(
    target: string,
    entries: readonly (readonly [string, T])[],
  ): { readonly matchedRoot: string; readonly value: T } | undefined => {
    for (const [root, value] of entries) {
      if (target === root || target.startsWith(root + path.sep)) {
        return { matchedRoot: root, value };
      }
    }
    return undefined;
  };

  return Effect.fn("UsageService.prepareProjectResolution")(function* (
    metadata: UsageMetadataSnapshot,
    filesByDir: readonly (readonly { readonly records: readonly UsageRecord[] }[])[],
  ) {
    const normalizedPaths = new Map<string, string | undefined>();
    const normalize = (raw: string | null | undefined) => {
      if (raw == null) return undefined;
      if (normalizedPaths.has(raw)) return normalizedPaths.get(raw);
      const trimmed = raw.trim();
      const value =
        path.isAbsolute(trimmed) && !trimmed.includes("\0") ? path.resolve(trimmed) : undefined;
      normalizedPaths.set(raw, value);
      return value;
    };
    const projectsById = new Map<string, UsageProject>();
    const projectsByRoot = new Map<string, { project: UsageProject; deleted: boolean }>();
    for (const entry of metadata.projects) {
      const workspaceRoot = normalize(entry.workspaceRoot);
      const project: UsageProject = {
        projectKey: `t3:${entry.projectId}`,
        label:
          entry.title.trim() ||
          (workspaceRoot === undefined
            ? entry.projectId
            : path.basename(workspaceRoot) || workspaceRoot),
        ...(workspaceRoot === undefined ? {} : { workspaceRoot }),
        t3ProjectId: entry.projectId,
      };
      projectsById.set(entry.projectId, project);
      if (workspaceRoot !== undefined) {
        const held = projectsByRoot.get(workspaceRoot);
        if (held === undefined || (held.deleted && entry.deletedAt === null)) {
          projectsByRoot.set(workspaceRoot, { project, deleted: entry.deletedAt !== null });
        }
      }
    }
    const projectsByWorktree = new Map<string, UsageProject>();
    for (const [raw, thread] of metadata.byWorktreePath) {
      const worktree = normalize(raw);
      const project = projectsById.get(thread.projectId);
      if (worktree !== undefined && project !== undefined && !projectsByWorktree.has(worktree)) {
        projectsByWorktree.set(worktree, project);
      }
    }
    const sortedWorktreePrefixes = [...projectsByWorktree.entries()].sort(
      (a, b) => b[0].length - a[0].length,
    );
    const sortedRootPrefixes = [...projectsByRoot.entries()]
      .map(([root, entry]) => [root, entry.project] as const)
      .sort((a, b) => b[0].length - a[0].length);

    const findThread = ({ provider, sessionId }: UsageRecord) =>
      metadata.byNativeId.get(provider)?.get(sessionId) ??
      metadata.bySessionUuid.get(provider)?.get(sessionId.toLowerCase());

    const gitProbes = new Map<string, GitProbeResult>();
    const symlinkStatusCache = new Map<string, boolean>();
    const rootsToRead = new Set<string>();
    for (const files of filesByDir) {
      for (const { records } of files) {
        for (const record of records) {
          const cwd = normalize(record.cwd);
          if (cwd === undefined || rootsToRead.has(cwd)) continue;
          if (
            matchLongestPrefix(cwd, sortedWorktreePrefixes) !== undefined ||
            matchLongestPrefix(cwd, sortedRootPrefixes) !== undefined
          ) {
            continue;
          }
          const thread = findThread(record);
          if (thread === undefined || !projectsById.has(thread.projectId)) rootsToRead.add(cwd);
        }
      }
    }
    yield* Effect.forEach(
      rootsToRead,
      (cwd) =>
        probeGitRoot(cwd, symlinkStatusCache).pipe(
          Effect.map((result) => gitProbes.set(cwd, result)),
        ),
      { concurrency: 8, discard: true },
    );

    const externalProjects = new Map<string, UsageProject>();
    return (record: UsageRecord): UsageProjectResolution => {
      const thread = findThread(record);
      const worktree = normalize(thread?.worktreePath);
      const cwd = normalize(record.cwd) ?? worktree;
      const matchedWorktree =
        cwd === undefined ? undefined : matchLongestPrefix(cwd, sortedWorktreePrefixes);
      const matchedRoot =
        cwd === undefined ? undefined : matchLongestPrefix(cwd, sortedRootPrefixes);
      const probe = cwd === undefined ? undefined : (gitProbes.get(cwd) ?? { root: cwd });
      const root = probe?.root;

      let project = thread === undefined ? undefined : projectsById.get(thread.projectId);
      if (project === undefined && matchedWorktree !== undefined) {
        project = matchedWorktree.value;
      }
      if (project === undefined && matchedRoot !== undefined) {
        project = matchedRoot.value;
      }
      if (project === undefined && root !== undefined) {
        project = projectsByRoot.get(root)?.project ?? externalProjects.get(root);
        if (project === undefined) {
          project = {
            projectKey: `path:${root}`,
            label: path.basename(root) || root,
            workspaceRoot: root,
          };
          externalProjects.set(root, project);
        }
      }
      if (project === undefined && thread === undefined) return UNATTRIBUTED;

      const workspaceRoot = project?.workspaceRoot;
      // Only count canonical linked checkouts, never nested subdirectories inside a repo.
      const observedWorktree = worktree ?? matchedWorktree?.matchedRoot ?? probe?.worktreeRoot;
      const worktreePath = observedWorktree === workspaceRoot ? undefined : observedWorktree;
      const title = thread?.title.trim();
      return {
        project: project ?? UNATTRIBUTED.project,
        ...(cwd === undefined ? {} : { cwd }),
        ...(worktreePath === undefined ? {} : { worktreePath }),
        ...(thread?.deletedAt === null ? { t3ThreadId: thread.threadId } : {}),
        ...(title ? { t3Title: title } : {}),
      };
    };
  });
});
