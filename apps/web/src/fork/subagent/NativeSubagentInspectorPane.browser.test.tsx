import { createMemoryHistory } from "@tanstack/react-router";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { NodeId, ProviderDriverKind, type OrchestrationV2Subagent } from "@t3tools/contracts";
import { DEFAULT_CLIENT_SETTINGS } from "@t3tools/contracts/settings";
import type * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import { expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";

import "~/index.css";
import { AppRoot } from "~/AppRoot";
import "~/components/ChatView";
import { __setClientSettingsForTests, getClientSettings } from "~/hooks/useSettings";
import { selectActiveRightPanelSurface, useRightPanelStore } from "~/rightPanelStore";
import { getRouter } from "~/router";
import {
  ENVIRONMENT_ID,
  emitThreadEvent,
  installFakeEnvironment,
  threadWithHistory,
  type FakeDriver,
} from "../../../test/fakeEnvironment";
import { act, render } from "../../../test/render";

// The app consumes a real detail subscription, with only its connection driver replaced.
vi.mock(
  "../../../../../packages/client-runtime/src/connection/driver.ts",
  async (importOriginal) => {
    const [actual, { fakeDriver }, Layer] = await Promise.all([
      importOriginal<{ readonly ConnectionDriver: Context.Key<unknown, FakeDriver> }>(),
      import("../../../test/fakeEnvironment"),
      import("effect/Layer"),
    ]);
    return { ...actual, layer: Layer.succeed(actual.ConnectionDriver, fakeDriver) };
  },
);

it("updates an open inspector from live progress to a copyable report with workspace links", async () => {
  await page.viewport(1400, 900);
  const thread = threadWithHistory("native-subagent-inspector", 1);
  const ref = scopeThreadRef(ENVIRONMENT_ID, thread.id);
  const run = thread.runs[0]!;
  const at = DateTime.makeUnsafe("2026-03-17T19:12:28.000Z");
  const agent: OrchestrationV2Subagent = {
    id: NodeId.make("architecture-scout"),
    threadId: thread.id,
    runId: run.id,
    parentNodeId: NodeId.make("architecture-parent"),
    origin: "provider_native",
    createdBy: "agent",
    driver: ProviderDriverKind.make("codex"),
    providerInstanceId: run.modelSelection.instanceId,
    providerThreadId: null,
    childThreadId: null,
    nativeTaskRef: null,
    prompt:
      "Trace the runtime boundaries.\nCompare the provider adapters.\nIdentify ownership of streamed state.",
    title: "RuntimeView (scout)",
    model: "gpt-5.4",
    status: "running",
    progress: "Reading the provider adapters",
    result: null,
    startedAt: at,
    completedAt: null,
    updatedAt: at,
  };
  using _environment = installFakeEnvironment([thread]);
  const beforeSettings = getClientSettings();
  const beforePanels = useRightPanelStore.getState();
  using cleanup = new DisposableStack();
  cleanup.defer(() => {
    __setClientSettingsForTests(beforeSettings);
    useRightPanelStore.setState(beforePanels);
  });
  __setClientSettingsForTests({
    ...DEFAULT_CLIENT_SETTINGS,
    onboardingCompletedAt: "2026-01-01T00:00:00.000Z",
  });
  const router = getRouter(
    createMemoryHistory({ initialEntries: [`/${ENVIRONMENT_ID}/${thread.id}`] }),
  );
  await router.load();
  await using screen = await render(<AppRoot router={router} />, {
    // AppRoot brings its own router.
    router: false,
  });
  await expect.element(screen.getByText("Answer 0 for native-subagent-inspector.")).toBeVisible();
  await act(() => useRightPanelStore.getState().openSubagent(ref, agent.id, "Architecture scout"));
  await expect.element(screen.getByRole("article", { name: "Architecture scout" })).toBeVisible();
  await expect.element(screen.getByText("This subagent is unavailable.")).toBeVisible();

  await emitThreadEvent(thread.id, { type: "subagent.updated", payload: agent });
  const inspector = screen.getByRole("article", { name: "RuntimeView (scout)" });
  const task = inspector.getByRole("button", { name: "Task" });
  await expect.element(task).toHaveAttribute("aria-expanded", "true");
  await expect.element(inspector.getByText("Reading the provider adapters")).toBeVisible();
  await expect
    .element(inspector.getByText("Waiting for the subagent to return a result."))
    .toBeVisible();

  const completedAt = DateTime.makeUnsafe("2026-03-17T19:12:33.000Z");
  const settled = { ...agent, status: "completed" as const, completedAt, updatedAt: completedAt };
  await emitThreadEvent(thread.id, { type: "subagent.updated", payload: settled });
  await expect.element(inspector.getByText("This subagent returned no text output.")).toBeVisible();
  await expect
    .element(inspector.getByText("Reading the provider adapters"))
    .not.toBeInTheDocument();

  const result = [
    "# Runtime boundaries",
    "| Layer | Owner |\n| --- | --- |\n| Adapter | Provider |",
    "```ts\nconst boundary = 'adapter';\n```",
    "See [runtime source](/workspace/render/src/runtime.ts:17).",
  ].join("\n\n");
  await emitThreadEvent(thread.id, { type: "subagent.updated", payload: { ...settled, result } });
  await expect
    .element(inspector.getByRole("heading", { name: "Runtime boundaries" }))
    .toBeVisible();
  await expect.element(inspector.getByRole("cell", { name: "Provider" })).toBeVisible();
  await expect.element(task).toHaveAttribute("aria-expanded", "false");
  await task.click();
  await expect.element(task).toHaveAttribute("aria-expanded", "true");

  using clipboard = vi.spyOn(navigator.clipboard, "writeText").mockResolvedValue(undefined);
  await inspector.getByRole("button", { name: "Copy output" }).click();
  await expect.element(inspector.getByRole("button", { name: "Copied" })).toBeVisible();
  expect(clipboard).toHaveBeenCalledExactlyOnceWith(result);
  await inspector.getByRole("link", { name: /runtime\.ts/ }).click();
  await vi.waitFor(() => {
    expect(
      selectActiveRightPanelSurface(useRightPanelStore.getState().byThreadKey, ref),
    ).toMatchObject({
      kind: "file",
      relativePath: "src/runtime.ts",
      revealLine: 17,
    });
  });
});
