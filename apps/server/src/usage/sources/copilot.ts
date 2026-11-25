import type {
  ServerProviderUsageBalance,
  ServerProviderUsageWindow,
  UsageLimitSourceSnapshot,
} from "@t3tools/contracts";
import { clampPercent } from "@t3tools/provider-core/server/usageLimits";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import type { ReadQuotaJson } from "../UsageLimitSources.ts";

const GITHUB_ORIGIN = "https://api.github.com";
export const COPILOT_USAGE_ENDPOINT = `${GITHUB_ORIGIN}/copilot_internal/user`;
const ORG_LOGIN = /^[a-z\d]+(?:-[a-z\d]+)*$/i;
const BUCKETS = [
  { id: "premium_interactions", label: "Credits", unit: "credits" },
  { id: "chat", label: "Chat", unit: "requests" },
  { id: "completions", label: "Completions", unit: "requests" },
] as const;

type Bucket = (typeof BUCKETS)[number];
type Reading = Pick<UsageLimitSourceSnapshot, "accounts" | "quotaAccounts" | "error">;

function record(value: unknown): Readonly<Record<string, unknown>> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : undefined;
}

function finite(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function resetDate(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const text = value.trim();
  if (!/^\d{4}-\d{2}-\d{2}(?:$|T)/.test(text)) return undefined;
  const parsed = DateTime.make(text);
  if (Option.isNone(parsed)) return undefined;
  const iso = DateTime.formatIso(parsed.value);
  return text.length !== 10 ? iso : iso.startsWith(`${text}T`) ? text : undefined;
}

function quotaWindow(
  bucket: Bucket,
  entitlement: number | undefined,
  remaining: number | undefined,
  percentRemaining: number | undefined,
  resetsAt: string | undefined,
): ServerProviderUsageWindow | undefined {
  if (
    (entitlement !== undefined && entitlement <= 0) ||
    (remaining !== undefined && remaining < 0)
  ) {
    return undefined;
  }
  const hasCounts = entitlement !== undefined && remaining !== undefined;
  const usedPercent =
    percentRemaining !== undefined
      ? 100 - percentRemaining
      : hasCounts
        ? (1 - remaining / entitlement) * 100
        : undefined;
  if (usedPercent === undefined) return undefined;
  return {
    id: bucket.id,
    label: bucket.label,
    kind: "monthly",
    category: "plan",
    usedPercent: clampPercent(usedPercent),
    ...(resetsAt === undefined ? {} : { resetsAt }),
    ...(hasCounts
      ? {
          usedAmount: Math.max(0, entitlement - remaining),
          limitAmount: entitlement,
          remainingAmount: remaining,
          unit: bucket.unit,
        }
      : {}),
  };
}

function validOrgLogin(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 && trimmed.length <= 39 && ORG_LOGIN.test(trimmed)
    ? trimmed
    : undefined;
}

function resolveSeatBillingOrg(body: Readonly<Record<string, unknown>>): string | undefined {
  const candidates = new Map<string, string>();
  const add = (value: unknown) => {
    const login = validOrgLogin(value);
    if (login !== undefined && !candidates.has(login.toLowerCase())) {
      candidates.set(login.toLowerCase(), login);
    }
  };
  if (Array.isArray(body.organization_login_list)) {
    for (const entry of body.organization_login_list) add(entry);
  }
  const directOrg = record(body.organization);
  add(directOrg ? directOrg.login : body.organization);
  // Only query org billing when the seat response identifies one unambiguous organization.
  if (candidates.size !== 1) return undefined;
  return candidates.values().next().value;
}

function billingBalances(org: string, value: unknown): ServerProviderUsageBalance[] | undefined {
  const items = record(value)?.usageItems;
  if (!Array.isArray(items)) return undefined;
  let credits = 0;
  let spend = 0;
  let matched = false;
  for (const entry of items) {
    const item = record(entry);
    if (item === undefined || typeof item.product !== "string") return undefined;
    if (item.product.trim().toLowerCase() !== "copilot") continue;
    if (typeof item.unitType !== "string") return undefined;
    const unit = item.unitType.trim().toLowerCase();
    if (unit !== "ai-units" && unit !== "ai-credits") continue;
    const quantity = finite(item.grossQuantity);
    const amount = finite(item.netAmount);
    if (quantity === undefined || amount === undefined || quantity < 0 || amount < 0) {
      return undefined;
    }
    matched = true;
    credits += quantity;
    spend += amount;
    if (!Number.isFinite(credits) || !Number.isFinite(spend)) return undefined;
  }
  if (!matched) return [];
  const slug = org.toLowerCase();
  return [
    {
      id: `org-credits-${slug}`,
      label: `Org Credits (${org})`,
      remaining: credits,
      unit: "credits",
      kind: "spend",
    },
    {
      id: `org-spend-${slug}`,
      label: `Org Spend (${org})`,
      remaining: spend,
      unit: "USD",
      kind: "spend",
    },
  ];
}

const readOrgBilling = Effect.fn("UsageLimitSources.readCopilotOrgBilling")(function* (
  org: string,
  authorization: string,
  readJson: ReadQuotaJson,
): Effect.fn.Return<
  | { readonly ok: true; readonly balances: ReadonlyArray<ServerProviderUsageBalance> }
  | { readonly ok: false; readonly error: string }
> {
  const summary = yield* readJson(
    `${GITHUB_ORIGIN}/organizations/${encodeURIComponent(org.toLowerCase())}/settings/billing/usage/summary`,
    {
      Authorization: authorization,
      Accept: "application/vnd.github+json",
      "User-Agent": "T3Lab",
      "X-Github-Api-Version": "2022-11-28",
    },
  );
  if (!summary) {
    return { ok: false, error: "Could not read GitHub Copilot org billing." };
  }
  // Standard seat members without billing-admin authority receive 403/404; omit org rows cleanly.
  if (summary.status === 403 || summary.status === 404) {
    return { ok: true, balances: [] };
  }
  if (summary.status < 200 || summary.status >= 300) {
    return {
      ok: false,
      error: `GitHub Copilot org billing request failed (HTTP ${summary.status}).`,
    };
  }
  const balances = billingBalances(org, summary.body);
  if (balances === undefined) {
    return { ok: false, error: "GitHub Copilot returned malformed org billing data." };
  }
  return { ok: true, balances };
});

export const readCopilotUsage = Effect.fn("UsageLimitSources.readCopilotUsage")(function* (
  token: string,
  readJson: ReadQuotaJson,
): Effect.fn.Return<{ readonly seatScope?: string | undefined; readonly result: Reading }> {
  const authorization = `token ${token}`;
  const response = yield* readJson(COPILOT_USAGE_ENDPOINT, {
    Authorization: authorization,
    "Editor-Version": "vscode/1.96.2",
    "Editor-Plugin-Version": "copilot-chat/0.26.7",
    "User-Agent": "GitHubCopilotChat/0.26.7",
    "X-Github-Api-Version": "2025-04-01",
  });
  if (!response) return { result: { accounts: [], error: "Could not read GitHub Copilot usage." } };
  if (response.status === 401 || response.status === 403) {
    return {
      result: {
        accounts: [],
        error: `GitHub Copilot rejected the token (HTTP ${response.status}).`,
      },
    };
  }
  if (response.status < 200 || response.status >= 300) {
    return {
      result: {
        accounts: [],
        error: `GitHub Copilot usage request failed (HTTP ${response.status}).`,
      },
    };
  }
  const body = record(response.body);
  const directOrg = record(body?.organization);
  const hasMalformedOrgField =
    body !== undefined &&
    ((body.organization_login_list !== undefined &&
      (!Array.isArray(body.organization_login_list) ||
        !body.organization_login_list.every((entry) => validOrgLogin(entry) !== undefined))) ||
      (body.organization !== undefined &&
        body.organization !== null &&
        validOrgLogin(directOrg ? directOrg.login : body.organization) === undefined));
  const hasValidOrgField =
    body !== undefined &&
    !hasMalformedOrgField &&
    (Array.isArray(body.organization_login_list) || body.organization !== undefined);
  const hasSeatEvidence =
    body !== undefined &&
    !hasMalformedOrgField &&
    (typeof body.copilot_plan === "string" ||
      typeof body.token_based_billing === "boolean" ||
      hasValidOrgField ||
      record(body.quota_snapshots) !== undefined ||
      record(body.limited_user_quotas) !== undefined ||
      record(body.monthly_quotas) !== undefined);
  if (!hasSeatEvidence) {
    return { result: { accounts: [], error: "GitHub Copilot returned no usable quota data." } };
  }
  const resolvedOrg = resolveSeatBillingOrg(body);
  const snapshots = record(body.quota_snapshots);
  const premium = record(snapshots?.premium_interactions);
  const resetsAt = resetDate(body.quota_reset_date) ?? resetDate(body.limited_user_reset_date);
  const windows: ServerProviderUsageWindow[] = [];
  const balances: ServerProviderUsageBalance[] = [];
  for (const bucket of BUCKETS) {
    const snapshot = record(snapshots?.[bucket.id]);
    if (snapshot === undefined || snapshot.unlimited === true) continue;
    const window = quotaWindow(
      bucket,
      finite(snapshot.entitlement),
      finite(snapshot.remaining),
      finite(snapshot.percent_remaining),
      resetsAt,
    );
    if (window !== undefined) windows.push(window);
  }
  if (windows.length === 0) {
    const limited = record(body.limited_user_quotas);
    const monthly = record(body.monthly_quotas);
    for (const bucket of BUCKETS) {
      if (bucket.id === "premium_interactions") continue;
      const window = quotaWindow(
        bucket,
        finite(monthly?.[bucket.id]),
        finite(limited?.[bucket.id]),
        undefined,
        resetsAt,
      );
      if (window !== undefined) windows.push(window);
    }
  }
  const overage = finite(premium?.overage_count);
  if (premium?.overage_permitted === true && overage !== undefined && overage > 0) {
    balances.push({
      id: "overage",
      label: "Extra Usage",
      remaining: overage,
      unit: "credits",
      kind: "overage",
    });
  }
  // Scope a valid seat response explicitly so switching/clearing orgs never borrows prior org rows.
  let seatScope = `seat:${resolvedOrg?.toLowerCase() ?? "personal"}`;
  let orgError: string | undefined;
  if (windows.length === 0 && body.token_based_billing === true) {
    const creditsUsed = finite(premium?.credits_used) ?? finite(body.credits_used);
    if (creditsUsed !== undefined && creditsUsed > 0) {
      balances.push({
        id: "credits-used",
        label: "Credits Used",
        remaining: creditsUsed,
        unit: "credits",
        kind: "spend",
      });
    }
    if (resolvedOrg !== undefined) {
      seatScope = `org:${resolvedOrg.toLowerCase()}`;
      const orgBilling = yield* readOrgBilling(resolvedOrg, authorization, readJson);
      if (orgBilling.ok) {
        balances.push(...orgBilling.balances);
      } else {
        orgError = orgBilling.error;
      }
    }
  } else if (windows.length === 0 && balances.length === 0) {
    return {
      seatScope,
      result: { accounts: [], error: "GitHub Copilot returned no usable quota data." },
    };
  }
  const plan = typeof body.copilot_plan === "string" ? body.copilot_plan.trim() : "";
  const planTier = plan
    .toLowerCase()
    .replace(/[_-]+/g, " ")
    .trim()
    .replace(/\b[a-z]/g, (letter) => letter.toUpperCase());
  return {
    seatScope,
    result: {
      accounts: [],
      quotaAccounts: [
        {
          id: "copilot",
          label: "GitHub Copilot",
          windows,
          ...(planTier ? { planTier } : {}),
          ...(balances.length > 0 ? { balances } : {}),
        },
      ],
      ...(orgError === undefined ? {} : { error: orgError }),
    },
  };
});
