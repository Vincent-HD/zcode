import type { JjHistoryStep } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { msg } from "gt-react";

import { m, type MessageResolver } from "~/i18n/messages";

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
    ? m(
        msg(
          "This environment's T3 Code server does not support the Jujutsu panel. Update that server to use it.",
        ),
      )
    : message;

const REASON_MESSAGES: Readonly<Record<string, string>> = {
  immutable: msg(
    "That revision is immutable. Pick a mutable revision or change immutable_heads() in your jj config.",
  ),
  conflicted: msg("Resolve the conflicts in that revision first."),
  "stale-state": msg("The workspace changed since the panel loaded. It has refreshed; try again."),
  "workspace-mismatch": msg("The workspace changed since the panel loaded. Refresh and try again."),
  "concurrent-operation": msg("Another jj operation ran at the same time. Refresh and try again."),
  "invalid-target": msg("That revision is no longer available. Refresh and try again."),
  "invalid-path": msg("That file is not changed in this revision."),
  "invalid-revset": msg("That revset is invalid."),
  "invalid-receipt": msg("That action can no longer be reverted. Use Undo in the panel header."),
  "no-history": msg("Nothing to undo or redo in this workspace."),
  "history-blocked": msg(
    "The repository changed after that operation, usually through working-copy edits. Reverting it now could split or conflict those changes.",
  ),
  unavailable: msg("Jujutsu is unavailable in this environment."),
};

export const historyLabel = (
  verb: "Undo" | "Redo",
  step: JjHistoryStep | undefined,
  resolve: MessageResolver = m,
) => {
  if (!step)
    return verb === "Undo" ? resolve(msg("Nothing to undo")) : resolve(msg("Nothing to redo"));
  const description = step.description || resolve(msg("the last operation"));
  if (step.blocked)
    return verb === "Undo"
      ? resolve(msg("Can't undo “{description}”: the repository changed since", { description }))
      : resolve(msg("Can't redo “{description}”: the repository changed since", { description }));
  return verb === "Undo"
    ? resolve(msg("Undo: {description}", { description }))
    : resolve(msg("Redo: {description}", { description }));
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
    if (known) return m(known);
  }
  const message =
    typeof error === "string"
      ? error
      : error instanceof Error
        ? error.message
        : m(msg("The Jujutsu request failed."));
  return jjPanelRequestError(message);
};
