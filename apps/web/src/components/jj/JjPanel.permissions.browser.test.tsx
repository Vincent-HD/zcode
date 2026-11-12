import { EnvironmentId, JjPanelReady, type JjPanelSnapshot } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { AsyncResult } from "effect/reactivity";
import { describe, expect, it, vi } from "vite-plus/test";

const state = vi.hoisted(() => ({
  canRead: true,
  configReady: false,
  supportsPanel: true,
  getPanel: vi.fn<(...args: ReadonlyArray<unknown>) => Promise<unknown>>(),
  getRevision: vi.fn<(...args: ReadonlyArray<unknown>) => Promise<unknown>>(),
}));

vi.mock(import("@effect/atom-react"), async (original) => ({
  ...(await original()),
  useAtomValue: (() => true) as never,
}));
vi.mock(import("~/state/entities"), async (original) => ({
  ...(await original()),
  useServerConfigs: (() => ({
    get: () =>
      state.configReady
        ? {
            environment: {
              capabilities: {
                jjPanel: state.supportsPanel,
                jjPanelActions: true,
                jjPanelDiff: true,
              },
            },
          }
        : undefined,
  })) as never,
}));
vi.mock(import("~/state/session"), async (original) => ({
  ...(await original()),
  useEnvironmentScope: (() => state.canRead) as never,
}));
vi.mock(import("~/state/use-atom-command"), async (original) => ({
  ...(await original()),
  useAtomCommand: ((command: { label: string }) =>
    command.label.endsWith("get-revision") ? state.getRevision : state.getPanel) as never,
}));
vi.mock(import("~/hooks/useTheme"), () => ({
  useTheme: (() => ({ resolvedTheme: "light" })) as never,
}));
vi.mock(import("./jj-action-dialog"), async (original) => ({
  ...(await original()),
  JjActionDialog: (() => null) as never,
}));
vi.mock(import("./jj-forge-panel"), () => ({ JjForgePanel: () => null }));

import { page, userEvent } from "vite-plus/test/browser";
import { act, render } from "../../../test/render";
import JjPanel from "./JjPanel";

const environmentId = EnvironmentId.make("jj-panel-permissions");
const decodePanel = Schema.decodeSync(JjPanelReady);

function setup() {
  state.canRead = true;
  state.configReady = false;
  state.supportsPanel = true;
  state.getPanel.mockReset();
  state.getRevision.mockReset();
}

const author = { name: "Test", email: "test@example.invalid", timestamp: "2026-01-01T00:00:00Z" };

function panel(description: string, extraRows: ReadonlyArray<string> = []): JjPanelSnapshot {
  return decodePanel({
    status: "ready",
    cwd: "/repo",
    workspaceIdentity: {
      workspaceRoot: "/repo",
      repositoryPath: "/repo/.jj/repo",
      workspaceId: "workspace",
    },
    operationId: "d".repeat(128),
    operationDescription: "snapshot working copy",
    workingCopyCommitId: "a".repeat(40),
    revset: "builtin_log()",
    offset: 0,
    hasMore: false,
    remotes: [],
    rows: [
      {
        commitId: "a".repeat(40),
        parentIds: ["0".repeat(40)],
        changeId: "k".repeat(32),
        summary: description,
        author,
        changePrefixLength: 1,
        commitPrefixLength: 1,
        current: true,
      },
      ...extraRows.map((summary, index) => ({
        commitId: String(index + 1).repeat(40),
        parentIds: ["0".repeat(40)],
        changeId: "lmnopqrs"[index]!.repeat(32),
        summary,
        author,
        changePrefixLength: 1,
        commitPrefixLength: 1,
      })),
    ],
  });
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

describe("JjPanel permission and capability refresh", () => {
  it("loads when panel capability arrives after mount", async () => {
    setup();
    state.getPanel.mockResolvedValue(AsyncResult.success(panel("loaded after config")));
    await using screen = await render(
      <JjPanel environmentId={environmentId} cwd="/repo" visible />,
    );
    await act(async () => await Promise.resolve());
    expect(state.getPanel).not.toHaveBeenCalled();

    state.configReady = true;
    await screen.rerender(<JjPanel environmentId={environmentId} cwd="/repo" visible />);
    await vi.waitFor(() => expect(screen.container.textContent).toContain("loaded after config"));
    expect(state.getPanel).toHaveBeenCalledOnce();
  });

  it.each(["read permission", "panel capability"] as const)(
    "ignores a response after %s is revoked and refreshes when restored",
    async (revoked) => {
      setup();
      const first = deferred<unknown>();
      const second = deferred<unknown>();
      state.configReady = true;
      state.getPanel.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
      await using screen = await render(
        <JjPanel environmentId={environmentId} cwd="/repo" visible />,
      );
      await vi.waitFor(() => expect(state.getPanel).toHaveBeenCalledOnce());

      if (revoked === "read permission") state.canRead = false;
      else state.supportsPanel = false;
      await screen.rerender(<JjPanel environmentId={environmentId} cwd="/repo" visible />);
      expect(screen.container.textContent).not.toContain("Refreshing…");
      await act(async () => first.resolve(AsyncResult.success(panel("stale response"))));
      expect(screen.container.textContent).not.toContain("stale response");

      if (revoked === "read permission") state.canRead = true;
      else state.supportsPanel = true;
      await screen.rerender(<JjPanel environmentId={environmentId} cwd="/repo" visible />);
      await vi.waitFor(() => expect(state.getPanel).toHaveBeenCalledTimes(2));
      expect(screen.container.textContent).not.toContain("stale response");

      await act(async () => second.resolve(AsyncResult.success(panel("fresh response"))));
      await vi.waitFor(() => expect(screen.container.textContent).toContain("fresh response"));
    },
  );

  it("selects with click, extends with Ctrl+click and clears with Escape", async () => {
    setup();
    state.configReady = true;
    state.getPanel.mockResolvedValue(AsyncResult.success(panel("working copy", ["sibling"])));
    state.getRevision.mockResolvedValue(
      AsyncResult.success({
        commitId: "a".repeat(40),
        changeId: "k".repeat(32),
        description: "working copy\n\nbody",
        author,
        committer: author,
        files: [{ path: "src/file.ts", status: "modified" }],
        filesTruncated: false,
        conflictPaths: [],
      }),
    );
    await using _screen = await render(
      <JjPanel environmentId={environmentId} cwd="/repo" visible />,
    );
    const first = page.getByRole("option", { name: /working copy/ });
    await userEvent.click(first);
    await expect.element(first).toHaveAttribute("aria-selected", "true");
    await expect.element(page.getByText("src/file.ts")).toBeVisible();
    await userEvent.click(page.getByRole("option", { name: /sibling/ }), {
      modifiers: ["Control"],
    });
    await expect.element(page.getByText("2 selected")).toBeVisible();
    await userEvent.keyboard("{Escape}");
    await expect.element(page.getByText("2 selected")).not.toBeInTheDocument();
    await expect.element(first).toHaveAttribute("aria-selected", "false");
  });
});
