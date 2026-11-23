import { ProviderDriverKind } from "@t3tools/contracts";
import { defineProviderClient } from "@t3tools/provider-core/client";

import { OmpSettings } from "./settings.ts";

export const ompClient = defineProviderClient({
  driverKind: ProviderDriverKind.make("omp"),
  label: "omp",
  settingsSchema: OmpSettings,
  // omp's mark from https://omp.sh/favicon.svg (MIT, can1357/oh-my-pi), cropped to the glyph.
  // Icons take flat fills, so the logo's pink-purple-cyan gradient becomes its middle stop.
  icon: {
    viewBox: "12 16 40 40",
    fill: { light: "#9B4DFF", dark: "#9B4DFF" },
    paths: [{ d: "M14 16h36v8H40v32h-8V24h-6v22h-8V24h-4z" }],
  },
});
