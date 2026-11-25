import * as NodeServices from "@effect/platform-node/NodeServices";
import { ProviderInstanceId } from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import { assert, describe, it } from "@effect/vitest";

import { ompUsageFormat, ompUsageReader, resolveOmpSessionsDir } from "./usage.ts";

describe("ompUsageFormat", () => {
  it("parses assistant messages, auxiliary model_usage entries, reasoningTokens, and cost", () => {
    const state = ompUsageFormat.state?.initial();
    if (!state) return assert.fail("expected ompUsageFormat state");

    ompUsageFormat.parseLine('{"type":"title","title":"Runtime attribution"}', state);
    assert.deepEqual(
      ompUsageFormat.parseLine(
        JSON.stringify({
          type: "session",
          id: "sess-omp-1",
          cwd: "/work/fork",
          timestamp: "2026-11-24T04:14:27.559Z",
        }),
        state,
      ),
      [],
    );

    const assistantRecords = ompUsageFormat.parseLine(
      JSON.stringify({
        type: "message",
        id: "msg-1",
        timestamp: "2026-11-24T04:15:08.766Z",
        message: {
          role: "assistant",
          provider: "openai-codex",
          model: "gpt-6.1-terra",
          usage: {
            input: 28528,
            output: 210,
            cacheRead: 1200,
            cacheWrite: 300,
            reasoningTokens: 9,
            cost: { total: 0.073945 },
          },
        },
      }),
      state,
    );

    assert.deepEqual(assistantRecords, [
      {
        provider: "omp",
        timestampMs: Date.parse("2026-11-24T04:15:08.766Z"),
        model: "openai-codex/gpt-6.1-terra",
        rateModel: "gpt-6.1-terra",
        sessionId: "sess-omp-1",
        cwd: "/work/fork",
        totals: {
          uncachedInputTokens: 28528,
          cachedInputTokens: 1200,
          cacheCreationTokens: 300,
          outputTokens: 210,
          reasoningTokens: 9,
        },
        reportedCostUsd: 0.073945,
        speed: "standard",
        dedupeKey: JSON.stringify([
          "omp",
          "msg-1",
          "2026-11-24T04:15:08.766Z",
          "openai-codex/gpt-6.1-terra",
        ]),
      },
    ]);

    const auxiliaryRecords = ompUsageFormat.parseLine(
      JSON.stringify({
        type: "model_usage",
        id: "aux-1",
        timestamp: "2026-11-24T04:15:10.084Z",
        provider: "typesafe",
        model: "jev-1.14.0",
        usage: {
          input: 2574,
          output: 460,
          cacheRead: 0,
          cacheWrite: 0,
          cost: { total: 0.000108108 },
        },
      }),
      state,
    );

    assert.equal(auxiliaryRecords.length, 1);
    assert.equal(auxiliaryRecords[0]?.model, "typesafe/jev-1.14.0");
    assert.equal(auxiliaryRecords[0]?.rateModel, "jev-1.14.0");
    assert.equal(auxiliaryRecords[0]?.reportedCostUsd, 0.000108108);
    assert.equal(auxiliaryRecords[0]?.sessionId, "sess-omp-1");
    assert.equal(auxiliaryRecords[0]?.cwd, "/work/fork");
    assert.deepStrictEqual(
      ompUsageFormat.readSessionTitles?.(state),
      new Map([["sess-omp-1", "Runtime attribution"]]),
    );
  });

  it("treats zero-cost omp models as unpriced (null reportedCostUsd) and handles compaction", () => {
    const state = ompUsageFormat.state?.initial();
    if (!state) return assert.fail("expected ompUsageFormat state");
    ompUsageFormat.parseLine(JSON.stringify({ type: "session", id: "sess-omp-2" }), state);

    const zeroCost = ompUsageFormat.parseLine(
      JSON.stringify({
        type: "message",
        id: "msg-glm",
        timestamp: "2026-11-23T18:52:00.000Z",
        message: {
          role: "assistant",
          provider: "zai",
          model: "glm-5.4",
          usage: {
            input: 3026,
            output: 1662,
            cacheRead: 19328,
            cacheWrite: 0,
            cost: { total: 0 },
          },
        },
      }),
      state,
    );

    assert.equal(zeroCost.length, 1);
    assert.equal(zeroCost[0]?.reportedCostUsd, null);
    assert.equal(zeroCost[0]?.totals.cachedInputTokens, 19328);

    const compaction = ompUsageFormat.parseLine(
      JSON.stringify({
        type: "compaction",
        id: "cmp-1",
        timestamp: "2026-11-23T18:55:00.000Z",
        usage: { input: 500, output: 120, cost: { total: 0.002 } },
      }),
      state,
    );
    assert.equal(compaction.length, 1);
    assert.equal(compaction[0]?.model, "Tools/summaries");
    assert.equal(compaction[0]?.reportedCostUsd, 0.002);
  });
});

describe("ompUsageReader directories", () => {
  const testLayer = Layer.mergeAll(
    NodeServices.layer,
    Layer.succeed(HostProcess.HomeDirectory, "/home/tester"),
    Layer.succeed(HostProcess.Platform, "darwin"),
  );

  it.effect("resolves default ~/.omp/agent/sessions and env overrides without leaking Pi dir", () =>
    Effect.gen(function* () {
      const pathService = yield* Path.Path;
      assert.equal(
        resolveOmpSessionsDir({}, "/home/tester", pathService),
        pathService.resolve("/home/tester/.omp/agent/sessions"),
      );
      assert.equal(
        resolveOmpSessionsDir(
          { OMP_CODING_AGENT_DIR: "~/custom-omp" },
          "/home/tester",
          pathService,
        ),
        pathService.resolve("/home/tester/custom-omp/sessions"),
      );
      assert.equal(
        resolveOmpSessionsDir({ PI_CODING_AGENT_DIR: "~/pi-only" }, "/home/tester", pathService),
        pathService.resolve("/home/tester/.omp/agent/sessions"),
      );
      assert.equal(
        resolveOmpSessionsDir(
          { OMP_CODING_AGENT_SESSION_DIR: "/var/omp/sessions" },
          "/home/tester",
          pathService,
        ),
        pathService.resolve("/var/omp/sessions"),
      );
    }).pipe(Effect.provide(testLayer)),
  );

  it.effect("includes --session-dir from launchArgs alongside default sessions directory", () =>
    Effect.gen(function* () {
      if (ompUsageReader.kind !== "transcripts") {
        return assert.fail("expected transcripts reader");
      }
      const pathService = yield* Path.Path;
      const dirs = yield* ompUsageReader.directories(
        {
          instanceId: ProviderInstanceId.make("omp"),
          configured: true,
          config: {
            enabled: true,
            binaryPath: "omp",
            launchArgs: "--thinking high --session-dir /custom/omp-sessions",
            customModels: [],
          },
          environment: { HOME: "/home/tester" },
        },
        { awaitRefresh: false },
      );
      assert.deepEqual(dirs, [
        { dir: pathService.resolve("/custom/omp-sessions") },
        { dir: pathService.resolve("/home/tester/.omp/agent/sessions") },
      ]);
    }).pipe(Effect.provide(testLayer)),
  );
});
