import { describe, expect, it } from "@effect/vitest";

import {
  encodeOmpAskResponse,
  encodeOmpFormResponse,
  OmpSubagentTracker,
  parseOmpAskRequest,
  parseOmpFormRequest,
  projectOmpTodoWrite,
} from "./orchestration.ts";

const lifecycle = (status: string) => ({
  type: "subagent_lifecycle",
  payload: {
    id: "Scout",
    parentToolCallId: "task-1",
    agent: "explore",
    status,
    description: "Inspect schema",
  },
});
const progress = (snapshot: Record<string, unknown>) => ({
  type: "subagent_progress",
  payload: {
    agent: "explore",
    task: "Find the schema",
    parentToolCallId: "task-1",
    progress: { id: "Scout", status: "running", ...snapshot },
  },
});
const taskResult = (...results: ReadonlyArray<Record<string, unknown>>) => ({
  type: "tool_execution_end",
  toolName: "task",
  toolCallId: "task-1",
  result: { details: { results } },
});

const askQuestions = [
  {
    id: "runtime ",
    question: "Which runtime?",
    header: "Runtime",
    options: [{ label: " Node ", preview: "node --version" }, { label: "Bun" }],
  },
  {
    id: "checks",
    question: "Which checks?",
    multi: true,
    options: [{ label: "Test" }, { label: "Lint" }],
  },
];

const parseForm = (html: string) =>
  parseOmpFormRequest({ type: "extension_ui_request", method: "form", html });

const todo = (phases: unknown, op = "start", toolName = "todo_write") => ({
  type: "tool_execution_end",
  toolName,
  isError: false,
  result: { details: { op, phases } },
});

describe("omp subagents", () => {
  it.each([
    ["completed", "completed"],
    ["failed", "failed"],
    ["aborted", "interrupted"],
  ])(
    "keeps %s terminal while enriching the same row with the final result",
    (nativeStatus, status) => {
      const tracker = new OmpSubagentTracker();
      const identity = { type: "t3.subagent_update", toolCallId: "task-1", taskKey: "Scout" };
      expect(tracker.fromSubscription(lifecycle("started"))).toMatchObject({
        ...identity,
        task: { status: "running", task: "Inspect schema" },
      });
      const update = progress({
        lastIntent: "Reading schema",
        currentTool: "grep",
        recentOutput: ["old"],
        resolvedModel: "example/model",
      });
      expect(tracker.fromSubscription(update)).toMatchObject({
        ...identity,
        task: {
          status: "running",
          progress: "Reading schema",
          task: "Find the schema",
          model: "example/model",
        },
      });
      expect(
        tracker.fromSubscription(progress({ ...update.payload.progress, cost: 0.1 })),
      ).toBeUndefined();
      expect(tracker.fromSubscription(lifecycle(nativeStatus))).toEqual({
        ...identity,
        task: {
          agent: "explore",
          status,
          task: "Find the schema",
          model: "example/model",
          result: null,
        },
      });
      expect(tracker.fromSubscription(progress({ lastIntent: "Late update" }))).toBeUndefined();
      const result = taskResult({
        id: "Scout",
        agent: "explore",
        output: "Found it",
        aborted: nativeStatus === "aborted",
        exitCode: nativeStatus === "failed" ? 1 : 0,
      });
      expect(tracker.fromTaskResult(result)).toMatchObject([
        { ...identity, task: { status, result: "Found it" } },
      ]);
      expect(tracker.fromTaskResult(result)).toEqual([]);
    },
  );

  it("uses tool args, then the output tail, and falls back to bounded final results", () => {
    const tracker = new OmpSubagentTracker();
    expect(
      tracker.fromSubscription(
        progress({ currentTool: "grep", currentToolArgs: "schema", recentOutput: ["ignored"] }),
      ),
    ).toMatchObject({ task: { progress: "grep(schema)" } });
    expect(
      tracker.fromSubscription(
        progress({ lastIntent: " ", recentOutput: ["old", `discarded${"a".repeat(200)}`, " "] }),
      ),
    ).toMatchObject({ task: { progress: "a".repeat(200) } });
    expect(
      tracker.fromTaskResult(
        taskResult(
          { id: "Writer", agent: "task", exitCode: 0, output: "x".repeat(12_000) },
          { id: "Broken", agent: "task", exitCode: 0, error: "Could not open schema" },
          { id: "Stopped", agent: "task", exitCode: 1, aborted: true, stderr: "Interrupted" },
          { agent: "unknown owner" },
        ),
      ),
    ).toMatchObject([
      { taskKey: "Writer", task: { status: "completed", result: "x".repeat(10_000) } },
      { taskKey: "Broken", task: { status: "failed", result: "Could not open schema" } },
      { taskKey: "Stopped", task: { status: "interrupted", result: "Interrupted" } },
    ]);
    expect(tracker.fromSubscription(lifecycle("started"))).toBeUndefined();
  });
});

describe("omp todos", () => {
  const inspect = {
    name: "Inspect",
    tasks: [
      { content: "Read schema", status: "in_progress" },
      { content: "Dropped", status: "abandoned" },
    ],
  };
  const verify = { name: "Verify", tasks: [{ content: "Run tests", status: "pending" }] };
  const unnamed = { name: "  ", tasks: [{ content: "Finish", status: "completed" }] };

  it("prefixes only if multiple named phases contain visible tasks and preserves order", () => {
    expect(projectOmpTodoWrite(todo([inspect, verify, unnamed]))).toEqual({
      type: "t3.todo_list_update",
      steps: [
        { id: "0:0", text: "[Inspect] Read schema", status: "running" },
        { id: "1:0", text: "[Verify] Run tests", status: "pending" },
        { id: "2:0", text: "Finish", status: "completed" },
      ],
    });
    expect(
      projectOmpTodoWrite(
        todo(
          [
            inspect,
            { name: "Removed", tasks: [{ content: "Dropped", status: "abandoned" }] },
            unnamed,
          ],
          "done",
          "todo",
        ),
      ),
    ).toMatchObject({ steps: [{ text: "Read schema" }, { text: "Finish" }] });
    expect(projectOmpTodoWrite(todo([], "rm"))).toEqual({ type: "t3.todo_list_update", steps: [] });
  });

  it("ignores reads, errors and malformed phase snapshots without emitting a partial checklist", () => {
    expect(projectOmpTodoWrite(todo([inspect], "view"))).toBeUndefined();
    expect(projectOmpTodoWrite({ ...todo([inspect]), isError: true })).toBeUndefined();
    expect(
      projectOmpTodoWrite(
        todo([inspect, { name: "Broken", tasks: [{ content: "Bad", status: "other" }] }]),
      ),
    ).toBeUndefined();
  });
});

describe("omp ask dialogs", () => {
  it("emits exact IDs and option labels in native order and trims only custom input", () => {
    const ask = parseOmpAskRequest({ questions: askQuestions })!;
    expect(ask.questions[0]).toMatchObject({
      id: "runtime",
      header: "Runtime",
      options: [{ label: "Node", value: " Node ", preview: "node --version" }, { label: "Bun" }],
    });
    expect(
      encodeOmpAskResponse(ask, { checks: ["Test", "  Timing  "], runtime: " Node " }),
    ).toEqual({
      answers: [
        { id: "runtime ", selectedOptions: [" Node "] },
        { id: "checks", selectedOptions: ["Test"], customInput: "Timing" },
      ],
    });
    expect(encodeOmpAskResponse(ask, { runtime: "Node", checks: ["Lint", "  "] })).toEqual({
      answers: [
        { id: "runtime ", selectedOptions: [], customInput: "Node" },
        { id: "checks", selectedOptions: ["Lint"] },
      ],
    });
  });

  it("rejects duplicate, missing or incompatible choices instead of guessing", () => {
    const ask = parseOmpAskRequest({ questions: askQuestions })!;
    for (const answer of [
      { runtime: [" Node ", "Bun"], checks: [] },
      { runtime: ["Bun", "Other"], checks: [] },
      { runtime: "Bun", checks: ["Lint", "Lint"] },
      { runtime: "Bun", checks: ["First custom", "Second custom"] },
      { runtime: "Bun", checks: [42] },
      { runtime: "Bun" },
      { runtime: "Bun", unknown: [] },
    ])
      expect(encodeOmpAskResponse(ask, answer)).toBeUndefined();

    for (const questions of [
      [],
      [askQuestions[0], askQuestions[0]],
      [{ ...askQuestions[0], options: [{ label: "Bun" }, { label: "Bun" }] }],
      [{ ...askQuestions[0], multi: "yes" }],
    ]) {
      expect(parseOmpAskRequest({ questions })).toBeUndefined();
    }
  });
});

describe("omp HTML forms", () => {
  it("keeps labels, exact values, text defaults, and hidden data without surfacing inert markup", () => {
    const form = parseForm(`
      <input name=outside>
      <form>
        <!-- <input type=file> -->
        <script>const example = '<input name=ignored type=file>';</script>
        <fieldset><legend>Store &amp; cache</legend>
          <label><input type=radio name=store value="sqlite&gt;db"> SQLite &#x26; disk</label>
          <input type=radio id=memory name=store value=memory><label for=memory>Memory</label>
        </fieldset>
        <label><input type=checkbox name=trace> Enable trace</label>
        <label>Lifetime <input type=number name=days value=" 12 "></label>
        <textarea name=note>
          &lt;input type=file&gt; &#39;quoted&#39;</textarea>
        <select name=region><option>Caf&eacute; &amp; &Eacute;ast<option disabled>West</select>
        <input type=hidden name=__proto__ value="a&gt;b">
        <input type=submit name=submit><input type=image name=image>
      </form>
    `)!;
    expect(form.questions.map(({ id }) => id)).toEqual([
      "store",
      "trace",
      "days",
      "note",
      "region",
    ]);
    expect(form.questions).toMatchObject([
      {
        header: "Store & cache",
        question: "Store & cache",
        allowCustomAnswer: true,
        options: [
          { label: "SQLite & disk", value: "sqlite>db" },
          { label: "Memory", value: "memory" },
        ],
      },
      {
        question: "Enable trace",
        multiSelect: true,
        allowCustomAnswer: false,
        options: [{ value: "on" }],
      },
      { question: "Lifetime", initialAnswer: " 12 " },
      { initialAnswer: "          <input type=file> 'quoted'" },
      { allowCustomAnswer: false, options: [{ value: "Café & Éast" }] },
    ]);
    const reply = encodeOmpFormResponse(form, {
      store: "sqlite>db",
      trace: ["on"],
      days: "12",
      note: "  Keep spaces  ",
      region: "Café & Éast",
    });
    expect(reply?.data).toEqual({
      ["__proto__"]: "a>b",
      store: "sqlite>db",
      trace: "on",
      days: "12",
      note: "  Keep spaces  ",
      region: "Café & Éast",
    });
    expect(encodeOmpFormResponse(form, { trace: [], note: "" })?.data).toEqual({
      ["__proto__"]: "a>b",
    });
    expect(encodeOmpFormResponse(form, { store: "different database" })?.data.store).toBe(
      "different database",
    );
    expect(encodeOmpFormResponse(form, { region: "West" })).toBeUndefined();
    expect(encodeOmpFormResponse(form, { trace: "unknown" })).toBeUndefined();
    expect(encodeOmpFormResponse(form, { ["__proto__"]: "changed" })).toBeUndefined();
  });

  it("uses wire cardinality and Other eligibility before filtering disabled options", () => {
    const form = parseForm(`<form>
      <input type=checkbox name=checks value=test><input type=checkbox name=checks value=lint>
      <select name=two multiple><option>A</option><option disabled>B</option></select>
      <select name=one multiple><option>A</option></select>
      <label><input name=radio type=radio value=primary>Primary</label>
      <label><input name=radio type=radio value=disabled disabled> Other provider</label>
    </form>`)!;
    expect(form.questions.find((question) => question.id === "radio")).toMatchObject({
      allowCustomAnswer: false,
      options: [{ value: "primary" }],
    });
    expect(
      encodeOmpFormResponse(form, {
        checks: ["test", "lint", "typecheck"],
        two: ["A"],
        one: ["A"],
      }),
    ).toEqual({ data: { checks: ["test", "lint", "typecheck"], two: ["A"], one: "A" } });
    expect(encodeOmpFormResponse(form, { checks: [], one: [] })).toEqual({ data: { checks: [] } });
    expect(encodeOmpFormResponse(form, { checks: ["test", "test"] })).toBeUndefined();
    expect(encodeOmpFormResponse(form, { radio: "custom" })).toBeUndefined();
  });

  it.each([
    ["file", "<form><input type=file name=upload><input name=answer></form>"],
    ["date", "<form><input type=date name=when></form>"],
    ["time", "<form><input type=time name=when></form>"],
    ["color", "<form><input type=color name=shade></form>"],
    ["mixed kinds", "<form><input type=radio name=answer><input name=answer></form>"],
    ["hidden only", "<form><input type=hidden name=version><button name=send>Send</button></form>"],
    ["broken attributes", '<form><input name="broken></form>'],
    ["oversized UTF-8", `<form><label>${"界".repeat(90_000)}</label><input name=answer></form>`],
  ])("fails closed for %s", (_reason, html) => {
    expect(parseForm(html)).toBeUndefined();
  });
});
