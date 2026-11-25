import { describe, expect, it } from "@effect/vitest";
import * as Schema from "effect/Schema";

import { piUsageFormat } from "./usage.ts";

const codec = piUsageFormat.state!;
const encodeState = Schema.encodeSync(codec.schema);
const decodeState = Schema.decodeUnknownSync(codec.schema);

describe("piUsageFormat session metadata", () => {
  it("retains the session cwd across a resume and uses the latest native name", () => {
    const state = codec.initial();
    piUsageFormat.parseLine(
      JSON.stringify({ type: "session", id: "pi-session", cwd: "/work/pi" }),
      state,
    );
    piUsageFormat.parseProjected({ type: "session_info", name: "First name" }, state);

    const resumed = decodeState(encodeState(state));
    const [usage] = piUsageFormat.parseProjected(
      {
        type: "message",
        id: "msg-1",
        timestamp: "2026-11-24T04:15:08Z",
        message: { role: "assistant", provider: "openai", model: "gpt", usage: { output: 3 } },
      },
      resumed,
    );
    expect(usage).toMatchObject({ sessionId: "pi-session", cwd: "/work/pi" });
    expect(piUsageFormat.readSessionTitles?.(resumed).get("pi-session")).toBe("First name");
    piUsageFormat.parseLine(JSON.stringify({ type: "session_info", name: "Renamed" }), resumed);
    expect(piUsageFormat.readSessionTitles?.(resumed).get("pi-session")).toBe("Renamed");
    piUsageFormat.parseProjected({ type: "session_info", name: "" }, resumed);
    expect(piUsageFormat.readSessionTitles?.(resumed).has("pi-session")).toBe(false);
  });
});
