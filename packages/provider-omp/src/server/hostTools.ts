import type { PiRpcRecord } from "@t3tools/provider-pi/server/rpc";

import type { OmpMcpCallResult, OmpMcpTool } from "./mcpClient.ts";

// Pi's public name; its underscore-prefixed alias is specific to Pi's native MCP registration.
const OMP_T3_TOOL_PREFIX = "mcp__t3-code__";

// These stay top-level tools; the rest load on demand through omp's xd:// tool devices.
const ESSENTIAL_TOOLS = new Set(["orchestrator_capabilities", "delegate_task", "task_status"]);

export function ompHostToolDefinitions(tools: ReadonlyArray<OmpMcpTool>): Array<PiRpcRecord> {
  return tools.map((tool) => {
    const schema = tool.inputSchema ?? {};
    return {
      name: `${OMP_T3_TOOL_PREFIX}${tool.name}`,
      label: tool.name,
      description: tool.description?.trim() || tool.name,
      // Zero-argument MCP tools may omit `properties`, which some OpenAI-compatible servers reject.
      parameters: {
        ...schema,
        type: schema["type"] ?? "object",
        ...(schema["properties"] === undefined ? { properties: {} } : {}),
      },
      loadMode: ESSENTIAL_TOOLS.has(tool.name) ? "essential" : "discoverable",
    };
  });
}

export function ompMcpToolName(hostToolName: string): string | undefined {
  if (!hostToolName.startsWith(OMP_T3_TOOL_PREFIX)) return undefined;
  return hostToolName.slice(OMP_T3_TOOL_PREFIX.length) || undefined;
}

type HostContent =
  | { readonly type: "text"; readonly text: string }
  | { readonly type: "image"; readonly data: string; readonly mimeType: string };

export function ompHostToolResult(
  toolName: string,
  result: OmpMcpCallResult,
): { readonly result: { readonly content: Array<HostContent> }; readonly isError?: true } {
  const content: Array<HostContent> = [];
  for (const part of result.content ?? []) {
    if (part.type === "text" && typeof part.text === "string") {
      content.push({ type: "text", text: part.text });
    } else if (
      part.type === "image" &&
      typeof part.data === "string" &&
      typeof part.mimeType === "string"
    ) {
      content.push({ type: "image", data: part.data, mimeType: part.mimeType });
    }
  }
  // Structured output belongs to scripts; use it as model text only when nothing else came back.
  if (content.length === 0 && result.isError !== true) {
    content.push({ type: "text", text: JSON.stringify(result.structuredContent ?? result) });
  }
  if (result.isError === true) {
    if (!content.some((part) => part.type === "text" && part.text.length > 0)) {
      content.push({ type: "text", text: `MCP tool t3-code/${toolName} returned an error` });
    }
    return { result: { content }, isError: true };
  }
  return { result: { content } };
}
