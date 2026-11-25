import { assert, it } from "@effect/vitest";
import { EventId, ProjectId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";

import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as UsageMetadataIndex from "./UsageMetadataIndex.ts";

it.effect("has an empty default without database services", () =>
  Effect.gen(function* () {
    const index = yield* UsageMetadataIndex.UsageMetadataIndex;
    const snapshot = yield* index.snapshot();
    assert.strictEqual(snapshot.projects.length, 0);
    assert.strictEqual(snapshot.byNativeId.size, 0);
    assert.strictEqual(snapshot.bySessionUuid.size, 0);
    assert.strictEqual(snapshot.byWorktreePath.size, 0);
  }),
);

it.layer(
  UsageMetadataIndex.layer.pipe(
    Layer.provideMerge(ProjectStore.layer),
    Layer.provideMerge(SqlitePersistence.layerMemory),
  ),
)("UsageMetadataIndex", (it) => {
  it.effect("indexes raw native IDs and Pi-family UUID suffixes with current T3 metadata", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const index = yield* UsageMetadataIndex.UsageMetadataIndex;
      const projects = yield* ProjectStore.ProjectStoreV2;
      const at = "2026-08-02T12:00:00.000Z";
      const id = ProjectId.make("test-project");
      yield* projects.apply({
        sequence: 1,
        eventId: EventId.make("create-test-project"),
        aggregateKind: "project",
        aggregateId: id,
        occurredAt: at,
        commandId: null,
        causationEventId: null,
        correlationId: null,
        metadata: {},
        type: "project.created",
        payload: {
          projectId: id,
          title: "Original project",
          workspaceRoot: "/work/repo",
          defaultModelSelection: null,
          scripts: [],
          createdAt: at,
          updatedAt: at,
        },
      });
      yield* sql`UPDATE projection_projects SET deleted_at = ${at} WHERE project_id = ${id}`;
      const uuid = "11111111-2222-3333-8444-555555555555";
      const nativeFile = `/logs/2026-08-02T12-00-00_${uuid}.jsonl`;
      for (const [driver, nativeId, deletedAt] of [
        ["omp", nativeFile, null],
        ["pi", nativeFile, null],
        ["claudeAgent", uuid, null],
        ["codex", uuid, null],
        ["opencode", "ses_legacy", at],
      ] as const) {
        yield* sql`
          INSERT INTO orchestration_v2_projection_threads (
            thread_id, project_id, title, default_provider, runtime_mode, interaction_mode,
            active_provider_thread_id, created_at, updated_at, deleted_at, payload_json
          ) VALUES (
            ${driver}, ${id}, ${`Title for ${driver}`}, ${driver}, 'full-access', 'default',
            ${`ref-${driver}`}, ${at}, ${at}, ${deletedAt},
            ${JSON.stringify({ worktreePath: `/work/${driver}-tree` })}
          )
        `;
        yield* sql`
          INSERT INTO orchestration_v2_projection_provider_threads (
            provider_thread_id, thread_id, provider, driver, status, updated_at, payload_json
          ) VALUES (
            ${`ref-${driver}`}, ${driver}, ${`instance-${driver}`}, ${driver}, 'ready', ${at},
            ${JSON.stringify({ nativeThreadRef: { nativeId } })}
          )
        `;
      }
      const snapshot = yield* index.snapshot();
      assert.deepStrictEqual(snapshot.projects, [
        {
          projectId: id,
          title: "Original project",
          workspaceRoot: "/work/repo",
          deletedAt: at,
        },
      ]);
      for (const provider of ["omp", "pi"] as const) {
        const raw = snapshot.byNativeId.get(provider)?.get(nativeFile);
        assert.strictEqual(raw?.threadId, provider);
        assert.strictEqual(snapshot.bySessionUuid.get(provider)?.get(uuid), raw);
      }
      assert.strictEqual(snapshot.byNativeId.get("claude")?.get(uuid)?.threadId, "claudeAgent");
      assert.strictEqual(snapshot.byNativeId.get("codex")?.get(uuid)?.threadId, "codex");
      assert.strictEqual(snapshot.byNativeId.get("opencode")?.get("ses_legacy")?.deletedAt, at);
      assert.strictEqual(snapshot.byWorktreePath.get("/work/omp-tree")?.projectId, id);

      yield* sql`UPDATE orchestration_v2_projection_threads SET title = 'New title' WHERE thread_id = 'omp'`;
      assert.strictEqual(
        (yield* index.snapshot()).bySessionUuid.get("omp")?.get(uuid)?.title,
        "New title",
      );
    }),
  );
});
