import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from "@tanstack/react-router";
import { act, render } from "../../test/render";
import { describe, expect, it, vi } from "vite-plus/test";

const mocks = vi.hoisted(() => ({
  requestConfirmDialog: vi.fn<(...args: ReadonlyArray<unknown>) => Promise<boolean>>(),
  deleteThread: vi.fn(),
}));

vi.mock("../confirmDialog", () => ({
  requestConfirmDialog: mocks.requestConfirmDialog,
}));

vi.mock("../hooks/useThreadActions", () => ({
  useThreadActions: () => ({ deleteThread: mocks.deleteThread }),
}));

import { TemporaryConversationCoordinatorGate } from "./TemporaryConversationCoordinator";
import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime/environment";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { useUiStateStore } from "../uiStateStore";

async function createCoordinatorRouter(authGateStatus: "hosted-static" | "guest") {
  const rootRoute = createRootRoute({
    component: () => (
      <>
        <TemporaryConversationCoordinatorGate authGateStatus={authGateStatus} />
        <Outlet />
      </>
    ),
  });
  const threadRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/threads/$environmentId/$threadId",
    component: () => <p>Temporary thread route</p>,
  });
  const otherRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/welcome",
    component: () => <p>Other route</p>,
  });
  const routeTree = rootRoute.addChildren([threadRoute, otherRoute]);

  const router = createRouter({
    routeTree,
    history: createMemoryHistory({ initialEntries: ["/threads/hosted-static/thread-1"] }),
  });
  await router.load();
  return router;
}

function markTemporaryThread(threadKey: string): Disposable {
  useUiStateStore.getState().setTemporaryThread(threadKey, true);
  return {
    [Symbol.dispose]() {
      useUiStateStore.getState().setTemporaryThread(threadKey, false);
    },
  };
}

function setup() {
  mocks.requestConfirmDialog.mockReset().mockResolvedValue(false);
  mocks.deleteThread.mockReset();
}

describe("TemporaryConversationCoordinator auth gate", () => {
  it("mounts the navigation guard for hosted-static routes", async () => {
    setup();
    const threadRef = scopeThreadRef(
      EnvironmentId.make("hosted-static"),
      ThreadId.make("thread-1"),
    );
    using _temporaryMarker = markTemporaryThread(scopedThreadKey(threadRef));
    const router = await createCoordinatorRouter("hosted-static");
    await using screen = await render(<RouterProvider router={router} />, { router: false });

    await act(() => {
      void router.navigate({ to: "/welcome" });
    });

    await vi.waitFor(() => expect(mocks.requestConfirmDialog).toHaveBeenCalledTimes(1));
    expect(router.state.location.pathname).toBe("/threads/hosted-static/thread-1");
    await expect.element(screen.getByText("Temporary thread route")).toBeVisible();
    expect(mocks.deleteThread).not.toHaveBeenCalled();
  });

  it("does not mount the guard on guest routes", async () => {
    setup();
    const threadRef = scopeThreadRef(
      EnvironmentId.make("hosted-static"),
      ThreadId.make("thread-1"),
    );
    using _temporaryMarker = markTemporaryThread(scopedThreadKey(threadRef));
    const router = await createCoordinatorRouter("guest");
    await using screen = await render(<RouterProvider router={router} />, { router: false });

    await act(() => {
      void router.navigate({ to: "/welcome" });
    });

    expect(mocks.requestConfirmDialog).not.toHaveBeenCalled();
    expect(router.state.location.pathname).toBe("/welcome");
    await expect.element(screen.getByText("Other route")).toBeVisible();
  });
});
