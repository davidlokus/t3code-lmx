// Shared with the client settings form; keep schema code browser-safe.
import {
  CustomModelSetting,
  makeBinaryPathSetting,
  makeProviderSettingsSchema,
  TrimmedString,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

const OMP_SERVICE_TIERS = [
  "",
  "none",
  "auto",
  "default",
  "flex",
  "scale",
  "priority",
  "ultrafast",
] as const;
const OmpServiceTier = Schema.Literals(OMP_SERVICE_TIERS);
const SERVICE_TIER_LABELS = {
  "": "Use default",
  none: "None",
  auto: "Auto",
  default: "Default",
  flex: "Flex",
  scale: "Scale",
  priority: "Priority",
  ultrafast: "Ultrafast",
} satisfies Record<(typeof OmpServiceTier)["Type"], string>;

export const OmpSettings = makeProviderSettingsSchema(
  {
    enabled: Schema.Boolean.pipe(
      Schema.withDecodingDefault(Effect.succeed(false)),
      Schema.annotateKey({ providerSettingsForm: { hidden: true } }),
    ),
    binaryPath: makeBinaryPathSetting("omp").pipe(
      Schema.annotateKey({
        title: "Binary path",
        providerSettingsForm: { placeholder: "omp", clearWhenEmpty: "omit" },
      }),
    ),
    profile: TrimmedString.pipe(
      Schema.withDecodingDefault(Effect.succeed("")),
      Schema.annotateKey({
        title: "Profile",
        description:
          "Named omp profile (~/.omp/profiles/NAME/agent). Takes precedence over Agent directory.",
        providerSettingsForm: { placeholder: "Optional", clearWhenEmpty: "omit" },
      }),
    ),
    agentDir: TrimmedString.pipe(
      Schema.withDecodingDefault(Effect.succeed("")),
      Schema.annotateKey({
        title: "Agent directory",
        description:
          "Custom omp agent directory (passed as PI_CODING_AGENT_DIR to this instance only).",
        providerSettingsForm: { placeholder: "~/.omp/agent", clearWhenEmpty: "omit" },
      }),
    ),
    serviceTier: OmpServiceTier.pipe(
      Schema.withDecodingDefault(Effect.succeed("")),
      Schema.annotateKey({
        title: "Service tier",
        description: "OpenAI service tier applied on session start.",
        providerSettingsForm: {
          control: "select",
          clearWhenEmpty: "omit",
          options: OMP_SERVICE_TIERS.map((value) => ({ value, label: SERVICE_TIER_LABELS[value] })),
        },
      }),
    ),
    smolModel: TrimmedString.pipe(
      Schema.withDecodingDefault(Effect.succeed("")),
      Schema.annotateKey({
        title: "Smol model",
        description:
          "Fast lightweight model for auxiliary work and default text generation (--smol).",
        providerSettingsForm: { placeholder: "Optional", clearWhenEmpty: "omit" },
      }),
    ),
    slowModel: TrimmedString.pipe(
      Schema.withDecodingDefault(Effect.succeed("")),
      Schema.annotateKey({
        title: "Slow model",
        description: "Deep reasoning model override (--slow).",
        providerSettingsForm: { placeholder: "Optional", clearWhenEmpty: "omit" },
      }),
    ),
    planModel: TrimmedString.pipe(
      Schema.withDecodingDefault(Effect.succeed("")),
      Schema.annotateKey({
        title: "Plan model",
        description: "Model used for planning (--plan).",
        providerSettingsForm: { placeholder: "Optional", clearWhenEmpty: "omit" },
      }),
    ),
    advisor: Schema.Boolean.pipe(
      Schema.withDecodingDefault(Effect.succeed(false)),
      Schema.annotateKey({
        title: "Advisor",
        description: "Enable omp's passive turn-review advisor (--advisor).",
        providerSettingsForm: { control: "switch", clearWhenEmpty: "omit" },
      }),
    ),
    launchArgs: TrimmedString.pipe(
      Schema.withDecodingDefault(Effect.succeed("")),
      Schema.annotateKey({
        title: "Launch arguments",
        description: "Additional CLI arguments passed on session start.",
        providerSettingsForm: { clearWhenEmpty: "omit" },
      }),
    ),
    customModels: Schema.Array(CustomModelSetting).pipe(
      Schema.withDecodingDefault(Effect.succeed([])),
      Schema.annotateKey({ providerSettingsForm: { hidden: true } }),
    ),
  },
  {
    order: [
      "binaryPath",
      "profile",
      "agentDir",
      "serviceTier",
      "smolModel",
      "slowModel",
      "planModel",
      "advisor",
      "launchArgs",
    ],
  },
);
export type OmpSettings = typeof OmpSettings.Type;
