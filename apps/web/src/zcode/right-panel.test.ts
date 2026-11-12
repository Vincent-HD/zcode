import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { type EnvironmentId, ThreadId } from "@t3tools/contracts";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { surfaceShortcutActionForKey } from "../components/RightPanelTabs";
import { reopenClosedView } from "../reopenClosedView";
import {
  migratePersistedRightPanelState,
  selectThreadRightPanelState,
  useRightPanelStore,
} from "../rightPanelStore";
import { zcodeSurfaceLaunchers } from "./right-panel-surfaces";

const refA = scopeThreadRef("env-1" as EnvironmentId, ThreadId.make("thread-A"));
const refB = scopeThreadRef("env-1" as EnvironmentId, ThreadId.make("thread-B"));
const panelState = (ref = refA) =>
  selectThreadRightPanelState(useRightPanelStore.getState().byThreadKey, ref);
const keyJ = {
  key: "j",
  altKey: false,
  ctrlKey: false,
  defaultPrevented: false,
  isComposing: false,
  metaKey: false,
};

beforeEach(() => {
  useRightPanelStore.setState(useRightPanelStore.getInitialState(), true);
});

describe("Jujutsu right panel surface", () => {
  it("keeps Jujutsu singleton, restores it, and scopes it to its thread", () => {
    const store = useRightPanelStore.getState();
    store.open(refA, "jj");
    store.open(refA, "jj");
    const state = panelState();
    expect(state.surfaces).toEqual([{ id: "jj", kind: "jj" }]);
    expect(panelState(refB).surfaces).toEqual([]);
    const migrated = migratePersistedRightPanelState({
      byThreadKey: useRightPanelStore.getState().byThreadKey,
    });
    expect(Object.values(migrated.byThreadKey)[0]?.surfaces).toEqual(state.surfaces);
    store.closeSurface(refA, "jj");
    expect(panelState().isOpen).toBe(false);
    store.open(refA, "jj");
    expect(panelState().activeSurfaceId).toBe("jj");
  });

  it("opens an available Jujutsu launcher from J", () => {
    const context = { threadRef: refA, cwd: "/repo", projectId: null, isServerThread: true };
    const available = zcodeSurfaceLaunchers(context);
    expect(surfaceShortcutActionForKey(available, keyJ)?.label).toBe("Jujutsu");
    surfaceShortcutActionForKey(available, keyJ)?.onClick();
    expect(panelState().activeSurfaceId).toBe("jj");
    expect(
      surfaceShortcutActionForKey(zcodeSurfaceLaunchers({ ...context, cwd: null }), keyJ),
    ).toBeNull();
  });

  it("does not reopen a Jujutsu tab without an available project", async () => {
    const reopened = await reopenClosedView(
      { kind: "panel-tab", threadRef: refA, surface: { kind: "jj", id: "jj" } },
      { openPreview: vi.fn(), workspaceAvailable: false },
    );
    expect(reopened).toBe(false);
    expect(panelState().surfaces).toEqual([]);
  });
});
