import { describe, expect, it } from "vite-plus/test";

import { formatAppDisplayName, resolveWebAppStageLabel } from "./branding.logic";

const baseName = "T3 Lab";

describe("web bootstrap branding", () => {
  it.each([
    { hostedAppChannel: null, development: false, expected: "T3 Lab (Extend)" },
    { hostedAppChannel: null, development: true, expected: "T3 Lab (Dev)" },
    { hostedAppChannel: "nightly", development: false, expected: "T3 Lab (Nightly)" },
    { hostedAppChannel: "latest", development: false, expected: "T3 Lab" },
  ])("uses $expected for the current build channel", ({ expected, ...input }) => {
    expect(formatAppDisplayName({ baseName, stageLabel: resolveWebAppStageLabel(input) })).toBe(
      expected,
    );
  });
});
