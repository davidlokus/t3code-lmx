import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import { parsePiDiscoveredCommands } from "@t3tools/provider-pi/server/commands";
import { makePiRpcConnection, piRecordField } from "@t3tools/provider-pi/server/rpc";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import { OMP_DIALECT } from "./dialect.ts";
import { ompHostToolDefinitions } from "./hostTools.ts";
import { projectOmpCommands } from "./protocol.ts";
import { checkOmpProviderStatus, parseOmpModels } from "./status.ts";

// Opt in with OMP_LIVE_BINARY=/absolute/path/to/omp; the test never uses the user's profile.
const binaryPath = process.env["OMP_LIVE_BINARY"];
const hostPath = process.env["PATH"] ?? "";

describe.skipIf(!binaryPath)("omp native RPC", () => {
  it.live("discovers its catalog and registers T3 host tools without opening a model turn", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      if (binaryPath === undefined || !path.isAbsolute(binaryPath)) {
        return assert.fail("OMP_LIVE_BINARY must be an absolute path to omp");
      }
      const home = yield* fs.makeTempDirectoryScoped({ prefix: "t3-omp-live-" });
      const cwd = path.join(home, "workspace");
      const agentDir = path.join(home, ".omp", "agent");
      const skills = path.join(cwd, ".omp", "skills", "t3-live-check");
      yield* fs.makeDirectory(skills, { recursive: true });
      yield* fs.writeFileString(
        path.join(skills, "SKILL.md"),
        "---\nname: t3-live-check\ndescription: Verify native skill discovery.\n---\nRead-only fixture.\n",
      );
      const commandsDir = path.join(cwd, ".omp", "commands");
      yield* fs.makeDirectory(commandsDir, { recursive: true });
      yield* fs.writeFileString(
        path.join(commandsDir, "t3-live-command.md"),
        "---\ndescription: Verify native file command discovery.\n---\nRead-only fixture.\n",
      );
      const environment = {
        PATH: hostPath,
        HOME: home,
        USERPROFILE: home,
        PI_CODING_AGENT_DIR: agentDir,
        // The bundled catalog only needs presence of a key; no prompt is sent.
        OPENAI_API_KEY: "not-a-real-openai-key",
      };
      const settings = { enabled: true, binaryPath, launchArgs: "", customModels: [] };
      const status = yield* checkOmpProviderStatus(settings, environment, cwd);
      assert.equal(status.status, "ready", status.message);
      assert.match(status.version ?? "", /^\d+\.\d+\.\d+/);
      assert.isTrue(status.models.some((model) => model.slug.startsWith("openai/")));
      assert.isTrue(
        status.models.some((model) =>
          model.capabilities?.optionDescriptors?.some((option) => option.id === "thinking"),
        ),
      );

      const launch = OMP_DIALECT.buildLaunch({
        launchArgs: ["--no-lsp", "--no-title"],
        environment,
        mcpSession: undefined,
        extensionPath: undefined,
        ephemeral: true,
        shortLived: true,
        disableExtensions: true,
      });
      const connection = yield* makePiRpcConnection({
        command: binaryPath,
        args: launch.args,
        cwd,
        env: launch.env,
      });
      const state = yield* connection.request({ type: "get_state" });
      const catalog = yield* connection.request({ type: "get_available_models" });
      const models = parseOmpModels(catalog, state);
      assert.isTrue(
        models?.some((model) =>
          model.capabilities?.optionDescriptors?.some(
            (option) =>
              option.id === "thinking" && option.type === "select" && option.options.length > 1,
          ),
        ) ?? false,
      );

      const commands = yield* connection.request({ type: "get_available_commands" });
      const discovered = parsePiDiscoveredCommands(projectOmpCommands(commands));
      assert.include(
        discovered.skills.map((skill) => skill.name),
        "t3-live-check",
      );
      assert.include(
        discovered.slashCommands.map((command) => command.name),
        "t3-live-command",
      );

      const tools = ompHostToolDefinitions([
        {
          name: "task_status",
          description: "Report the status of a delegated task.",
          inputSchema: { type: "object", properties: { taskId: { type: "string" } } },
        },
      ]);
      const registered = yield* connection.request({ type: "set_host_tools", tools });
      const toolName = "mcp__t3-code__task_status";
      assert.deepEqual(registered, { toolNames: [toolName] });
      const dumpTools = piRecordField(
        yield* connection.request({ type: "get_state" }),
        "dumpTools",
      );
      assert.isTrue(
        Array.isArray(dumpTools) &&
          dumpTools.some((tool) => piRecordField(tool, "name") === toolName),
      );
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});
