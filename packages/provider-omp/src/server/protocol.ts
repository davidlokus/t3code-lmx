// OMP's wire dialect was ported from t3-extend (ab7181dc0f).
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import {
  piRecordField as recordField,
  piRecordNumber as recordNumber,
  piRecordString as recordString,
  type PiRpcRecord,
} from "@t3tools/provider-pi/server/rpc";
import { SESSION_UNAVAILABLE_NOTICE } from "@t3tools/shared/forkNotices";

/** omp's approval prompt title: `Allow tool: <name>`, then one detail line per input. */
const APPROVAL_TITLE = /^Allow tool: ([^\n]+)(?:\n([\s\S]*))?$/;

// omp's select options have no ids: the labels are the values it reads back, so choices are found
// by meaning, and a prompt with any label omp is not known to send is refused whole.
// NFKC makes full-width look-alikes read as ASCII; omp's wording is English only, so no other list.
const normalizeLabel = (label: string) =>
  label.normalize("NFKC").trim().replace(/\s+/g, " ").toLowerCase();

// Grants wider than the one request: never sent, but recognised so they do not refuse the prompt.
const WIDER_GRANT_LABELS = [
  /^(always )?approve directory: .+$/,
  /^always approve( file)?$/,
  /^approve file$/,
];

interface ApprovalChoices {
  readonly approve: string;
  readonly session: string | undefined;
  readonly deny: string;
}

/** Labels omp only sends for an approval prompt, whatever its title says. */
const looksLikeApprovalChoice = (label: string) => {
  const normalized = normalizeLabel(label);
  return (
    normalized === "deny" ||
    normalized.startsWith("approve") ||
    normalized.startsWith("always approve")
  );
};

/**
 * `undefined` unless every option is recognised and the choices are unambiguous: one single
 * approval, one deny, and at most one session approval for this tool. When anything wider than
 * the request is on offer omp names the single approval "Approve Once" and may use plain
 * "Approve" for a scoped grant, so without "Approve Once" no choice is known to be a single one.
 */
function readApprovalChoices(
  options: ReadonlyArray<string>,
  tool: string,
): ApprovalChoices | undefined {
  const sessionLabel = `approve ${normalizeLabel(tool)} for this session`;
  const once: Array<string> = [];
  const plain: Array<string> = [];
  const session: Array<string> = [];
  const deny: Array<string> = [];
  let wider = 0;
  for (const option of options) {
    const label = normalizeLabel(option);
    if (label === "approve once") once.push(option);
    else if (label === "approve") plain.push(option);
    else if (label === "deny") deny.push(option);
    else if (WIDER_GRANT_LABELS.some((grant) => grant.test(label))) {
      if (label === sessionLabel) return undefined;
      wider += 1;
    } else if (label === sessionLabel) session.push(option);
    else return undefined;
  }
  if (deny.length !== 1 || session.length > 1) return undefined;
  if (once.length > 0 || wider > 0) {
    // "Approve" beside "Approve Once" is a scoped grant; it needs "Approve Once" to be real.
    if (once.length !== 1 || plain.length > 1 || wider + plain.length === 0) return undefined;
    return { approve: once[0]!, session: session[0], deny: deny[0]! };
  }
  if (plain.length !== 1) return undefined;
  return { approve: plain[0]!, session: session[0], deny: deny[0]! };
}

export interface OmpTranslation {
  /** What the Pi adapter should see, possibly nothing. */
  readonly frames: ReadonlyArray<PiRpcRecord>;
  /** What must go straight back to omp without the adapter's involvement. */
  readonly replies: ReadonlyArray<PiRpcRecord>;
}

export interface OmpTranslator {
  /** omp stdout frame to the frames the Pi adapter expects, and any replies owed to omp. */
  readonly fromOmp: (frame: PiRpcRecord) => OmpTranslation;
  /** Pi adapter command to the command omp understands. */
  readonly toOmp: (record: PiRpcRecord) => PiRpcRecord;
  /** Notices that translating commands produced for the user; each is returned once. */
  readonly takeNotices: () => ReadonlyArray<PiRpcRecord>;
}

export function makeOmpTranslator(): OmpTranslator {
  let agentRunning = false;
  let noticeSeq = 0;
  const emittedErrorNotices = new Set<string>();
  // Prompts sent while the agent ran are queued behind it; omp's acknowledgement does not say so.
  const sentWhileRunning = new Map<string, boolean>();
  const approvals = new Map<string, ApprovalChoices>();
  let notices: Array<PiRpcRecord> = [];
  const frames = (...translated: ReadonlyArray<PiRpcRecord>): OmpTranslation => ({
    frames: translated,
    replies: [],
  });

  const settled = (frame: PiRpcRecord): boolean => {
    const yielded = frame["yielded"];
    return yielded === true || (yielded === undefined && frame["isTerminal"] === true);
  };

  const lastAssistantStopReason = (frame: PiRpcRecord): string | undefined => {
    const messages = frame["messages"];
    if (!Array.isArray(messages)) return undefined;
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      const message: unknown = messages[index];
      if (recordString(message, "role") === "assistant") return recordString(message, "stopReason");
    }
    return undefined;
  };

  const fromOmp = (frame: PiRpcRecord): OmpTranslation => {
    switch (frame["type"]) {
      case "ready":
        return frames();
      case "notice": {
        const message = recordString(frame, "message")?.trim();
        if (!message) return frames();
        const level = frame["level"];
        const notifyType = level === "error" || level === "warning" ? level : "info";
        if (notifyType === "error") emittedErrorNotices.add(message);
        return frames({
          type: "extension_ui_request",
          id: `omp:notice:${++noticeSeq}`,
          method: "notify",
          notifyType,
          message,
        });
      }
      case "prompt_result": {
        if (frame["status"] !== "error") return frames();
        const error = recordField(frame, "error");
        if (recordString(error, "code") !== "cost_cap") return frames();
        const message =
          recordString(error, "message")?.trim() ||
          "Session reached its configured cost cap (--max-cost).";
        if (emittedErrorNotices.has(message)) return frames();
        emittedErrorNotices.add(message);
        return frames({
          type: "extension_ui_request",
          id: `omp:cost-cap:${++noticeSeq}`,
          method: "notify",
          notifyType: "error",
          message,
        });
      }
      // The yield settles a turn (see agent_end); omp's quiescence frame would settle it twice.
      case "session_settled":
        emittedErrorNotices.clear();
        return frames();
      case "agent_start":
        agentRunning = true;
        emittedErrorNotices.clear();
        return frames(frame);
      case "agent_end": {
        if (!settled(frame)) return frames(frame);
        agentRunning = false;
        emittedErrorNotices.clear();
        return frames(frame, {
          type: "agent_settled",
          aborted: lastAssistantStopReason(frame) === "aborted",
        });
      }
      case "message_update": {
        if (frame["usage"] !== undefined) return frames(frame);
        // OMP nests the counters on its streaming assistant snapshot; Pi reads them on the event.
        const delta = frame["assistantMessageEvent"];
        const usage =
          recordField(frame["message"], "usage") ??
          recordField(recordField(delta, "partial"), "usage");
        return usage === undefined ? frames(frame) : frames({ ...frame, usage });
      }
      case "message_end": {
        const message = frame["message"];
        const stopReason = recordString(message, "stopReason");
        const usage = recordField(message, "usage");
        // Some backends only populate the final snapshot's counters.
        return recordString(message, "role") === "assistant" &&
          stopReason !== "error" &&
          stopReason !== "aborted" &&
          (recordNumber(usage, "totalTokens") ?? 0) > 0
          ? frames({ type: "message_update", usage }, frame)
          : frames(frame);
      }
      case "manual_compaction_start":
        return frames({ type: "compaction_start", reason: "manual" });
      case "auto_compaction_start":
        return frames({
          type: "compaction_start",
          reason: recordString(frame, "reason") ?? "threshold",
        });
      case "manual_compaction_end":
      case "auto_compaction_end":
        return frames(compactionEnd(frame));
      case "extension_ui_request":
        return approvalAsConfirm(frame);
      case "response":
        return frames(promptAcknowledgement(frame));
      default:
        return frames(frame);
    }
  };

  const compactionEnd = (frame: PiRpcRecord): PiRpcRecord => {
    const manual = frame["type"] === "manual_compaction_end";
    const base = {
      type: "compaction_end",
      reason: manual ? "manual" : (recordString(frame, "reason") ?? "threshold"),
      aborted: frame["aborted"] === true,
      willRetry: frame["willRetry"] === true,
    };
    const result = frame["result"];
    // Nothing to compact is an ordinary outcome, so it completes with omp's explanation as its note.
    if (frame["skipped"] === true) {
      const note = recordString(frame, "errorMessage");
      return { ...base, skipped: true, result: note === undefined ? {} : { summary: note } };
    }
    if (result === undefined || result === null) {
      const errorMessage = recordString(frame, "errorMessage");
      return { ...base, result: null, ...(errorMessage === undefined ? {} : { errorMessage }) };
    }
    const summary = recordString(result, "summary");
    const tokensBefore = recordNumber(result, "tokensBefore");
    const estimatedTokensAfter = recordNumber(result, "estimatedTokensAfter");
    return {
      ...base,
      result: {
        ...(summary === undefined ? {} : { summary }),
        ...(tokensBefore === undefined ? {} : { tokensBefore }),
        ...(estimatedTokensAfter === undefined ? {} : { estimatedTokensAfter }),
      },
    };
  };

  // Guessing a choice could approve something the user never saw, so omp is told to deny.
  const refuseApproval = (id: string | undefined, tool: string | undefined): OmpTranslation => {
    if (id !== undefined) approvals.delete(id);
    return {
      frames: [
        {
          type: "extension_ui_request",
          id: `${id ?? "unknown"}:unreadable`,
          method: "notify",
          notifyType: "error",
          message: `omp asked to allow ${tool ?? "a tool"} in a format T3 Code does not recognise, so the request was denied.`,
        },
      ],
      replies: id ? [{ type: "extension_ui_response", id, cancelled: true }] : [],
    };
  };

  const approvalAsConfirm = (frame: PiRpcRecord): OmpTranslation => {
    const id = recordString(frame, "id");
    const title = recordString(frame, "title") ?? "";
    const options = recordField(frame, "options");
    // Whatever shape a prompt has, one that looks like an approval never reaches the adapter as
    // a plain select, where the user's pick would go back to omp as an unchecked choice.
    const approvalShaped =
      normalizeLabel(title).includes("allow tool") ||
      (Array.isArray(options) &&
        options.some((option) => typeof option === "string" && looksLikeApprovalChoice(option)));
    if (!approvalShaped) return frames(frame);
    const match = APPROVAL_TITLE.exec(title);
    const tool = match?.[1]?.trim();
    if (
      id === undefined ||
      id.length === 0 ||
      approvals.has(id) ||
      frame["method"] !== "select" ||
      match === null ||
      tool === undefined ||
      tool.length === 0 ||
      !Array.isArray(options) ||
      !options.every((option): option is string => typeof option === "string")
    ) {
      return refuseApproval(id, tool);
    }
    const choices = readApprovalChoices(options, tool);
    if (choices === undefined) return refuseApproval(id, tool);
    approvals.set(id, choices);
    const details = match[2]?.trim();
    const timeout = recordNumber(frame, "timeout");
    return frames({
      type: "extension_ui_request",
      id,
      method: "confirm",
      title: `Allow ${tool}?`,
      ...(details === undefined || details.length === 0 ? {} : { message: details }),
      ...(timeout === undefined ? {} : { timeout }),
    });
  };

  const promptAcknowledgement = (frame: PiRpcRecord): PiRpcRecord => {
    if (frame["command"] !== "prompt") return frame;
    const id = recordString(frame, "id");
    const queued = id === undefined ? false : (sentWhileRunning.get(id) ?? false);
    if (id !== undefined) sentWhileRunning.delete(id);
    if (frame["success"] !== true) return frame;
    const data = frame["data"];
    const dataFields =
      typeof data === "object" && data !== null && !Array.isArray(data) ? data : {};
    if (recordField(data, "agentInvoked") === false) {
      return { ...frame, data: { ...dataFields, disposition: "handled" } };
    }
    return queued ? { ...frame, data: { ...dataFields, disposition: "queued" } } : frame;
  };

  const toOmp = (record: PiRpcRecord): PiRpcRecord => {
    switch (record["type"]) {
      case "prompt": {
        const id = recordString(record, "id");
        if (id !== undefined) sentWhileRunning.set(id, agentRunning);
        return record;
      }
      case "get_commands":
        return { ...record, type: "get_available_commands" };
      // Pi's fork starts the new session before the entry; omp's `fork` keeps the entry, and its
      // `branch` (which also returns the entry's text) is the one that cuts before it.
      case "fork":
        return { ...record, type: "branch" };
      // Pi's clear_queue empties the queue and leaves the run alone; omp's closest command also
      // aborts, which both callers (Stop and restart) send next anyway.
      case "clear_queue":
        return { ...record, type: "abort_and_restore_queue" };
      case "extension_ui_response": {
        const id = recordString(record, "id");
        const approval = id === undefined ? undefined : approvals.get(id);
        if (id === undefined || approval === undefined) return record;
        approvals.delete(id);
        if (record["cancelled"] === true)
          return { type: "extension_ui_response", id, cancelled: true };
        if (record["confirmed"] !== true) {
          return { type: "extension_ui_response", id, value: approval.deny };
        }
        // Without a native session choice, the grant stays a single approval.
        if (record["forSession"] === true && approval.session === undefined) {
          notices.push({
            type: "extension_ui_request",
            id: `${id}:session-unavailable`,
            method: "notify",
            notifyType: "warning",
            message: SESSION_UNAVAILABLE_NOTICE,
          });
        }
        return {
          type: "extension_ui_response",
          id,
          value:
            record["forSession"] === true && approval.session !== undefined
              ? approval.session
              : approval.approve,
        };
      }
      default:
        return record;
    }
  };

  const takeNotices = (): ReadonlyArray<PiRpcRecord> => {
    const taken = notices;
    notices = [];
    return taken;
  };

  return { fromOmp, toOmp, takeNotices };
}

/** The data of a successful response, reshaped for the command the Pi adapter sent. */
export function translateOmpResponseData(command: string, data: unknown): unknown {
  switch (command) {
    case "get_commands":
      return projectOmpCommands(data);
    case "get_state": {
      if (typeof data !== "object" || data === null || Array.isArray(data)) return data;
      const queued = recordField(data, "queuedMessages");
      const count = (key: string) => {
        const entries = recordField(queued, key);
        return Array.isArray(entries) ? entries.length : 0;
      };
      // queuedMessageCount also counts advisor cards and next-turn notes the user cannot withdraw.
      return { ...data, pendingMessageCount: count("steering") + count("followUp") };
    }
    case "clear_queue": {
      const texts = (key: string) => {
        const entries = recordField(data, key);
        return Array.isArray(entries)
          ? entries.flatMap((entry) => {
              const text = recordString(entry, "text");
              return text === undefined ? [] : [text];
            })
          : [];
      };
      return { steering: texts("steering"), followUp: texts("followUp") };
    }
    default:
      return data;
  }
}

/**
 * omp's builtin commands are TUI actions, and most do nothing useful over RPC (or reset the
 * session out from under T3). `/compact` reaches the adapter through its own RPC, so no builtin
 * is advertised here.
 */
export function projectOmpCommands(data: unknown): {
  readonly commands: ReadonlyArray<PiRpcRecord>;
} {
  const commands = recordField(data, "commands");
  if (!Array.isArray(commands)) return { commands: [] };
  const projected: Array<PiRpcRecord> = [];
  for (const command of commands) {
    const name = recordString(command, "name")?.trim();
    if (!name) continue;
    const source = recordString(command, "source");
    const piSource =
      source === "custom" || source === "file" || source === "mcp_prompt"
        ? "prompt"
        : source === "skill" || source === "extension"
          ? source
          : undefined;
    if (piSource === undefined) continue;
    const description = recordString(command, "description");
    projected.push({
      name,
      source: piSource,
      ...(description === undefined ? {} : { description }),
    });
  }
  return { commands: projected };
}

const decodeLine = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Unknown));

/** omp's first line is a title record; the `session` record that names the cwd follows it. */
export function readOmpSessionCwd(headerLines: ReadonlyArray<string>): string | undefined {
  for (const line of headerLines) {
    const record = Option.getOrUndefined(decodeLine(line));
    if (recordString(record, "type") === "session") {
      const cwd = recordString(record, "cwd");
      return cwd?.trim() ? cwd : undefined;
    }
  }
  return undefined;
}
