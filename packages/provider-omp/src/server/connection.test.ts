// @effect-diagnostics globalFetch:off - The MCP client under test uses the global fetch, so the test stubs it.
import { assert, describe, it, vi } from "@effect/vitest";
import { EnvironmentId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import type { McpProviderSessionConfig } from "@t3tools/provider-core/server/mcpSession";
import type { PiRpcRecord } from "@t3tools/provider-pi/server/rpc";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Logger from "effect/Logger";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import { makeOmpRpcConnection } from "./connection.ts";
import { makeFakeOmp } from "./fakeOmp.testkit.ts";

const mcpSession: McpProviderSessionConfig = {
  endpoint: "http://t3.test/mcp",
  authorizationHeader: "Bearer session-token",
  environmentId: EnvironmentId.make("environment"),
  threadId: ThreadId.make("thread"),
  providerSessionId: "provider-session",
  providerInstanceId: ProviderInstanceId.make("omp"),
  browserToolsAvailable: false,
};

const TOOLS = [
  {
    name: "delegate_task",
    description: "Start a delegated task",
    inputSchema: { type: "object", properties: { task: { type: "string" } } },
  },
  { name: "t3_thread_list" },
];

const stubMcpServer = (callTool?: (signal: AbortSignal | null | undefined) => Promise<unknown>) => {
  const calls: Array<{
    readonly method: string;
    readonly params: unknown;
    readonly auth: string | null;
    readonly sessionId: string | null;
  }> = [];
  const spy = vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => {
    const body = JSON.parse(String(init?.body)) as {
      method: string;
      id?: number;
      params?: { cursor?: string };
    };
    const headers = new Headers(init?.headers);
    calls.push({
      method: body.method,
      params: body.params,
      auth: headers.get("authorization"),
      sessionId: headers.get("mcp-session-id"),
    });
    if (body.id === undefined) return new Response(null, { status: 202 });
    const result =
      body.method === "tools/list"
        ? body.params?.cursor === "page-2"
          ? { tools: [TOOLS[1]] }
          : { tools: [TOOLS[0]], nextCursor: "page-2" }
        : body.method === "tools/call"
          ? callTool === undefined
            ? { content: [{ type: "text", text: "task started" }] }
            : await callTool(init?.signal)
          : {};
    const payload = JSON.stringify({ jsonrpc: "2.0", id: body.id, result });
    if (body.method === "initialize") {
      return new Response(payload, {
        headers: { "content-type": "application/json", "mcp-session-id": "mcp-session" },
      });
    }
    return new Response(
      `data: {"jsonrpc":"2.0","method":"notifications/message"}\n\ndata: ${payload}\n\n`,
      { headers: { "content-type": "text/event-stream" } },
    );
  });
  return { calls, restore: () => spy.mockRestore() };
};

const decodeRecord = Schema.decodeSync(
  Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown)),
);

const controlledStartup = Effect.gen(function* () {
  const stdout = yield* Queue.unbounded<Uint8Array>();
  const stdin = yield* Queue.unbounded<PiRpcRecord>();
  const spawner = ChildProcessSpawner.make(() =>
    Effect.succeed(
      ChildProcessSpawner.makeHandle({
        pid: ChildProcessSpawner.ProcessId(999_999_999),
        exitCode: Effect.never,
        isRunning: Effect.succeed(true),
        kill: () => Effect.void,
        unref: Effect.succeed(Effect.void),
        stdin: Sink.forEach((chunk: Uint8Array) =>
          Queue.offer(stdin, decodeRecord(new TextDecoder().decode(chunk))),
        ),
        stdout: Stream.fromQueue(stdout),
        stderr: Stream.empty,
        all: Stream.empty,
        getInputFd: () => Sink.drain,
        getOutputFd: () => Stream.empty,
      }),
    ),
  );
  const connection = yield* makeOmpRpcConnection({
    command: "omp",
    args: ["--mode", "rpc"],
    cwd: undefined,
    env: {},
  }).pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner));
  return {
    connection,
    stdin,
    emit: (frame: PiRpcRecord) =>
      Queue.offer(stdout, new TextEncoder().encode(`${JSON.stringify(frame)}\n`)),
  };
});

describe("omp connection", () => {
  it.effect("registers T3's MCP tools with omp and runs the calls omp hands back", () =>
    Effect.gen(function* () {
      const mcp = stubMcpServer();
      yield* Effect.addFinalizer(() => Effect.sync(mcp.restore));
      const fake = yield* makeFakeOmp();
      const connection = yield* makeOmpRpcConnection({
        command: "omp",
        args: [],
        cwd: undefined,
        env: {},
        mcpSession,
      }).pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, fake.spawner));

      yield* connection.request({ type: "prompt", message: "Continue" });
      const registration = yield* fake.takeRequest("set_host_tools");
      assert.deepEqual(
        (registration["tools"] as Array<{ name: string; loadMode: string }>).map((tool) => [
          tool.name,
          tool.loadMode,
        ]),
        [
          ["mcp__t3-code__delegate_task", "essential"],
          ["mcp__t3-code__t3_thread_list", "discoverable"],
        ],
      );
      assert.isTrue(mcp.calls.every((call) => call.auth === "Bearer session-token"));
      assert.deepEqual(
        mcp.calls.map(({ method, sessionId }) => [method, sessionId]),
        [
          ["initialize", null],
          ["notifications/initialized", "mcp-session"],
          ["tools/list", "mcp-session"],
          ["tools/list", "mcp-session"],
        ],
      );
      assert.deepEqual(mcp.calls[3]?.params, { cursor: "page-2" });
      const types = fake.allRequests().map((request) => request["type"]);
      assert.deepEqual(types.slice(-1), ["prompt"]);
      assert.sameMembers(types.slice(0, -1), [
        "set_host_tools",
        "set_subagent_subscription",
        "set_ask_dialog",
      ]);
      assert.include(
        fake.allRequests().find((request) => request["type"] === "set_subagent_subscription"),
        { level: "progress" },
      );
      assert.include(
        fake.allRequests().find((request) => request["type"] === "set_ask_dialog"),
        { enabled: true },
      );

      yield* fake.emit({
        type: "host_tool_call",
        id: "host_1",
        toolCallId: "toolu_1",
        toolName: "mcp__t3-code__delegate_task",
        arguments: { task: "write the docs" },
      });
      const result = yield* fake.takeRequest("host_tool_result");
      assert.deepEqual(result, {
        type: "host_tool_result",
        id: "host_1",
        result: { content: [{ type: "text", text: "task started" }] },
      });
      assert.deepEqual(mcp.calls.at(-1)?.params, {
        name: "delegate_task",
        arguments: { task: "write the docs" },
      });

      // Host tool frames never reach the adapter; ordinary frames still do.
      yield* fake.emit({ type: "agent_start" });
      const forwarded = yield* Queue.take(connection.events);
      assert.equal(forwarded["type"], "agent_start");
    }).pipe(Effect.scoped),
  );

  it.effect("rejects a host tool call that is not one of T3's, and reports MCP failures", () =>
    Effect.gen(function* () {
      const mcp = stubMcpServer(() => Promise.reject(new Error("private transport detail")));
      yield* Effect.addFinalizer(() => Effect.sync(mcp.restore));
      const fake = yield* makeFakeOmp();
      const connection = yield* makeOmpRpcConnection({
        command: "omp",
        args: [],
        cwd: undefined,
        env: {},
        mcpSession,
      }).pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, fake.spawner));
      yield* connection.request({ type: "prompt", message: "Continue" });
      yield* fake.takeRequest("set_host_tools");

      yield* fake.emit({
        type: "host_tool_call",
        id: "h1",
        toolName: "mcp__t3-code__not_registered",
        arguments: {},
      });
      const unknown = yield* fake.takeRequest("host_tool_result");
      assert.equal(unknown["isError"], true);

      assert.isFalse(mcp.calls.some((call) => call.method === "tools/call"));
      yield* fake.emit({
        type: "host_tool_call",
        id: "h2",
        toolName: "mcp__t3-code__t3_thread_list",
        arguments: {},
      });
      const failed = yield* fake.takeRequest("host_tool_result");
      assert.equal(failed["isError"], true);
      assert.include(JSON.stringify(failed["result"]), "t3_thread_list failed");
      assert.notInclude(JSON.stringify(failed["result"]), "private transport detail");
    }).pipe(Effect.scoped),
  );

  it.effect("starts without T3's tools when the MCP server is unreachable", () =>
    Effect.gen(function* () {
      const spy = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("connection refused"));
      yield* Effect.addFinalizer(() => Effect.sync(() => spy.mockRestore()));
      const fake = yield* makeFakeOmp();
      const connection = yield* makeOmpRpcConnection({
        command: "omp",
        args: [],
        cwd: undefined,
        env: {},
        mcpSession,
      }).pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, fake.spawner));
      // The prompt is held until registration settles, then goes through without tools.
      yield* connection.send({ type: "prompt", id: "p1", message: "hello" });
      const prompt = yield* fake.takeRequest("prompt");
      assert.equal(prompt["message"], "hello");
      assert.isUndefined(
        fake.allRequests().find((request) => request["type"] === "set_host_tools"),
      );
    }).pipe(Effect.scoped),
  );

  it.effect("interrupts the matching MCP request when OMP cancels a host tool call", () =>
    Effect.gen(function* () {
      const started = Promise.withResolvers<void>();
      const aborted = Promise.withResolvers<void>();
      const mcp = stubMcpServer((signal) => {
        const call = Promise.withResolvers<unknown>();
        signal?.addEventListener(
          "abort",
          () => {
            aborted.resolve();
            call.reject(signal.reason);
          },
          { once: true },
        );
        started.resolve();
        return call.promise;
      });
      yield* Effect.addFinalizer(() => Effect.sync(mcp.restore));
      const fake = yield* makeFakeOmp();
      const connection = yield* makeOmpRpcConnection({
        command: "omp",
        args: [],
        cwd: undefined,
        env: {},
        mcpSession,
      }).pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, fake.spawner));
      yield* connection.request({ type: "prompt", message: "Continue" });
      yield* fake.emit({
        type: "host_tool_call",
        id: "h1",
        toolCallId: "c1",
        toolName: "mcp__t3-code__delegate_task",
        arguments: {},
      });
      yield* Effect.promise(() => started.promise);
      yield* fake.emit({ type: "host_tool_cancel", id: "cancel", targetId: "h1" });
      yield* Effect.promise(() => aborted.promise);
      yield* fake.emit({ type: "agent_start" });
      assert.equal((yield* Queue.take(connection.events))["type"], "agent_start");
      assert.isFalse(fake.allRequests().some((request) => request["type"] === "host_tool_result"));
    }).pipe(Effect.scoped),
  );

  it.effect("publishes native command changes on the live connection without invoking MCP", () =>
    Effect.gen(function* () {
      const fake = yield* makeFakeOmp();
      const commands = yield* Queue.unbounded<unknown>();
      const connection = yield* makeOmpRpcConnection({
        command: "omp",
        args: [],
        cwd: undefined,
        env: {},
        onCommands: (frame) => Queue.offer(commands, frame["commands"]).pipe(Effect.asVoid),
      }).pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, fake.spawner));
      const update = {
        type: "available_commands_update",
        commands: [{ name: "review-pr", source: "mcp_prompt" }],
      };
      yield* fake.emit(update);
      assert.deepEqual(yield* Queue.take(commands), update.commands);
      assert.deepEqual(yield* Queue.take(connection.events), update);
      assert.isFalse(fake.allRequests().some((request) => request["type"] === "set_host_tools"));
    }).pipe(Effect.scoped),
  );

  it.effect("waits for both feature requests, then proceeds after rejection and timeout", () => {
    const warnings: unknown[] = [];
    const capture = Logger.make<unknown, void>(({ logLevel, message }) => {
      if (logLevel === "Warn" && Array.isArray(message)) warnings.push(message[1]);
    });
    return Effect.gen(function* () {
      const { connection, emit, stdin } = yield* controlledStartup;
      yield* emit({ type: "ready" });
      const setup = [yield* Queue.take(stdin), yield* Queue.take(stdin)];
      const ask = setup.find((request) => request["type"] === "set_ask_dialog");
      assert.isDefined(ask);
      assert.sameMembers(
        setup.map((request) => request["type"]),
        ["set_subagent_subscription", "set_ask_dialog"],
      );
      yield* emit({
        type: "response",
        id: ask?.["id"],
        command: "set_ask_dialog",
        success: false,
        error: "Unknown command",
      });

      const sent = yield* Deferred.make<void>();
      yield* connection
        .send({ type: "prompt", message: "Continue" })
        .pipe(Effect.andThen(Deferred.succeed(sent, undefined)), Effect.forkScoped);
      yield* TestClock.adjust("1 second");
      assert.isFalse(yield* Deferred.isDone(sent));
      yield* TestClock.adjust("5 seconds");
      yield* Deferred.await(sent);
      assert.deepEqual(yield* Queue.take(stdin), { type: "prompt", message: "Continue" });
      assert.sameDeepMembers(warnings, [
        { command: "set_ask_dialog", errorKind: "PiRpcError" },
        { command: "set_subagent_subscription", errorKind: "PiRpcTimeoutError" },
      ]);
      yield* emit({ type: "ready" });
      yield* emit({ type: "agent_start" });
      yield* Queue.take(connection.events);
      yield* connection.send({ type: "prompt", message: "Next turn" });
      assert.deepEqual(yield* Queue.take(stdin), { type: "prompt", message: "Next turn" });
    }).pipe(Effect.scoped, Effect.provide(Logger.layer([capture], { mergeWithExisting: false })));
  });

  it.effect("forwards a legacy prompt without waiting for ready", () =>
    Effect.gen(function* () {
      const { connection, emit, stdin } = yield* controlledStartup;
      const prompt = yield* connection
        .request({ type: "prompt", message: "Hello" })
        .pipe(Effect.forkScoped);
      const request = yield* Queue.take(stdin);
      assert.include(request, { type: "prompt", message: "Hello" });
      yield* emit({
        type: "response",
        id: request["id"],
        command: "prompt",
        success: true,
        data: { agentInvoked: true },
      });
      assert.deepEqual(yield* Fiber.join(prompt), { agentInvoked: true });
    }).pipe(Effect.scoped),
  );
});
