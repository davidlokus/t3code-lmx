// Drives the Pi adapter through omp's dialect against frames recorded from `omp --mode rpc` 18.20.2.
import { assert, describe, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  NodeId,
  ProviderInstanceId,
  ProviderSessionId,
  ProviderTurnId,
  RunAttemptId,
  RunId,
  ThreadId,
  type ModelSelection,
  type OrchestrationV2AppThread,
  type OrchestrationV2ProviderThread,
  type OrchestrationV2ProviderTurn,
  type RuntimeMode,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as FileSystem from "effect/FileSystem";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as ProviderHost from "@t3tools/provider-core/server/ProviderHost";
import * as ProviderContinuationRequests from "@t3tools/provider-core/server/ProviderContinuationRequests";
import type { PiDiscoveredCommands } from "@t3tools/provider-pi/server/commands";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as TestProviderHost from "@t3tools/provider-testing/TestProviderHost";

import { OmpAdapterV2Driver } from "./adapter.ts";
import { OMP_PROVIDER } from "./dialect.ts";
import { type FakeOmp, makeFakeOmp } from "./fakeOmp.testkit.ts";

const layerTest = Layer.mergeAll(
  NodeServices.layer,
  IdAllocator.layer,
  McpProviderSessions.layer,
  TestProviderHost.layer().pipe(Layer.provide(NodeServices.layer)),
);

const INSTANCE_ID = ProviderInstanceId.make("omp");
const THREAD_ID = ThreadId.make("thread-omp-test");
const SESSION_ID = ProviderSessionId.make("provider-session-omp-test");

const modelSelection = (model = "default"): ModelSelection => ({ instanceId: INSTANCE_ID, model });

const runtimePolicy = (runtimeMode: RuntimeMode) =>
  ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
    runtimeMode,
    interactionMode: "default",
    cwd: null,
  });

const openRuntime = Effect.fnUntraced(function* (
  fake: FakeOmp,
  runtimeMode: RuntimeMode,
  forkFake?: FakeOmp,
  initialNativeThreadId?: string,
  onCommands?: Parameters<typeof OmpAdapterV2Driver.create>[0]["onCommands"],
) {
  const spawner =
    forkFake === undefined
      ? fake.spawner
      : ChildProcessSpawner.make((command) =>
          ChildProcess.isStandardCommand(command) && command.args.includes("--fork")
            ? forkFake.spawner.spawn(command)
            : fake.spawner.spawn(command),
        );
  const adapter = yield* OmpAdapterV2Driver.create({
    instanceId: INSTANCE_ID,
    displayName: undefined,
    enabled: true,
    environment: [
      { name: "OPENAI_API_KEY", value: "instance-test-key", sensitive: true },
      { name: "PI_CODING_AGENT_DIR", value: "/fake/isolated", sensitive: false },
    ],
    config: { enabled: true, binaryPath: "omp", launchArgs: "--no-lsp", customModels: [] },
    onCommands,
  }).pipe(
    Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
    Effect.provideService(HostProcess.Environment, {
      HOME: "/fake",
      https_proxy: "http://localhost:8080",
      OPENAI_API_KEY: "ambient-test-key",
      ANTHROPIC_API_KEY: "unconfigured-test-key",
      OMP_PROFILE: "ambient-profile",
    }),
    Effect.provideService(ProviderContinuationRequests.ProviderContinuationRequests, {
      offer: () => Effect.void,
      take: Effect.never,
    } as never),
  );
  const runtime = yield* adapter.openSession({
    threadId: THREAD_ID,
    providerSessionId: SESSION_ID,
    modelSelection: modelSelection(),
    runtimePolicy: runtimePolicy(runtimeMode),
    ...(initialNativeThreadId === undefined ? {} : { initialNativeThreadId }),
  });
  const emitted = yield* Queue.unbounded<ProviderAdapter.ProviderAdapterV2Event>();
  yield* runtime.events.pipe(
    Stream.runForEach((event) => Queue.offer(emitted, event)),
    Effect.forkScoped,
  );
  const takeEvent = (predicate: (event: ProviderAdapter.ProviderAdapterV2Event) => boolean) =>
    Effect.gen(function* () {
      while (true) {
        const event = yield* Queue.take(emitted);
        if (predicate(event)) return event;
      }
    });
  const providerThread = yield* runtime.ensureThread({
    threadId: THREAD_ID,
    modelSelection: modelSelection(),
    runtimePolicy: runtimePolicy(runtimeMode),
  });
  return { runtime, takeEvent, providerThread };
});

const startTurn = Effect.fnUntraced(function* (
  runtime: ProviderAdapter.ProviderAdapterV2SessionRuntime,
  providerThread: OrchestrationV2ProviderThread,
  runtimeMode: RuntimeMode,
) {
  const now = yield* DateTime.now;
  const appThread = {
    createdBy: "user",
    creationSource: "web",
    id: THREAD_ID,
    projectId: "project:fixture:omp" as OrchestrationV2AppThread["projectId"],
    title: "omp test thread",
    providerInstanceId: INSTANCE_ID,
    modelSelection: modelSelection(),
    runtimeMode,
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    activeProviderThreadId: null,
    lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: THREAD_ID },
    forkedFrom: null,
    createdAt: now,
    updatedAt: now,
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    lastVisitedAt: null,
    deletedAt: null,
  } satisfies OrchestrationV2AppThread;
  const runId = RunId.make(`run:${THREAD_ID}:1`);
  yield* runtime.startTurn({
    appThread,
    threadId: THREAD_ID,
    runId,
    runOrdinal: 1,
    providerTurnOrdinal: 1,
    attemptId: RunAttemptId.make(`run-attempt:${runId}:1`),
    rootNodeId: NodeId.make(`node:${runId}:root`),
    providerThread,
    message: {
      messageId: `message:${THREAD_ID}:1` as never,
      text: "Reply with exactly the single word: pong",
      attachments: [],
      createdBy: "user",
      creationSource: "web",
    },
    modelSelection: modelSelection(),
    runtimePolicy: runtimePolicy(runtimeMode),
  });
});

const assistantMessage = (text: string, extra: Record<string, unknown> = {}) => ({
  role: "assistant",
  content: [{ type: "text", text }],
  api: "openai-completions",
  provider: "magpie",
  model: "auto/deepseek-v4.1-flash",
  usage: { input: 9418, output: 3, cacheRead: 128, cacheWrite: 0, totalTokens: 9549 },
  stopReason: "stop",
  ...extra,
});

/** The frames omp wrote for "Reply with exactly the single word: pong", message bodies trimmed. */
const pongTurn = (finalMessage = assistantMessage("pong")) => [
  { type: "thinking_level_changed", thinkingLevel: "low", configured: "auto", resolved: "low" },
  { type: "agent_start" },
  { type: "turn_start" },
  { type: "message_start", message: { role: "user" }, messageId: "msg-1" },
  { type: "message_end", message: { role: "user" }, messageId: "msg-1" },
  { type: "message_start", message: assistantMessage(""), messageId: "msg-2" },
  {
    type: "message_update",
    assistantMessageEvent: { type: "text_start", contentIndex: 0 },
    messageId: "msg-2",
  },
  {
    type: "message_update",
    assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "p" },
    messageId: "msg-2",
  },
  {
    type: "message_update",
    assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "ong" },
    messageId: "msg-2",
  },
  {
    type: "message_update",
    assistantMessageEvent: { type: "text_end", contentIndex: 0, content: "pong" },
    messageId: "msg-2",
  },
  { type: "message_end", message: finalMessage, messageId: "msg-2" },
  { type: "turn_end", message: finalMessage },
];

const agentEnd = (finalMessage = assistantMessage("pong")) => [
  { type: "agent_end", messages: [finalMessage], yielded: true, isTerminal: true },
  {
    type: "prompt_result",
    id: "t3-prompt-0",
    agentInvoked: true,
    status: "completed",
    sessionSettled: true,
  },
  { type: "session_settled" },
];

describe("OmpAdapterV2", () => {
  it.effect("runs a turn through omp's RPC dialect and settles when the agent yields", () =>
    Effect.gen(function* () {
      const fake = yield* makeFakeOmp();
      const { runtime, takeEvent, providerThread } = yield* openRuntime(fake, "full-access");
      assert.equal(providerThread.driver, OMP_PROVIDER);
      assert.equal(
        providerThread.nativeThreadRef?.nativeId,
        "/fake/.omp/agent/sessions/--workspace--/session-1.jsonl",
      );
      // T3's runtime mode and an ordinary launch argument both reach omp; the Pi extension does not.
      assert.deepEqual(fake.lastSpawnArgs(), [
        "--mode",
        "rpc",
        "--no-lsp",
        "--approval-mode",
        "yolo",
      ]);
      const env = fake.lastSpawnEnv();
      assert.include(env, {
        HOME: "/fake",
        https_proxy: "http://localhost:8080",
        OPENAI_API_KEY: "instance-test-key",
        PI_CODING_AGENT_DIR: "/fake/isolated",
      });
      assert.notProperty(env, "ANTHROPIC_API_KEY");
      assert.notProperty(env, "OMP_PROFILE");

      yield* startTurn(runtime, providerThread, "full-access");
      const prompt = yield* fake.takeRequest("prompt");
      assert.equal(prompt["message"], "Reply with exactly the single word: pong");
      assert.isFalse(fake.allRequests().some((request) => request["type"] === "set_model"));
      for (const frame of [...pongTurn(), ...agentEnd()]) yield* fake.emit(frame);

      const answer = yield* takeEvent(
        (event) =>
          event.type === "turn_item.updated" &&
          event.turnItem.type === "assistant_message" &&
          !event.turnItem.streaming,
      );
      if (answer.type !== "turn_item.updated" || answer.turnItem.type !== "assistant_message") {
        return assert.fail("expected the assistant message");
      }
      assert.equal(answer.turnItem.text, "pong");
      assert.equal(answer.driver, OMP_PROVIDER);

      const completed = yield* takeEvent(
        (event) =>
          event.type === "provider_turn.updated" && event.providerTurn.status === "completed",
      );
      assert.equal(completed.driver, OMP_PROVIDER);
      // Session stats supply context size; the assistant message supplies the input breakdown.
      if (completed.type !== "provider_turn.updated") return assert.fail("expected a turn");
      assert.include(completed.providerTurn.tokenUsage, {
        usedTokens: 8460,
        maxTokens: 1048576,
        inputTokens: 9418 + 128,
        outputTokens: 3,
        cachedInputTokens: 128,
      });
    }).pipe(Effect.scoped, Effect.provide(layerTest)),
  );

  it.effect("reads and updates the command catalog of an authorized session without a prompt", () =>
    Effect.gen(function* () {
      const fake = yield* makeFakeOmp({
        get_available_commands: { commands: [{ name: "inspect", source: "file" }] },
      });
      const observed = yield* Queue.unbounded<PiDiscoveredCommands>();
      yield* openRuntime(fake, "full-access", undefined, undefined, (_cwd, catalog) =>
        Queue.offer(observed, catalog).pipe(Effect.asVoid),
      );
      assert.deepEqual((yield* Queue.take(observed)).slashCommands, [{ name: "inspect" }]);
      yield* fake.emit({
        type: "available_commands_update",
        commands: [{ name: "skill:workspace", source: "skill" }],
      });
      assert.deepEqual(
        (yield* Queue.take(observed)).skills.map((skill) => skill.name),
        ["workspace"],
      );
      assert.isFalse(fake.allRequests().some((request) => request["type"] === "prompt"));
    }).pipe(Effect.scoped, Effect.provide(layerTest)),
  );

  it.effect("streams thinking and text as growing items that start at their first delta", () =>
    Effect.gen(function* () {
      const fake = yield* makeFakeOmp();
      const { runtime, takeEvent, providerThread } = yield* openRuntime(fake, "full-access");
      yield* startTurn(runtime, providerThread, "full-access");
      yield* fake.takeRequest("prompt");
      const origin = DateTime.toEpochMillis(yield* DateTime.now);
      const seen: Array<{
        readonly type: string;
        readonly text: string;
        readonly streaming: boolean;
        readonly startedAt: number;
        readonly completedAt: number | null;
      }> = [];
      // takeEvent discards what it skips, so every event passes through here to be recorded.
      const record = (event: ProviderAdapter.ProviderAdapterV2Event) => {
        if (event.type !== "turn_item.updated") return;
        const item = event.turnItem;
        if (item.type !== "assistant_message" && item.type !== "reasoning") return;
        seen.push({
          type: item.type,
          text: item.text,
          streaming: item.streaming,
          startedAt:
            item.startedAt === null ? Number.NaN : DateTime.toEpochMillis(item.startedAt) - origin,
          completedAt:
            item.completedAt === null ? null : DateTime.toEpochMillis(item.completedAt) - origin,
        });
      };
      // Frames are handled in order, so a dialog raised after a frame proves the frame was handled.
      let barriers = 0;
      const handled = Effect.gen(function* () {
        barriers += 1;
        yield* fake.emit({
          type: "extension_ui_request",
          id: `barrier-${barriers}`,
          method: "confirm",
          title: "Barrier",
        });
        yield* takeEvent((event) => {
          record(event);
          return (
            event.type === "runtime_request.updated" &&
            event.runtimeRequest.nativeRequestRef?.nativeId === `barrier-${barriers}`
          );
        });
      });
      const update = (assistantMessageEvent: Record<string, unknown>) =>
        fake.emit({ type: "message_update", assistantMessageEvent, messageId: "msg-2" });
      const later = (millis: number) => TestClock.adjust(Duration.millis(millis));

      yield* fake.emit({ type: "agent_start" });
      yield* fake.emit({
        type: "message_start",
        message: assistantMessage(""),
        messageId: "msg-2",
      });
      yield* handled;
      // omp took 300 ms to produce its first thinking token; the items must not start before it.
      yield* later(300);
      yield* update({ type: "thinking_start", contentIndex: 0 });
      yield* update({ type: "thinking_delta", contentIndex: 0, delta: "Let me " });
      yield* handled;
      yield* later(100);
      yield* update({ type: "thinking_delta", contentIndex: 0, delta: "think." });
      yield* handled;
      yield* later(100);
      yield* update({ type: "thinking_end", contentIndex: 0, content: "Let me think." });
      yield* handled;
      yield* later(200);
      yield* update({ type: "text_start", contentIndex: 1 });
      yield* update({ type: "text_delta", contentIndex: 1, delta: "The sea" });
      yield* handled;
      yield* later(100);
      yield* update({ type: "text_delta", contentIndex: 1, delta: " is salty." });
      yield* handled;
      yield* later(100);
      yield* update({ type: "text_end", contentIndex: 1, content: "The sea is salty." });
      const final = assistantMessage("The sea is salty.");
      for (const frame of [
        { type: "message_end", message: final, messageId: "msg-2" },
        { type: "turn_end", message: final },
        ...agentEnd(final),
      ])
        yield* fake.emit(frame);

      yield* takeEvent((event) => {
        record(event);
        return event.type === "provider_turn.updated" && event.providerTurn.status === "completed";
      });
      assert.deepEqual(seen, [
        { type: "reasoning", text: "Let me ", streaming: true, startedAt: 300, completedAt: null },
        {
          type: "reasoning",
          text: "Let me think.",
          streaming: true,
          startedAt: 300,
          completedAt: null,
        },
        {
          type: "reasoning",
          text: "Let me think.",
          streaming: false,
          startedAt: 300,
          completedAt: 500,
        },
        {
          type: "assistant_message",
          text: "The sea",
          streaming: true,
          startedAt: 700,
          completedAt: null,
        },
        {
          type: "assistant_message",
          text: "The sea is salty.",
          streaming: true,
          startedAt: 700,
          completedAt: null,
        },
        {
          type: "assistant_message",
          text: "The sea is salty.",
          streaming: false,
          startedAt: 700,
          completedAt: 900,
        },
      ]);
    }).pipe(Effect.scoped, Effect.provide(layerTest)),
  );

  it.effect("fails the turn when omp reports a provider error", () =>
    Effect.gen(function* () {
      const fake = yield* makeFakeOmp();
      const { runtime, takeEvent, providerThread } = yield* openRuntime(fake, "full-access");
      yield* startTurn(runtime, providerThread, "full-access");
      yield* fake.takeRequest("prompt");
      const failed = assistantMessage("", {
        stopReason: "error",
        errorMessage: "429 rate limited",
      });
      for (const frame of [...pongTurn(failed), ...agentEnd(failed)]) yield* fake.emit(frame);
      const turn = yield* takeEvent(
        (event) =>
          event.type === "provider_turn.updated" &&
          (event.providerTurn.status === "failed" || event.providerTurn.status === "completed"),
      );
      assert.equal(turn.type === "provider_turn.updated" && turn.providerTurn.status, "failed");
      if (turn.type !== "provider_turn.updated") return assert.fail("expected a turn");
      assert.isUndefined(turn.providerTurn.tokenUsage?.inputTokens);
    }).pipe(Effect.scoped, Effect.provide(layerTest)),
  );

  it.effect(
    "raises omp's approval prompt as an approval request and answers it in omp's words",
    () =>
      Effect.gen(function* () {
        const fake = yield* makeFakeOmp();
        const { runtime, takeEvent, providerThread } = yield* openRuntime(
          fake,
          "approval-required",
        );
        assert.deepEqual(fake.lastSpawnArgs().slice(-2), ["--approval-mode", "always-ask"]);
        yield* startTurn(runtime, providerThread, "approval-required");
        yield* fake.takeRequest("prompt");
        yield* fake.emit({ type: "agent_start" });
        yield* fake.emit({
          type: "tool_execution_start",
          toolCallId: "call_00_QFTnixzA3jRuMNkEApNy2299",
          toolName: "bash",
          args: { command: "echo omp-probe" },
          intent: "Running echo probe",
        });
        yield* fake.emit({
          type: "extension_ui_request",
          id: "15cfcc57317e7bcc",
          method: "select",
          title: "Allow tool: bash\nCommand: echo omp-probe",
          options: ["Approve", "Approve bash for this session", "Deny"],
        });

        const pending = yield* takeEvent(
          (event) =>
            event.type === "runtime_request.updated" && event.runtimeRequest.status === "pending",
        );
        if (pending.type !== "runtime_request.updated") return assert.fail("expected a request");
        assert.equal(pending.runtimeRequest.nativeRequestRef?.nativeId, "15cfcc57317e7bcc");
        assert.equal(pending.runtimeRequest.kind, "command");

        yield* runtime.respondToRuntimeRequest({
          requestId: pending.runtimeRequest.id,
          decision: "accept",
        });
        const answered = yield* fake.takeRequest("extension_ui_response");
        assert.deepEqual(answered, {
          type: "extension_ui_response",
          id: "15cfcc57317e7bcc",
          value: "Approve",
        });

        yield* fake.emit({
          type: "extension_ui_request",
          id: "second",
          method: "select",
          title: "Allow tool: bash\nCommand: rm -rf build",
          options: ["Approve", "Approve bash for this session", "Deny"],
        });
        const second = yield* takeEvent(
          (event) =>
            event.type === "runtime_request.updated" && event.runtimeRequest.status === "pending",
        );
        if (second.type !== "runtime_request.updated") return assert.fail("expected a request");
        yield* runtime.respondToRuntimeRequest({
          requestId: second.runtimeRequest.id,
          decision: "decline",
        });
        assert.equal((yield* fake.takeRequest("extension_ui_response"))["value"], "Deny");
      }).pipe(Effect.scoped, Effect.provide(layerTest)),
  );

  const approvalPrompt = (id: string, options: ReadonlyArray<string>, command = "ls") => ({
    type: "extension_ui_request",
    id,
    method: "select",
    title: `Allow tool: bash\nCommand: ${command}`,
    options,
  });

  const pendingApproval = (
    takeEvent: (
      predicate: (event: ProviderAdapter.ProviderAdapterV2Event) => boolean,
    ) => Effect.Effect<ProviderAdapter.ProviderAdapterV2Event>,
  ) =>
    Effect.gen(function* () {
      const event = yield* takeEvent(
        (candidate) =>
          candidate.type === "runtime_request.updated" &&
          candidate.runtimeRequest.status === "pending",
      );
      if (event.type !== "runtime_request.updated") return assert.fail("expected a request");
      return event.runtimeRequest.id;
    });

  it.effect("sends omp's own session choice, whatever order omp lists its choices in", () =>
    Effect.gen(function* () {
      const fake = yield* makeFakeOmp();
      const { runtime, takeEvent, providerThread } = yield* openRuntime(fake, "approval-required");
      yield* startTurn(runtime, providerThread, "approval-required");
      yield* fake.takeRequest("prompt");
      yield* fake.emit({ type: "agent_start" });
      yield* fake.emit(approvalPrompt("a1", ["Deny", "Approve bash for this session", "Approve"]));
      yield* runtime.respondToRuntimeRequest({
        requestId: yield* pendingApproval(takeEvent),
        decision: "acceptForSession",
      });
      assert.equal(
        (yield* fake.takeRequest("extension_ui_response"))["value"],
        "Approve bash for this session",
      );
      yield* fake.emit(
        approvalPrompt("a2", ["Deny", "Approve bash for this session", "Approve"], "pwd"),
      );
      yield* runtime.respondToRuntimeRequest({
        requestId: yield* pendingApproval(takeEvent),
        decision: "accept",
      });
      assert.equal((yield* fake.takeRequest("extension_ui_response"))["value"], "Approve");
    }).pipe(Effect.scoped, Effect.provide(layerTest)),
  );

  it.effect("says so when a session approval can only be granted once", () =>
    Effect.gen(function* () {
      const fake = yield* makeFakeOmp();
      const { runtime, takeEvent, providerThread } = yield* openRuntime(fake, "approval-required");
      yield* startTurn(runtime, providerThread, "approval-required");
      yield* fake.takeRequest("prompt");
      yield* fake.emit({ type: "agent_start" });
      yield* fake.emit(approvalPrompt("n1", ["Approve", "Deny"]));
      yield* runtime.respondToRuntimeRequest({
        requestId: yield* pendingApproval(takeEvent),
        decision: "acceptForSession",
      });
      assert.equal((yield* fake.takeRequest("extension_ui_response"))["value"], "Approve");
      const notice = yield* takeEvent(
        (event) => event.type === "turn_item.updated" && event.turnItem.type === "system_notice",
      );
      if (notice.type !== "turn_item.updated" || notice.turnItem.type !== "system_notice") {
        return assert.fail("expected a notice");
      }
      assert.equal(
        notice.turnItem.message,
        "omp did not offer a session-wide approval, so this request was approved once only.",
      );
      assert.equal(notice.turnItem.level, "warning");
    }).pipe(Effect.scoped, Effect.provide(layerTest)),
  );

  it.effect("denies an approval prompt it cannot read instead of guessing a choice", () =>
    Effect.gen(function* () {
      const fake = yield* makeFakeOmp();
      const { runtime, takeEvent, providerThread } = yield* openRuntime(fake, "approval-required");
      yield* startTurn(runtime, providerThread, "approval-required");
      yield* fake.takeRequest("prompt");
      yield* fake.emit({ type: "agent_start" });
      yield* fake.emit(approvalPrompt("u1", ["Yes", "No"]));
      assert.deepEqual(yield* fake.takeRequest("extension_ui_response"), {
        type: "extension_ui_response",
        id: "u1",
        cancelled: true,
      });
      const notice = yield* takeEvent(
        (event) => event.type === "turn_item.updated" && event.turnItem.type === "system_notice",
      );
      assert.include(JSON.stringify(notice), "does not recognise");
      assert.isUndefined(
        fake
          .allRequests()
          .find(
            (request) =>
              request["type"] === "extension_ui_response" && request["value"] !== undefined,
          ),
      );
    }).pipe(Effect.scoped, Effect.provide(layerTest)),
  );

  it.effect("completes a compaction omp skipped as a no-op instead of failing it", () =>
    Effect.gen(function* () {
      const fake = yield* makeFakeOmp();
      const { runtime, takeEvent, providerThread } = yield* openRuntime(fake, "full-access");
      yield* startTurn(runtime, providerThread, "full-access");
      yield* fake.takeRequest("prompt");
      yield* fake.emit({ type: "agent_start" });
      yield* fake.emit({ type: "manual_compaction_start" });
      yield* fake.emit({
        type: "manual_compaction_end",
        aborted: false,
        skipped: true,
        errorMessage: "Nothing to compact",
      });
      const done = yield* takeEvent(
        (event) =>
          event.type === "turn_item.updated" &&
          event.turnItem.type === "compaction" &&
          event.turnItem.status !== "running",
      );
      if (done.type !== "turn_item.updated" || done.turnItem.type !== "compaction") {
        return assert.fail("expected a compaction");
      }
      assert.equal(done.turnItem.status, "completed");
      assert.equal(done.turnItem.summary, "Nothing to compact");
    }).pipe(Effect.scoped, Effect.provide(layerTest)),
  );

  it.effect(
    "forks a thread through omp's own --fork and its RPC fork, not Pi's session format",
    () =>
      Effect.gen(function* () {
        const host = yield* ProviderHost.ProviderHost;
        const fileSystem = yield* FileSystem.FileSystem;
        const dir = yield* fileSystem.makeTempDirectoryScoped();
        const forkFile = `${dir}/forked.jsonl`;
        yield* fileSystem.writeFileString(
          forkFile,
          `${JSON.stringify({ type: "session", version: 3, id: "fork", cwd: host.paths.cwd })}\n`,
        );
        const fake = yield* makeFakeOmp();
        const forkFake = yield* makeFakeOmp({ get_state: { sessionFile: forkFile } });
        const { runtime, providerThread: source } = yield* openRuntime(
          fake,
          "full-access",
          forkFake,
        );
        const turn = (ordinal: number): OrchestrationV2ProviderTurn => ({
          id: ProviderTurnId.make(`turn-${ordinal}`),
          providerThreadId: source.id,
          nodeId: NodeId.make(`node-${ordinal}`),
          runAttemptId: null,
          nativeTurnRef: { driver: OMP_PROVIDER, nativeId: `u${ordinal}`, strength: "strong" },
          ordinal,
          status: "completed",
          startedAt: null,
          completedAt: null,
        });
        const forked = yield* runtime.forkThread({
          sourceProviderThread: source,
          sourceProviderTurns: [turn(1), turn(2)],
          providerTurnId: turn(1).id,
          targetThreadId: ThreadId.make("fork-target"),
        });
        assert.equal(forked.driver, OMP_PROVIDER);
        // The live session adopts the forked file; the fake process keeps reporting its own file.
        assert.equal(
          fake.allRequests().findLast((request) => request["type"] === "switch_session")?.[
            "sessionPath"
          ],
          forkFile,
        );
        const args = forkFake.lastSpawnArgs();
        assert.equal(args[args.indexOf("--fork") + 1], source.nativeThreadRef?.nativeId);
        assert.deepEqual(args.slice(0, 2), ["--mode", "rpc"]);
        assert.notInclude(args, "--no-session");
        // omp's own `fork` keeps the entry it is given and Pi's drops it; only `branch` cuts before it.
        const forks = (process: typeof fake) =>
          process
            .allRequests()
            .filter((request) => request["type"] === "branch" || request["type"] === "fork")
            .map((request) => [request["type"], request["entryId"]]);
        assert.deepEqual(forks(forkFake), [["branch", "u2"]]);
        assert.deepEqual(forks(fake), []);
      }).pipe(Effect.scoped, Effect.provide(layerTest)),
  );

  it.effect("forks a session whose cwd is on omp's second header line into the runtime cwd", () =>
    Effect.gen(function* () {
      const host = yield* ProviderHost.ProviderHost;
      const fileSystem = yield* FileSystem.FileSystem;
      const forkFile = "/fake/.omp/agent/sessions/--worktree--/forked.jsonl";
      const fake = yield* makeFakeOmp();
      const forkFake = yield* makeFakeOmp({ get_state: { sessionFile: forkFile } });
      const { runtime, providerThread } = yield* openRuntime(fake, "full-access", forkFake);
      const dir = yield* fileSystem.makeTempDirectoryScoped();
      // omp's first line is a title record; the session record, which names the cwd, follows it.
      const sessionAt = (name: string, sessionCwd: string | undefined) =>
        Effect.gen(function* () {
          const file = `${dir}/${name}.jsonl`;
          const session = { type: "session", version: 3, id: "s", cwd: sessionCwd };
          yield* fileSystem.writeFileString(
            file,
            `${JSON.stringify({ type: "title", v: 1, title: "" })}\n${JSON.stringify(session)}\n{}\n`,
          );
          return {
            ...providerThread,
            nativeThreadRef: { driver: OMP_PROVIDER, nativeId: file, strength: "strong" as const },
          };
        });
      const lastSwitch = () =>
        fake.allRequests().findLast((request) => request["type"] === "switch_session")?.[
          "sessionPath"
        ];
      const forkSpawnedFrom = (file: string | undefined) => {
        const args = forkFake.lastSpawnArgs();
        return args[args.indexOf("--fork") + 1] === file;
      };

      const sameCwd = yield* sessionAt("same", host.paths.cwd);
      yield* runtime.resumeThread({ providerThread: sameCwd });
      assert.equal(lastSwitch(), sameCwd.nativeThreadRef?.nativeId);
      assert.deepEqual(forkFake.lastSpawnArgs(), []);

      // A first line past the read limit hides the session record, so the cwd is unknown.
      const oversize = `${dir}/oversize.jsonl`;
      yield* fileSystem.writeFileString(
        oversize,
        `${JSON.stringify({ type: "title", v: 1, title: "", pad: "x".repeat(200_000) })}\n${JSON.stringify({ type: "session", version: 3, id: "s", cwd: host.paths.cwd })}\n`,
      );
      const oversized = {
        ...sameCwd,
        nativeThreadRef: { driver: OMP_PROVIDER, nativeId: oversize, strength: "strong" as const },
      };
      yield* runtime.resumeThread({ providerThread: oversized });
      assert.isTrue(forkSpawnedFrom(oversize));
      assert.equal(lastSwitch(), forkFile);

      for (const [name, sessionCwd] of [
        ["other", `${host.paths.cwd}-original-checkout`],
        ["unknown", undefined],
      ] as const) {
        const thread = yield* sessionAt(name, sessionCwd);
        yield* runtime.resumeThread({ providerThread: thread });
        assert.isTrue(forkSpawnedFrom(thread.nativeThreadRef?.nativeId), name);
        assert.equal(lastSwitch(), forkFile, name);
      }

      // A cold start attaches a session recorded in this cwd and no other.
      for (const [name, thread] of [
        ["same", sameCwd],
        ["other", yield* sessionAt("cold-other", `${host.paths.cwd}-original-checkout`)],
      ] as const) {
        const coldFake = yield* makeFakeOmp();
        yield* openRuntime(coldFake, "full-access", undefined, thread.nativeThreadRef?.nativeId);
        const args = coldFake.lastSpawnArgs();
        assert.equal(
          args.includes("--resume") ? args[args.indexOf("--resume") + 1] : undefined,
          name === "same" ? thread.nativeThreadRef?.nativeId : undefined,
          name,
        );
      }
    }).pipe(Effect.scoped, Effect.provide(layerTest)),
  );

  it.effect("does not show extension status text, which clients label as Pi's", () =>
    Effect.gen(function* () {
      const fake = yield* makeFakeOmp();
      const { runtime, takeEvent } = yield* openRuntime(fake, "full-access");
      yield* fake.emit({
        type: "extension_ui_request",
        id: "s1",
        method: "setStatus",
        statusKey: "watch",
        statusText: "Watching 3 files",
      });
      // Frames are handled in order, so a dialog raised after the status proves it was handled.
      yield* fake.emit({
        type: "extension_ui_request",
        id: "barrier",
        method: "confirm",
        title: "Continue?",
      });
      yield* takeEvent(
        (event) =>
          event.type === "runtime_request.updated" && event.runtimeRequest.status === "pending",
      );
      assert.deepEqual(runtime.providerSession.extensionStatuses, []);
    }).pipe(Effect.scoped, Effect.provide(layerTest)),
  );

  it.effect("stops a turn by withdrawing queued input and aborting", () =>
    Effect.gen(function* () {
      const fake = yield* makeFakeOmp();
      const { runtime, takeEvent, providerThread } = yield* openRuntime(fake, "full-access");
      yield* startTurn(runtime, providerThread, "full-access");
      yield* fake.takeRequest("prompt");
      yield* fake.emit({ type: "agent_start" });
      const started = yield* takeEvent(
        (event) =>
          event.type === "provider_turn.updated" && event.providerTurn.status === "running",
      );
      if (started.type !== "provider_turn.updated") return assert.fail("expected a running turn");
      yield* runtime.interruptTurn({ providerThread, providerTurnId: started.providerTurn.id });
      yield* fake.takeRequest("abort_and_restore_queue");
      yield* fake.takeRequest("abort");
    }).pipe(Effect.scoped, Effect.provide(layerTest)),
  );
});
