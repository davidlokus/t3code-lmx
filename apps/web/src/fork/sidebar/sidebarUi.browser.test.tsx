import {
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  RunId,
  ThreadId,
  type ScopedThreadRef,
} from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";

import { render } from "../../../test/render";
import Sidebar from "../../components/Sidebar";
import { SidebarChromeHeader } from "../../components/sidebar/SidebarChrome";
import { SidebarProvider } from "../../components/ui/sidebar";
import { useHandleNewThread } from "../../hooks/useHandleNewThread";
import { useNowMinute } from "../../hooks/useNowMinute";
import { useThreadRouteTarget } from "../../hooks/useThreadRouteTarget";
import { useProjects, useQuietThreadShells, useThreadShell } from "../../state/entities";
import { makeThreadFixture } from "../../test-fixtures";
import type { Project } from "../../types";
import { SIDEBAR_OPTIONS_STORAGE_KEY, useSidebarOptionsStore } from "./sidebarOptionsStore";

vi.mock("../../state/entities", { spy: true });
vi.mock("../../hooks/useHandleNewThread", { spy: true });
vi.mock("../../hooks/useNowMinute", { spy: true });
vi.mock("../../hooks/useThreadRouteTarget", { spy: true });
vi.mock("../../components/sidebar/SidebarChrome", async (original) => {
  const actual = await original<typeof import("../../components/sidebar/SidebarChrome")>();
  return {
    ...actual,
    SidebarChromeFooter: () => null,
  };
});

function makeProject(id: string): Project {
  return {
    id: ProjectId.make(id),
    environmentId: EnvironmentId.make("local"),
    title: id,
    workspaceRoot: `/projects/${id}`,
    repositoryIdentity: null,
    defaultModelSelection: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    scripts: [],
  };
}

describe("T3 Lab sidebar redesign", () => {
  it("renders T3 Lab wordmark and accessible home link in SidebarChromeHeader", async () => {
    await using screen = await render(
      <SidebarProvider>
        <SidebarChromeHeader isElectron={false} />
      </SidebarProvider>,
    );
    const homeLink = screen.getByRole("link", { name: "T3 Lab home" });
    await expect.element(homeLink).toBeInTheDocument();
    await expect.element(homeLink).toHaveTextContent("Lab");
  });

  it("renders aligned status lane, smart metadata, deleted provider fallback, attention filter, and display options", async () => {
    using stack = new DisposableStack();
    stack.defer(() => {
      useSidebarOptionsStore.getState().resetSidebarOptions();
      useSidebarOptionsStore.getState().setActivityOnly(false);
      window.localStorage.removeItem(SIDEBAR_OPTIONS_STORAGE_KEY);
    });
    useSidebarOptionsStore.getState().resetSidebarOptions();
    useSidebarOptionsStore.getState().setActivityOnly(false);
    window.localStorage.removeItem(SIDEBAR_OPTIONS_STORAGE_KEY);

    const alpha = makeProject("alpha");
    const beta = makeProject("beta");

    const quietReadThread = makeThreadFixture({
      environmentId: alpha.environmentId,
      id: ThreadId.make("thread-quiet"),
      projectId: alpha.id,
      title: "Quiet read task",
      branch: "feat/sidebar-lane",
      worktreePath: "/worktrees/sidebar-lane",
      interactionMode: "plan",
      runtimeMode: "full-access",
      modelSelection: {
        instanceId: ProviderInstanceId.make("omp_omp_3"),
        model: "claude-opus-4-6",
      },
      lastVisitedAt: "2026-01-05T00:00:00.000Z",
      updatedAt: "2026-01-04T00:00:00.000Z",
      latestRun: {
        runId: RunId.make("turn-quiet"),
        status: "completed",
        requestedAt: "2026-01-04T00:00:00.000Z",
        startedAt: "2026-01-04T00:00:00.000Z",
        completedAt: "2026-01-04T00:01:00.000Z",
        assistantMessageId: null,
      },
    });

    const approvalThread = makeThreadFixture({
      environmentId: beta.environmentId,
      id: ThreadId.make("thread-approval"),
      projectId: beta.id,
      title: "Needs approval task",
      branch: "fix/auth",
      runtimeMode: "approval-required",
      modelSelection: {
        instanceId: ProviderInstanceId.make("legacy_unknown_9"),
        model: "gpt-6.2-sol",
      },
      hasPendingApprovals: true,
      updatedAt: "2026-01-05T00:00:00.000Z",
    });

    const threads = [quietReadThread, approvalThread];
    const routeThreadRef: ScopedThreadRef = {
      environmentId: beta.environmentId,
      threadId: approvalThread.id,
    };

    vi.mocked(useNowMinute).mockReturnValue("2026-01-05T00:05");
    vi.mocked(useProjects).mockReturnValue([alpha, beta]);
    vi.mocked(useQuietThreadShells).mockReturnValue(threads);
    vi.mocked(useThreadShell).mockImplementation((ref) =>
      ref === null ? null : (threads.find((t) => t.id === ref.threadId) ?? null),
    );
    vi.mocked(useThreadRouteTarget).mockReturnValue({ kind: "server", threadRef: routeThreadRef });
    vi.mocked(useHandleNewThread).mockReturnValue({
      activeDraftThread: null,
      activeThread: null,
      defaultProjectRef: { environmentId: alpha.environmentId, projectId: alpha.id },
      defaultProjectFallbackReady: true,
      handleNewThread: vi.fn().mockResolvedValue(null),
      routeDraftId: null,
      routeThreadRef,
    });

    await using screen = await render(
      <SidebarProvider>
        <Sidebar routeReveal={{ observedKey: null, pendingKey: null }} />
      </SidebarProvider>,
    );

    // Status lane, loud pill, branch, mode badges, compact model name, and monogram fallback
    await expect.element(screen.getByText("Quiet read task")).toBeInTheDocument();
    await expect.element(screen.getByText("Needs approval task")).toBeInTheDocument();
    await expect.element(screen.getByText("Approval")).toBeInTheDocument();
    await expect.element(screen.getByText("feat/sidebar-lane")).toBeInTheDocument();
    await expect.element(screen.getByText("Plan")).toBeInTheDocument();
    await expect.element(screen.getByText("Full")).toBeInTheDocument();
    await expect.element(screen.getByText("opus-4.6")).toBeInTheDocument();
    await expect.element(screen.getByText("gpt-6.2-sol")).toBeInTheDocument();
    await expect
      .element(screen.getByTestId("sidebar-provider-fallback-monogram"))
      .toHaveTextContent("LE");
    expect(
      screen.container.querySelectorAll('[data-slot="sidebar-status-lane"]').length,
    ).toBeGreaterThanOrEqual(2);
    expect(
      screen.container.querySelectorAll('[data-slot="sidebar-row-meta"]').length,
    ).toBeGreaterThanOrEqual(2);

    // Attention filter isolates urgent thread and restores focus to bell on Show all
    const bell = screen.getByTestId("sidebar-attention-filter");
    await userEvent.click(bell);
    await expect.element(screen.getByTestId("sidebar-attention-banner")).toBeInTheDocument();
    await expect.element(screen.getByText("Needs approval task")).toBeInTheDocument();
    await expect.element(screen.getByText("Quiet read task")).not.toBeInTheDocument();
    expect(screen.container.querySelectorAll("[data-thread-item]")).toHaveLength(1);

    await userEvent.click(screen.getByRole("button", { name: "Show all" }));
    await expect.element(screen.getByText("Quiet read task")).toBeInTheDocument();
    await expect.element(bell).toHaveFocus();

    // Display options popover: compact single-line + status grouping persistence
    await userEvent.click(screen.getByTestId("sidebar-display-options-trigger"));
    await userEvent.click(screen.getByText("Compact single line"));
    expect(useSidebarOptionsStore.getState().compactSingleLine).toBe(true);
    expect(
      screen.container.querySelectorAll(
        '[data-testid="sidebar-row-folder"] [data-slot="sidebar-row-meta"]',
      ),
    ).toHaveLength(0);

    await userEvent.click(screen.getByRole("button", { name: "Status" }));
    expect(useSidebarOptionsStore.getState()).toMatchObject({
      groupBy: "status",
      compactSingleLine: true,
    });
    expect(
      screen.container.querySelectorAll('[data-testid="sidebar-row-card"]').length,
    ).toBeGreaterThan(0);
    // Compact single-line also keeps status cards collapsed to one line with no second meta row
    expect(
      screen.container.querySelectorAll(
        '[data-testid="sidebar-row-card"] [data-slot="sidebar-row-meta"]',
      ),
    ).toHaveLength(0);

    const saved = JSON.parse(window.localStorage.getItem(SIDEBAR_OPTIONS_STORAGE_KEY) ?? "{}");
    expect(saved).toMatchObject({
      groupBy: "status",
      compactSingleLine: true,
    });
    expect("activityOnly" in saved).toBe(false);
  });

  it("renders a compact worktree folder label when branch is null", async () => {
    using stack = new DisposableStack();
    stack.defer(() => {
      useSidebarOptionsStore.getState().resetSidebarOptions();
      window.localStorage.removeItem(SIDEBAR_OPTIONS_STORAGE_KEY);
    });
    useSidebarOptionsStore.getState().resetSidebarOptions();
    const proj = makeProject("detached");
    const detachedThread = makeThreadFixture({
      environmentId: proj.environmentId,
      id: ThreadId.make("thread-detached"),
      projectId: proj.id,
      title: "Detached worktree task",
      branch: null,
      worktreePath: "/Users/dev/worktrees/hotfix-wt",
    });
    const routeThreadRef: ScopedThreadRef = {
      environmentId: proj.environmentId,
      threadId: detachedThread.id,
    };
    vi.mocked(useNowMinute).mockReturnValue("2026-01-05T00:05");
    vi.mocked(useProjects).mockReturnValue([proj]);
    vi.mocked(useQuietThreadShells).mockReturnValue([detachedThread]);
    vi.mocked(useThreadShell).mockReturnValue(detachedThread);
    vi.mocked(useThreadRouteTarget).mockReturnValue({ kind: "server", threadRef: routeThreadRef });
    vi.mocked(useHandleNewThread).mockReturnValue({
      activeDraftThread: null,
      activeThread: null,
      defaultProjectRef: { environmentId: proj.environmentId, projectId: proj.id },
      defaultProjectFallbackReady: true,
      handleNewThread: vi.fn().mockResolvedValue(null),
      routeDraftId: null,
      routeThreadRef,
    });

    await using screen = await render(
      <SidebarProvider>
        <Sidebar routeReveal={{ observedKey: null, pendingKey: null }} />
      </SidebarProvider>,
    );
    await expect.element(screen.getByText("hotfix-wt")).toBeInTheDocument();
  });
});
