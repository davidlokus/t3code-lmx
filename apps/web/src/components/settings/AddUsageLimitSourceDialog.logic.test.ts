import { DEFAULT_SERVER_SETTINGS, type ServerSettings } from "@t3tools/contracts";
import { applyServerSettingsPatch } from "@t3tools/shared/serverSettings";
import { describe, expect, it } from "vite-plus/test";

import {
  OLLAMA_DEFAULT_SOURCE_URL,
  OMP_DEFAULT_SOURCE_URL,
  defaultUsageLimitSourceRegion,
  defaultUsageLimitSourceUrl,
  displayUsageLimitSourceTarget,
  sourceIdFromUrl,
} from "./AddUsageLimitSourceDialog.logic";

describe("adding usage limit sources", () => {
  it.each([
    ["http://proxy.test:8318/hub-a", "http://proxy.test:8318/hub-b"],
    ["localhost:8318", "localhost:9318"],
  ])("retains saved configurations for %s and %s", (firstUrl, secondUrl) => {
    let settings: ServerSettings = DEFAULT_SERVER_SETTINGS;
    const sources = [
      [firstUrl, "First hub", "first-key"],
      [secondUrl, "Second hub", "second-key"],
      [`${secondUrl}/extra`, "Third hub", "third-key"],
    ] as const;
    for (const [url, label, managementKey] of sources) {
      const id = sourceIdFromUrl(url, settings.usageLimitSources);
      settings = applyServerSettingsPatch(settings, {
        usageLimitSources: {
          [id]: { kind: "cliproxy", url, label, managementKey, enabled: true },
        },
      });
    }
    expect(Object.values(settings.usageLimitSources)).toEqual(
      sources.map(([url, label, managementKey]) => ({
        kind: "cliproxy",
        url,
        label,
        managementKey,
        enabled: true,
      })),
    );
  });

  it("updates a saved hub when its URL is added again", () => {
    let settings: ServerSettings = DEFAULT_SERVER_SETTINGS;
    for (const managementKey of ["old-key", "new-key"]) {
      const url = "http://proxy.test:8318/hub-a";
      settings = applyServerSettingsPatch(settings, {
        usageLimitSources: {
          [sourceIdFromUrl(url, settings.usageLimitSources)]: {
            kind: "cliproxy",
            url,
            managementKey,
            enabled: true,
          },
        },
      });
    }
    expect(Object.values(settings.usageLimitSources)).toEqual([
      {
        kind: "cliproxy",
        url: "http://proxy.test:8318/hub-a",
        managementKey: "new-key",
        enabled: true,
      },
    ]);
  });

  it("assigns distinct non-reusable IDs for concurrent and repeated Kimi/Z.ai additions", () => {
    let settings: ServerSettings = DEFAULT_SERVER_SETTINGS;
    const kimiUrl = defaultUsageLimitSourceUrl("kimi", "cn");
    // Two tabs reading the same empty snapshot allocate non-colliding IDs.
    const concurrentA = sourceIdFromUrl(kimiUrl, settings.usageLimitSources, "kimi", "cn");
    const concurrentB = sourceIdFromUrl(kimiUrl, settings.usageLimitSources, "kimi", "cn");
    expect(concurrentA).toMatch(/^kimi-cn-[a-f0-9-]{32,}$/);
    expect(concurrentB).toMatch(/^kimi-cn-[a-f0-9-]{32,}$/);
    expect(concurrentA).not.toBe(concurrentB);

    settings = applyServerSettingsPatch(settings, {
      usageLimitSources: {
        [concurrentA]: {
          kind: "kimi",
          region: "cn",
          url: kimiUrl,
          label: "Kimi Personal",
          managementKey: "k1",
          enabled: true,
        },
      },
    });
    const nextKimiId = sourceIdFromUrl(kimiUrl, settings.usageLimitSources, "kimi", "cn");
    expect(nextKimiId).toMatch(/^kimi-cn-[a-f0-9-]{32,}$/);
    expect(nextKimiId).not.toBe(concurrentA);

    const zaiUrl = defaultUsageLimitSourceUrl("zai", "global");
    expect(sourceIdFromUrl(zaiUrl, settings.usageLimitSources, "zai", "global")).toMatch(
      /^zai-global-[a-f0-9-]{32,}$/,
    );
  });

  it("deduplicates default OMP cache path and resolves display targets", () => {
    let settings: ServerSettings = DEFAULT_SERVER_SETTINGS;
    const firstId = sourceIdFromUrl(OMP_DEFAULT_SOURCE_URL, settings.usageLimitSources, "omp");
    settings = applyServerSettingsPatch(settings, {
      usageLimitSources: {
        [firstId]: {
          kind: "omp",
          url: OMP_DEFAULT_SOURCE_URL,
          managementKey: "",
          enabled: true,
        },
      },
    });
    expect(firstId).toBe("omp-default");
    expect(sourceIdFromUrl(OMP_DEFAULT_SOURCE_URL, settings.usageLimitSources, "omp")).toBe(
      "omp-default",
    );
    expect(defaultUsageLimitSourceRegion("kimi")).toBe("cn");
    expect(defaultUsageLimitSourceRegion("zai")).toBe("global");
    expect(displayUsageLimitSourceTarget({ kind: "omp", url: OMP_DEFAULT_SOURCE_URL })).toBe(
      "~/.omp/agent/agent.db",
    );
    expect(
      displayUsageLimitSourceTarget({
        kind: "kimi",
        region: "global",
        url: "https://api.kimi.ai/coding/v1/usages",
      }),
    ).toBe("api.kimi.ai");
    expect(
      displayUsageLimitSourceTarget({
        kind: "zai",
        region: "cn",
        url: "https://open.bigmodel.cn",
      }),
    ).toBe("open.bigmodel.cn");
  });

  it("allocates non-reusable IDs for OpenRouter/Copilot/OpenAI API and deduplicates Ollama default key path", () => {
    let settings: ServerSettings = DEFAULT_SERVER_SETTINGS;
    for (const kind of ["openrouter", "copilot", "openaiApi"] as const) {
      const url = defaultUsageLimitSourceUrl(kind);
      const first = sourceIdFromUrl(url, settings.usageLimitSources, kind);
      const second = sourceIdFromUrl(url, settings.usageLimitSources, kind);
      expect(first).toMatch(new RegExp(`^${kind}-[a-f0-9-]{32,}$`));
      expect(second).toMatch(new RegExp(`^${kind}-[a-f0-9-]{32,}$`));
      expect(first).not.toBe(second);
    }

    const ollamaId = sourceIdFromUrl(
      OLLAMA_DEFAULT_SOURCE_URL,
      settings.usageLimitSources,
      "ollama",
    );
    expect(ollamaId).toBe("ollama-default");
    settings = applyServerSettingsPatch(settings, {
      usageLimitSources: {
        [ollamaId]: {
          kind: "ollama",
          url: OLLAMA_DEFAULT_SOURCE_URL,
          managementKey: "",
          enabled: true,
        },
      },
    });
    expect(sourceIdFromUrl(OLLAMA_DEFAULT_SOURCE_URL, settings.usageLimitSources, "ollama")).toBe(
      "ollama-default",
    );
    expect(displayUsageLimitSourceTarget({ kind: "ollama", url: OLLAMA_DEFAULT_SOURCE_URL })).toBe(
      "~/.ollama/id_ed25519",
    );
    expect(
      displayUsageLimitSourceTarget({ kind: "openrouter", url: "https://openrouter.ai" }),
    ).toBe("openrouter.ai");
    expect(
      displayUsageLimitSourceTarget({
        kind: "copilot",
        url: "https://api.github.com/copilot_internal/user",
      }),
    ).toBe("api.github.com");
    expect(
      displayUsageLimitSourceTarget({
        kind: "openaiApi",
        url: "https://api.openai.com/v1/organization/costs",
      }),
    ).toBe("api.openai.com");
  });

  it("falls back to crypto.getRandomValues hex entropy when crypto.randomUUID is unavailable", () => {
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, "crypto");
    const realCrypto = globalThis.crypto;
    Object.defineProperty(globalThis, "crypto", {
      configurable: true,
      value: {
        getRandomValues: realCrypto.getRandomValues.bind(realCrypto),
      },
    });
    try {
      const id = sourceIdFromUrl("https://openrouter.ai", {}, "openrouter");
      expect(id).toMatch(/^openrouter-[a-f0-9]{32}$/);
    } finally {
      if (descriptor) {
        Object.defineProperty(globalThis, "crypto", descriptor);
      }
    }
  });
});
