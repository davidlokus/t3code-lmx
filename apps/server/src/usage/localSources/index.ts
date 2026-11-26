import type { ServerSettings, UsageProviderKind } from "@t3tools/contracts";
import type { ProviderUsageScan } from "@t3tools/provider-core/server/usage";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import { makeKimiCliScanner } from "./kimiCli.ts";
import { makeMagpieScanner } from "./magpie.ts";
import { scanZcode } from "./zcode.ts";

export function makeLocalHistoryScanner() {
  const scanKimiCli = makeKimiCliScanner();
  const scanMagpie = makeMagpieScanner();
  return Effect.fn("UsageService.scanLocalHistory")(function* (
    settings: ServerSettings["usageLocalHistorySources"],
    windowStartMs: number,
  ) {
    const { kimiCli, zcode, magpie } = settings;
    const home = yield* HostProcess.HomeDirectory;
    const environment = yield* HostProcess.Environment;
    const [kimi, zai, gateway] = yield* Effect.all(
      [
        kimiCli ? Effect.promise(() => scanKimiCli({ home, windowStartMs })) : Effect.undefined,
        zcode ? Effect.sync(() => scanZcode({ home, windowStartMs })) : Effect.undefined,
        magpie
          ? Effect.promise(() =>
              scanMagpie({
                home,
                windowStartMs,
                configDirectory: environment.MAGPIE_CONFIG_DIR,
                excludeKimiCli: kimiCli,
                excludeZcode: zcode,
              }),
            )
          : Effect.undefined,
      ],
      { concurrency: "unbounded" },
    );
    const sources: (ProviderUsageScan & { readonly provider: UsageProviderKind })[] = [];
    if (kimi !== undefined) sources.push({ provider: "kimi", ...kimi });
    if (zai !== undefined) sources.push({ provider: "zai", ...zai });
    // An unreadable gateway log cannot be attributed to any upstream provider.
    if (gateway !== undefined) sources.push(...gateway.sources);
    return sources;
  });
}
