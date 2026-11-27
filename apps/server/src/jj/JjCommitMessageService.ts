import {
  JjPanelError,
  type JjGenerateCommitMessageInput,
  type JjGenerateCommitMessageResult,
  type ProjectId,
  type SourceControlWritingStyleSettings,
} from "@t3tools/contracts";
import {
  hasProjectSettingsOverrides,
  resolveProjectSettings,
} from "@t3tools/shared/projectSettings";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as TextGeneration from "../textGeneration/TextGeneration.ts";
import {
  conventionalCommitsTextGenerationPolicy,
  customTextGenerationPolicy,
  repositoryConventionsTextGenerationPolicy,
} from "../textGeneration/TextGenerationPresets.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";

const SUMMARY_LIMIT = 8_000;
const PATCH_LIMIT = 50_000;

const failed = (detail?: string) =>
  new JjPanelError({ reason: "command-failed", ...(detail ? { detail } : {}) });

const limit = (text: string, max: number) =>
  text.length <= max ? text : `${text.slice(0, max)}\n[truncated]`;

/**
 * Writes the working copy's commit message with T3's text generation, the way Git's Commit
 * does: the same writer model, writing style, and repository conventions, fed `jj diff` of `@`.
 */
export class JjCommitMessageService extends Context.Service<
  JjCommitMessageService,
  {
    readonly generate: (
      input: JjGenerateCommitMessageInput,
    ) => Effect.Effect<JjGenerateCommitMessageResult, JjPanelError>;
  }
>()("t3/jj/JjCommitMessageService") {}

const make = Effect.gen(function* () {
  const textGeneration = yield* TextGeneration.TextGeneration;
  const settingsService = yield* ServerSettings.ServerSettingsService;
  const providerRegistry = yield* ProviderRegistry.ProviderRegistry;
  const process = yield* VcsProcess.VcsProcess;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;

  const jj = (cwd: string, args: ReadonlyArray<string>, maxOutputBytes: number) =>
    process
      .run({
        operation: "JjCommitMessageService.jj",
        command: "jj",
        cwd,
        args: ["--no-pager", "--color=never", ...args],
        maxOutputBytes,
        outputMode: "error",
      })
      .pipe(
        Effect.map((result) => result.stdout),
        Effect.mapError(() => failed()),
      );

  const readInstructions = (cwd: string, file: string) =>
    fileSystem.readFileString(path.join(cwd, file)).pipe(
      Effect.map((text) => limit(text.trim(), 6_000)),
      Effect.orElseSucceed(() => ""),
    );

  const settingsFor = Effect.fn("JjCommitMessageService.settings")(function* (
    projectId: ProjectId | null,
  ) {
    const all = yield* settingsService.getSettings.pipe(Effect.mapError(() => failed()));
    const settings = hasProjectSettingsOverrides(all)
      ? resolveProjectSettings(all, projectId).settings
      : all;
    const modelSelection =
      settings.sourceControlWriterModelSelection === null
        ? settings.textGenerationModelSelection
        : ServerSettings.resolveSourceControlWriterModelSelection(
            settings,
            yield* providerRegistry.getProviders,
            projectId,
          );
    return { modelSelection, style: settings.sourceControlWritingStyle };
  });

  const policyFor = Effect.fn("JjCommitMessageService.policy")(function* (input: {
    cwd: string;
    style: SourceControlWritingStyleSettings;
  }) {
    switch (input.style.mode) {
      case "conventional_commits":
        return conventionalCommitsTextGenerationPolicy;
      case "custom":
        return customTextGenerationPolicy(
          input.style.customInstructions
            ? {
                commitInstructions: input.style.customInstructions,
                changeRequestInstructions: input.style.customInstructions,
              }
            : {},
        );
      case "repo_conventions": {
        const subjects = yield* jj(
          input.cwd,
          [
            "log",
            "--ignore-working-copy",
            "--no-graph",
            "--limit",
            "20",
            "-r",
            "::trunk() ~ root()",
            "-T",
            'description.first_line() ++ "\\n"',
          ],
          100_000,
        ).pipe(Effect.orElseSucceed(() => ""));
        const agents = yield* readInstructions(input.cwd, "AGENTS.md");
        const examples = [
          ...(subjects.trim()
            ? [`Recent commit subjects from this repository:\n${subjects.trim()}`]
            : []),
          ...(agents ? [`Local AGENTS.md:\n${agents}`] : []),
        ].join("\n\n");
        if (!examples) return repositoryConventionsTextGenerationPolicy;
        return {
          ...repositoryConventionsTextGenerationPolicy,
          commitInstructions: `${repositoryConventionsTextGenerationPolicy.commitInstructions}\n\n${examples}`,
        };
      }
    }
  });

  const generate = Effect.fn("JjCommitMessageService.generate")(function* (
    input: JjGenerateCommitMessageInput,
  ) {
    // Snapshots the working copy first, so the message covers the files as they are now.
    // `--stat` prints a zero total even for an empty change, so emptiness is read from `--summary`.
    const files = yield* jj(input.cwd, ["diff", "-r", "@", "--summary"], 200_000);
    if (!files.trim()) return yield* failed("The working copy has no changes to describe.");
    const summary = yield* jj(
      input.cwd,
      ["diff", "--ignore-working-copy", "-r", "@", "--stat"],
      200_000,
    );
    const patch = yield* jj(
      input.cwd,
      ["diff", "--ignore-working-copy", "-r", "@", "--git"],
      2_000_000,
    );
    const projectId = input.projectId ?? null;
    const settings = yield* settingsFor(projectId);
    const policy = yield* policyFor({ cwd: input.cwd, style: settings.style });
    const generated = yield* textGeneration
      .generateCommitMessage({
        cwd: input.cwd,
        branch: null,
        stagedSummary: limit(summary, SUMMARY_LIMIT),
        stagedPatch: limit(patch, PATCH_LIMIT),
        policy,
        modelSelection: settings.modelSelection,
        projectId,
      })
      .pipe(Effect.mapError((cause) => failed(cause.message)));
    const subject = generated.subject.trim().split(/\r?\n/)[0]?.trim() ?? "";
    if (!subject) return yield* failed("The model returned an empty commit message.");
    const body = generated.body.trim();
    return { message: body ? `${subject}\n\n${body}` : subject };
  });

  return JjCommitMessageService.of({ generate });
});

export const layer = Layer.effect(JjCommitMessageService, make);
