import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import { forkIdentity, isForkDesktopProtocol } from "./forkIdentity.ts";

const readRepoFile = (relativePath: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const repoRoot = path.resolve(import.meta.dirname, "../../..");
    return yield* fs.readFileString(path.join(repoRoot, relativePath));
  });

const repoFileExists = (relativePath: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const repoRoot = path.resolve(import.meta.dirname, "../../..");
    return yield* fs.exists(path.join(repoRoot, relativePath));
  });

it.layer(NodeServices.layer)("T3 Lab (Extend) fork invariants", (it) => {
  it.effect("keeps fork identity isolated from official T3 Code defaults", () =>
    Effect.sync(() => {
      assert.strictEqual(forkIdentity.displayName, "T3 Lab (Extend)");
      assert.notStrictEqual(forkIdentity.appId, "com.t3tools.t3code");
      assert.notStrictEqual(forkIdentity.homeDirectoryName, ".t3");
      assert.notStrictEqual(forkIdentity.userDataDirectoryName, "t3code-v2");
      assert.notStrictEqual(forkIdentity.developmentUserDataDirectoryName, "t3code-dev");
      assert.notStrictEqual(forkIdentity.protocolScheme, "t3code");
      assert.notStrictEqual(forkIdentity.developmentProtocolScheme, "t3code-dev");
      assert.notStrictEqual(forkIdentity.cliCommand, "t3");
      assert.notStrictEqual(forkIdentity.desktopBackendPort, 3773);
      assert.strictEqual(forkIdentity.upstreamUpdateRepository, "pingdotgg/t3code");
      assert.isTrue(isForkDesktopProtocol(`${forkIdentity.protocolScheme}:`));
      assert.isTrue(isForkDesktopProtocol(`${forkIdentity.developmentProtocolScheme}:`));
      assert.isFalse(isForkDesktopProtocol("t3code:"));
      assert.isFalse(isForkDesktopProtocol("t3code-dev:"));
    }),
  );

  it.effect("keeps desktop productName aligned with forkIdentity", () =>
    Effect.gen(function* () {
      const raw = yield* readRepoFile("apps/desktop/package.json");
      const parsed = JSON.parse(raw) as { productName?: string };
      assert.strictEqual(parsed.productName, forkIdentity.displayName);
    }),
  );

  it.effect("prevents desktop profile code from reading official T3 Code profiles", () =>
    Effect.gen(function* () {
      const userDataSource = yield* readRepoFile("apps/desktop/src/app/DesktopUserData.ts");
      assert.notInclude(userDataSource, "T3 Code (Alpha)");
      assert.notInclude(userDataSource, "T3 Code (Dev)");
      assert.notInclude(userDataSource, "t3code-v2");

      const legacySource = yield* readRepoFile("apps/desktop/src/app/DesktopLegacyLocalStorage.ts");
      assert.match(legacySource, /const V1_PROFILE_NAMES(?::[^=]+)?\s*=\s*\[\s*\];/);
    }),
  );

  it.effect("keeps boot/compileCache bundler entry inlining @t3tools/shared/forkIdentity", () =>
    Effect.gen(function* () {
      const viteConfig = yield* readRepoFile("apps/desktop/vite.config.ts");
      const bootPackMatch = viteConfig.match(
        /entry:\s*\[\s*"src\/boot\.ts"\s*,\s*"src\/compileCache\.ts"\s*,\s*"src\/serverCompileCache\.ts"\s*\][\s\S]*?deps:\s*\{([\s\S]*?)\}/,
      );
      assert.isNotNull(bootPackMatch, "boot/compileCache pack entry must exist");
      assert.include(
        bootPackMatch![1],
        "@t3tools/shared/forkIdentity",
        "boot/compileCache pack entry must alwaysBundle @t3tools/shared/forkIdentity",
      );
    }),
  );

  it.effect("keeps upstream pingdotgg/t3code rejected as a desktop update repository", () =>
    Effect.gen(function* () {
      const buildScript = yield* readRepoFile("scripts/build-desktop-artifact.ts");
      assert.include(buildScript, "forkIdentity.upstreamUpdateRepository");
    }),
  );

  it.effect("keeps the native omp provider registered on the server and clients", () =>
    Effect.gen(function* () {
      const drivers = yield* readRepoFile("apps/server/src/provider/builtInDrivers.ts");
      const driverList = drivers.match(/^export const BUILT_IN_DRIVERS[^=]*=\s*\[([\s\S]*?)^\];/m);
      assert.match(driverList?.[1] ?? "", /^\s*OmpDriver\s*,/m, "native server driver");

      const clients = yield* readRepoFile("packages/client-runtime/src/providerClients.ts");
      const clientList = clients.match(
        /^export const providerClients = makeProviderClientRegistry\(\[([\s\S]*?)^\]\);/m,
      );
      assert.match(clientList?.[1] ?? "", /^\s*ompClient\s*,/m, "shared client registration");

      const raw = yield* readRepoFile("apps/server/src/provider/model-manifest.json");
      const manifest = JSON.parse(raw) as { compatibility: Array<{ driver: string }> };
      assert.isTrue(manifest.compatibility.some(({ driver }) => driver === "omp"));
    }),
  );

  it.effect("preserves fork governance files and AGENTS/CLAUDE override wiring", () =>
    Effect.gen(function* () {
      const agents = yield* readRepoFile("AGENTS.md");
      assert.isTrue(
        agents.startsWith("<!-- FORK-OVERRIDE:START -->"),
        "AGENTS.md must start with FORK-OVERRIDE block so harnesses never truncate it",
      );
      assert.include(agents, "<!-- FORK-OVERRIDE:END -->");
      assert.include(agents, "FORK.md");
      assert.include(agents, "LESSONS.md");

      const claude = yield* readRepoFile("CLAUDE.md");
      assert.include(claude, "@FORK.md");
      assert.include(claude, "@LESSONS.md");
      assert.include(claude, "@AGENTS.md");

      for (const required of [
        "FORK.md",
        "LESSONS.md",
        ".github/workflows/fork-ci.yml",
        ".github/workflows/fork-release.yml",
        "fork/scripts/release-preflight.mjs",
        "fork/scripts/sync-upstream.mjs",
        "fork/scripts/verify-mac-dmg.sh",
      ]) {
        assert.isTrue(yield* repoFileExists(required), `missing required fork file: ${required}`);
      }
    }),
  );
});
