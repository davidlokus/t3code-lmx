import { UsageProviderKind } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";

interface UsageThreadMetadata {
  readonly threadId: string;
  readonly projectId: string;
  readonly title: string;
  readonly worktreePath: string | null;
  readonly deletedAt: string | null;
}

type UsageSessionIndex = ReadonlyMap<UsageProviderKind, ReadonlyMap<string, UsageThreadMetadata>>;

export interface UsageMetadataSnapshot {
  readonly projects: readonly Pick<
    ProjectStore.ProjectRow,
    "projectId" | "title" | "workspaceRoot" | "deletedAt"
  >[];
  readonly byNativeId: UsageSessionIndex;
  readonly bySessionUuid: UsageSessionIndex;
  readonly byWorktreePath: ReadonlyMap<string, UsageThreadMetadata>;
}

const EMPTY_SNAPSHOT: UsageMetadataSnapshot = {
  projects: [],
  byNativeId: new Map(),
  bySessionUuid: new Map(),
  byWorktreePath: new Map(),
};

export class UsageMetadataIndex extends Context.Reference<{
  readonly snapshot: () => Effect.Effect<UsageMetadataSnapshot>;
}>("t3/usage/UsageMetadataIndex", {
  defaultValue: () => ({ snapshot: () => Effect.succeed(EMPTY_SNAPSHOT) }),
}) {}

const isUsageProvider = Schema.is(UsageProviderKind);
const SESSION_FILE_UUID = /_([\da-f]{8}-(?:[\da-f]{4}-){3}[\da-f]{12})\.jsonl$/i;

type MutableSessionIndex = Map<UsageProviderKind, Map<string, UsageThreadMetadata>>;

function indexSession(
  index: MutableSessionIndex,
  provider: UsageProviderKind,
  id: string,
  thread: UsageThreadMetadata,
) {
  let sessions = index.get(provider);
  if (sessions === undefined) {
    sessions = new Map();
    index.set(provider, sessions);
  }
  // The query orders live, active links ahead of historical links to the same session.
  if (!sessions.has(id)) sessions.set(id, thread);
}

const make = Effect.gen(function* () {
  const projects = yield* ProjectStore.ProjectStoreV2;
  const sql = yield* SqlClient.SqlClient;
  const snapshot = Effect.fn("UsageMetadataIndex.snapshot")(
    function* () {
      const allProjects = yield* projects.list({ includeDeleted: true });
      const rows = yield* sql<
        UsageThreadMetadata & { readonly driver: string | null; readonly nativeId: unknown }
      >`
        SELECT t.thread_id AS threadId, t.project_id AS projectId, t.title,
          t.deleted_at AS deletedAt,
          CASE WHEN json_valid(t.payload_json) THEN json_extract(t.payload_json, '$.worktreePath') END AS worktreePath,
          p.driver AS driver,
          CASE WHEN json_valid(p.payload_json) THEN json_extract(p.payload_json, '$.nativeThreadRef.nativeId') END AS nativeId
        FROM orchestration_v2_projection_threads AS t
        LEFT JOIN orchestration_v2_projection_provider_threads AS p ON p.thread_id = t.thread_id
        ORDER BY t.deleted_at IS NOT NULL, t.active_provider_thread_id IS NOT p.provider_thread_id,
          t.updated_at DESC, t.thread_id, p.provider_thread_id
      `;
      const byNativeId: MutableSessionIndex = new Map();
      const bySessionUuid: MutableSessionIndex = new Map();
      const byWorktreePath = new Map<string, UsageThreadMetadata>();
      for (const { driver, nativeId, ...thread } of rows) {
        if (typeof thread.worktreePath === "string" && !byWorktreePath.has(thread.worktreePath)) {
          byWorktreePath.set(thread.worktreePath, thread);
        }
        const provider = driver === "claudeAgent" ? "claude" : driver;
        if (!isUsageProvider(provider) || typeof nativeId !== "string" || !nativeId) continue;
        indexSession(byNativeId, provider, nativeId, thread);
        if (provider === "omp" || provider === "pi") {
          const uuid = SESSION_FILE_UUID.exec(nativeId)?.[1];
          if (uuid !== undefined) indexSession(bySessionUuid, provider, uuid.toLowerCase(), thread);
        }
      }
      return {
        projects: allProjects.map(({ projectId, title, workspaceRoot, deletedAt }) => ({
          projectId,
          title,
          workspaceRoot,
          deletedAt,
        })),
        byNativeId,
        bySessionUuid,
        byWorktreePath,
      } satisfies UsageMetadataSnapshot;
    },
    sql.withTransaction,
    Effect.catch(() =>
      Effect.logDebug("Could not read usage attribution metadata").pipe(Effect.as(EMPTY_SNAPSHOT)),
    ),
  );
  return { snapshot };
});

export const layer = Layer.effect(UsageMetadataIndex, make);
