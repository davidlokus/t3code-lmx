import "~/index.css";

import {
  EnvironmentId,
  SecretProviderId,
  SecretProviderKind,
  UsageLimitSourceId,
} from "@t3tools/contracts";
import { page, userEvent } from "vite-plus/test/browser";
import { describe, expect, it, vi } from "vite-plus/test";

import { render } from "../../../test/render";

const updateSettings = vi.hoisted(() => vi.fn());
const secretSources = vi.hoisted(() => ({
  current: [] as Array<{
    readonly id: SecretProviderId;
    readonly kind: SecretProviderKind;
    readonly label: string;
  }>,
}));

vi.mock(import("../../hooks/useSettings"), async (original) => ({
  ...(await original()),
  useUpdateEnvironmentSettings: (() => updateSettings) as never,
}));
vi.mock(import("./SecretSourceInput"), async (original) => ({
  ...(await original()),
  useSecretSources: () => secretSources.current,
}));

import { AddUsageLimitSourceDialog } from "./AddUsageLimitSourceDialog";
import { UsageProviderSettings } from "./UsageProviderSettings";

describe("AddUsageLimitSourceDialog", () => {
  it("adds the hub when Enter is pressed in a field", async () => {
    updateSettings.mockClear();
    const onOpenChange = vi.fn();
    await using _screen = await render(
      <AddUsageLimitSourceDialog
        open
        onOpenChange={onOpenChange}
        environmentId={EnvironmentId.make("local")}
        environmentLabel="This Mac"
        sources={{}}
      />,
    );

    await userEvent.type(page.getByLabelText("Hub URL"), "https://hub.example.ts.net:8318");
    await userEvent.type(page.getByLabelText("Management key"), "secret-key{Enter}");

    expect(updateSettings).toHaveBeenCalledOnce();
    expect(updateSettings).toHaveBeenCalledWith({
      usageLimitSources: {
        "cliproxy-hub.example.ts.net-8318": expect.objectContaining({
          kind: "cliproxy",
          url: "https://hub.example.ts.net:8318",
          managementKey: "secret-key",
        }),
      },
    });
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("adds an OMP local cache source from UsageProviderSettings without a secret", async () => {
    updateSettings.mockClear();
    await using _screen = await render(
      <UsageProviderSettings
        environmentId={EnvironmentId.make("local")}
        environmentLabel="This Mac"
        readOnly={false}
        sources={{}}
      />,
    );

    await userEvent.click(page.getByRole("button", { name: "Add source" }));
    const dialog = page.getByRole("dialog");
    await expect.element(dialog.getByLabelText("Database path (optional)")).toBeVisible();
    await userEvent.click(dialog.getByRole("button", { name: "Add source" }));

    expect(updateSettings).toHaveBeenCalledOnce();
    expect(updateSettings).toHaveBeenCalledWith({
      usageLimitSources: {
        "omp-default": {
          kind: "omp",
          url: "omp://default",
          managementKey: "",
          enabled: true,
        },
      },
    });
  });

  it("switches to Kimi Code and saves with region and API key", async () => {
    updateSettings.mockClear();
    await using _screen = await render(
      <UsageProviderSettings
        environmentId={EnvironmentId.make("local")}
        environmentLabel="This Mac"
        readOnly={false}
        sources={{}}
      />,
    );

    await userEvent.click(page.getByRole("button", { name: "Add source" }));
    const dialog = page.getByRole("dialog");
    await userEvent.click(dialog.getByLabelText("Source type"));
    await userEvent.click(page.getByRole("option", { name: "Kimi Code" }));

    await expect.element(dialog.getByRole("button", { name: "Add source" })).toBeDisabled();
    await userEvent.type(dialog.getByLabelText("API key"), "sk-kimi-test");
    await userEvent.type(dialog.getByLabelText("Label (optional)"), "Kimi Work");
    await userEvent.click(dialog.getByRole("button", { name: "Add source" }));

    expect(updateSettings).toHaveBeenCalledOnce();
    const saved = updateSettings.mock.calls[0]?.[0]?.usageLimitSources as Record<string, unknown>;
    const [savedId] = Object.keys(saved);
    expect(savedId).toMatch(/^kimi-cn-[a-z0-9]+$/);
    expect(saved[savedId!]).toEqual({
      kind: "kimi",
      region: "cn",
      label: "Kimi Work",
      url: "https://api.kimi.com/coding/v1/usages",
      managementKey: "sk-kimi-test",
      enabled: true,
    });
  });

  it("switches to Z.ai / BigModel, switches region to China, and saves", async () => {
    updateSettings.mockClear();
    await using _screen = await render(
      <UsageProviderSettings
        environmentId={EnvironmentId.make("local")}
        environmentLabel="This Mac"
        readOnly={false}
        sources={{}}
      />,
    );

    await userEvent.click(page.getByRole("button", { name: "Add source" }));
    const dialog = page.getByRole("dialog");
    await userEvent.click(dialog.getByLabelText("Source type"));
    await userEvent.click(page.getByRole("option", { name: "Z.ai / BigModel" }));
    await userEvent.click(dialog.getByLabelText("Region"));
    await userEvent.click(page.getByRole("option", { name: "China (open.bigmodel.cn)" }));
    await userEvent.type(dialog.getByLabelText("API key"), "zai-key-123{Enter}");

    expect(updateSettings).toHaveBeenCalledOnce();
    const saved = updateSettings.mock.calls[0]?.[0]?.usageLimitSources as Record<string, unknown>;
    const [savedId] = Object.keys(saved);
    expect(savedId).toMatch(/^zai-cn-[a-z0-9]+$/);
    expect(saved[savedId!]).toEqual({
      kind: "zai",
      region: "cn",
      url: "https://open.bigmodel.cn",
      managementKey: "zai-key-123",
      enabled: true,
    });
  });

  it("resets secret-provider picker and invalid-reference state when switching between secret-bearing source kinds", async () => {
    updateSettings.mockClear();
    secretSources.current = [
      {
        id: SecretProviderId.make("op-personal"),
        kind: SecretProviderKind.make("one_password"),
        label: "1Password",
      },
    ];
    try {
      await using _screen = await render(
        <AddUsageLimitSourceDialog
          open
          kind="kimi"
          onOpenChange={vi.fn()}
          environmentId={EnvironmentId.make("local")}
          environmentLabel="This Mac"
          sources={{}}
        />,
      );

      const dialog = page.getByRole("dialog");
      // Pick 1Password on Kimi and commit a malformed reference to trigger invalid-reference state.
      await userEvent.click(dialog.getByLabelText("API key source"));
      await userEvent.click(page.getByRole("option", { name: "1Password" }));
      const refInput = dialog.getByLabelText("API key reference");
      await expect.element(refInput).toBeVisible();
      await userEvent.type(refInput, "not-an-op-ref");
      await userEvent.tab();
      await expect.element(refInput).toHaveAttribute("aria-invalid", "true");
      await expect.element(dialog.getByRole("button", { name: "Add source" })).toBeDisabled();

      // Switch directly to HTTP: the secret field must remount back to direct value mode.
      await userEvent.click(dialog.getByLabelText("Source type"));
      await userEvent.click(page.getByRole("option", { name: "HTTP quota source" }));
      await expect.element(dialog.getByLabelText("Bearer token (optional)")).toBeVisible();
      await expect
        .element(dialog.getByLabelText("Bearer token (optional) reference"))
        .not.toBeInTheDocument();

      await userEvent.type(dialog.getByLabelText("Endpoint URL"), "https://quota.test/v1");
      await userEvent.click(dialog.getByRole("button", { name: "Add source" }));
      expect(updateSettings).toHaveBeenCalledOnce();
      expect(updateSettings).toHaveBeenCalledWith({
        usageLimitSources: {
          "http-quota.test": {
            kind: "http",
            url: "https://quota.test/v1",
            managementKey: "",
            enabled: true,
          },
        },
      });
    } finally {
      secretSources.current = [];
    }
  });

  it("hides extended source kinds when connected to an older server", async () => {
    updateSettings.mockClear();
    await using _screen = await render(
      <UsageProviderSettings
        environmentId={EnvironmentId.make("local")}
        environmentLabel="Older Host"
        readOnly={false}
        supportsExtendedSources={false}
        sources={{}}
      />,
    );

    await userEvent.click(page.getByRole("button", { name: "Add source" }));
    const dialog = page.getByRole("dialog");
    await expect.element(dialog.getByLabelText("Endpoint URL")).toBeVisible();
    await userEvent.click(dialog.getByLabelText("Source type"));
    await expect.element(page.getByRole("option", { name: "HTTP quota source" })).toBeVisible();
    await expect
      .element(page.getByRole("option", { name: "OMP local cache" }))
      .not.toBeInTheDocument();
    await expect.element(page.getByRole("option", { name: "Kimi Code" })).not.toBeInTheDocument();
    await expect
      .element(page.getByRole("option", { name: "Z.ai / BigModel" }))
      .not.toBeInTheDocument();
  });

  it("renders saved OMP, Kimi, and Z.ai rows in UsageProviderSettings", async () => {
    await using _screen = await render(
      <UsageProviderSettings
        environmentId={EnvironmentId.make("local")}
        environmentLabel="This Mac"
        readOnly={false}
        sources={{
          [UsageLimitSourceId.make("omp-default")]: {
            kind: "omp",
            url: "omp://default",
            managementKey: "",
            enabled: true,
          },
          [UsageLimitSourceId.make("kimi-cn")]: {
            kind: "kimi",
            region: "cn",
            label: "Kimi Personal",
            url: "https://api.kimi.com/coding/v1/usages",
            managementKey: "••••••",
            enabled: true,
          },
          [UsageLimitSourceId.make("zai-global")]: {
            kind: "zai",
            region: "global",
            url: "https://api.z.ai",
            managementKey: "••••••",
            enabled: true,
          },
        }}
      />,
    );

    await expect.element(page.getByText("OMP local cache", { exact: true })).toBeVisible();
    await expect.element(page.getByText("Kimi Personal")).toBeVisible();
    await expect.element(page.getByText("Z.ai / BigModel", { exact: true })).toBeVisible();
  });
});
