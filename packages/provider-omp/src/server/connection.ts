import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Queue from "effect/Queue";

import type { PiDialectConnectOptions } from "@t3tools/provider-pi/server/dialect";
import {
  makePiRpcConnection,
  piRecordField as recordField,
  piRecordString as recordString,
  type PiRpcConnection,
  type PiRpcError,
  type PiRpcRecord,
} from "@t3tools/provider-pi/server/rpc";

import { ompHostToolDefinitions, ompHostToolResult, ompMcpToolName } from "./hostTools.ts";
import { makeOmpMcpClient, OmpMcpError } from "./mcpClient.ts";
import { makeOmpTranslator, translateOmpResponseData } from "./protocol.ts";

const HOST_TOOL_SETUP_TIMEOUT = Duration.seconds(10);

export const makeOmpRpcConnection = Effect.fn("OmpRpc.connect")(function* (
  options: PiDialectConnectOptions & {
    readonly onCommands?: (frame: PiRpcRecord) => Effect.Effect<void>;
  },
) {
  const { mcpSession, onCommands } = options;
  const raw = yield* makePiRpcConnection(options);
  const scope = yield* Effect.scope;
  const translator = makeOmpTranslator();
  const events = yield* Queue.unbounded<PiRpcRecord, PiRpcError>();
  const hostToolsReady = yield* Deferred.make<void>();
  const hostCalls = new Map<string, Fiber.Fiber<void>>();
  let registeredTools: ReadonlySet<string> | undefined;
  let registrationStarted = false;
  const mcp =
    mcpSession === undefined
      ? undefined
      : makeOmpMcpClient(mcpSession.endpoint, mcpSession.authorizationHeader);

  // Without T3's tools the session is still usable, so a failure here only logs.
  const registerHostTools = Effect.fn("OmpRpc.registerHostTools")(
    function* () {
      if (mcp === undefined) return;
      const tools = yield* Effect.tryPromise({
        try: async (signal) => {
          await mcp.connect(signal);
          return mcp.listTools(signal);
        },
        catch: (cause) => new OmpMcpError({ operation: "tools/list", cause }),
      });
      yield* raw.request({ type: "set_host_tools", tools: ompHostToolDefinitions(tools) });
      registeredTools = new Set(tools.map((tool) => tool.name));
    },
    Effect.timeout(HOST_TOOL_SETUP_TIMEOUT),
    Effect.catch((cause) => {
      registeredTools = undefined;
      return Effect.logWarning("omp could not load T3's MCP tools.", { cause });
    }),
    Effect.ensuring(Deferred.succeed(hostToolsReady, undefined)),
  );

  const answerHostToolCall = Effect.fn("OmpRpc.hostToolCall")(function* (frame: PiRpcRecord) {
    const id = recordString(frame, "id");
    const toolName = recordString(frame, "toolName") ?? "";
    const mcpName = ompMcpToolName(toolName);
    if (id === undefined) return;
    if (mcp === undefined || mcpName === undefined || !registeredTools?.has(mcpName)) {
      yield* raw.send({
        type: "host_tool_result",
        id,
        isError: true,
        result: { content: [{ type: "text", text: "Unknown host tool." }] },
      });
      return;
    }
    const args = recordField(frame, "arguments");
    if (typeof args !== "object" || args === null || Array.isArray(args)) {
      yield* raw.send({
        type: "host_tool_result",
        id,
        isError: true,
        result: { content: [{ type: "text", text: "Host tool arguments must be an object." }] },
      });
      return;
    }
    const reply = yield* Effect.tryPromise({
      try: (signal) => mcp.callTool(mcpName, args as Record<string, unknown>, signal),
      catch: (cause) => new OmpMcpError({ operation: "tools/call", cause }),
    }).pipe(
      Effect.map((result) => ompHostToolResult(mcpName, result)),
      Effect.orElseSucceed(() => ({
        result: {
          content: [{ type: "text" as const, text: `MCP tool t3-code/${mcpName} failed.` }],
        },
        isError: true as const,
      })),
    );
    yield* raw.send({ type: "host_tool_result", id, ...reply });
  });

  // All streaming frames pass through the connection's existing span.
  const route = Effect.fnUntraced(function* (frame: PiRpcRecord) {
    switch (frame["type"]) {
      case "ready":
        if (mcp !== undefined && !registrationStarted) {
          registrationStarted = true;
          yield* registerHostTools().pipe(Effect.forkIn(scope));
        }
        return;
      case "host_tool_call": {
        const id = recordString(frame, "id");
        if (id === undefined || hostCalls.has(id)) return;
        const fiber = yield* answerHostToolCall(frame).pipe(
          Effect.ensuring(Effect.sync(() => hostCalls.delete(id))),
          Effect.ignore,
          Effect.forkIn(scope, { startImmediately: false }),
        );
        hostCalls.set(id, fiber);
        return;
      }
      case "host_tool_cancel": {
        const target = recordString(frame, "targetId");
        const fiber = target === undefined ? undefined : hostCalls.get(target);
        if (fiber !== undefined) yield* Fiber.interrupt(fiber);
        return;
      }
      default: {
        if (frame["type"] === "available_commands_update" && onCommands !== undefined) {
          yield* onCommands(frame);
        }
        const translation = translator.fromOmp(frame);
        for (const reply of translation.replies) yield* raw.send(reply);
        for (const translated of translation.frames) yield* Queue.offer(events, translated);
      }
    }
  });

  yield* Effect.gen(function* () {
    while (true) yield* route(yield* Queue.take(raw.events));
  }).pipe(
    Effect.catchCause((cause) =>
      Queue.failCause(events, cause).pipe(
        Effect.andThen(Deferred.succeed(hostToolsReady, undefined)),
      ),
    ),
    Effect.forkIn(scope),
  );

  // A prompt must not outrun the tool registration; a runtime that never sent `ready` cannot hang it.
  const afterHostTools = (record: PiRpcRecord) =>
    record["type"] === "prompt" && mcp !== undefined
      ? Deferred.await(hostToolsReady).pipe(
          Effect.timeoutOption(Duration.seconds(12)),
          Effect.asVoid,
        )
      : Effect.void;

  // Notices the translator raised while translating a command go to the adapter like omp's own.
  const publishNotices = Effect.suspend(() =>
    Effect.forEach(translator.takeNotices(), (notice) => Queue.offer(events, notice), {
      discard: true,
    }),
  );

  return {
    send: (record) =>
      afterHostTools(record).pipe(
        Effect.andThen(
          Effect.suspend(() => {
            const translated = translator.toOmp(record);
            return publishNotices.pipe(Effect.andThen(raw.send(translated)));
          }),
        ),
      ),
    request: (record, timeoutMs?: number) =>
      afterHostTools(record).pipe(
        Effect.andThen(Effect.suspend(() => raw.request(translator.toOmp(record), timeoutMs))),
        Effect.map((data) => translateOmpResponseData(String(record["type"]), data)),
      ),
    events,
    exited: raw.exited,
    terminate: raw.terminate,
  } satisfies PiRpcConnection;
});
