import { describe, expect, it } from "@effect/vitest";
import { EnvironmentId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import type { McpProviderSessionConfig } from "@t3tools/provider-core/server/mcpSession";
import * as Effect from "effect/Effect";
import * as Path from "effect/Path";

import { buildOmpRpcLaunch, ompInventoryLaunchArgs, resolveOmpLaunchArgs } from "./dialect.ts";
import { ompModelCapabilities } from "./modelCapabilities.ts";

const launch = (input: Partial<Parameters<typeof buildOmpRpcLaunch>[0]> = {}) =>
  buildOmpRpcLaunch({
    launchArgs: [],
    environment: { HOME: "/home/user" },
    mcpSession: undefined,
    extensionPath: undefined,
    ...input,
  });

describe("omp launch arguments", () => {
  it("accepts ordinary flags, with or without = for flags that take a value", () => {
    expect(resolveOmpLaunchArgs("--model=opus --thinking high --no-lsp")).toEqual({
      ok: true,
      args: ["--model", "opus", "--thinking", "high", "--no-lsp"],
    });
    expect(resolveOmpLaunchArgs("")).toEqual({ ok: true, args: [] });
  });

  it.each([
    ["--mode text", "--mode"],
    ["--resume abc", "--resume"],
    ["-c", "-c"],
    ["--yolo", "--yolo"],
    ["--auto-approve", "--auto-approve"],
    ["--approval-mode=yolo", "--approval-mode"],
    ["--no-session", "--no-session"],
    // T3 starts the fork of a session itself, so a second --fork would race its own.
    ["--fork /other.jsonl", "--fork"],
    ["--fork=/other.jsonl", "--fork"],
    ["--session=/other.jsonl", "--session"],
    ["--from-claude", "--from-claude"],
    ["--from-codex", "--from-codex"],
    ["--cwd /other", "--cwd"],
    ["--goal 'start work'", "--goal"],
    ["--plan-yolo", "--plan-yolo"],
    ["--plan-yolo-into opus", "--plan-yolo-into"],
    ["--restore=other", "--restore"],
    ["--alias shortcut", "--alias"],
    ["--no-ui", "--no-ui"],
  ])("keeps T3's own flag %s out of the settings", (launchArgs, flag) => {
    expect(resolveOmpLaunchArgs(launchArgs)).toEqual({
      ok: false,
      message: `omp launch argument '${flag}' is controlled by T3 Code and cannot be overridden.`,
    });
  });

  it.each([
    ["-r=/tmp/x", "-r"],
    ["-c=foo", "-c"],
    ["-cr", "-c"],
    ["-rabc", "-r"],
    ["-xp", "-p"],
    ["--no-lsp -ve", "-v"],
    ["-er", "-r"],
    ["--print=1", "--print"],
  ])("sees T3's own flag through the short forms of %s", (launchArgs, flag) => {
    expect(resolveOmpLaunchArgs(launchArgs)).toEqual({
      ok: false,
      message: `omp launch argument '${flag}' is controlled by T3 Code and cannot be overridden.`,
    });
  });

  it("accepts native -e values but rejects attached short arguments OMP does not parse", () => {
    expect(resolveOmpLaunchArgs("-e /ext/a.ts -e=/ext/b.ts")).toEqual({
      ok: true,
      args: ["-e", "/ext/a.ts", "-e", "/ext/b.ts"],
    });
    expect(resolveOmpLaunchArgs("-e/ext/x.ts").ok).toBe(false);
    expect(resolveOmpLaunchArgs("--plan opus --profile team")).toEqual({
      ok: true,
      args: ["--plan=opus", "--profile", "team"],
    });
  });

  it("rejects a stray prompt, which omp would otherwise send as the first message", () => {
    expect(resolveOmpLaunchArgs("--no-lsp list the files")).toEqual({
      ok: false,
      message: "omp launch arguments cannot include positional prompt 'list'.",
    });
    expect(resolveOmpLaunchArgs("--model")).toEqual({
      ok: false,
      message: "omp launch argument '--model' requires a non-flag value.",
    });
    for (const args of ["--plan --yolo", "--model=--resume", "--model --", "--=end", "-"]) {
      expect(resolveOmpLaunchArgs(args).ok).toBe(false);
    }
  });

  it.effect("passes only the profile and cwd-independent config overlays to static discovery", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const resolved = resolveOmpLaunchArgs(
        "--profile team --config /config/extra.yml --config relative.yml --model=opus --hook /hook.ts",
      );
      if (!resolved.ok) throw new Error(resolved.message);
      expect(ompInventoryLaunchArgs(resolved.args, path.isAbsolute)).toEqual([
        "--profile",
        "team",
        "--config",
        "/config/extra.yml",
      ]);
    }).pipe(Effect.provide(Path.layer)),
  );
});

describe("omp launch command line", () => {
  it("binds the session by file and maps each runtime mode to omp's own approval mode", () => {
    expect(launch({ sessionPath: "/s/a.jsonl", runtimeMode: "approval-required" }).args).toEqual([
      "--mode",
      "rpc",
      "--resume",
      "/s/a.jsonl",
      "--approval-mode",
      "always-ask",
    ]);
    const modeOf = (runtimeMode: "auto" | "auto-accept-edits" | "full-access") =>
      launch({ runtimeMode }).args.at(-1);
    expect(modeOf("auto")).toBe("always-ask");
    expect(modeOf("auto-accept-edits")).toBe("write");
    expect(modeOf("full-access")).toBe("yolo");
  });

  it("puts T3's approval mode after the user's arguments", () => {
    const args = launch({ launchArgs: ["--thinking", "high"], runtimeMode: "full-access" }).args;
    expect(args.indexOf("--thinking")).toBeLessThan(args.indexOf("--approval-mode"));
  });

  it("starts probes without a session, extensions, tools or an approval mode", () => {
    expect(launch({ ephemeral: true, disableExtensions: true, disableTools: true }).args).toEqual([
      "--mode",
      "rpc",
      "--no-session",
      "--no-extensions",
      "--no-tools",
    ]);
  });

  it("strips explicit extension roots, hooks, and tool overrides from a short-lived fork", () => {
    const launchArgs = resolveOmpLaunchArgs(
      "--profile team --extension=/e.ts -e /x.ts --trusted-extension /t.ts --hook /h.ts --plugin-dir /plugins --tools bash --thinking high",
    );
    if (!launchArgs.ok) throw new Error(launchArgs.message);
    expect(
      launch({
        shortLived: true,
        disableExtensions: true,
        disableTools: true,
        launchArgs: launchArgs.args,
      }).args,
    ).toEqual([
      "--mode",
      "rpc",
      "--profile",
      "team",
      "--thinking",
      "high",
      "--no-extensions",
      "--no-tools",
    ]);
  });

  it("appends T3's orchestration guidance only when the thread has MCP tools", () => {
    const withoutMcp = launch().args;
    expect(withoutMcp).not.toContain("--append-system-prompt");
    const mcpSession: McpProviderSessionConfig = {
      endpoint: "http://127.0.0.1:1/mcp",
      authorizationHeader: "Bearer x",
      environmentId: EnvironmentId.make("environment"),
      threadId: ThreadId.make("thread"),
      providerSessionId: "provider-session",
      providerInstanceId: ProviderInstanceId.make("omp"),
      browserToolsAvailable: false,
    };
    const args = launch({ mcpSession }).args;
    expect(args.at(-2)).toBe("--append-system-prompt");
    expect(args.at(-1)).toContain("T3 Code orchestration");
  });

  it("passes the instance environment through untouched", () => {
    expect(launch().env).toEqual({ HOME: "/home/user" });
  });
});

describe("omp thinking catalog", () => {
  it("reads both native RPC and static CLI catalogs without inventing an active default", () => {
    const efforts = ["max", "low", "unknown", "low", "xhigh"];
    const rpc = ompModelCapabilities({ reasoning: true, thinking: { efforts } }, "xhigh");
    const cli = ompModelCapabilities({ reasoning: true, thinking: efforts }, undefined);
    expect(rpc.optionDescriptors?.[0]).toMatchObject({
      options: [{ id: "off" }, { id: "low" }, { id: "xhigh", isDefault: true }, { id: "max" }],
    });
    const cliDescriptor = cli.optionDescriptors?.[0];
    if (cliDescriptor?.type !== "select") throw new Error("Expected thinking choices");
    expect(cliDescriptor.options).toMatchObject([
      { id: "off" },
      { id: "low" },
      { id: "xhigh" },
      { id: "max" },
    ]);
    expect(cliDescriptor.options.some((choice) => choice.isDefault === true)).toBe(false);
    expect(
      ompModelCapabilities({ reasoning: true, thinking: null }, undefined).optionDescriptors,
    ).toEqual([]);
  });
});
