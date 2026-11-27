import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import type { CommitMessageGenerationInput } from "@t3tools/provider-core/server/textGeneration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";

import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as TextGeneration from "../textGeneration/TextGeneration.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import * as JjCommitMessageService from "./JjCommitMessageService.ts";

const makeLayer = (seen: Array<CommitMessageGenerationInput>) =>
  JjCommitMessageService.layer.pipe(
    Layer.provideMerge(
      Layer.mock(TextGeneration.TextGeneration)({
        generateCommitMessage: (input) => {
          seen.push(input);
          return Effect.succeed({ subject: "feat: add greeting\nignored", body: "Says hello." });
        },
      }),
    ),
    Layer.provideMerge(ServerSettings.layerTest()),
    Layer.provideMerge(
      Layer.mock(ProviderRegistry.ProviderRegistry)({ getProviders: Effect.succeed([]) }),
    ),
    Layer.provideMerge(VcsProcess.layer),
    Layer.provideMerge(NodeServices.layer),
  );

const repository = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const process = yield* VcsProcess.VcsProcess;
  const cwd = yield* fs.makeTempDirectoryScoped({ prefix: "t3-jj-commit-message-" });
  const jj = (args: ReadonlyArray<string>) =>
    process.run({
      operation: "JjCommitMessageService.test",
      command: "jj",
      cwd,
      args: [
        "--no-pager",
        "--config",
        'user.name="Test"',
        "--config",
        'user.email="t@e.invalid"',
        ...args,
      ],
    });
  yield* jj(["git", "init"]);
  return { fs, cwd };
});

describe("JjCommitMessageService", () => {
  it.live("writes the working copy's message from its jj diff", () => {
    const seen: Array<CommitMessageGenerationInput> = [];
    return Effect.gen(function* () {
      const { fs, cwd } = yield* repository;
      yield* fs.writeFileString(`${cwd}/hello.txt`, "hello\n");
      const service = yield* JjCommitMessageService.JjCommitMessageService;
      const result = yield* service.generate({ cwd });
      expect(result.message).toBe("feat: add greeting\n\nSays hello.");
      expect(seen[0]?.stagedSummary).toContain("hello.txt");
      expect(seen[0]?.stagedPatch).toContain("+hello");
    }).pipe(Effect.provide(makeLayer(seen)), Effect.scoped);
  });

  it.live("refuses an empty working copy without calling the model", () => {
    const seen: Array<CommitMessageGenerationInput> = [];
    return Effect.gen(function* () {
      const { cwd } = yield* repository;
      const service = yield* JjCommitMessageService.JjCommitMessageService;
      const error = yield* service.generate({ cwd }).pipe(Effect.flip);
      expect(error.reason).toBe("command-failed");
      expect(seen).toHaveLength(0);
    }).pipe(Effect.provide(makeLayer(seen)), Effect.scoped);
  });
});
