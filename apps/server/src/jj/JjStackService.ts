import { JjPanelError, type JjStackLinkInput, type JjStackLinkResult } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as VcsProcess from "../vcs/VcsProcess.ts";

const failed = (detail: string) => new JjPanelError({ reason: "command-failed", detail });

/** The gh-stack arguments that link the bookmarks, bottom to top, into one GitHub stack. */
const stackLinkArgs = (input: JjStackLinkInput): ReadonlyArray<string> => [
  "stack",
  "link",
  "--base",
  input.baseBookmark,
  "--remote",
  input.remote,
  ...input.bookmarks,
];

// gh prints its install hint when the extension is missing, and exits non-zero.
const MISSING_EXTENSION = /gh stack is available as an official extension|unknown command "stack"/i;

/**
 * Turns a jj stack's bookmarks into a GitHub stack of pull requests with `gh stack link`, which
 * pushes the branches, opens a draft pull request for each one that has none with the layer below
 * as its base, and links them on GitHub. jj has no GitHub integration of its own.
 */
export class JjStackService extends Context.Service<
  JjStackService,
  {
    readonly link: (input: JjStackLinkInput) => Effect.Effect<JjStackLinkResult, JjPanelError>;
  }
>()("t3/jj/JjStackService") {}

const make = Effect.gen(function* () {
  const process = yield* VcsProcess.VcsProcess;

  const link = Effect.fn("JjStackService.link")(function* (input: JjStackLinkInput) {
    const result = yield* process
      .run({
        operation: "JjStackService.link",
        command: "gh",
        cwd: input.cwd,
        args: stackLinkArgs(input),
        allowNonZeroExit: true,
        timeoutMs: 180_000,
        maxOutputBytes: 200_000,
      })
      .pipe(Effect.mapError(() => failed("The GitHub CLI could not be started.")));
    if (Number(result.exitCode) === 0) return { output: result.stdout.trim() };
    const stderr = result.stderr.trim();
    if (MISSING_EXTENSION.test(stderr) || MISSING_EXTENSION.test(result.stdout))
      return yield* failed(
        "Stacked pull requests need the gh-stack extension: gh extension install github/gh-stack",
      );
    return yield* failed(stderr.split("\n").slice(-3).join("\n") || "gh stack link failed.");
  });

  return JjStackService.of({ link });
});

export const layer = Layer.effect(JjStackService, make);
