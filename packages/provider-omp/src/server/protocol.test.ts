// Fixtures use the omp 18.20.2 RPC transcripts and 19.2.1 budget frame shapes.
import { describe, expect, it } from "@effect/vitest";
import { parsePiDiscoveredCommands } from "@t3tools/provider-pi/server/commands";

import {
  makeOmpTranslator,
  type OmpTranslator,
  projectOmpCommands,
  readOmpSessionCwd,
  translateOmpResponseData,
} from "./protocol.ts";

const approvalRequest = {
  type: "extension_ui_request",
  id: "15cfcc57317e7bcc",
  method: "select",
  title: "Allow tool: bash\nCommand: echo omp-probe",
  options: ["Approve", "Approve bash for this session", "Deny"],
};

const agentEnd = (extra: Record<string, unknown> = {}, stopReason = "stop") => ({
  type: "agent_end",
  messages: [
    { role: "user", content: [{ type: "text", text: "hi" }] },
    { role: "assistant", content: [{ type: "text", text: "pong" }], stopReason },
  ],
  ...extra,
});

const outbound = (translator: OmpTranslator, ...frames: ReadonlyArray<Record<string, unknown>>) =>
  frames.flatMap((frame) => translator.fromOmp(frame).frames);

const costCapResult = {
  type: "prompt_result",
  id: "p1",
  agentInvoked: false,
  status: "error",
  error: { code: "cost_cap", message: "Cost cap reached.", retryable: false },
  sessionSettled: true,
};

describe("omp outbound frames", () => {
  it("drops frames Pi has no equivalent for", () => {
    const translator = makeOmpTranslator();
    expect(
      outbound(
        translator,
        {
          type: "ready",
          protocolVersion: 1,
          supportedProtocolVersions: [1, 2],
          maxFrameBytes: 1048576,
        },
        { type: "prompt_result", id: "p1", agentInvoked: true, status: "completed" },
        { ...costCapResult, error: { ...costCapResult.error, code: "other" } },
        { type: "session_settled" },
      ),
    ).toEqual([]);
  });

  it("surfaces nonblank OMP notices as Pi notifications", () => {
    const translator = makeOmpTranslator();
    expect(
      outbound(
        translator,
        { type: "notice", level: "warning", message: "Cost warning: $2.50", source: "cost_gate" },
        { type: "notice", level: "error", message: "  " },
        { type: "notice", level: "other", message: " Information " },
      ),
    ).toEqual([
      {
        type: "extension_ui_request",
        id: "omp:notice:1",
        method: "notify",
        notifyType: "warning",
        message: "Cost warning: $2.50",
      },
      {
        type: "extension_ui_request",
        id: "omp:notice:2",
        method: "notify",
        notifyType: "info",
        message: "Information",
      },
    ]);
  });

  it("does not repeat a cost-cap error notice in the prompt result or clear it on an unsettled end", () => {
    const translator = makeOmpTranslator();
    expect(
      outbound(
        translator,
        { type: "notice", level: "error", message: " Cost cap reached. ", source: "cost_gate" },
        agentEnd({ yielded: false }),
        costCapResult,
      ).filter((frame) => frame["type"] === "extension_ui_request"),
    ).toEqual([
      {
        type: "extension_ui_request",
        id: "omp:notice:1",
        method: "notify",
        notifyType: "error",
        message: "Cost cap reached.",
      },
    ]);
  });

  it.each([{ type: "agent_start" }, agentEnd({ yielded: true }), { type: "session_settled" }])(
    "surfaces a standalone cost-cap failure again after $type",
    (boundary) => {
      const translator = makeOmpTranslator();
      const result = { ...costCapResult, error: { ...costCapResult.error, message: "  " } };
      const notification = {
        type: "extension_ui_request",
        id: "omp:cost-cap:1",
        method: "notify",
        notifyType: "error",
        message: "Session reached its configured cost cap (--max-cost).",
      };
      expect(outbound(translator, result, result)).toEqual([notification]);
      outbound(translator, boundary);
      expect(outbound(translator, result)).toEqual([{ ...notification, id: "omp:cost-cap:2" }]);
    },
  );

  it("settles when the agent yields, not when the whole session is done", () => {
    const translator = makeOmpTranslator();
    expect(outbound(translator, { type: "agent_start" }, agentEnd({ yielded: true }))).toEqual([
      { type: "agent_start" },
      expect.objectContaining({ type: "agent_end" }),
      { type: "agent_settled", aborted: false },
    ]);
  });

  it("does not settle while omp retries or compacts on its own", () => {
    const translator = makeOmpTranslator();
    expect(
      outbound(
        translator,
        { type: "agent_start" },
        agentEnd({ yielded: false, isTerminal: false }),
      ),
    ).toEqual([{ type: "agent_start" }, expect.objectContaining({ type: "agent_end" })]);
  });

  it("settles an old runtime's terminal end that carries no yielded field", () => {
    const translator = makeOmpTranslator();
    expect(outbound(translator, agentEnd({ isTerminal: true })).map((f) => f["type"])).toEqual([
      "agent_end",
      "agent_settled",
    ]);
    expect(outbound(translator, agentEnd()).map((f) => f["type"])).toEqual(["agent_end"]);
  });

  it("reports an aborted settle from the last assistant message", () => {
    const translator = makeOmpTranslator();
    expect(outbound(translator, agentEnd({ yielded: true }, "aborted")).at(-1)).toEqual({
      type: "agent_settled",
      aborted: true,
    });
  });

  it("renames compaction events and normalizes their results", () => {
    const translator = makeOmpTranslator();
    expect(
      outbound(
        translator,
        { type: "manual_compaction_start" },
        {
          type: "manual_compaction_end",
          aborted: false,
          result: { summary: "kept", firstKeptEntryId: "e1", tokensBefore: 48210 },
        },
        { type: "auto_compaction_start", reason: "threshold", action: "context-full" },
        {
          type: "auto_compaction_end",
          reason: "threshold",
          action: "context-full",
          aborted: false,
          willRetry: true,
          result: { summary: "again", tokensBefore: 90000 },
        },
        {
          type: "manual_compaction_end",
          aborted: false,
          skipped: true,
          errorMessage: "Already compacted",
        },
        { type: "manual_compaction_end", aborted: true },
      ),
    ).toEqual([
      { type: "compaction_start", reason: "manual" },
      {
        type: "compaction_end",
        reason: "manual",
        aborted: false,
        willRetry: false,
        result: { summary: "kept", tokensBefore: 48210 },
      },
      { type: "compaction_start", reason: "threshold" },
      {
        type: "compaction_end",
        reason: "threshold",
        aborted: false,
        willRetry: true,
        result: { summary: "again", tokensBefore: 90000 },
      },
      // A skipped compaction is a normal no-op that carries omp's own explanation, not a failure.
      {
        type: "compaction_end",
        reason: "manual",
        aborted: false,
        willRetry: false,
        skipped: true,
        result: { summary: "Already compacted" },
      },
      { type: "compaction_end", reason: "manual", aborted: true, willRetry: false, result: null },
    ]);
  });

  it("presents an omp approval prompt as the confirm dialog the adapter expects", () => {
    const translator = makeOmpTranslator();
    expect(outbound(translator, approvalRequest)).toEqual([
      {
        type: "extension_ui_request",
        id: "15cfcc57317e7bcc",
        method: "confirm",
        title: "Allow bash?",
        message: "Command: echo omp-probe",
      },
    ]);
  });

  it("denies and reports an approval prompt whose choices it cannot tell apart", () => {
    const unreadable = [
      ["Yes", "No"],
      ["Approve", "Approve bash for this session"],
      ["Approve", "Approve", "Deny"],
      ["Deny", "Deny", "Approve"],
      // One unrecognised choice among readable ones is enough: the whole prompt is refused.
      ["Approve", "Approve bash for this session", "Deny", "Approve everything forever"],
      // A session choice for another tool is not this tool's session choice.
      ["Approve", "Approve edit for this session", "Deny"],
      ["Approve", "Approve bash and edit for this session", "Deny"],
      // Without "Approve Once", "Approve" may itself be a scoped grant, so it is not a safe choice.
      ["Approve", "Approve Directory: /repo", "Deny"],
      ["Approve", "Always Approve", "Deny"],
      ["Approve Once", "Deny"],
    ];
    for (const options of unreadable) {
      const translator = makeOmpTranslator();
      const result = translator.fromOmp({ ...approvalRequest, options });
      expect(result.replies).toEqual([
        { type: "extension_ui_response", id: "15cfcc57317e7bcc", cancelled: true },
      ]);
      expect(result.frames).toHaveLength(1);
      expect(result.frames[0]).toMatchObject({
        type: "extension_ui_request",
        method: "notify",
        notifyType: "error",
      });
      expect(String(result.frames[0]?.["message"])).toContain("bash");
    }
  });

  it("leaves other dialogs, such as the ask tool's questions, as they are", () => {
    const translator = makeOmpTranslator();
    const ask = {
      type: "extension_ui_request",
      id: "ui_2",
      method: "select",
      title: "Which database?",
      options: ["Postgres", "SQLite"],
    };
    expect(outbound(translator, ask)).toEqual([ask]);
  });

  it("passes ordinary session events through", () => {
    const translator = makeOmpTranslator();
    const events = [
      { type: "agent_start" },
      { type: "turn_start" },
      { type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "p" } },
      { type: "tool_execution_start", toolCallId: "c1", toolName: "bash", args: { command: "ls" } },
      { type: "auto_retry_start", attempt: 1, maxAttempts: 3, delayMs: 1000 },
    ];
    expect(outbound(translator, ...events)).toEqual(events);
  });

  it("projects nested counters unchanged and recovers usage only present at message end", () => {
    const translator = makeOmpTranslator();
    const usage = { input: 4, cacheRead: 3, cacheWrite: 2, output: 1, totalTokens: 10 };
    const message = { role: "assistant", usage, stopReason: "stop" };
    const update = {
      type: "message_update",
      message,
      assistantMessageEvent: { type: "text_delta", delta: "reply" },
    };
    const end = { type: "message_end", message };
    expect(outbound(translator, update, end)).toEqual([
      { ...update, usage },
      { type: "message_update", usage },
      end,
    ]);
    const failed = { ...end, message: { ...message, stopReason: "error" } };
    expect(outbound(translator, failed)).toEqual([failed]);
    const noUsage = { ...end, message: { role: "assistant", stopReason: "stop" } };
    expect(outbound(translator, noUsage)).toEqual([noUsage]);
  });
});

describe("omp prompt acknowledgements", () => {
  it("marks a prompt that finished locally as handled", () => {
    const translator = makeOmpTranslator();
    translator.toOmp({ type: "prompt", id: "p1", message: "/fast" });
    expect(
      outbound(translator, {
        id: "p1",
        type: "response",
        command: "prompt",
        success: true,
        data: { agentInvoked: false },
      }),
    ).toEqual([
      {
        id: "p1",
        type: "response",
        command: "prompt",
        success: true,
        data: { agentInvoked: false, disposition: "handled" },
      },
    ]);
  });

  it("marks a prompt sent while the agent is running as queued", () => {
    const translator = makeOmpTranslator();
    outbound(translator, { type: "agent_start" });
    translator.toOmp({
      type: "prompt",
      id: "p2",
      message: "also this",
      streamingBehavior: "steer",
    });
    expect(
      outbound(translator, { id: "p2", type: "response", command: "prompt", success: true }),
    ).toEqual([
      {
        id: "p2",
        type: "response",
        command: "prompt",
        success: true,
        data: { disposition: "queued" },
      },
    ]);
  });

  it("leaves the acknowledgement of a prompt that starts a turn alone", () => {
    const translator = makeOmpTranslator();
    translator.toOmp({ type: "prompt", id: "p3", message: "hello" });
    const ack = { id: "p3", type: "response", command: "prompt", success: true };
    expect(outbound(translator, ack)).toEqual([ack]);
  });

  it("forgets a prompt once the agent yielded before the next one", () => {
    const translator = makeOmpTranslator();
    outbound(translator, { type: "agent_start" }, agentEnd({ yielded: true }));
    translator.toOmp({ type: "prompt", id: "p4", message: "next", streamingBehavior: "steer" });
    const ack = { id: "p4", type: "response", command: "prompt", success: true };
    expect(outbound(translator, ack)).toEqual([ack]);
  });
});

describe("omp inbound commands", () => {
  it("answers an approval prompt with omp's own choice labels", () => {
    const translator = makeOmpTranslator();
    outbound(translator, approvalRequest);
    expect(
      translator.toOmp({ type: "extension_ui_response", id: "15cfcc57317e7bcc", confirmed: true }),
    ).toEqual({ type: "extension_ui_response", id: "15cfcc57317e7bcc", value: "Approve" });
    outbound(translator, { ...approvalRequest, id: "second" });
    expect(
      translator.toOmp({ type: "extension_ui_response", id: "second", confirmed: false }),
    ).toEqual({ type: "extension_ui_response", id: "second", value: "Deny" });
    outbound(translator, { ...approvalRequest, id: "third" });
    expect(
      translator.toOmp({ type: "extension_ui_response", id: "third", cancelled: true }),
    ).toEqual({ type: "extension_ui_response", id: "third", cancelled: true });
  });

  it("sends omp's own session choice when the user approves for the session", () => {
    const translator = makeOmpTranslator();
    outbound(translator, approvalRequest);
    expect(
      translator.toOmp({
        type: "extension_ui_response",
        id: "15cfcc57317e7bcc",
        confirmed: true,
        forSession: true,
      }),
    ).toEqual({
      type: "extension_ui_response",
      id: "15cfcc57317e7bcc",
      value: "Approve bash for this session",
    });
  });

  it("finds the choices by meaning, so their order and case do not matter", () => {
    const answer = (options: ReadonlyArray<string>, response: Record<string, unknown>) => {
      const translator = makeOmpTranslator();
      outbound(translator, { ...approvalRequest, options });
      return translator.toOmp({
        type: "extension_ui_response",
        id: "15cfcc57317e7bcc",
        ...response,
      })["value"];
    };
    const shuffled = ["Deny", "Approve bash for this session", "Approve"];
    expect(answer(shuffled, { confirmed: true })).toBe("Approve");
    expect(answer(shuffled, { confirmed: true, forSession: true })).toBe(
      "Approve bash for this session",
    );
    expect(answer(shuffled, { confirmed: false })).toBe("Deny");
    const loose = [" deny", "APPROVE  bash FOR this session", "approve "];
    expect(answer(loose, { confirmed: true })).toBe("approve ");
    expect(answer(loose, { confirmed: true, forSession: true })).toBe(
      "APPROVE  bash FOR this session",
    );
    expect(answer(loose, { confirmed: false })).toBe(" deny");
  });

  it("approves once with the plain choice when omp also offers scoped grants", () => {
    const translator = makeOmpTranslator();
    outbound(translator, {
      ...approvalRequest,
      options: [
        "Approve Once",
        "Approve Directory: /work",
        "Always Approve Directory: /work",
        "Approve",
        "Always Approve",
        "Approve bash for this session",
        "Deny",
      ],
    });
    expect(
      translator.toOmp({ type: "extension_ui_response", id: "15cfcc57317e7bcc", confirmed: true }),
    ).toMatchObject({ value: "Approve Once" });
  });

  it("refuses an approval-shaped select it cannot parse instead of forwarding it", () => {
    const refused = (frame: Record<string, unknown>) => {
      const result = makeOmpTranslator().fromOmp({
        type: "extension_ui_request",
        method: "select",
        ...frame,
      });
      expect(result.frames).toHaveLength(1);
      expect(result.frames[0]).toMatchObject({ method: "notify", notifyType: "error" });
      return result.replies;
    };
    const cancelled = [{ type: "extension_ui_response", id: "u1", cancelled: true }];
    const choices = ["Approve", "Deny"];
    expect(refused({ id: "u1", title: "Allow tool:\nCommand: x", options: choices })).toEqual(
      cancelled,
    );
    expect(refused({ id: "u1", title: "Allow tool bash", options: choices })).toEqual(cancelled);
    // A title that does not say so is still approval-shaped when its choices are.
    expect(refused({ id: "u1", title: "Run this?", options: choices })).toEqual(cancelled);
    expect(
      refused({ id: "u1", title: "Allow tool: bash", options: ["Approve", 5, "Deny"] }),
    ).toEqual(cancelled);
    expect(refused({ id: "u1", title: "Allow tool: bash" })).toEqual(cancelled);
    // Leading space, full-width letters, and a title that only mentions the tool further in do not
    // hide an approval, and neither do choices that are not omp's wording.
    const yesNo = ["Yes", "No"];
    expect(refused({ id: "u1", title: "  Allow tool: bash", options: yesNo })).toEqual(cancelled);
    expect(refused({ id: "u1", title: "\nAllow tool: bash", options: yesNo })).toEqual(cancelled);
    expect(refused({ id: "u1", title: "Ａｌｌｏｗ　ｔｏｏｌ: bash", options: yesNo })).toEqual(
      cancelled,
    );
    expect(refused({ id: "u1", title: "Please ALLOW   TOOL bash", options: yesNo })).toEqual(
      cancelled,
    );
    expect(refused({ id: "u1", title: "Run this?", options: ["Ａｐｐｒｏｖｅ", "No"] })).toEqual(
      cancelled,
    );
    // With no id there is nothing to answer, but the prompt must still not reach the adapter.
    expect(refused({ title: "Allow tool: bash", options: choices })).toEqual([]);
    expect(
      refused({ id: "u1", method: "confirm", title: "Allow tool: bash", options: choices }),
    ).toEqual(cancelled);
  });

  it("binds the session choice to a tool name that contains spaces", () => {
    const translator = makeOmpTranslator();
    outbound(translator, {
      ...approvalRequest,
      title: "Allow tool: my tool\nCommand: x",
      options: ["Approve", "Approve my tool for this session", "Deny"],
    });
    expect(
      translator.toOmp({
        type: "extension_ui_response",
        id: "15cfcc57317e7bcc",
        confirmed: true,
        forSession: true,
      }),
    ).toMatchObject({ value: "Approve my tool for this session" });
  });

  it("tells the user when a session approval can only be a single one", () => {
    const translator = makeOmpTranslator();
    outbound(translator, { ...approvalRequest, options: ["Approve", "Deny"] });
    translator.toOmp({
      type: "extension_ui_response",
      id: "15cfcc57317e7bcc",
      confirmed: true,
      forSession: true,
    });
    expect(translator.takeNotices()).toEqual([
      {
        type: "extension_ui_request",
        id: "15cfcc57317e7bcc:session-unavailable",
        method: "notify",
        notifyType: "warning",
        message:
          "omp did not offer a session-wide approval, so this request was approved once only.",
      },
    ]);
    expect(translator.takeNotices()).toEqual([]);

    // Nothing to report when the session choice exists, or when none was asked for.
    outbound(translator, approvalRequest);
    translator.toOmp({
      type: "extension_ui_response",
      id: "15cfcc57317e7bcc",
      confirmed: true,
      forSession: true,
    });
    outbound(translator, { ...approvalRequest, id: "second", options: ["Approve", "Deny"] });
    translator.toOmp({ type: "extension_ui_response", id: "second", confirmed: true });
    expect(translator.takeNotices()).toEqual([]);
  });

  it("never sends a directory or always grant, even one worded like a session choice", () => {
    const options = [
      "Approve Once",
      "Approve Directory: /repo",
      "Approve Directory: /repo for this session",
      "Always Approve Directory: /repo",
      "Approve",
      "Always Approve",
      "Always Approve File",
      "Approve File",
      "Approve bash for this session",
      "Deny",
    ];
    const answer = (response: Record<string, unknown>, labels = options) => {
      const translator = makeOmpTranslator();
      expect(translator.fromOmp({ ...approvalRequest, options: labels }).replies).toEqual([]);
      return translator.toOmp({
        type: "extension_ui_response",
        id: "15cfcc57317e7bcc",
        ...response,
      })["value"];
    };
    expect(answer({ confirmed: true, forSession: true })).toBe("Approve bash for this session");
    expect(answer({ confirmed: true })).toBe("Approve Once");
    // With only a directory-scoped "session" grant on offer, the user gets a single approval.
    const withoutToolSession = options.filter((label) => label !== "Approve bash for this session");
    expect(answer({ confirmed: true, forSession: true }, withoutToolSession)).toBe("Approve Once");
  });

  it("approves once when the user asks for the session but omp offers no session choice", () => {
    const translator = makeOmpTranslator();
    outbound(translator, { ...approvalRequest, options: ["Approve", "Deny"] });
    expect(
      translator.toOmp({
        type: "extension_ui_response",
        id: "15cfcc57317e7bcc",
        confirmed: true,
        forSession: true,
      }),
    ).toMatchObject({ value: "Approve" });
  });

  it("passes responses to other dialogs through", () => {
    const translator = makeOmpTranslator();
    const response = { type: "extension_ui_response", id: "ui_2", value: "SQLite" };
    expect(translator.toOmp(response)).toEqual(response);
  });

  it("renames the commands omp serves under another name", () => {
    const translator = makeOmpTranslator();
    expect(translator.toOmp({ type: "get_commands", id: "a" })).toEqual({
      type: "get_available_commands",
      id: "a",
    });
    expect(translator.toOmp({ type: "clear_queue", id: "b" })).toEqual({
      type: "abort_and_restore_queue",
      id: "b",
    });
  });

  it("forks before an entry with omp's branch, since omp's own fork keeps the entry", () => {
    const translator = makeOmpTranslator();
    expect(translator.toOmp({ type: "fork", id: "c", entryId: "e1" })).toEqual({
      type: "branch",
      id: "c",
      entryId: "e1",
    });
  });

  it("passes everything else through", () => {
    const translator = makeOmpTranslator();
    const commands = [
      { type: "get_state", id: "1" },
      { type: "set_model", id: "2", provider: "magpie", modelId: "auto/deepseek-v4.1-flash" },
      { type: "switch_session", id: "3", sessionPath: "/s/a.jsonl" },
      { type: "compact", id: "4", customInstructions: "focus" },
      { type: "abort", id: "5" },
    ];
    for (const command of commands) expect(translator.toOmp(command)).toEqual(command);
  });
});

describe("omp response data", () => {
  it("counts only the queued messages a user could still withdraw as pending", () => {
    expect(
      translateOmpResponseData("get_state", {
        isStreaming: false,
        queuedMessageCount: 3,
        queuedMessages: { steering: ["one"], followUp: ["two"] },
      }),
    ).toEqual({
      isStreaming: false,
      queuedMessageCount: 3,
      queuedMessages: { steering: ["one"], followUp: ["two"] },
      pendingMessageCount: 2,
    });
    expect(translateOmpResponseData("get_state", { isStreaming: true })).toEqual({
      isStreaming: true,
      pendingMessageCount: 0,
    });
  });

  it("hands back withdrawn queue text as Pi's clear_queue does", () => {
    expect(
      translateOmpResponseData("clear_queue", {
        steering: [{ text: "Use the existing parser" }],
        followUp: [{ text: "Then run the tests", images: [{ type: "image" }] }],
      }),
    ).toEqual({ steering: ["Use the existing parser"], followUp: ["Then run the tests"] });
  });

  it("leaves other data alone", () => {
    const data = { messages: [] };
    expect(translateOmpResponseData("get_messages", data)).toBe(data);
  });
});

describe("omp command discovery", () => {
  it("advertises each user command source while keeping native builtins out of the picker", () => {
    const projected = projectOmpCommands({
      commands: [
        { name: "security", source: "builtin", description: "Scans" },
        { name: "compact", source: "builtin", description: "Compact the conversation" },
        { name: "new", source: "builtin", description: "Start a new session" },
        { name: "skill:agent-browser", source: "skill", description: "Browser automation" },
        {
          name: "green",
          source: "custom",
          description: "Iterate on CI",
          input: { hint: "arguments" },
        },
        { name: "init", source: "file" },
        { name: "autoresearch", source: "extension", description: "Toggle autoresearch" },
        { name: "review-pr", source: "mcp_prompt", description: "MCP prompt" },
        { name: "unknown", source: "future" },
      ],
    });
    expect(projected).toEqual({
      commands: [
        { name: "skill:agent-browser", source: "skill", description: "Browser automation" },
        { name: "green", source: "prompt", description: "Iterate on CI" },
        { name: "init", source: "prompt" },
        { name: "autoresearch", source: "extension", description: "Toggle autoresearch" },
        { name: "review-pr", source: "prompt", description: "MCP prompt" },
      ],
    });
    expect(parsePiDiscoveredCommands(projected)).toMatchObject({
      slashCommands: [
        { name: "green" },
        { name: "init" },
        { name: "autoresearch" },
        { name: "review-pr", description: "MCP prompt" },
      ],
      skills: [{ name: "agent-browser", enabled: true }],
    });
  });

  it("tolerates a malformed catalog", () => {
    expect(projectOmpCommands(undefined)).toEqual({ commands: [] });
    expect(projectOmpCommands({ commands: "nope" })).toEqual({ commands: [] });
  });
});

describe("omp session headers", () => {
  it("uses the actual session entry, never the title or a message cwd", () => {
    expect(
      readOmpSessionCwd([
        '{"type":"title","cwd":"/wrong"}',
        '{"type":"session","cwd":"/path with spaces"}',
        '{"type":"message","cwd":"/other"}',
      ]),
    ).toBe("/path with spaces");
    expect(readOmpSessionCwd(['{"type":"title"}', "not json"])).toBeUndefined();
    expect(readOmpSessionCwd(['{"type":"session","cwd":"  "}'])).toBeUndefined();
  });
});
