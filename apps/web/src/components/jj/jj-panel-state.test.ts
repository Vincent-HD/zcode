import { JjPanelError } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { describe, expect, it } from "vite-plus/test";
import { descriptionDraftIsStale, formatJjPanelError, jjPanelRequestError } from "./jj-panel-state";

const revision = { commitId: "commit-1", description: "Title\n\nFull body\n" };
const draft = {
  text: "Edited title\n\nEdited body\n",
  baseDescription: revision.description,
  baseCommitId: revision.commitId,
};

describe("Jujutsu description drafts", () => {
  it("marks a draft stale when its revision is rewritten or redescribed elsewhere", () => {
    expect(descriptionDraftIsStale({ draft, revision })).toBe(false);
    expect(
      descriptionDraftIsStale({ draft, revision: { ...revision, commitId: "commit-2" } }),
    ).toBe(true);
    expect(
      descriptionDraftIsStale({ draft, revision: { ...revision, description: "External\n" } }),
    ).toBe(true);
  });

  it("gives an old remote a helpful unsupported message", () => {
    expect(jjPanelRequestError("Unknown method jj.getPanel")).toContain("Update that server");
    expect(formatJjPanelError(Cause.die("Unknown request tag: jj.getPanel"))).toContain(
      "Update that server",
    );
    expect(jjPanelRequestError("Permission denied")).toBe("Permission denied");
  });

  it("explains rejected targets and prefers jj's own explanation when it has one", () => {
    expect(formatJjPanelError(Cause.fail(new JjPanelError({ reason: "immutable" })))).toContain(
      "immutable_heads()",
    );
    expect(
      formatJjPanelError(
        Cause.fail(
          new JjPanelError({ reason: "invalid-revset", detail: "Function `nope` doesn't exist" }),
        ),
      ),
    ).toBe("Jujutsu: Function `nope` doesn't exist");
  });
});
