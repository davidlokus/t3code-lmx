import { TextGenerationError } from "@t3tools/contracts";
import * as TextGenerationOperations from "@t3tools/provider-core/server/textGenerationOperations";
import {
  findReportedPiModel,
  piRecordField,
  piRecordString,
  resolvePiModelSlug,
} from "@t3tools/provider-pi/server/rpc";
import { getModelSelectionStringOptionValue } from "@t3tools/shared/model";
import * as Effect from "effect/Effect";
import * as Path from "effect/Path";
import * as Queue from "effect/Queue";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import type { OmpSettings } from "../settings.ts";
import { withOmpAgentDir } from "./adapter.ts";
import { makeOmpRpcConnection } from "./connection.ts";
import { OMP_DIALECT, ompInventoryLaunchArgs, resolveOmpSettingsLaunchArgs } from "./dialect.ts";
import { OMP_THINKING_LEVELS } from "./modelCapabilities.ts";

const OMP_TIMEOUT_MS = 180_000;

// RPC errors and assistant failures can include upstream response bodies and credentials.
function ompTurnErrorDetail(errorMessage: string | undefined, fallback: string): string {
  const status = errorMessage?.match(/^(?:HTTP\s+)?([45]\d{2})\b/i)?.[1];
  return status === undefined
    ? fallback
    : `omp could not generate text: the model provider returned HTTP ${status}.`;
}

export const makeOmpTextGeneration = Effect.fn("makeOmpTextGeneration")(function* (
  settings: OmpSettings,
  environment: NodeJS.ProcessEnv,
) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const path = yield* Path.Path;
  const resolved = yield* resolveOmpSettingsLaunchArgs(settings, environment);
  const launch = resolved.ok
    ? OMP_DIALECT.buildLaunch({
        launchArgs: ompInventoryLaunchArgs(resolved.args, path.isAbsolute),
        environment: withOmpAgentDir(settings, environment, resolved.paths),
        mcpSession: undefined,
        extensionPath: undefined,
        ephemeral: true,
        shortLived: true,
        disableExtensions: true,
        disableTools: true,
      })
    : undefined;

  const runOmpJson: TextGenerationOperations.Runner = Effect.fnUntraced(
    function* (request) {
      const { operation, cwd, prompt, modelSelection } = request;
      if (launch === undefined) {
        return yield* new TextGenerationError({
          operation,
          detail:
            "Invalid omp launch settings. Review the instance's settings and launch arguments.",
        });
      }
      const connection = yield* makeOmpRpcConnection({
        command: settings.binaryPath || OMP_DIALECT.defaultBinary,
        args: launch.args,
        cwd,
        env: launch.env,
      }).pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner));

      const useDefault = modelSelection.model === "default";
      const requestedModel = useDefault ? settings.smolModel : modelSelection.model;
      if (requestedModel) {
        const inventory = yield* connection.request({ type: "get_available_models" }).pipe(
          Effect.catchTags({
            PiRpcError: (error) =>
              error.operation === "get_available_models" ? Effect.undefined : Effect.fail(error),
          }),
        );
        const available = piRecordField(inventory, "models");
        const model = useDefault
          ? findReportedPiModel(requestedModel, available)
          : resolvePiModelSlug(requestedModel, available);
        if (!model && !useDefault) {
          return yield* new TextGenerationError({
            operation,
            detail: "The selected omp model must use provider/model format.",
          });
        }
        if (model) {
          yield* connection.request({ type: "set_model", ...model }).pipe(
            Effect.catchTags({
              PiRpcError: (error) =>
                useDefault && error.operation === "set_model"
                  ? Effect.logDebug(
                      "omp rejected the configured Smol model; using its default model.",
                    )
                  : Effect.fail(error),
            }),
          );
        }
      }

      const thinking = getModelSelectionStringOptionValue(modelSelection, "thinking");
      if (thinking !== undefined && OMP_THINKING_LEVELS.has(thinking)) {
        yield* connection.request({ type: "set_thinking_level", level: thinking }).pipe(
          Effect.catchTags({
            PiRpcError: (error) =>
              error.operation === "set_thinking_level" ? Effect.void : Effect.fail(error),
          }),
        );
      }

      yield* connection.request({ type: "prompt", message: prompt });
      let turnError: string | undefined;
      while (true) {
        const event = yield* Queue.take(connection.events);
        if (event["type"] === "agent_settled") break;
        const message = event["message"];
        if (event["type"] === "message_end" && piRecordString(message, "role") === "assistant") {
          turnError =
            piRecordString(message, "stopReason") === "error"
              ? ompTurnErrorDetail(
                  piRecordString(message, "errorMessage"),
                  "omp could not generate text: the model provider reported an error.",
                )
              : undefined;
        }
      }
      if (turnError !== undefined) {
        return yield* new TextGenerationError({ operation, detail: turnError });
      }

      const text = piRecordString(
        yield* connection.request({ type: "get_last_assistant_text" }),
        "text",
      )?.trim();
      if (!text) {
        return yield* new TextGenerationError({ operation, detail: "omp returned empty output." });
      }
      return yield* TextGenerationOperations.decodeJsonReply(request, "omp", text);
    },
    (effect, { operation }) =>
      effect.pipe(
        Effect.timeout(OMP_TIMEOUT_MS),
        Effect.scoped,
        Effect.withTracerEnabled(false),
        Effect.mapError((error) => {
          switch (error._tag) {
            case "TextGenerationError":
              return new TextGenerationError({ operation, detail: error.detail });
            case "TimeoutError":
            case "PiRpcTimeoutError":
              return new TextGenerationError({ operation, detail: "omp request timed out." });
            case "PiRpcError":
              return new TextGenerationError({
                operation,
                detail: ompTurnErrorDetail(
                  error.detail,
                  error.operation === "set_model"
                    ? "omp rejected the selected model. Text generation runs without extensions."
                    : "omp text generation failed.",
                ),
              });
          }
        }),
      ),
  );

  return TextGenerationOperations.fromRunner(
    "OmpTextGeneration",
    TextGenerationOperations.withoutInvestigation("omp", runOmpJson),
  );
});
