// @effect-diagnostics nodeBuiltinImport:off - loads .github/scripts/ci-changes.cjs directly to guard Fork CI scoping.
import * as NodeModule from "node:module";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import { forkIdentity, isForkDesktopProtocol } from "./forkIdentity.ts";
import { isDoNotTrackSet, isRelayTracingEnabled } from "./otelEnvironment.ts";

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
        "fork/scripts/worktree-task.mjs",
        "fork/scripts/verify-mac-dmg.sh",
        "fork/scripts/install-local-mac.sh",
      ]) {
        assert.isTrue(yield* repoFileExists(required), `missing required fork file: ${required}`);
      }

      const installScript = yield* readRepoFile("fork/scripts/install-local-mac.sh");
      assert.include(installScript, "verify-mac-dmg.sh");
      assert.include(installScript, "smoke-desktop-app.ts");
      assert.include(installScript, "T3CODE_DESKTOP_UNTRUSTED_BUNDLE");

      const forkCi = yield* readRepoFile(".github/workflows/fork-ci.yml");
      assert.include(forkCi, "name: Fork checks");
      assert.include(forkCi, "mode=sharded");
      assert.include(forkCi, "test_server:");
      assert.include(forkCi, "!/.repos/");
      assert.notInclude(forkCi, "persist-credentials: false");

      const forkRelease = yield* readRepoFile(".github/workflows/fork-release.yml");
      assert.include(forkRelease, "runs-on: macos-26");
      assert.include(forkRelease, "!/.repos/");
      assert.notInclude(forkRelease, "persist-credentials: false");
      assert.notInclude(
        forkRelease,
        "--filter=@t3tools/shared...",
        "preflight runs root `vp test run`, which loads all workspace vite configs",
      );
      assert.include(
        forkRelease,
        "unset GITHUB_REPOSITORY",
        "GitHub Actions ignores step env overrides of built-in GITHUB_* variables",
      );
      assert.notInclude(
        forkRelease,
        'GITHUB_REPOSITORY: ""',
        "step-level GITHUB_REPOSITORY overrides are ignored by GitHub Actions runners",
      );
    }),
  );

  it.effect("keeps OpenSpec tiered workflow, router skill, and CI/fmt isolation intact", () =>
    Effect.gen(function* () {
      for (const required of [
        "openspec/config.yaml",
        "openspec/epics/README.md",
        "openspec/schemas/t3lab-light/schema.yaml",
        "openspec/schemas/t3lab-light/templates/proposal.md",
        "openspec/schemas/t3lab-light/templates/tasks.md",
        ".agents/skills/t3lab-dev/SKILL.md",
        ".agents/skills/t3lab-dev/references/direct-flow.md",
        ".agents/skills/t3lab-dev/references/light-spec-flow.md",
        ".agents/skills/t3lab-dev/references/fork-gates.md",
        ".agents/skills/t3lab-dev/references/handoff.md",
      ]) {
        assert.isTrue(
          yield* repoFileExists(required),
          `missing required OpenSpec fork file: ${required}`,
        );
      }

      const handoffDoc = yield* readRepoFile(".agents/skills/t3lab-dev/references/handoff.md");
      assert.include(handoffDoc, "hc run --bg", "handoff runbook must use hc run --bg");
      assert.notInclude(handoffDoc, "hc spawn", "handoff runbook must not use removed hc spawn");
      assert.include(handoffDoc, "Pre-Review Gate");
      assert.include(handoffDoc, "Author ≠ Reviewer");
      assert.include(handoffDoc, "fresh read-only");
      assert.include(handoffDoc, "4-Quadrant Defense Matrix");
      assert.include(handoffDoc, "worktree-task.mjs");

      const viteConfig = yield* readRepoFile("vite.config.ts");
      assert.include(
        viteConfig,
        '".agents/skills/openspec-*/**"',
        "vite.config.ts must ignore OpenSpec-generated skills in fmt.ignorePatterns",
      );

      const require = NodeModule.createRequire(import.meta.url);
      const ciChanges = require("../../../.github/scripts/ci-changes.cjs") as {
        readonly readWorkspace: () => ReadonlyArray<unknown>;
        readonly decide: (
          files: ReadonlyArray<string>,
          packages: ReadonlyArray<unknown>,
          full: boolean,
        ) => { readonly affected: ReadonlyArray<string> };
      };
      const decision = ciChanges.decide(
        [
          "openspec/config.yaml",
          "openspec/epics/usage-subscriptions.md",
          "openspec/changes/demo/proposal.md",
          ".agents/skills/t3lab-dev/SKILL.md",
        ],
        ciChanges.readWorkspace(),
        false,
      );
      assert.deepStrictEqual(
        decision.affected,
        [],
        "openspec/** and .agents/skills/** changes must stay inert in ci-changes.cjs",
      );
    }),
  );

  it.effect(
    "keeps upstream telemetry, PostHog ingest, Axiom tracing, and agent feedback disabled by default",
    () =>
      Effect.gen(function* () {
        assert.isFalse(isRelayTracingEnabled({}));
        assert.isTrue(isRelayTracingEnabled({ T3CODE_TELEMETRY_ENABLED: "true" }));
        assert.isFalse(
          isRelayTracingEnabled({ T3CODE_TELEMETRY_ENABLED: "true", DO_NOT_TRACK: "1" }),
        );
        assert.isTrue(isDoNotTrackSet({ DO_NOT_TRACK: "1" }));
        assert.isFalse(isDoNotTrackSet({ DO_NOT_TRACK: "0" }));

        const analyticsSource = yield* readRepoFile(
          "apps/server/src/telemetry/AnalyticsService.ts",
        );
        assert.notInclude(
          analyticsSource,
          "phc_XOWci4oZP4VvLiEyrFqkFjP4CZn55mjYYBMREK5Wd6m",
          "official T3 PostHog key must not be bundled in T3 Lab",
        );
        assert.notInclude(
          analyticsSource,
          "https://ingest.t3.codes",
          "official T3 ingest host must not be bundled as a default in T3 Lab",
        );
        assert.include(
          analyticsSource,
          'Config.Boolean("T3CODE_TELEMETRY_ENABLED").pipe(Config.withDefault(false))',
          "T3CODE_TELEMETRY_ENABLED must default to false",
        );
        assert.include(
          analyticsSource,
          "isDoNotTrackSet",
          "AnalyticsService must honor DO_NOT_TRACK",
        );

        const serverEnvSource = yield* readRepoFile(
          "apps/server/src/environment/ServerEnvironment.ts",
        );
        assert.match(serverEnvSource, /\bagentFeedback:\s*false\b/);
        assert.notMatch(serverEnvSource, /\bagentFeedback:\s*true\b/);

        const onboardingSource = yield* readRepoFile(
          "apps/web/src/components/cloud/ConnectOnboardingDialog.tsx",
        );
        assert.notMatch(onboardingSource, /publishAgentActivity.*useState\(true\)/);
        assert.notInclude(onboardingSource, "setPublishAgentActivity(true)");

        const mobileAppConfig = yield* readRepoFile("apps/mobile/app.config.ts");
        assert.notInclude(
          mobileAppConfig,
          "https://api.axiom.co/v1/traces",
          "mobile config must not fall back to the upstream Axiom endpoint",
        );

        const mobileDiagnostics = yield* readRepoFile(
          "apps/mobile/src/features/observability/diagnosticsSetting.ts",
        );
        assert.include(mobileDiagnostics, "preferences.connectionTracesEnabled === true");
        assert.notInclude(mobileDiagnostics, "preferences.connectionTracesEnabled !== false");

        const mobileObserve = yield* readRepoFile(
          "apps/mobile/src/features/observability/observe.ts",
        );
        assert.include(mobileObserve, "preferences.crashReportsEnabled === true");
        assert.notInclude(mobileObserve, "preferences.crashReportsEnabled !== false");
      }),
  );
});
