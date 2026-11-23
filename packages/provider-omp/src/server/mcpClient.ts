// @effect-diagnostics globalFetch:off - Requests carry the abort signal of the Effect fiber that awaits them.
// Only the per-thread T3 server is used by this bridge.
import * as Schema from "effect/Schema";

const PROTOCOL = "2025-06-18";

const McpTool = Schema.Struct({
  name: Schema.NonEmptyString,
  description: Schema.optionalKey(Schema.String),
  inputSchema: Schema.optionalKey(Schema.Record(Schema.String, Schema.Unknown)),
});
export type OmpMcpTool = typeof McpTool.Type;

const McpCallResult = Schema.Struct({
  content: Schema.optionalKey(
    Schema.Array(
      Schema.Struct({
        type: Schema.optionalKey(Schema.String),
        text: Schema.optionalKey(Schema.String),
        data: Schema.optionalKey(Schema.String),
        mimeType: Schema.optionalKey(Schema.String),
      }),
    ),
  ),
  structuredContent: Schema.optionalKey(Schema.Unknown),
  isError: Schema.optionalKey(Schema.Boolean),
});
export type OmpMcpCallResult = typeof McpCallResult.Type;

const decodeCallResult = Schema.decodeUnknownSync(McpCallResult);
const decodeToolsPage = Schema.decodeUnknownSync(
  Schema.Struct({
    tools: Schema.Array(McpTool),
    nextCursor: Schema.optionalKey(Schema.String),
  }),
);
const decodeResponse = Schema.decodeUnknownOption(
  Schema.fromJsonString(
    Schema.Struct({
      id: Schema.Number,
      result: Schema.optionalKey(Schema.Unknown),
      error: Schema.optionalKey(Schema.Unknown),
    }),
  ),
);

function parseBody(body: string, contentType: string, id: number) {
  if (!contentType.includes("text/event-stream")) {
    const parsed = decodeResponse(body);
    if (parsed._tag === "Some" && parsed.value.id === id) return parsed.value;
  } else {
    for (const line of body.split("\n")) {
      if (!line.startsWith("data:")) continue;
      const parsed = decodeResponse(line.slice(5).trim());
      if (parsed._tag === "Some" && parsed.value.id === id) return parsed.value;
    }
  }
  throw new Error("MCP response had no matching JSON-RPC payload.");
}

export function makeOmpMcpClient(endpoint: string, authorizationHeader: string) {
  let nextId = 1;
  let sessionId: string | undefined;

  const headers = (): Record<string, string> => ({
    accept: "application/json, text/event-stream",
    authorization: authorizationHeader,
    "content-type": "application/json",
    "mcp-protocol-version": PROTOCOL,
    ...(sessionId === undefined ? {} : { "mcp-session-id": sessionId }),
  });

  const request = async (method: string, params: unknown, signal?: AbortSignal) => {
    const id = nextId++;
    const response = await fetch(endpoint, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
      redirect: "error",
      ...(signal === undefined ? {} : { signal }),
    });
    sessionId = response.headers.get("mcp-session-id") ?? sessionId;
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error(`MCP ${method} failed (${response.status}).`);
    }
    const body = await response.text();
    const parsed = parseBody(body, response.headers.get("content-type") ?? "", id);
    if (parsed.error !== undefined) {
      throw new Error(`MCP ${method} returned a JSON-RPC error.`);
    }
    return parsed.result;
  };

  return {
    async connect(signal?: AbortSignal): Promise<void> {
      await request(
        "initialize",
        {
          protocolVersion: PROTOCOL,
          capabilities: {},
          clientInfo: { name: "t3-omp-mcp", version: "1.0.0" },
        },
        signal,
      );
      const initialized = await fetch(endpoint, {
        method: "POST",
        headers: headers(),
        body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized", params: {} }),
        redirect: "error",
        ...(signal === undefined ? {} : { signal }),
      });
      await initialized.body?.cancel();
      if (!initialized.ok) {
        throw new Error(`MCP initialized notification failed (${initialized.status})`);
      }
    },
    async listTools(signal?: AbortSignal): Promise<ReadonlyArray<OmpMcpTool>> {
      const tools: Array<OmpMcpTool> = [];
      let cursor: string | undefined;
      do {
        const result = decodeToolsPage(
          await request("tools/list", cursor === undefined ? {} : { cursor }, signal),
        );
        tools.push(...result.tools);
        cursor = result.nextCursor;
      } while (cursor);
      return tools;
    },
    async callTool(
      name: string,
      args: Record<string, unknown>,
      signal?: AbortSignal,
    ): Promise<OmpMcpCallResult> {
      return decodeCallResult(await request("tools/call", { name, arguments: args }, signal));
    },
  };
}

export class OmpMcpError extends Schema.TaggedError<OmpMcpError>()("OmpMcpError", {
  operation: Schema.String,
  cause: Schema.Defect(),
}) {
  override get message(): string {
    return `omp MCP ${this.operation} failed.`;
  }
}
