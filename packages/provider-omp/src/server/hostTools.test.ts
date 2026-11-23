import { describe, expect, it } from "@effect/vitest";
import { resolveT3McpToolId } from "@t3tools/shared/t3McpToolPresentation";

import { ompHostToolDefinitions, ompHostToolResult, ompMcpToolName } from "./hostTools.ts";

describe("omp host tools", () => {
  it("registers T3's MCP tools under the names Pi's bridge uses", () => {
    expect(
      ompHostToolDefinitions([
        {
          name: "delegate_task",
          description: "Start a delegated task",
          inputSchema: { type: "object", properties: { task: { type: "string" } } },
        },
        { name: "t3_thread_list" },
      ]),
    ).toEqual([
      {
        name: "mcp__t3-code__delegate_task",
        label: "delegate_task",
        description: "Start a delegated task",
        parameters: { type: "object", properties: { task: { type: "string" } } },
        loadMode: "essential",
      },
      {
        name: "mcp__t3-code__t3_thread_list",
        label: "t3_thread_list",
        description: "t3_thread_list",
        parameters: { type: "object", properties: {} },
        loadMode: "discoverable",
      },
    ]);
  });

  it("maps a host tool name back to its MCP tool", () => {
    expect(ompMcpToolName("mcp__t3-code__task_status")).toBe("task_status");
    expect(resolveT3McpToolId("mcp__t3-code__task_status")).toBe("task_status");
    expect(resolveT3McpToolId("mcp__t3_code__task_status")).toBe("task_status");
    expect(ompMcpToolName("mcp__t3-code__")).toBeUndefined();
    expect(ompMcpToolName("bash")).toBeUndefined();
  });

  it("returns text and image blocks, and falls back to structured output", () => {
    expect(
      ompHostToolResult("t", {
        content: [
          { type: "text", text: "done" },
          { type: "image", data: "AAAA", mimeType: "image/png" },
          { type: "resource" },
        ],
      }),
    ).toEqual({
      result: {
        content: [
          { type: "text", text: "done" },
          { type: "image", data: "AAAA", mimeType: "image/png" },
        ],
      },
    });
    expect(ompHostToolResult("t", { content: [], structuredContent: { ok: true } })).toEqual({
      result: { content: [{ type: "text", text: '{"ok":true}' }] },
    });
  });

  it("rejects the call when the MCP tool reports an error, and always says why", () => {
    expect(ompHostToolResult("t3_thread_read", { isError: true })).toEqual({
      result: {
        content: [{ type: "text", text: "MCP tool t3-code/t3_thread_read returned an error" }],
      },
      isError: true,
    });
    expect(
      ompHostToolResult("t", {
        isError: true,
        content: [{ type: "text", text: "no such thread" }],
      }),
    ).toEqual({
      result: { content: [{ type: "text", text: "no such thread" }] },
      isError: true,
    });
  });
});
