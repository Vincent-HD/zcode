import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { ChildProcessSpawner } from "effect/process";

import * as VcsProcess from "../vcs/VcsProcess.ts";
import * as JjStackService from "./JjStackService.ts";

const input = {
  cwd: "/repo",
  remote: "origin",
  baseBookmark: "main",
  bookmarks: ["t3/x-2", "t3/x"],
};

const withExit = (exitCode: number, stderr: string, seen: Array<ReadonlyArray<string>>) =>
  JjStackService.layer.pipe(
    Layer.provide(
      Layer.mock(VcsProcess.VcsProcess)({
        run: (run) => {
          seen.push(run.args);
          return Effect.succeed({
            exitCode: ChildProcessSpawner.ExitCode(exitCode),
            stdout: exitCode === 0 ? "Linked stack #7\n" : "",
            stderr,
            stdoutTruncated: false,
            stderrTruncated: false,
          });
        },
      }),
    ),
  );

describe("JjStackService", () => {
  it.effect("links the bookmarks bottom to top onto trunk's bookmark", () => {
    const seen: Array<ReadonlyArray<string>> = [];
    return Effect.gen(function* () {
      const service = yield* JjStackService.JjStackService;
      expect(yield* service.link(input)).toEqual({ output: "Linked stack #7" });
      expect(seen).toEqual([
        ["stack", "link", "--base", "main", "--remote", "origin", "t3/x-2", "t3/x"],
      ]);
    }).pipe(Effect.provide(withExit(0, "", seen)));
  });

  it.effect("names the extension to install when gh lacks gh-stack", () =>
    Effect.gen(function* () {
      const service = yield* JjStackService.JjStackService;
      const error = yield* service.link(input).pipe(Effect.flip);
      expect(error.detail).toContain("gh extension install github/gh-stack");
    }).pipe(
      Effect.provide(
        withExit(1, "gh stack is available as an official extension.\nTo install it, run:", []),
      ),
    ),
  );
});
