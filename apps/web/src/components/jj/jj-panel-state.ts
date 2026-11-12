import type { JjHistoryStep } from "@t3tools/contracts";
import * as Cause from "effect/Cause";

export interface DescriptionDraft {
  readonly text: string;
  readonly baseDescription: string;
  readonly baseCommitId: string;
}

export const descriptionDraftIsStale = (input: {
  draft: DescriptionDraft;
  revision: { commitId: string; description: string };
}) =>
  input.draft.baseCommitId !== input.revision.commitId ||
  input.draft.baseDescription !== input.revision.description;

export const jjPanelRequestError = (message: string) =>
  /unknown (?:method|request|rpc)|not (?:found|implemented)|unsupported.*(?:method|rpc)|method.*(?:unknown|not found|unsupported)|no handler/i.test(
    message,
  )
    ? "This environment's T3 Code server does not support the Jujutsu panel. Update that server to use it."
    : message;

const REASON_MESSAGES: Readonly<Record<string, string>> = {
  immutable:
    "That revision is immutable. Pick a mutable revision or change immutable_heads() in your jj config.",
  conflicted: "Resolve the conflicts in that revision first.",
  "stale-state": "The workspace changed since the panel loaded. It has refreshed; try again.",
  "workspace-mismatch": "The workspace changed since the panel loaded. Refresh and try again.",
  "concurrent-operation": "Another jj operation ran at the same time. Refresh and try again.",
  "invalid-target": "That revision is no longer available. Refresh and try again.",
  "invalid-path": "That file is not changed in this revision.",
  "invalid-revset": "That revset is invalid.",
  "invalid-receipt": "That action can no longer be reverted. Use Undo in the panel header.",
  "no-history": "Nothing to undo or redo in this workspace.",
  "history-blocked":
    "The repository changed after that operation, usually through working-copy edits. Reverting it now could split or conflict those changes.",
  unavailable: "Jujutsu is unavailable in this environment.",
};

export const historyLabel = (verb: "Undo" | "Redo", step: JjHistoryStep | undefined) => {
  if (!step) return `Nothing to ${verb.toLowerCase()}`;
  const description = step.description || "the last operation";
  return step.blocked
    ? `Can't ${verb.toLowerCase()} “${description}”: the repository changed since`
    : `${verb}: ${description}`;
};

export const formatJjPanelError = (cause: Cause.Cause<unknown>) => {
  const error = Cause.squash(cause);
  if (
    typeof error === "object" &&
    error !== null &&
    "reason" in error &&
    typeof error.reason === "string" &&
    !("detail" in error && error.detail)
  ) {
    const known = REASON_MESSAGES[error.reason];
    if (known) return known;
  }
  const message =
    typeof error === "string"
      ? error
      : error instanceof Error
        ? error.message
        : "The Jujutsu request failed.";
  return jjPanelRequestError(message);
};
