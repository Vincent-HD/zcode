import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { scopeThreadRef, scopedThreadKey } from "@t3tools/client-runtime/environment";
import { expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import { render } from "../../test/render";
import { useTemporaryConversationStore } from "./temporary-conversation-store";
import { ZcodeTemporaryHeaderActions, useZcodeTemporaryHeader } from "./temporary-header";

const threadRef = scopeThreadRef(EnvironmentId.make("header-env"), ThreadId.make("header-thread"));

const Harness = (props: { readonly destroy: () => Promise<boolean> }) => {
  const header = useZcodeTemporaryHeader({
    conversation: { keys: [scopedThreadKey(threadRef)], destroy: props.destroy },
    activeThreadRef: threadRef,
    onOpenProjectSettings: undefined,
  });
  return <ZcodeTemporaryHeaderActions header={header} canOperateThread />;
};

it("confirms destruction with action-specific labels before destroying", async () => {
  const destroy = vi.fn(async () => true);
  await using _screen = await render(<Harness destroy={destroy} />, {
    // A store-only harness; it never navigates.
    router: false,
  });

  try {
    await userEvent.click(page.getByRole("button", { name: "Make conversation temporary" }));
    await userEvent.click(page.getByRole("button", { name: "Destroy temporary conversation" }));
    await expect.element(page.getByText("Destroy this temporary conversation?")).toBeVisible();
    page
      .getByRole("button", { name: "Keep conversation" })
      .element()
      .dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await expect.element(page.getByRole("alertdialog")).not.toBeInTheDocument();
    expect(destroy).not.toHaveBeenCalled();

    await userEvent.click(page.getByRole("button", { name: "Destroy temporary conversation" }));
    await expect.element(page.getByText("Destroy this temporary conversation?")).toBeVisible();
    page
      .getByRole("button", { name: "Destroy conversation", exact: true })
      .element()
      .dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await vi.waitFor(() => expect(destroy).toHaveBeenCalledOnce());
  } finally {
    useTemporaryConversationStore.getState().setTemporaryThread(scopedThreadKey(threadRef), false);
  }
});
