import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  EnvironmentId,
  NodeId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  TurnItemId,
  type OrchestrationV2Subagent,
  type OrchestrationV2TurnItem,
} from "@t3tools/contracts";
import { Atom } from "effect/reactivity";
import { expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";

import { render } from "../../../test/render";
import { SideThreadsOpenContext } from "../../hooks/useSideThreadTrigger";
import { selectActiveRightPanelSurface, useRightPanelStore } from "../../rightPanelStore";
import { environmentThreadDetails } from "../../state/threads";
import { makeThreadProjectionFixture } from "../../test-fixtures";
import { V2LifecycleRow } from "./V2LifecycleRow";

function turnItem(agent: OrchestrationV2Subagent, ordinal: number): OrchestrationV2TurnItem {
  return {
    type: "subagent",
    id: TurnItemId.make(agent.id),
    threadId: agent.threadId,
    runId: agent.runId,
    nodeId: agent.id,
    subagentId: agent.id,
    providerThreadId: agent.providerThreadId,
    providerTurnId: null,
    providerInstanceId: agent.providerInstanceId,
    nativeItemRef: null,
    parentItemId: null,
    ordinal,
    status: agent.status,
    title: agent.title,
    origin: agent.origin,
    driver: agent.driver,
    startedAt: agent.startedAt,
    completedAt: agent.completedAt,
    updatedAt: agent.updatedAt,
    childThreadId: agent.childThreadId,
    prompt: agent.prompt,
    result: null,
  };
}

it("opens native subagents in the scoped panel without replacing child thread navigation or the tooltip", async () => {
  const projection = makeThreadProjectionFixture();
  const environmentId = EnvironmentId.make("timeline-environment");
  const parentRef = scopeThreadRef(environmentId, projection.thread.id);
  const childThreadId = ThreadId.make("child-thread");
  const remoteChild = {
    environmentId: EnvironmentId.make("linked-environment"),
    threadId: ThreadId.make("linked-child"),
    label: "Linked environment",
  };
  const native: OrchestrationV2Subagent = {
    id: NodeId.make("native-audit"),
    threadId: projection.thread.id,
    runId: null,
    parentNodeId: NodeId.make("parent-node"),
    origin: "provider_native",
    createdBy: "agent",
    driver: ProviderDriverKind.make("claudeAgent"),
    providerInstanceId: ProviderInstanceId.make("claudeAgent"),
    providerThreadId: null,
    childThreadId: null,
    nativeTaskRef: null,
    prompt: "Audit metrics",
    title: "Subagent: Native Audit (scout)",
    model: "claude-opus-4-6",
    status: "completed",
    result: "The audit found three missing tests.",
    startedAt: null,
    completedAt: null,
    updatedAt: projection.thread.updatedAt,
  };
  const local: OrchestrationV2Subagent = {
    ...native,
    id: NodeId.make("local-audit"),
    origin: "app_owned",
    childThreadId,
    title: "Local Audit",
  };
  const remote: OrchestrationV2Subagent = {
    ...local,
    id: NodeId.make("remote-audit"),
    childThreadId: null,
    remoteChild,
    title: "Remote Audit",
  };
  const unnamed: OrchestrationV2Subagent = {
    ...native,
    id: NodeId.make("unnamed-agent"),
    title: "Subagent: ",
  };
  const agents = [native, local, remote, unnamed];
  using _threadAtom = vi
    .spyOn(environmentThreadDetails, "threadAtom")
    .mockReturnValue(
      Atom.make({ environmentId, projection: { ...projection, subagents: agents } }),
    );
  const beforePanel = useRightPanelStore.getState();
  using cleanup = new DisposableStack();
  cleanup.defer(() => useRightPanelStore.setState(beforePanel));
  useRightPanelStore.setState({ byThreadKey: {} });
  const onOpenThread = vi.fn();
  const rows = (canOpen: boolean) => (
    <SideThreadsOpenContext value={canOpen}>
      {agents.map((agent, index) => (
        <V2LifecycleRow
          key={agent.id}
          item={turnItem(agent, index)}
          environmentId={environmentId}
          runs={[]}
          onOpenThread={onOpenThread}
        />
      ))}
    </SideThreadsOpenContext>
  );
  await using screen = await render(rows(true));

  const nativeRow = screen.getByRole("button", { name: "Open Native Audit (scout)" });
  await nativeRow.hover();
  await expect.element(page.getByText("Claude Opus 4.6", { exact: true })).toBeVisible();
  await nativeRow.click();
  expect(
    selectActiveRightPanelSurface(useRightPanelStore.getState().byThreadKey, parentRef),
  ).toMatchObject({
    id: `subagent:${native.id}`,
    kind: "subagent",
    subagentId: native.id,
    title: "Native Audit (scout)",
  });
  expect(onOpenThread).not.toHaveBeenCalled();

  await screen.getByRole("button", { name: "Open Local Audit" }).click();
  expect(onOpenThread).toHaveBeenCalledExactlyOnceWith(childThreadId, undefined, "primary");

  // The remote child only exists in the live projection, not the timeline item.
  await screen.getByRole("button", { name: "Open Remote Audit" }).click();
  expect(
    selectActiveRightPanelSurface(useRightPanelStore.getState().byThreadKey, parentRef),
  ).toMatchObject({
    kind: "linked-thread",
    viaEnvironmentId: environmentId,
    environmentId: remoteChild.environmentId,
    threadId: remoteChild.threadId,
  });

  await screen.getByRole("button", { name: "Open Subagent" }).click();
  expect(
    selectActiveRightPanelSurface(useRightPanelStore.getState().byThreadKey, parentRef),
  ).toMatchObject({ kind: "subagent", subagentId: unnamed.id, title: "Subagent" });

  await screen.rerender(rows(false));
  await expect.element(nativeRow).not.toBeInTheDocument();
});
