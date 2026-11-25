import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientResponse from "effect/http/HttpClientResponse";

import { readOpenCodeGoUsageLimits } from "./usageLimits.ts";

it.effect("scopes every window to its OpenCode Go subscription", () =>
  Effect.gen(function* () {
    const resetsAt = "2026-09-17T12:00:00.000Z";
    const limits = yield* readOpenCodeGoUsageLimits({
      enabled: true,
      serverUrl: "",
      environment: {
        XDG_DATA_HOME: "/instance/data",
        OPENCODE_AUTH_CONTENT: JSON.stringify({ "opencode-go": { type: "api", key: "go-key" } }),
      },
    }).pipe(
      Effect.provideService(
        HttpClient.HttpClient,
        HttpClient.make((request) =>
          Effect.succeed(
            HttpClientResponse.fromWeb(
              request,
              Response.json({
                usage: {
                  rolling: { percent: 0, resetsAt },
                  weekly: { percent: 10, resetsAt },
                  monthly: { percent: 125, resetsAt },
                },
              }),
            ),
          ),
        ),
      ),
      Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
    );

    expect(limits.planTier).toBe("OpenCode Go");
    expect(limits.windows).toMatchObject([
      { id: "go_rolling", category: "plan", scopeLabel: "OpenCode Go", usedPercent: 0 },
      { id: "go_weekly", category: "plan", scopeLabel: "OpenCode Go", usedPercent: 10 },
      { id: "go_monthly", category: "plan", scopeLabel: "OpenCode Go", usedPercent: 100 },
    ]);
  }),
);
