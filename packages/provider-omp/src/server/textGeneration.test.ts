import { assert, it } from "@effect/vitest";
import { ProviderInstanceId } from "@t3tools/contracts";
import { createModelSelection } from "@t3tools/shared/model";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Path from "effect/Path";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as TestClock from "effect/testing/TestClock";

import { OmpSettings, type OmpSettings as Settings } from "../settings.ts";
import { makeOmpTextGeneration } from "./textGeneration.ts";

const decodeSettings = Schema.decodeUnknownSync(OmpSettings);
const decodeRequest = Schema.decodeUnknownSync(
  Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown)),
);
const model = { provider: "fixture/openai", id: "small/1" };
const modelSlug = `${model.provider}/${model.id}`;
const reply = JSON.stringify({ subject: "Update release notes", body: "Document changes." });
const secret = "secret-from-upstream";

const makeHarness = Effect.fnUntraced(function* (
  fixture: {
    readonly config?: Partial<Settings>;
    readonly setModelError?: string;
    readonly thinkingError?: string;
    readonly turnError?: string;
    readonly hang?: boolean;
    readonly reply?: string;
  } = {},
) {
  const frames = yield* Queue.unbounded<string>();
  const promptReceived = yield* Deferred.make<void>();
  const closed = yield* Ref.make(false);
  const requests: Array<Record<string, unknown>> = [];
  let launch: ChildProcess.StandardCommand | undefined;
  const emit = (frame: Record<string, unknown>) =>
    Queue.offer(frames, `${JSON.stringify(frame)}\n`);
  const stdin = Sink.forEach((chunk: Uint8Array) =>
    Effect.gen(function* () {
      const request = decodeRequest(new TextDecoder().decode(chunk));
      requests.push(request);
      const command = request["type"];
      const error =
        command === "set_model"
          ? fixture.setModelError
          : command === "set_thinking_level"
            ? fixture.thinkingError
            : undefined;
      const data =
        command === "get_available_models"
          ? { models: [model] }
          : command === "get_last_assistant_text"
            ? { text: fixture.reply ?? reply }
            : undefined;
      yield* emit({
        type: "response",
        id: request["id"],
        command,
        success: error === undefined,
        error,
        data,
      });
      if (command !== "prompt") return;
      yield* Deferred.succeed(promptReceived, undefined);
      if (fixture.hang) return;
      if (fixture.turnError !== undefined) {
        yield* emit({
          type: "message_end",
          message: { role: "assistant", stopReason: "error", errorMessage: fixture.turnError },
        });
      }
      yield* emit({ type: "agent_end", yielded: true, messages: [] });
    }),
  );
  const spawner = ChildProcessSpawner.make((command) =>
    Effect.acquireRelease(
      Effect.sync(() => {
        if (!ChildProcess.isStandardCommand(command)) throw new Error("Expected a native launch");
        launch = command;
        return ChildProcessSpawner.makeHandle({
          // Outside the OS pid range: shared RPC teardown must not signal a test process.
          pid: ChildProcessSpawner.ProcessId(999_999_999),
          exitCode: Effect.never,
          isRunning: Effect.succeed(true),
          kill: () => Effect.void,
          unref: Effect.succeed(Effect.void),
          stdin,
          stdout: Stream.encodeText(Stream.fromQueue(frames)),
          stderr: Stream.empty,
          all: Stream.empty,
          getInputFd: () => Sink.drain,
          getOutputFd: () => Stream.empty,
        });
      }),
      () => Ref.set(closed, true),
    ),
  );
  const generation = yield* makeOmpTextGeneration(decodeSettings(fixture.config ?? {}), {
    HOME: "/fixture-home",
  }).pipe(
    Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
    Effect.provide(Path.layer),
  );
  const generate = (slug = "default", thinking?: string) =>
    generation.generateCommitMessage({
      cwd: "/fixture-workspace",
      branch: "main",
      stagedSummary: "M CHANGELOG.md",
      stagedPatch: "Release notes change",
      modelSelection: createModelSelection(
        ProviderInstanceId.make("omp"),
        slug,
        thinking === undefined ? [] : [{ id: "thinking", value: thinking }],
      ),
    });
  return { generate, requests, promptReceived, closed, launch: () => launch };
});

it.effect("uses the configured Smol model and auto thinking in a tool-free ephemeral process", () =>
  Effect.gen(function* () {
    const omp = yield* makeHarness({
      config: {
        profile: "work",
        smolModel: modelSlug,
        advisor: true,
        launchArgs:
          "--config /safe/overlay.yml --extension /bad/ext.ts --tools bash --add-dir /other",
      },
    });
    assert.deepEqual(yield* omp.generate("default", "auto"), {
      subject: "Update release notes",
      body: "Document changes.",
    });
    assert.deepEqual(omp.launch()?.args, [
      "--mode",
      "rpc",
      "--no-session",
      "--config",
      "/safe/overlay.yml",
      "--profile",
      "work",
      "--no-extensions",
      "--no-tools",
      "--no-title",
      "--no-lsp",
      "--no-skills",
      "--no-rules",
      "--no-context-files",
    ]);
    assert.include(omp.requests[1], {
      type: "set_model",
      provider: model.provider,
      modelId: model.id,
    });
    assert.include(omp.requests[2], { type: "set_thinking_level", level: "auto" });
    assert.isTrue(yield* Ref.get(omp.closed));
  }),
);

it.effect("falls back to the default when the Smol model or configured thinking is rejected", () =>
  Effect.gen(function* () {
    const omp = yield* makeHarness({
      config: { agentDir: "~/alt", smolModel: modelSlug },
      setModelError: "Model no longer available",
      thinkingError: "Unsupported thinking level",
    });
    assert.equal((yield* omp.generate("default", "auto")).subject, "Update release notes");
    assert.equal(omp.launch()?.options.env?.PI_CODING_AGENT_DIR, "/fixture-home/alt");
    assert.deepEqual(
      omp.requests.map((request) => request["type"]),
      [
        "get_available_models",
        "set_model",
        "set_thinking_level",
        "prompt",
        "get_last_assistant_text",
      ],
    );
  }),
);

it.effect(
  "never silently falls back from an explicitly selected model or exposes its RPC error body",
  () =>
    Effect.gen(function* () {
      const omp = yield* makeHarness({
        config: { smolModel: "demo/another-model" },
        setModelError: `HTTP 401: ${secret}`,
      });
      const error = yield* omp.generate(modelSlug).pipe(Effect.flip);
      assert.include(error.detail, "HTTP 401");
      assert.notInclude(error.message, secret);
      assert.isUndefined(error.cause);
      assert.include(omp.requests[1], {
        type: "set_model",
        provider: model.provider,
        modelId: model.id,
      });
      assert.isFalse(omp.requests.some((request) => request["type"] === "prompt"));
      assert.isTrue(yield* Ref.get(omp.closed));
    }),
);

it.effect("redacts the assistant's upstream response even when a JSON reply exists", () =>
  Effect.gen(function* () {
    const omp = yield* makeHarness({ turnError: `429: {"key":"${secret}"}` });
    const error = yield* omp.generate().pipe(Effect.flip);
    assert.include(error.detail, "HTTP 429");
    assert.notInclude(error.message, secret);
    assert.isUndefined(error.cause);
    assert.isFalse(omp.requests.some((request) => request["type"] === "get_last_assistant_text"));
    assert.isTrue(yield* Ref.get(omp.closed));
  }),
);

it.effect("does not expose malformed provider output through a decode failure", () =>
  Effect.gen(function* () {
    const omp = yield* makeHarness({ reply: `{"subject": ["${secret}"], "body": ""}` });
    const error = yield* omp.generate().pipe(Effect.flip);
    assert.include(error.detail, "invalid structured output");
    assert.notInclude(error.message, secret);
    assert.isUndefined(error.cause);
  }),
);

it.effect("releases the process on timeout while waiting for the settled turn", () =>
  Effect.gen(function* () {
    const omp = yield* makeHarness({ hang: true });
    const generation = yield* omp.generate().pipe(Effect.flip, Effect.forkScoped);
    yield* Deferred.await(omp.promptReceived);
    yield* TestClock.adjust("3 minutes");
    const error = yield* Fiber.join(generation);
    assert.include(error.detail, "timed out");
    assert.isTrue(yield* Ref.get(omp.closed));
  }),
);
