import { describe, expect, it } from "vite-plus/test";
import {
  makeProviderSettingsSchema,
  ProviderDriverKind,
  SettingsSecretValue,
  TrimmedString,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";

import { providerClients } from "./providerDriverMeta";
import type { MessageResolver } from "../../i18n/messages";
import {
  deriveProviderSettingsFields,
  nextProviderConfigWithFieldValue,
  reconcileRowsDraft,
  seedRowsDraft,
} from "./ProviderSettingsForm";

describe("ProviderSettingsForm helpers", () => {
  it("keeps every masked field as a stored secret and offers a reference only where typed so", () => {
    const settingsSchema = makeProviderSettingsSchema({
      token: TrimmedString.pipe(
        Schema.annotateKey({ providerSettingsForm: { control: "password" } }),
      ),
      apiKey: SettingsSecretValue,
    });

    expect(
      deriveProviderSettingsFields({ settingsSchema }).map(
        ({ key, secret, acceptsSecretReference }) => ({ key, secret, acceptsSecretReference }),
      ),
    ).toEqual([
      { key: "token", secret: true, acceptsSecretReference: undefined },
      { key: "apiKey", secret: true, acceptsSecretReference: true },
    ]);
  });

  it("preserves unknown config keys while omitting empty configurable fields", () => {
    const opencode = providerClients.get(ProviderDriverKind.make("opencode"));
    expect(opencode).toBeDefined();

    const serverUrl = deriveProviderSettingsFields(opencode!).find(
      (field) => field.key === "serverUrl",
    );
    expect(serverUrl).toBeDefined();

    const next = nextProviderConfigWithFieldValue(
      { forkOwned: 1, serverUrl: "http://127.0.0.1:4096" },
      serverUrl!,
      "",
    );

    expect(next).toEqual({ forkOwned: 1 });
  });

  it("does not store a text value its field's schema rejects", () => {
    const claude = providerClients.get(ProviderDriverKind.make("claudeAgent"));
    expect(claude).toBeDefined();
    const autoCompactWindow = deriveProviderSettingsFields(claude!).find(
      (field) => field.key === "autoCompactWindow",
    );
    expect(autoCompactWindow).toBeDefined();

    for (const invalid of ["300k", "50000"]) {
      expect(
        nextProviderConfigWithFieldValue({ launchArgs: "--x" }, autoCompactWindow!, invalid),
      ).toEqual({ launchArgs: "--x" });
    }
    expect(
      nextProviderConfigWithFieldValue({ launchArgs: "--x" }, autoCompactWindow!, "300000"),
    ).toEqual({ launchArgs: "--x", autoCompactWindow: "300000" });
  });

  it("stores false boolean fields when true is the default", () => {
    const next = nextProviderConfigWithFieldValue(
      undefined,
      {
        key: "experimental",
        control: "switch",
        label: "Experimental",
        clearWhenEmpty: "omit",
        defaultBooleanValue: true,
      },
      false,
    );

    expect(next).toEqual({ experimental: false });
  });

  it("derives and translates omp Wave 1 settings in order while omitting defaults", () => {
    const omp = providerClients.get(ProviderDriverKind.make("omp"));
    expect(omp).toBeDefined();

    const translated: string[] = [];
    const resolve = ((value: string | null | undefined) => {
      if (typeof value === "string") {
        translated.push(value);
        return `t:${value}`;
      }
      return value;
    }) as MessageResolver;
    const fields = deriveProviderSettingsFields(omp!, undefined, resolve);

    expect(fields.map((field) => field.key)).toEqual([
      "binaryPath",
      "profile",
      "agentDir",
      "serviceTier",
      "smolModel",
      "slowModel",
      "planModel",
      "advisor",
      "warnCostUsd",
      "maxCostUsd",
      "maxTime",
      "launchArgs",
    ]);

    const serviceTier = fields.find((field) => field.key === "serviceTier");
    expect(serviceTier?.control).toBe("select");
    expect(serviceTier?.options?.map((option) => option.value)).toEqual([
      "",
      "none",
      "auto",
      "default",
      "flex",
      "scale",
      "priority",
      "ultrafast",
    ]);
    expect(serviceTier?.options?.every((option) => option.label.startsWith("t:"))).toBe(true);

    const profile = fields.find((field) => field.key === "profile");
    expect(profile?.label.startsWith("t:")).toBe(true);
    expect(profile?.description?.startsWith("t:")).toBe(true);

    const advisor = fields.find((field) => field.key === "advisor");
    expect(advisor?.control).toBe("switch");
    expect(nextProviderConfigWithFieldValue({ advisor: true }, advisor!, false)).toBeUndefined();
    expect(
      nextProviderConfigWithFieldValue({ serviceTier: "priority" }, serviceTier!, ""),
    ).toBeUndefined();

    const warnCostUsd = fields.find((field) => field.key === "warnCostUsd");
    const maxCostUsd = fields.find((field) => field.key === "maxCostUsd");
    const maxTime = fields.find((field) => field.key === "maxTime");
    expect(warnCostUsd?.label.startsWith("t:")).toBe(true);
    expect(warnCostUsd?.description?.startsWith("t:")).toBe(true);
    expect(maxCostUsd?.label.startsWith("t:")).toBe(true);
    expect(maxCostUsd?.description?.startsWith("t:")).toBe(true);
    expect(maxTime?.label.startsWith("t:")).toBe(true);
    expect(maxTime?.description?.startsWith("t:")).toBe(true);
    expect(maxTime?.placeholder?.startsWith("t:")).toBe(true);
    expect(nextProviderConfigWithFieldValue({ maxTime: "30m" }, maxTime!, "")).toBeUndefined();
    expect(translated.length).toBeGreaterThan(20);
  });
});

describe("reconcileRowsDraft", () => {
  let nextId = 0;
  const toRows = (values: ReadonlyArray<string>) =>
    values.map((value) => ({ id: nextId++, value }));
  const equal = (left: ReadonlyArray<string>, right: ReadonlyArray<string>) =>
    left.length === right.length && left.every((value, index) => value === right[index]);

  it("keeps rows when an equal value arrives with a new identity", () => {
    const draft = seedRowsDraft(["a"], toRows);
    expect(reconcileRowsDraft(draft, ["a"], equal, toRows)).toBe(draft);
  });

  it("keeps row ids when the published value echoes back", () => {
    const seeded = seedRowsDraft(["a"], toRows);
    const edited = { rows: [...seeded.rows, { id: 99, value: "" }], seen: seeded.seen };
    const draft = { ...edited, lastPublished: ["a", ""] };
    const next = reconcileRowsDraft(draft, ["a", ""], equal, toRows);
    expect(next.rows).toBe(draft.rows);
    expect(next.seen).toEqual(["a", ""]);
    expect(next.lastPublished).toBeUndefined();
  });

  it("reseeds rows when the value changes from outside", () => {
    const draft = { ...seedRowsDraft(["a"], toRows), lastPublished: ["b"] };
    const next = reconcileRowsDraft(draft, ["c"], equal, toRows);
    expect(next.rows.map((row) => row.value)).toEqual(["c"]);
    expect(next.lastPublished).toBeUndefined();
  });
});
