import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import type { ReadQuotaJson } from "../UsageLimitSources.ts";
import { readCopilotUsage } from "./copilot.ts";

const TOKEN = "copilot-fixture-only";
const USER = "https://api.github.com/copilot_internal/user";
const SUMMARY_SUFFIX = "/settings/billing/usage/summary";

it.effect(
  "uses Copilot headers and reports real credits and overage, not legacy fallback rows",
  () =>
    Effect.gen(function* () {
      const readJson: ReadQuotaJson = (url, headers) => {
        expect(url).toBe(USER);
        expect(headers).toMatchObject({
          Authorization: `token ${TOKEN}`,
          "Editor-Version": expect.stringMatching(/^vscode\//),
          "Editor-Plugin-Version": expect.stringMatching(/^copilot-chat\//),
          "User-Agent": expect.stringMatching(/^GitHubCopilotChat\//),
          "X-Github-Api-Version": "2025-04-01",
        });
        return Effect.succeed({
          status: 200,
          body: {
            copilot_plan: "pro_plus",
            quota_reset_date: "2026-12-01T00:00:00Z",
            quota_snapshots: {
              premium_interactions: {
                entitlement: 200,
                remaining: 150,
                percent_remaining: 75,
                overage_permitted: true,
                overage_count: 6,
              },
              chat: { unlimited: true, entitlement: 50, remaining: 20 },
              completions: { entitlement: 2000, remaining: -1, percent_remaining: 100 },
            },
            monthly_quotas: { chat: 50, completions: 2000 },
            limited_user_quotas: { chat: 25, completions: 1000 },
            token_based_billing: true,
          },
        });
      };
      const { result: usage } = yield* readCopilotUsage(TOKEN, readJson);
      expect(usage.quotaAccounts).toMatchObject([
        {
          planTier: "Pro Plus",
          windows: [
            {
              label: "Credits",
              usedPercent: 25,
              resetsAt: "2026-12-01T00:00:00.000Z",
              usedAmount: 50,
              limitAmount: 200,
              remainingAmount: 150,
              unit: "credits",
            },
          ],
          balances: [{ label: "Extra Usage", remaining: 6, unit: "credits", kind: "overage" }],
        },
      ]);
    }),
);

it.effect.each([
  { unlimited: true },
  { entitlement: -1 },
  { entitlement: 50, remaining: -1 },
  { entitlement: 0 },
])("uses dated legacy quota only when a modern snapshot has no finite quota (%j)", (snapshot) =>
  Effect.gen(function* () {
    const { result: usage } = yield* readCopilotUsage(TOKEN, () =>
      Effect.succeed({
        status: 200,
        body: {
          limited_user_reset_date: "2026-12-19",
          quota_snapshots: { chat: { percent_remaining: 100, ...snapshot } },
          limited_user_quotas: { chat: 25, completions: -1 },
          monthly_quotas: { chat: 50, completions: 2000 },
        },
      }),
    );
    expect(usage.quotaAccounts?.[0]?.windows).toMatchObject([
      {
        label: "Chat",
        usedPercent: 50,
        resetsAt: "2026-12-19",
        remainingAmount: 25,
        limitAmount: 50,
      },
    ]);
  }),
);

it.effect(
  "combines personal consumed credits and verified seat org billing via /organizations without a percent bar",
  () =>
    Effect.gen(function* () {
      const requested: string[] = [];
      const { seatScope, result: usage } = yield* readCopilotUsage(TOKEN, (url, headers) => {
        if (url === USER)
          return Effect.succeed({
            status: 200,
            body: {
              copilot_plan: "business",
              token_based_billing: true,
              organization_login_list: ["Acme"],
              quota_snapshots: {
                premium_interactions: {
                  entitlement: 0,
                  percent_remaining: 100,
                  credits_used: 7.5,
                  overage_permitted: true,
                  overage_count: 0,
                },
              },
            },
          });
        expect(headers).toMatchObject({
          Authorization: `token ${TOKEN}`,
          Accept: "application/vnd.github+json",
          "X-Github-Api-Version": "2022-11-28",
        });
        requested.push(new URL(url).pathname);
        expect(url).toBe(`https://api.github.com/organizations/acme${SUMMARY_SUFFIX}`);
        return Effect.succeed({
          status: 200,
          body: {
            usageItems: [
              { product: "copilot", unitType: "ai-units", grossQuantity: 15, netAmount: 0.5 },
              { product: "Copilot", unitType: "AI-Credits", grossQuantity: 20, netAmount: 1 },
              { product: "copilot", unitType: "seats", grossQuantity: 10, netAmount: 300 },
              { product: "actions", unitType: "ai-credits", grossQuantity: 800, netAmount: 9 },
            ],
          },
        });
      });
      expect(seatScope).toBe("org:acme");
      expect(usage.error).toBeUndefined();
      expect(requested).toEqual([`/organizations/acme${SUMMARY_SUFFIX}`]);
      expect(usage.quotaAccounts).toMatchObject([
        {
          planTier: "Business",
          windows: [],
          balances: [
            { id: "credits-used", label: "Credits Used", remaining: 7.5, unit: "credits" },
            { id: "org-credits-acme", label: "Org Credits (Acme)", remaining: 35, unit: "credits" },
            { id: "org-spend-acme", label: "Org Spend (Acme)", remaining: 1.5, unit: "USD" },
          ],
        },
      ]);
    }),
);

it.effect.each([
  { creditsUsed: 0, status: 403 },
  { creditsUsed: 9, status: 404 },
])(
  "omits org billing cleanly when the seat lacks billing-admin access (credits=$creditsUsed, HTTP $status)",
  ({ creditsUsed, status }) =>
    Effect.gen(function* () {
      const probed: string[] = [];
      const { result: usage } = yield* readCopilotUsage(TOKEN, (url) => {
        if (url === USER)
          return Effect.succeed({
            status: 200,
            body: {
              token_based_billing: true,
              copilot_plan: "enterprise",
              credits_used: creditsUsed,
              organization_login_list: ["Acme"],
            },
          });
        probed.push(new URL(url).pathname);
        return Effect.succeed({ status });
      });
      expect(usage.error).toBeUndefined();
      expect(probed).toEqual([`/organizations/acme${SUMMARY_SUFFIX}`]);
      expect(usage.quotaAccounts).toMatchObject([{ planTier: "Enterprise", windows: [] }]);
      expect(usage.quotaAccounts?.[0]?.balances).toEqual(
        creditsUsed === 0
          ? undefined
          : [
              {
                id: "credits-used",
                label: "Credits Used",
                remaining: creditsUsed,
                unit: "credits",
                kind: "spend",
              },
            ],
      );
    }),
);

it.effect("does not guess an org via /user/orgs when multiple or zero seat orgs are listed", () =>
  Effect.gen(function* () {
    const requested: string[] = [];
    for (const orgs of [[], ["Acme", "Beta"]]) {
      const { seatScope, result: usage } = yield* readCopilotUsage(TOKEN, (url) => {
        requested.push(new URL(url).pathname);
        if (url === USER)
          return Effect.succeed({
            status: 200,
            body: {
              token_based_billing: true,
              copilot_plan: "business",
              credits_used: 4,
              organization_login_list: orgs,
            },
          });
        return Effect.die(`Unexpected GitHub probe: ${url}`);
      });
      expect(seatScope).toBe("seat:personal");
      expect(usage.error).toBeUndefined();
      expect(usage.quotaAccounts?.[0]?.balances).toEqual([
        {
          id: "credits-used",
          label: "Credits Used",
          remaining: 4,
          unit: "credits",
          kind: "spend",
        },
      ]);
    }
    expect(requested).toEqual(["/copilot_internal/user", "/copilot_internal/user"]);
  }),
);

it.effect("accepts an explicit empty usageItems array without error", () =>
  Effect.gen(function* () {
    const { seatScope, result: usage } = yield* readCopilotUsage(TOKEN, (url) =>
      url === USER
        ? Effect.succeed({
            status: 200,
            body: {
              token_based_billing: true,
              copilot_plan: "business",
              credits_used: 3,
              organization_login_list: ["Acme"],
            },
          })
        : Effect.succeed({ status: 200, body: { usageItems: [] } }),
    );
    expect(seatScope).toBe("org:acme");
    expect(usage.error).toBeUndefined();
    expect(usage.quotaAccounts?.[0]?.balances).toEqual([
      { id: "credits-used", label: "Credits Used", remaining: 3, unit: "credits", kind: "spend" },
    ]);
  }),
);

it.effect(
  "scopes a valid seat response without token_based_billing or windows so prior org rows are not borrowed",
  () =>
    Effect.gen(function* () {
      const { seatScope, result: usage } = yield* readCopilotUsage(TOKEN, () =>
        Effect.succeed({
          status: 200,
          body: {
            copilot_plan: "business",
            organization_login_list: ["NewOrg"],
          },
        }),
      );
      expect(seatScope).toBe("seat:neworg");
      expect(usage).toEqual({
        accounts: [],
        error: "GitHub Copilot returned no usable quota data.",
      });
    }),
);

it.effect.each([
  { name: "empty body", body: {} },
  { name: "empty organization object", body: { organization: {} } },
  { name: "null entry in organization_login_list", body: { organization_login_list: [null] } },
])(
  "omits seatScope on malformed or empty 200 seat payloads so last-good org data is preserved ($name)",
  ({ body }) =>
    Effect.gen(function* () {
      const { seatScope, result: usage } = yield* readCopilotUsage(TOKEN, () =>
        Effect.succeed({ status: 200, body }),
      );
      expect(seatScope).toBeUndefined();
      expect(usage).toEqual({
        accounts: [],
        error: "GitHub Copilot returned no usable quota data.",
      });
    }),
);

it.effect("keeps explicit empty organization_login_list fail-closed as seat:personal", () =>
  Effect.gen(function* () {
    const { seatScope, result: usage } = yield* readCopilotUsage(TOKEN, () =>
      Effect.succeed({ status: 200, body: { organization_login_list: [] } }),
    );
    expect(seatScope).toBe("seat:personal");
    expect(usage).toEqual({
      accounts: [],
      error: "GitHub Copilot returned no usable quota data.",
    });
  }),
);

it.effect.each([
  {
    name: "transient 503",
    response: { status: 503 },
    expectedError: "GitHub Copilot org billing request failed (HTTP 503).",
  },
  {
    name: "malformed 200 envelope",
    response: { status: 200, body: { unexpected: true } },
    expectedError: "GitHub Copilot returned malformed org billing data.",
  },
  {
    name: "null entry in usageItems",
    response: { status: 200, body: { usageItems: [null] } },
    expectedError: "GitHub Copilot returned malformed org billing data.",
  },
  {
    name: "matching row with null netAmount",
    response: {
      status: 200,
      body: {
        usageItems: [
          { product: "copilot", unitType: "ai-credits", grossQuantity: 20, netAmount: null },
        ],
      },
    },
    expectedError: "GitHub Copilot returned malformed org billing data.",
  },
])(
  "reports an error while keeping personal credits when org billing fails ($name)",
  ({ response, expectedError }) =>
    Effect.gen(function* () {
      const { seatScope, result: usage } = yield* readCopilotUsage(TOKEN, (url) => {
        if (url === USER)
          return Effect.succeed({
            status: 200,
            body: {
              token_based_billing: true,
              copilot_plan: "business",
              credits_used: 7.5,
              organization_login_list: ["Acme"],
            },
          });
        return Effect.succeed(response);
      });
      expect(seatScope).toBe("org:acme");
      expect(usage).toEqual({
        accounts: [],
        error: expectedError,
        quotaAccounts: [
          {
            id: "copilot",
            label: "GitHub Copilot",
            planTier: "Business",
            windows: [],
            balances: [
              {
                id: "credits-used",
                label: "Credits Used",
                remaining: 7.5,
                unit: "credits",
                kind: "spend",
              },
            ],
          },
        ],
      });
    }),
);

it.effect("reports rejected tokens without exposing the response payload", () =>
  Effect.gen(function* () {
    const { result: usage } = yield* readCopilotUsage(TOKEN, () =>
      Effect.succeed({ status: 403, body: { message: TOKEN } }),
    );
    expect(usage).toEqual({ accounts: [], error: "GitHub Copilot rejected the token (HTTP 403)." });
  }),
);
