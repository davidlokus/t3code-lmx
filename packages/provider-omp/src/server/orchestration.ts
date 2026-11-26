import type {
  OrchestrationV2PlanStep,
  OrchestrationV2Subagent,
  OrchestrationV2UserInputQuestion,
} from "@t3tools/contracts";
import {
  piRecordField as recordField,
  piRecordNumber as recordNumber,
  piRecordString as recordString,
  type PiRpcRecord,
} from "@t3tools/provider-pi/server/rpc";
import * as Schema from "effect/Schema";

type Question = OrchestrationV2UserInputQuestion;
type SubagentStatus = Extract<
  OrchestrationV2Subagent["status"],
  "pending" | "running" | "completed" | "failed" | "interrupted"
>;

const MAX_SUBAGENT_RESULT_CHARS = 50_000;
const MAX_SUBAGENT_PROGRESS_CHARS = 200;

interface SubagentTask {
  readonly agent: string;
  readonly title: string;
  readonly task: string;
  readonly model: string | null;
  readonly status: SubagentStatus;
  readonly progress?: string;
  readonly result: string | null;
}

function subagentStatus(status: unknown): SubagentStatus | undefined {
  switch (status) {
    case "started":
      return "running";
    case "aborted":
    case "cancelled":
      return "interrupted";
    case "pending":
    case "running":
    case "completed":
    case "failed":
      return status;
  }
}

function isTerminal(status: SubagentStatus): boolean {
  return status !== "pending" && status !== "running";
}

function subagentProgress(progress: unknown): string | undefined {
  const intent = recordString(progress, "lastIntent")?.trim();
  if (intent) return intent.slice(0, 200);
  const tool = recordString(progress, "currentTool")?.trim();
  if (tool) {
    const args = recordString(progress, "currentToolArgs")?.trim();
    return args ? `${tool.slice(0, 200)}(${args.slice(0, 200)})`.slice(0, 200) : tool.slice(0, 200);
  }
  const output = recordField(progress, "recentOutput");
  if (Array.isArray(output)) {
    for (let i = output.length - 1; i >= 0; i--) {
      const line: unknown = output[i];
      if (typeof line !== "string") continue;
      const text = line
        .trim()
        .replace(/^(?:#{1,6}|[-*>])\s+/, "")
        .replace(/\[([^[\]\r\n]+)\]\([^()\r\n]*\)/g, "$1");
      if (!text || text.startsWith("```") || text.startsWith("~~~")) continue;
      if (text.length <= MAX_SUBAGENT_PROGRESS_CHARS) return text;
      const prefix = text.slice(0, MAX_SUBAGENT_PROGRESS_CHARS - 1);
      const boundary = prefix.lastIndexOf(" ");
      return `${(boundary > 0 ? prefix.slice(0, boundary) : prefix).trimEnd()}…`;
    }
  }
}

function shortSubagentLabel(value: string | undefined): string | undefined {
  const label = value?.trim();
  return label && label.length <= 60 && !/[\r\n\u2028\u2029]/.test(label) ? label : undefined;
}

function taskResultBody(text: string) {
  const read = (tag: "output" | "preview" | "error") => {
    const match = new RegExp(`<${tag}(?:\\s[^<>]*)?>`).exec(text);
    if (match === null) return undefined;
    const contentStart = match.index + match[0].length;
    const end = text.lastIndexOf(`</${tag}>`);
    return end >= contentStart ? text.slice(contentStart, end).trim() : undefined;
  };
  const error = read("error");
  const result = read("output") || read("preview") || error;
  return { result, error };
}

function* taskResultBlocks(text: string) {
  // An invalid opener cannot scan across the next tag, so recovery is linear even on malformed input.
  const tags = /<task-result(?=[\s>])([^<>]*)>|<\/task-result>/g;
  let open: { start: number; attributes: string } | undefined;
  for (const match of text.matchAll(tags)) {
    const [tag, attributes] = match;
    if (attributes !== undefined) {
      open = { start: match.index + tag.length, attributes };
    } else if (open !== undefined) {
      let id: string | undefined;
      let status: string | undefined;
      for (const [, name, doubleQuoted, singleQuoted] of open.attributes.matchAll(
        /\s([a-zA-Z][\w-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/g,
      )) {
        if (name === "id") id = doubleQuoted ?? singleQuoted;
        if (name === "status") status = doubleQuoted ?? singleQuoted;
      }
      yield { id, status, ...taskResultBody(text.slice(open.start, match.index)) };
      open = undefined;
    }
  }
}

function backgroundResultStatus(job: unknown, envelopeStatus: string | undefined, failed: boolean) {
  const jobStatus = subagentStatus(recordString(job, "status"));
  if (jobStatus !== undefined && isTerminal(jobStatus)) return jobStatus;
  const status = subagentStatus(envelopeStatus);
  if (status !== undefined && isTerminal(status)) return status;
  return failed ? "failed" : "completed";
}

export class OmpSubagentTracker {
  readonly #tasks = new Map<string, Map<string, SubagentTask>>();

  fromSubscription(frame: PiRpcRecord): PiRpcRecord | undefined {
    const payload = frame["payload"];
    const progress =
      frame["type"] === "subagent_progress" ? recordField(payload, "progress") : undefined;
    const snapshot = frame["type"] === "subagent_progress" ? progress : payload;
    const status = subagentStatus(recordField(snapshot, "status"));
    if (status === undefined) return undefined;
    return this.#update(payload, snapshot, recordString(payload, "parentToolCallId"), status, {
      progress: subagentProgress(progress),
    });
  }

  fromTaskResult(frame: PiRpcRecord): PiRpcRecord[] {
    const toolCallId = recordString(frame, "toolCallId");
    const results = recordField(recordField(frame["result"], "details"), "results");
    const updates: PiRpcRecord[] = [];
    if (!toolCallId || !Array.isArray(results)) return updates;
    for (const entry of results as ReadonlyArray<unknown>) {
      const error = recordString(entry, "error");
      const status =
        recordField(entry, "aborted") === true
          ? "interrupted"
          : (recordNumber(entry, "exitCode") ?? 0) !== 0 || Boolean(error)
            ? "failed"
            : "completed";
      const result =
        recordString(entry, "output")?.trim() ||
        error?.trim() ||
        recordString(entry, "stderr")?.trim();
      const update = this.#update(entry, entry, toolCallId, status, { result });
      if (update !== undefined) updates.push(update);
    }
    return updates;
  }

  fromWaitResult(frame: PiRpcRecord): PiRpcRecord[] {
    const jobs = recordField(recordField(frame["result"], "details"), "jobs");
    const updates: PiRpcRecord[] = [];
    if (!Array.isArray(jobs)) return updates;
    for (const job of jobs) {
      const error = recordString(job, "errorText")?.trim() || recordString(job, "error")?.trim();
      const text = recordString(job, "resultText")?.trim() || error;
      if (!text) continue;
      const jobId = recordString(job, "id") ?? recordString(job, "jobId");
      const agentId = recordString(job, "agentUrlId") ?? recordString(job, "agentId");
      const knownKey = this.#trackedKey(agentId, jobId);
      if (knownKey === undefined && recordString(job, "type") !== "task") continue;
      const wrapped = /^<task-result[\s>]/.test(text);
      const block = wrapped ? taskResultBlocks(text).next().value : undefined;
      const taskKey = this.#trackedKey(agentId, block?.id, jobId);
      const body =
        !wrapped && /^<(?:output|preview|error)(?:[\s>])/.test(text)
          ? taskResultBody(text)
          : undefined;
      const result = wrapped ? block?.result || error : body?.result || text;
      if (taskKey === undefined || !result) continue;
      const status = backgroundResultStatus(
        job,
        block?.status,
        Boolean(error || block?.error || body?.error),
      );
      const update = this.#enrich(taskKey, status, result);
      if (update !== undefined) updates.push(update);
    }
    return updates;
  }

  fromAsyncResultMessage(frame: PiRpcRecord): PiRpcRecord[] {
    const message = frame["message"];
    const jobs = recordField(recordField(message, "details"), "jobs");
    const updates: PiRpcRecord[] = [];
    if (!Array.isArray(jobs)) return updates;
    const content = recordField(message, "content");
    const text =
      typeof content === "string"
        ? content
        : Array.isArray(content)
          ? content
              .filter((block) => recordString(block, "type") === "text")
              .map((block) => recordString(block, "text") ?? "")
              .join("")
          : "";
    const jobsById = new Map<string, unknown>();
    for (const job of jobs) {
      const jobId = recordString(job, "jobId");
      const agentId = recordString(job, "agentId");
      if (jobId) jobsById.set(jobId, job);
      if (agentId) jobsById.set(agentId, job);
    }
    for (const block of taskResultBlocks(text)) {
      if (!block.id || !block.result) continue;
      const job = jobsById.get(block.id);
      if (job === undefined) continue;
      const taskKey = this.#trackedKey(
        recordString(job, "agentId"),
        block.id,
        recordString(job, "jobId"),
      );
      if (taskKey === undefined) continue;
      const status = backgroundResultStatus(job, block.status, Boolean(block.error));
      const update = this.#enrich(taskKey, status, block.result);
      if (update !== undefined) updates.push(update);
    }
    return updates;
  }

  #trackedKey(...ids: ReadonlyArray<string | undefined>): string | undefined {
    return ids.find((id) => id !== undefined && this.#tasks.get(id)?.size === 1);
  }

  #enrich(taskKey: string, status: SubagentStatus, text: string): PiRpcRecord | undefined {
    const result = text.trim().slice(0, MAX_SUBAGENT_RESULT_CHARS);
    const previous = this.#tasks.get(taskKey)?.values().next().value;
    // Async notifications can repeat a shortened preview after wait provided the full report.
    if (!result || (previous?.result && previous.result.length >= result.length)) return undefined;
    return this.#update(undefined, { id: taskKey }, undefined, status, { result });
  }

  #update(
    payload: unknown,
    snapshot: unknown,
    parentToolCallId: string | undefined,
    nextStatus: SubagentStatus,
    update: { readonly progress?: string | undefined; readonly result?: string | undefined },
  ): PiRpcRecord | undefined {
    const taskKey = recordString(snapshot, "id");
    if (!taskKey) return undefined;
    const owners = this.#tasks.get(taskKey);
    const toolCallId =
      parentToolCallId ?? (owners?.size === 1 ? owners.keys().next().value : undefined);
    if (!toolCallId) return undefined;
    const previous = owners?.get(toolCallId);
    if (previous !== undefined && isTerminal(previous.status) && !isTerminal(nextStatus))
      return undefined;
    const status =
      previous !== undefined &&
      (isTerminal(previous.status) || (previous.status === "running" && nextStatus === "pending"))
        ? previous.status
        : nextStatus;
    const agent = recordString(payload, "agent") ?? previous?.agent;
    if (!agent) return undefined;
    const description =
      shortSubagentLabel(recordString(snapshot, "description")) ??
      shortSubagentLabel(recordString(payload, "description"));
    const label = description ?? shortSubagentLabel(recordString(snapshot, "taskKey") ?? taskKey);
    const title =
      (description === undefined ? previous?.title : undefined) ??
      (label && label !== agent ? `${label} (${agent})` : agent);
    const task =
      recordString(payload, "task") ??
      recordString(payload, "assignment") ??
      previous?.task ??
      recordString(snapshot, "description") ??
      taskKey;
    const model =
      recordString(snapshot, "resolvedModel") ??
      recordString(snapshot, "model") ??
      previous?.model ??
      recordString(snapshot, "modelOverride") ??
      null;
    const progress = isTerminal(status) ? undefined : (update.progress ?? previous?.progress);
    const result = update.result?.slice(0, MAX_SUBAGENT_RESULT_CHARS) || previous?.result || null;
    if (
      previous?.agent === agent &&
      previous.title === title &&
      previous.task === task &&
      previous.model === model &&
      previous.status === status &&
      previous.progress === progress &&
      previous.result === result
    )
      return undefined;
    const next = {
      agent,
      title,
      task,
      model,
      status,
      ...(progress === undefined ? {} : { progress }),
      result,
    };
    if (owners === undefined) this.#tasks.set(taskKey, new Map([[toolCallId, next]]));
    else owners.set(toolCallId, next);
    return { type: "t3.subagent_update", toolCallId, taskKey, task: next };
  }
}

const isTodoPhases = Schema.is(
  Schema.Array(
    Schema.Struct({
      name: Schema.String,
      tasks: Schema.Array(
        Schema.Struct({
          content: Schema.String,
          status: Schema.Literals(["pending", "in_progress", "completed", "abandoned"]),
        }),
      ),
    }),
  ),
);

export function projectOmpTodoWrite(frame: PiRpcRecord): PiRpcRecord | undefined {
  // v19.2.1 calls the built-in `todo`, while compatible callers may send `todo_write`.
  if (
    frame["type"] !== "tool_execution_end" ||
    (frame["toolName"] !== "todo_write" && frame["toolName"] !== "todo") ||
    frame["isError"]
  )
    return undefined;
  const details = recordField(frame["result"], "details");
  const phases = recordField(details, "phases");
  if (recordField(details, "op") === "view" || !isTodoPhases(phases)) return undefined;
  let visibleNamedPhases = 0;
  for (const phase of phases) {
    if (
      phase.name.trim() &&
      phase.tasks.some((task) => task.status !== "abandoned" && task.content.trim())
    ) {
      if (++visibleNamedPhases === 2) break;
    }
  }
  const prefixPhases = visibleNamedPhases > 1;
  const steps: OrchestrationV2PlanStep[] = [];
  for (const [phaseIndex, phase] of phases.entries()) {
    const name = phase.name.trim();
    for (const [taskIndex, task] of phase.tasks.entries()) {
      if (task.status === "abandoned" || !task.content.trim()) continue;
      steps.push({
        id: `${phaseIndex}:${taskIndex}`,
        text: prefixPhases && name ? `[${name}] ${task.content}` : task.content,
        status: task.status === "in_progress" ? "running" : task.status,
      });
    }
  }
  return { type: "t3.todo_list_update", steps };
}

const isAskQuestions = Schema.is(
  Schema.NonEmptyArray(
    Schema.Struct({
      id: Schema.String,
      question: Schema.String,
      header: Schema.optional(Schema.String),
      multi: Schema.optional(Schema.Boolean),
      recommended: Schema.optional(Schema.Int),
      options: Schema.Array(
        Schema.Struct({
          label: Schema.String,
          description: Schema.optional(Schema.String),
          preview: Schema.optional(Schema.String),
        }),
      ),
    }),
  ),
);

export interface OmpAskRequest {
  readonly questions: ReadonlyArray<Question>;
  readonly fields: ReadonlyArray<{
    readonly id: string;
    readonly choices: ReadonlyMap<string, boolean>;
  }>;
}

export function parseOmpAskRequest(frame: PiRpcRecord): OmpAskRequest | undefined {
  const raw = frame["questions"];
  if (!isAskQuestions(raw)) return undefined;
  const questions: Question[] = [];
  const fields: Array<OmpAskRequest["fields"][number]> = [];
  const ids = new Set<string>();
  for (const entry of raw) {
    const id = entry.id.trim();
    const question = entry.question.trim();
    if (!id || !question || ids.has(id)) return undefined;
    ids.add(id);
    const choices = new Map<string, boolean>();
    const options: Array<Question["options"][number]> = [];
    for (const option of entry.options) {
      const label = option.label.trim();
      if (!label || choices.has(option.label)) return undefined;
      choices.set(option.label, true);
      options.push({
        label,
        value: option.label,
        description: option.description?.trim() || label,
        ...(option.preview === undefined ? {} : { preview: option.preview }),
      });
    }
    questions.push({
      id,
      header: entry.header?.trim() || question,
      question,
      options,
      multiSelect: entry.multi === true,
      allowCustomAnswer: true,
    });
    fields.push({ id: entry.id, choices });
  }
  return { questions, fields };
}

function readAnswers(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function splitChoices(
  answer: unknown,
  choices: ReadonlyMap<string, boolean>,
  multi: boolean,
  allowCustom: boolean,
): { readonly selectedOptions: string[]; readonly customInput: string | undefined } | undefined {
  const values: ReadonlyArray<unknown> = Array.isArray(answer) ? answer : [answer];
  const selectedOptions: string[] = [];
  let customInput: string | undefined;
  for (const value of values) {
    if (typeof value !== "string") return undefined;
    const enabled = choices.get(value);
    if (enabled === true) {
      if (selectedOptions.includes(value)) return undefined;
      selectedOptions.push(value);
    } else {
      if (enabled === false) return undefined;
      if (!value.trim()) continue;
      if (!allowCustom || customInput !== undefined) return undefined;
      customInput = value;
    }
  }
  if (
    !multi &&
    (selectedOptions.length > 1 || (selectedOptions.length > 0 && customInput !== undefined))
  )
    return undefined;
  return { selectedOptions, customInput };
}

export function encodeOmpAskResponse(request: OmpAskRequest, reply: unknown) {
  const answers = readAnswers(reply);
  if (answers === undefined || Object.keys(answers).length !== request.questions.length)
    return undefined;
  const encoded: Array<{ id: string; selectedOptions: string[]; customInput?: string }> = [];
  for (const [index, question] of request.questions.entries()) {
    const field = request.fields[index]!;
    if (!Object.hasOwn(answers, question.id)) return undefined;
    const answer = splitChoices(
      answers[question.id],
      field.choices,
      question.multiSelect === true,
      true,
    );
    if (answer === undefined) return undefined;
    const customInput = answer.customInput?.trim();
    encoded.push({
      id: field.id,
      selectedOptions: answer.selectedOptions,
      ...(customInput === undefined ? {} : { customInput }),
    });
  }
  return { answers: encoded };
}

const MAX_FORM_BYTES = 256 * 1024;
const VOID_TAGS = {
  area: true,
  base: true,
  br: true,
  col: true,
  embed: true,
  hr: true,
  img: true,
  input: true,
  link: true,
  meta: true,
  param: true,
  source: true,
  track: true,
  wbr: true,
};
const SKIPPED_TAGS = {
  button: true,
  head: true,
  iframe: true,
  noscript: true,
  script: true,
  style: true,
  svg: true,
  template: true,
  title: true,
};
const RAW_TEXT_TAGS = {
  iframe: true,
  noscript: true,
  script: true,
  style: true,
  textarea: true,
  title: true,
};
const IGNORED_INPUTS = { submit: true, reset: true, button: true, image: true };
const UNSUPPORTED_INPUTS = {
  file: true,
  color: true,
  date: true,
  datetime: true,
  "datetime-local": true,
  month: true,
  week: true,
  time: true,
};
// Match OMP's named entities: decoding a different set can change submitted field keys or values.
const NAMED_ENTITY_CODE_POINTS: Readonly<Record<string, number>> = {
  AElig: 0xc6,
  Aacute: 0xc1,
  Acirc: 0xc2,
  Agrave: 0xc0,
  Aring: 0xc5,
  Atilde: 0xc3,
  Auml: 0xc4,
  Ccedil: 0xc7,
  ETH: 0xd0,
  Eacute: 0xc9,
  Ecirc: 0xca,
  Egrave: 0xc8,
  Euml: 0xcb,
  Iacute: 0xcd,
  Icirc: 0xce,
  Igrave: 0xcc,
  Iuml: 0xcf,
  Ntilde: 0xd1,
  Oacute: 0xd3,
  Ocirc: 0xd4,
  Ograve: 0xd2,
  Oslash: 0xd8,
  Otilde: 0xd5,
  Ouml: 0xd6,
  THORN: 0xde,
  Uacute: 0xda,
  Ucirc: 0xdb,
  Ugrave: 0xd9,
  Uuml: 0xdc,
  Yacute: 0xdd,
  aacute: 0xe1,
  acirc: 0xe2,
  aelig: 0xe6,
  agrave: 0xe0,
  amp: 0x26,
  apos: 0x27,
  aring: 0xe5,
  atilde: 0xe3,
  auml: 0xe4,
  brvbar: 0xa6,
  bull: 0x2022,
  ccedil: 0xe7,
  cedil: 0xb8,
  cent: 0xa2,
  copy: 0xa9,
  curren: 0xa4,
  deg: 0xb0,
  divide: 0xf7,
  eacute: 0xe9,
  ecirc: 0xea,
  egrave: 0xe8,
  emsp: 0x2003,
  ensp: 0x2002,
  eth: 0xf0,
  euml: 0xeb,
  euro: 0x20ac,
  frac12: 0xbd,
  frac14: 0xbc,
  frac34: 0xbe,
  gt: 0x3e,
  hellip: 0x2026,
  iacute: 0xed,
  icirc: 0xee,
  iexcl: 0xa1,
  igrave: 0xec,
  iquest: 0xbf,
  iuml: 0xef,
  laquo: 0xab,
  ldquo: 0x201c,
  lsquo: 0x2018,
  lt: 0x3c,
  macr: 0xaf,
  mdash: 0x2014,
  micro: 0xb5,
  middot: 0xb7,
  nbsp: 0xa0,
  ndash: 0x2013,
  ntilde: 0xf1,
  oacute: 0xf3,
  ocirc: 0xf4,
  ograve: 0xf2,
  ordf: 0xaa,
  ordm: 0xba,
  oslash: 0xf8,
  otilde: 0xf5,
  ouml: 0xf6,
  para: 0xb6,
  plusmn: 0xb1,
  pound: 0xa3,
  quot: 0x22,
  raquo: 0xbb,
  rdquo: 0x201d,
  reg: 0xae,
  rsquo: 0x2019,
  sect: 0xa7,
  shy: 0xad,
  sup1: 0xb9,
  sup2: 0xb2,
  sup3: 0xb3,
  szlig: 0xdf,
  thinsp: 0x2009,
  thorn: 0xfe,
  times: 0xd7,
  trade: 0x2122,
  uacute: 0xfa,
  ucirc: 0xfb,
  ugrave: 0xf9,
  uml: 0xa8,
  uuml: 0xfc,
  yacute: 0xfd,
  yen: 0xa5,
  yuml: 0xff,
};

function decodeEntities(text: string): string {
  if (!text.includes("&")) return text;
  return text.replace(/&(#(?:\d+|x[0-9a-f]+)|[a-z][a-z\d]+);/gi, (original, entity: string) => {
    if (!entity.startsWith("#")) {
      const key = Object.hasOwn(NAMED_ENTITY_CODE_POINTS, entity) ? entity : entity.toLowerCase();
      return Object.hasOwn(NAMED_ENTITY_CODE_POINTS, key)
        ? String.fromCodePoint(NAMED_ENTITY_CODE_POINTS[key]!)
        : original;
    }
    const hex = entity[1]?.toLowerCase() === "x";
    const point = Number.parseInt(entity.slice(hex ? 2 : 1), hex ? 16 : 10);
    return point > 0 && point <= 0x10ffff && (point < 0xd800 || point > 0xdfff)
      ? String.fromCodePoint(point)
      : "\ufffd";
  });
}

interface HtmlElement {
  readonly tag: string;
  readonly attrs: ReadonlyMap<string, string>;
  readonly parent: HtmlElement | undefined;
  readonly siblingIndex: number;
  readonly children: Array<string | HtmlElement>;
}

function readAttributes(source: string) {
  const attrs = new Map<string, string>();
  const attribute = /\s*([^\s"'<>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'`=<>]+)))?/y;
  const end = /\s*(\/?)$/y;
  let offset = 0;
  for (;;) {
    end.lastIndex = offset;
    const closing = end.exec(source);
    if (closing !== null) return { attrs, selfClosing: closing[1] === "/" };
    attribute.lastIndex = offset;
    const match = attribute.exec(source);
    if (match === null) return undefined;
    const name = match[1]!.toLowerCase();
    if (!attrs.has(name)) attrs.set(name, decodeEntities(match[2] ?? match[3] ?? match[4] ?? ""));
    offset = attribute.lastIndex;
  }
}

function parseFormMarkup(html: string): HtmlElement | undefined {
  if (html.length > MAX_FORM_BYTES || Buffer.byteLength(html, "utf8") > MAX_FORM_BYTES)
    return undefined;
  const root: HtmlElement = {
    tag: "",
    attrs: new Map(),
    parent: undefined,
    siblingIndex: 0,
    children: [],
  };
  const stack = [root];
  const tagPattern = /<(\/?)([a-z][\w:-]*)(?=[\s/>])((?:[^<>"']|"[^"]*"|'[^']*')*)>/iy;
  const tagStart = /<\/?[a-z]/iy;
  const doctype = /<!doctype\s+[^<>]*>/iy;
  let offset = 0;
  while (offset < html.length) {
    const parent = stack.at(-1)!;
    const start = html.indexOf("<", offset);
    if (start < 0) {
      parent.children.push(html.slice(offset));
      break;
    }
    if (start > offset) parent.children.push(html.slice(offset, start));
    offset = start + 1;
    if (html.startsWith("<!--", start)) {
      const end = html.indexOf("-->", start + 4);
      if (end < 0) return undefined;
      offset = end + 3;
      continue;
    }
    doctype.lastIndex = start;
    if (doctype.test(html)) {
      offset = doctype.lastIndex;
      continue;
    }
    tagPattern.lastIndex = start;
    const match = tagPattern.exec(html);
    if (match === null) {
      tagStart.lastIndex = start;
      if (tagStart.test(html)) return undefined;
      parent.children.push("<");
      continue;
    }
    offset = tagPattern.lastIndex;
    const closing = match[1] === "/";
    const tag = match[2]!.toLowerCase();
    if ((tag === "select" && closing) || tag === "option" || tag === "optgroup") {
      if (stack.at(-1)?.tag === "option" && !(closing && tag === "option")) stack.pop();
      if (
        ((tag === "select" && closing) || (tag === "optgroup" && !closing)) &&
        stack.at(-1)?.tag === "optgroup"
      )
        stack.pop();
    }
    if (closing) {
      if (stack.at(-1)?.tag !== tag || match[3]?.trim()) return undefined;
      stack.pop();
      continue;
    }
    const attributes = readAttributes(match[3] ?? "");
    if (attributes === undefined) return undefined;
    const container = stack.at(-1)!;
    const node: HtmlElement = {
      tag,
      attrs: attributes.attrs,
      parent: container,
      siblingIndex: container.children.length,
      children: [],
    };
    container.children.push(node);
    if (Object.hasOwn(RAW_TEXT_TAGS, tag)) {
      const close = new RegExp(`</${tag}\\s*>`, "gi");
      close.lastIndex = offset;
      const end = close.exec(html);
      if (end === null) return undefined;
      if (tag === "textarea")
        node.children.push(html.slice(offset, end.index).replace(/^\r?\n/, ""));
      offset = close.lastIndex;
    } else if (!attributes.selfClosing && !Object.hasOwn(VOID_TAGS, tag)) {
      // Bound nesting before the recursive text and field walks.
      if (stack.length >= 128) return undefined;
      stack.push(node);
    }
  }
  return stack.length === 1 ? root : undefined;
}

function* formElements(root: HtmlElement): Generator<HtmlElement> {
  for (const child of root.children) {
    if (typeof child === "string" || Object.hasOwn(SKIPPED_TAGS, child.tag)) continue;
    yield child;
    yield* formElements(child);
  }
}

function htmlText(node: HtmlElement, fragments: string[], optionText = false): void {
  for (const child of node.children) {
    if (typeof child === "string") fragments.push(decodeEntities(child));
    else if (optionText) htmlText(child, fragments, true);
    else if (child.tag === "img") fragments.push(child.attrs.get("alt") ?? "");
    else if (child.tag === "br") fragments.push(" ");
    else if (
      child.tag !== "input" &&
      child.tag !== "select" &&
      child.tag !== "textarea" &&
      !Object.hasOwn(SKIPPED_TAGS, child.tag)
    )
      htmlText(child, fragments);
  }
}

function closest(node: HtmlElement, tag: string): HtmlElement | undefined {
  for (let current = node.parent; current !== undefined; current = current.parent) {
    if (current.tag === tag) return current;
  }
}

function precedingCaption(node: HtmlElement): HtmlElement | undefined {
  const siblings = node.parent?.children;
  if (siblings === undefined) return undefined;
  for (let i = node.siblingIndex - 1; i >= 0; i--) {
    const previous = siblings[i];
    if (typeof previous === "string" && !previous.trim()) continue;
    if (typeof previous === "object" && (previous.tag === "p" || /^h[1-6]$/.test(previous.tag)))
      return previous;
    return undefined;
  }
}

interface HtmlChoice {
  readonly value: string;
  readonly label: string;
  readonly disabled: boolean;
}

type HtmlField = {
  readonly name: string;
  readonly label: string;
  readonly legend: string;
  readonly caption: string;
  required: boolean;
} & (
  | { readonly kind: "text"; readonly value: string }
  | {
      readonly kind: "checkbox" | "radio" | "select";
      readonly multi: boolean;
      readonly options: HtmlChoice[];
    }
);

type FormField = { readonly name: string; readonly question: Question } & (
  | { readonly kind: "text" }
  | {
      readonly kind: "choice";
      readonly choices: ReadonlyMap<string, boolean>;
      readonly array: boolean;
    }
);

export interface OmpFormRequest {
  readonly questions: ReadonlyArray<Question>;
  readonly fields: ReadonlyMap<string, FormField>;
  readonly hidden: ReadonlyMap<string, string>;
}

export function parseOmpFormRequest(frame: PiRpcRecord): OmpFormRequest | undefined {
  const html = recordString(frame, "html");
  if (html === undefined) return undefined;
  const document = parseFormMarkup(html);
  if (document === undefined) return undefined;
  const root = formElements(document).find((node) => node.tag === "form") ?? document;
  const labels = new Map<string, HtmlElement>();
  for (const node of formElements(root)) {
    const target = node.tag === "label" ? node.attrs.get("for") : undefined;
    if (target && !labels.has(target)) labels.set(target, node);
  }
  const textCache = new Map<HtmlElement, string>();
  const text = (node: HtmlElement | undefined): string => {
    if (node === undefined) return "";
    const cached = textCache.get(node);
    if (cached !== undefined) return cached;
    const fragments: string[] = [];
    htmlText(node, fragments, node.tag === "option");
    const value = fragments.join("").replace(/\s+/g, " ").trim();
    textCache.set(node, value);
    return value;
  };
  const parsed = new Map<string, HtmlField>();
  const hidden = new Map<string, string>();
  for (const node of formElements(root)) {
    if (node.tag === "form") return undefined;
    if (node.tag !== "input" && node.tag !== "select" && node.tag !== "textarea") continue;
    if (closest(node, "select") !== undefined) return undefined;
    const type = node.tag === "input" ? (node.attrs.get("type") ?? "text").toLowerCase() : node.tag;
    if (Object.hasOwn(UNSUPPORTED_INPUTS, type)) return undefined;
    if (Object.hasOwn(IGNORED_INPUTS, type)) continue;
    const name = node.attrs.get("name");
    if (!name?.trim()) continue;
    const existing = parsed.get(name);
    if (type === "hidden") {
      if (existing !== undefined) return undefined;
      hidden.set(name, node.attrs.get("value") ?? "");
      continue;
    }
    if (hidden.has(name)) return undefined;
    const wrapping = closest(node, "label");
    const label =
      text(wrapping) ||
      text(labels.get(node.attrs.get("id") ?? "")) ||
      node.attrs.get("aria-label")?.trim() ||
      node.attrs.get("title")?.trim() ||
      "";
    const required = node.attrs.has("required");
    const legend = closest(node, "fieldset")?.children.find(
      (child) => typeof child !== "string" && child.tag === "legend",
    );
    const base = {
      name,
      label,
      legend: text(typeof legend === "string" ? undefined : legend),
      caption: text(precedingCaption(wrapping ?? node)),
      required,
    };
    if (type === "checkbox" || type === "radio") {
      const value = node.attrs.get("value");
      const option = {
        value: value ?? "on",
        label: label || (value ?? name),
        disabled: node.attrs.has("disabled"),
      };
      if (existing !== undefined) {
        if (existing.kind !== type) return undefined;
        existing.options.push(option);
        existing.required ||= required;
      } else {
        parsed.set(name, { ...base, kind: type, multi: type === "checkbox", options: [option] });
      }
    } else {
      if (existing !== undefined) return undefined;
      if (node.tag === "select") {
        const options: HtmlChoice[] = [];
        for (const option of formElements(node)) {
          if (option.tag !== "option") continue;
          const label = text(option);
          options.push({
            label,
            value: option.attrs.get("value") ?? label,
            disabled:
              option.attrs.has("disabled") ||
              closest(option, "optgroup")?.attrs.has("disabled") === true,
          });
        }
        parsed.set(name, { ...base, kind: "select", multi: node.attrs.has("multiple"), options });
      } else {
        const value =
          node.tag === "textarea"
            ? decodeEntities(String(node.children[0] ?? ""))
            : (node.attrs.get("value") ?? "");
        parsed.set(name, { ...base, kind: "text", value });
      }
    }
  }
  const questions: Question[] = [];
  const fields = new Map<string, FormField>();
  for (const field of parsed.values()) {
    const id = field.name.trim();
    if (fields.has(id)) return undefined;
    const fallback = id.replace(/[_-]+/g, " ").trim() || id;
    const header = field.legend || fallback;
    if (field.kind === "text") {
      const question = {
        id,
        header,
        question: field.label || field.caption || header,
        options: [],
        allowCustomAnswer: true,
        initialAnswer: field.value,
        required: field.required,
      };
      questions.push(question);
      fields.set(id, { name: field.name, kind: "text", question });
      continue;
    }
    // omp counts disabled options in both Y$() and its automatic Other decision.
    const array = field.multi && field.options.length > 1;
    const allowCustomAnswer =
      field.kind !== "select" &&
      field.options.length >= 2 &&
      !field.options.some((option) => /^\s*other\b/i.test(option.label));
    const choices = new Map<string, boolean>();
    const options: Array<Question["options"][number]> = [];
    for (const option of field.options) {
      if (choices.get(option.value) === true) continue;
      choices.set(option.value, !option.disabled);
      if (option.disabled) continue;
      const label = option.label.trim() || option.value.trim() || fallback;
      options.push({ label, description: label, value: option.value });
    }
    if (options.length === 0 && !allowCustomAnswer) continue;
    const prompt =
      (field.kind === "select" ? field.label : "") ||
      field.caption ||
      field.legend ||
      (options.length === 1 ? options[0]?.label : undefined) ||
      fallback;
    const question = {
      id,
      header,
      question: prompt,
      options,
      multiSelect: field.multi,
      allowCustomAnswer,
      required: field.required,
    };
    questions.push(question);
    fields.set(id, { name: field.name, kind: "choice", choices, array, question });
  }
  return questions.length === 0 ? undefined : { questions, fields, hidden };
}

export function encodeOmpFormResponse(request: OmpFormRequest, reply: unknown) {
  const answers = readAnswers(reply);
  if (answers === undefined) return undefined;
  const data = new Map<string, string | string[]>(request.hidden);
  for (const [id, value] of Object.entries(answers)) {
    const field = request.fields.get(id);
    if (field === undefined) return undefined;
    if (field.kind === "text") {
      if (typeof value !== "string") return undefined;
      if (value !== "") data.set(field.name, value);
      continue;
    }
    const answer = splitChoices(
      value,
      field.choices,
      field.array,
      field.question.allowCustomAnswer === true,
    );
    if (answer === undefined) return undefined;
    const selected = answer.selectedOptions;
    if (answer.customInput !== undefined) selected.push(answer.customInput);
    if (field.array) data.set(field.name, selected);
    else if (selected[0] !== undefined) data.set(field.name, selected[0]);
  }
  return { data: Object.fromEntries(data) };
}
