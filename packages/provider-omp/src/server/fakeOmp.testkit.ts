// A scripted omp RPC process. Responses reuse data recorded from `omp --mode rpc` 18.20.2.
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import type { PiRpcRecord } from "@t3tools/provider-pi/server/rpc";

const decodeJsonLine = Schema.decodeSync(Schema.fromJsonString(Schema.Unknown));
const encodeJsonLine = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

/** Deliberately outside the valid pid range so a group-kill can never land. */
const FAKE_PID = 999_999_999;

const FAKE_OMP_SESSION_FILE = "/fake/.omp/agent/sessions/--workspace--/session-1.jsonl";

const OMP_READY_FRAME = {
  type: "ready",
  protocolVersion: 1,
  supportedProtocolVersions: [1, 2],
  maxFrameBytes: 1048576,
  maxReassembledFrameBytes: 67108864,
  supportsBashExcludeFromContext: true,
};

const MODEL = {
  id: "auto/deepseek-v4.1-flash",
  name: "DeepSeek V4.1 Flash · routing group",
  api: "openai-completions",
  provider: "magpie",
  reasoning: true,
  thinking: { mode: "effort", efforts: ["low", "high", "max"] },
  input: ["text", "image"],
  contextWindow: 1048576,
  maxTokens: 384000,
};

const OMP_IDLE_STATE = {
  model: MODEL,
  thinkingLevel: "high",
  isStreaming: false,
  isCompacting: false,
  steeringMode: "one-at-a-time",
  followUpMode: "one-at-a-time",
  interruptMode: "immediate",
  sessionFile: FAKE_OMP_SESSION_FILE,
  sessionId: "01a1e1fb-10bd-71fd-9ffa-6334d5e437f4",
  autoCompactionEnabled: true,
  queuedMessageCount: 0,
  hasPendingAsyncWork: false,
  isSettled: true,
  queuedMessages: { steering: [], followUp: [] },
  messageCount: 0,
  contextUsage: { tokens: 8460, contextWindow: 1048576, percent: 0.8068084716796875 },
};

export interface FakeOmp {
  readonly spawner: ChildProcessSpawner.ChildProcessSpawner["Service"];
  /** Writes a frame to omp's stdout. */
  readonly emit: (frame: PiRpcRecord) => Effect.Effect<void>;
  readonly takeRequest: (type: string) => Effect.Effect<PiRpcRecord>;
  readonly allRequests: () => ReadonlyArray<PiRpcRecord>;
  readonly lastSpawnArgs: () => ReadonlyArray<string>;
  readonly lastSpawnEnv: () => ChildProcess.StandardCommand["options"]["env"];
}

/** `answers` override the recorded response data for a command. */
export const makeFakeOmp = (answers: Readonly<Record<string, unknown>> = {}) =>
  Effect.gen(function* () {
    const stdout = yield* Queue.unbounded<Uint8Array, Cause.Done>();
    const requests = yield* Queue.unbounded<PiRpcRecord>();
    const all: Array<PiRpcRecord> = [];
    let stdinBuffer = "";
    let spawnArgs: ReadonlyArray<string> = [];
    let spawnEnv: ChildProcess.StandardCommand["options"]["env"];

    const emit = (frame: PiRpcRecord) =>
      Queue.offer(stdout, new TextEncoder().encode(`${encodeJsonLine(frame)}\n`)).pipe(
        Effect.asVoid,
      );

    const dataFor = (record: PiRpcRecord): unknown => {
      const type = String(record["type"]);
      if (type in answers) return answers[type];
      switch (type) {
        case "get_state":
          return OMP_IDLE_STATE;
        case "get_available_models":
          return { models: [MODEL] };
        case "get_entries":
          return {
            entries: [
              {
                type: "model_change",
                id: "a6368bab",
                parentId: null,
                timestamp: "2026-11-16T01:31:30.181Z",
                model: "magpie/auto/deepseek-v4.1-flash",
              },
            ],
            leafId: "a6368bab",
          };
        case "get_messages":
          return { messages: [] };
        case "get_session_stats":
          return {
            sessionFile: FAKE_OMP_SESSION_FILE,
            tokens: {
              input: 9418,
              output: 3,
              reasoning: 0,
              cacheRead: 128,
              cacheWrite: 0,
              total: 9549,
            },
            contextUsage: OMP_IDLE_STATE.contextUsage,
          };
        case "new_session":
        case "switch_session":
        case "fork":
          return { cancelled: false };
        case "abort_and_restore_queue":
          return { steering: [], followUp: [] };
        default:
          return undefined;
      }
    };

    const handleStdinChunk = (chunk: Uint8Array) =>
      Effect.gen(function* () {
        stdinBuffer += new TextDecoder().decode(chunk);
        while (true) {
          const newline = stdinBuffer.indexOf("\n");
          if (newline === -1) return;
          const line = stdinBuffer.slice(0, newline);
          stdinBuffer = stdinBuffer.slice(newline + 1);
          if (line.length === 0) continue;
          const record = decodeJsonLine(line) as PiRpcRecord;
          all.push(record);
          yield* Queue.offer(requests, record);
          // Only commands are answered; UI and host-tool replies carry an id but have no response.
          if (
            typeof record["id"] !== "string" ||
            ["extension_ui_response", "host_tool_result", "host_tool_update"].includes(
              String(record["type"]),
            )
          )
            continue;
          const data = dataFor(record);
          yield* emit({
            type: "response",
            id: record["id"],
            command: String(record["type"]),
            success: true,
            ...(data === undefined ? {} : { data }),
          });
        }
      });

    const spawner = ChildProcessSpawner.make((command) =>
      Effect.gen(function* () {
        if (ChildProcess.isStandardCommand(command)) {
          spawnArgs = command.args.map(String);
          spawnEnv = command.options.env;
        }
        yield* emit(OMP_READY_FRAME);
        return ChildProcessSpawner.makeHandle({
          pid: ChildProcessSpawner.ProcessId(FAKE_PID),
          exitCode: Effect.never,
          isRunning: Effect.succeed(true),
          kill: () => Effect.void,
          unref: Effect.succeed(Effect.void),
          stdin: Sink.forEach(handleStdinChunk),
          stdout: Stream.fromQueue(stdout),
          stderr: Stream.empty,
          all: Stream.empty,
          getInputFd: () => Sink.drain,
          getOutputFd: () => Stream.empty,
        });
      }),
    );

    return {
      spawner,
      emit,
      takeRequest: (type: string) =>
        Effect.gen(function* () {
          while (true) {
            const record = yield* Queue.take(requests);
            if (record["type"] === type) return record;
          }
        }),
      allRequests: () => all,
      lastSpawnArgs: () => spawnArgs,
      lastSpawnEnv: () => spawnEnv,
    } satisfies FakeOmp;
  });
