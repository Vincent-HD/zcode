import { expect, it } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import { render } from "../../../test/render";
import { UsagePopover } from "./usage-popover";

it("opens usage on click, stays closed on hover, and dismisses with Escape", async () => {
  await using screen = await render(
    <UsagePopover label="Turn usage" icon={null} summary="Usage 1K tok">
      <p>Recorded usage details</p>
    </UsagePopover>,
  );
  const trigger = screen.getByRole("button", { name: "Turn usage" });

  await userEvent.hover(trigger);
  await expect.element(trigger).toHaveAttribute("aria-expanded", "false");
  await expect.element(page.getByRole("dialog")).not.toBeInTheDocument();

  await userEvent.click(trigger);
  await expect.element(trigger).toHaveAttribute("aria-expanded", "true");
  await expect.element(page.getByText("Recorded usage details")).toBeVisible();

  await userEvent.keyboard("{Escape}");
  await expect.element(trigger).toHaveAttribute("aria-expanded", "false");
});
