// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vite-plus/test";
import { UsagePopover } from "./usage-popover";

it("opens usage on click, stays closed on hover, and dismisses with Escape", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  try {
    await act(() =>
      root.render(
        <UsagePopover label="Turn usage" icon={null} summary="Usage 1K tok">
          <p>Recorded usage details</p>
        </UsagePopover>,
      ),
    );
    const trigger = container.querySelector("button");
    if (!trigger) throw new Error("Missing usage trigger");
    await act(() => trigger.dispatchEvent(new MouseEvent("mouseover", { bubbles: true })));
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    await act(() => trigger.click());
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain(
      "Recorded usage details",
    );
    await act(() =>
      document.activeElement?.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
      ),
    );
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
  } finally {
    await act(() => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  }
});
