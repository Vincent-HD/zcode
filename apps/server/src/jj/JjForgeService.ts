import {
  JjCommitId,
  type ChangeRequest,
  type JjPanelReady,
  type JjWorkspaceIdentity,
  type PullRequestRef,
} from "@t3tools/contracts";
import {
  JjForgeError,
  buildJjForgeLayers,
  type JjForgeDestination,
  type JjForgePreviewInput,
  type JjForgePlan,
  type JjForgePublishInput,
  type JjForgePublishResult,
  type JjForgeStatusInput,
  type JjForgeStatusResult,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as PullRequestService from "../pullRequest/PullRequestService.ts";
import * as SourceControlProviderRegistry from "../sourceControl/SourceControlProviderRegistry.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import * as JjPanelService from "./JjPanelService.ts";
import { sourceControlDefinitions } from "../sourceControl/sourceControlDefinitions.ts";

const error = (reason: JjForgeError["reason"]) => new JjForgeError({ reason });
const sameWorkspace = (input: { left: JjWorkspaceIdentity; right: JjWorkspaceIdentity }) =>
  input.left.workspaceId === input.right.workspaceId &&
  input.left.workspaceRoot === input.right.workspaceRoot &&
  input.left.repositoryPath === input.right.repositoryPath;
const sameDestination = (input: { left: JjForgeDestination; right: JjForgeDestination }) =>
  input.left.remote === input.right.remote &&
  input.left.provider === input.right.provider &&
  input.left.host === input.right.host &&
  input.left.repository === input.right.repository;
const quote = Schema.encodeSync(Schema.fromJsonString(Schema.String));
const decodeCommit = Schema.decodeEffect(Schema.fromJsonString(JjCommitId));
const isForgeError = Schema.is(JjForgeError);

export class JjForgeService extends Context.Service<
  JjForgeService,
  {
    readonly preview: (input: JjForgePreviewInput) => Effect.Effect<JjForgePlan, JjForgeError>;
    readonly publish: (
      input: JjForgePublishInput,
    ) => Effect.Effect<JjForgePublishResult, JjForgeError>;
    readonly getStatus: (
      input: JjForgeStatusInput,
    ) => Effect.Effect<JjForgeStatusResult, JjForgeError>;
  }
>()("t3/jj/JjForgeService") {}

const make = Effect.gen(function* () {
  const jj = yield* JjPanelService.JjPanelService;
  const providers = yield* SourceControlProviderRegistry.SourceControlProviderRegistry;
  const reviews = yield* PullRequestService.PullRequestService;
  const process = yield* VcsProcess.VcsProcess;
  const fs = yield* FileSystem.FileSystem;
  const publications = yield* Semaphore.make(1);

  const readWorkspace = Effect.fn("JjForgeService.readWorkspace")(function* (
    input: Pick<JjForgePreviewInput, "cwd" | "workspaceIdentity" | "expectedOperationId">,
  ) {
    const panel = yield* jj
      .getPanel({ cwd: input.cwd })
      .pipe(Effect.mapError(() => error("command-failed")));
    if (panel.status !== "ready") return yield* error("unavailable");
    if (!sameWorkspace({ left: input.workspaceIdentity, right: panel.workspaceIdentity }))
      return yield* error("workspace-mismatch");
    if (panel.operationId !== input.expectedOperationId) return yield* error("stale-state");
    return panel;
  });
  const cli = Effect.fn("JjForgeService.readCli")(function* (input: {
    cwd: string;
    args: ReadonlyArray<string>;
  }) {
    const result = yield* process
      .run({
        operation: "JjForgeService.readCli",
        command: "jj",
        cwd: input.cwd,
        args: ["--no-pager", "--color=never", "--ignore-working-copy", ...input.args],
        maxOutputBytes: 1_000_000,
        outputMode: "error",
      })
      .pipe(Effect.mapError(() => error("command-failed")));
    if (result.stdoutTruncated || result.stdoutInvalidUtf8) return yield* error("invalid-output");
    return result.stdout;
  });
  const destination = Effect.fn("JjForgeService.destination")(function* (
    input: Pick<JjForgePreviewInput, "cwd" | "remote">,
  ) {
    const lines = yield* cli({ cwd: input.cwd, args: ["git", "remote", "list"] });
    const matches = lines
      .split("\n")
      .map((line) => /^([^\s]+)\s+(.+)$/.exec(line))
      .filter((line) => line?.[1] === input.remote);
    const remoteUrl = matches[0]?.[2];
    if (matches.length !== 1 || !remoteUrl) return yield* error("destination-mismatch");
    const detected = sourceControlDefinitions.recognizeRemote(remoteUrl);
    if (!detected) return yield* error("unsupported-forge");
    const handle = yield* providers
      .resolveHandle({
        cwd: input.cwd,
        context: { provider: detected, remoteName: input.remote, remoteUrl },
      })
      .pipe(Effect.mapError(() => error("provider-failed")));
    const context = handle.context;
    if (!context || context.provider.kind === "unknown") return yield* error("unsupported-forge");
    // Other creation adapters derive their repository from the checkout, ignoring context.
    if (handle.provider.kind !== "github") {
      const defaultHandle = yield* providers
        .resolveHandle({ cwd: input.cwd })
        .pipe(Effect.mapError(() => error("provider-failed")));
      if (
        defaultHandle.context?.remoteName !== input.remote ||
        defaultHandle.context.remoteUrl !== remoteUrl
      )
        return yield* error("unsupported-destination");
    }
    const locator = yield* Effect.try({
      try: () => {
        const scp = /^[^@\s]+@[^:\s]+:(.+)$/.exec(remoteUrl);
        return {
          host: new URL(context.provider.baseUrl).host,
          repository: (scp?.[1] ?? new URL(remoteUrl).pathname)
            .replace(/^\/+|\/+$/g, "")
            .replace(/\.git$/, ""),
        };
      },
      catch: () => error("unsupported-destination"),
    });
    const host = locator.host;
    let repository = locator.repository;
    if (!repository || repository.split("/").length < 2)
      return yield* error("unsupported-destination");
    if (context.provider.kind === "azure-devops")
      repository = repository.split("/").at(-1) ?? repository;
    return {
      provider: handle.provider,
      context,
      destination: {
        remote: input.remote,
        provider: handle.provider.kind,
        host,
        repository,
      } satisfies JjForgeDestination,
    };
  });
  const localTarget = Effect.fn("JjForgeService.localTarget")(function* (input: {
    panel: JjPanelReady;
    bookmark: string;
  }) {
    const output = yield* cli({
      cwd: input.panel.cwd,
      args: [
        "--at-operation",
        input.panel.operationId,
        "log",
        "--no-graph",
        "-r",
        `bookmarks(exact:${quote(input.bookmark)})`,
        "-T",
        'json(commit_id) ++ "\\n"',
      ],
    });
    return yield* Effect.forEach(output.trim().split("\n").filter(Boolean), (line) =>
      decodeCommit(line).pipe(Effect.mapError(() => error("invalid-output"))),
    );
  });
  const findChangeRequests = Effect.fn("JjForgeService.findChangeRequests")(function* (input: {
    cwd: string;
    resolved: Effect.Success<ReturnType<typeof destination>>;
    bookmark: string;
    state: "open" | "all";
  }) {
    const headSelectors = [input.bookmark];
    const probe = input.resolved.provider.headBranchProbe?.({
      headSelectors,
      state: input.state,
    }) ?? {
      headSelectors,
      limit: input.state === "open" ? 1 : 20,
    };
    const records: Array<ChangeRequest> = [];
    for (const headSelector of probe.headSelectors) {
      const matching = yield* input.resolved.provider
        .listChangeRequests({
          cwd: input.cwd,
          context: input.resolved.context,
          headSelector,
          source: { refName: input.bookmark },
          state: input.state,
          limit: probe.limit,
        })
        .pipe(Effect.mapError(() => error("provider-failed")));
      records.push(...matching);
    }
    return records.filter(
      (record) =>
        record.headRefName === input.bookmark &&
        !record.isCrossRepository &&
        (!record.headRepositoryNameWithOwner ||
          record.headRepositoryNameWithOwner.toLowerCase() ===
            input.resolved.destination.repository.toLowerCase()),
    );
  });
  const prepare = Effect.fn("JjForgeService.prepare")(function* (input: JjForgePreviewInput) {
    const panel = yield* readWorkspace(input);
    const resolved = yield* destination(input);
    const layers = yield* Effect.try({
      try: () => buildJjForgeLayers({ request: input, panel, provider: resolved.provider.kind }),
      catch: (cause) => (isForgeError(cause) ? cause : error("invalid-selection")),
    });
    for (const layer of layers) {
      const targets = yield* localTarget({ panel, bookmark: layer.bookmark });
      if (targets.length !== 1 || targets[0] !== layer.commitId)
        return yield* error("missing-bookmark");
    }
    const checked = yield* Effect.forEach(layers, (layer) =>
      Effect.gen(function* () {
        const records = yield* findChangeRequests({
          cwd: input.cwd,
          resolved,
          bookmark: layer.bookmark,
          state: "open",
        });
        if (records.length > 1) return yield* error("ambiguous-pull-request");
        const existing = records[0] ?? null;
        // Refuse before push: inverted bases can cause forge auto-closure on stack reorder.
        if (existing && existing.baseRefName !== layer.baseBookmark)
          return yield* error("retarget-required");
        return { ...layer, existing };
      }),
    );
    yield* readWorkspace(input);
    return {
      resolved,
      plan: { input, destination: resolved.destination, layers: checked } satisfies JjForgePlan,
    };
  });
  const preview = Effect.fn("JjForgeService.preview")((input: JjForgePreviewInput) =>
    prepare(input).pipe(Effect.map((value) => value.plan)),
  );
  const reference = (input: {
    request: JjForgePreviewInput | JjForgeStatusInput;
    destination: JjForgeDestination;
    record: ChangeRequest;
  }): PullRequestRef => ({
    projectId: input.request.projectId,
    host: input.destination.host,
    repository: input.destination.repository,
    number: input.record.number,
  });
  const publish = Effect.fn("JjForgeService.publish")((input: JjForgePublishInput) =>
    publications.withPermit(
      Effect.scoped(
        Effect.gen(function* () {
          const prepared = yield* prepare(input);
          if (
            !sameDestination({ left: prepared.plan.destination, right: input.expectedDestination })
          )
            return yield* error("destination-mismatch");
          const pushed = yield* jj
            .runAction({
              cwd: input.cwd,
              workspaceIdentity: input.workspaceIdentity,
              expectedOperationId: input.expectedOperationId,
              action: {
                type: "push",
                remote: input.remote,
                bookmarkNames: prepared.plan.layers.map((layer) => layer.bookmark),
              },
            })
            .pipe(Effect.mapError(() => error("command-failed")));
          const result: JjForgePublishResult = {
            pushed: true,
            operationId: pushed.panel.operationId,
            layers: [],
            failedBookmark: null,
          };
          const completed: Array<JjForgePublishResult["layers"][number]> = [];
          for (const layer of prepared.plan.layers) {
            const synchronized = yield* Effect.result(
              Effect.gen(function* () {
                yield* readWorkspace({ ...input, expectedOperationId: pushed.panel.operationId });
                const current = yield* destination(input);
                if (
                  !sameDestination({ left: current.destination, right: input.expectedDestination })
                )
                  return yield* error("destination-mismatch");
                const open = yield* findChangeRequests({
                  cwd: input.cwd,
                  resolved: current,
                  bookmark: layer.bookmark,
                  state: "open",
                });
                if (open.length > 1) return yield* error("ambiguous-pull-request");
                let record = open[0];
                const created = !record;
                if (record && record.baseRefName !== layer.baseBookmark)
                  return yield* error("retarget-required");
                if (!record) {
                  const bodyFile = yield* fs
                    .makeTempFileScoped({ prefix: "t3-jj-forge-" })
                    .pipe(Effect.mapError(() => error("command-failed")));
                  yield* fs
                    .writeFileString(bodyFile, layer.body)
                    .pipe(Effect.mapError(() => error("command-failed")));
                  yield* current.provider
                    .createChangeRequest({
                      cwd: input.cwd,
                      context: current.context,
                      source: { refName: layer.bookmark },
                      target: { refName: layer.baseBookmark },
                      headSelector: layer.bookmark,
                      baseRefName: layer.baseBookmark,
                      title: layer.title,
                      bodyFile,
                    })
                    .pipe(Effect.mapError(() => error("provider-failed")));
                  const createdRecords = yield* findChangeRequests({
                    cwd: input.cwd,
                    resolved: current,
                    bookmark: layer.bookmark,
                    state: "open",
                  });
                  if (
                    createdRecords.length !== 1 ||
                    createdRecords[0]?.baseRefName !== layer.baseBookmark
                  )
                    return yield* error("ambiguous-pull-request");
                  record = createdRecords[0];
                }
                if (!record) return yield* error("provider-failed");
                const ref = reference({ request: input, destination: current.destination, record });
                yield* reviews.invalidate({ reference: ref }).pipe(Effect.ignore);
                return {
                  commitId: layer.commitId,
                  bookmark: layer.bookmark,
                  baseBookmark: layer.baseBookmark,
                  reference: ref,
                  url: record.url,
                  created,
                };
              }),
            );
            if (synchronized._tag === "Failure")
              return { ...result, layers: completed, failedBookmark: layer.bookmark };
            completed.push(synchronized.success);
          }
          return { ...result, layers: completed };
        }),
      ),
    ),
  );
  const getStatus = Effect.fn("JjForgeService.getStatus")(function* (input: JjForgeStatusInput) {
    const panel = yield* readWorkspace(input);
    const resolved = yield* destination(input);
    const revisions = [...panel.revisions, ...(panel.visibleRevisions ?? [])];
    const selected = [...new Set(input.revisionCommitIds)].map((commitId) =>
      revisions.find((revision) => revision.commitId === commitId),
    );
    if (selected.some((revision) => !revision)) return yield* error("invalid-selection");
    const statuses: Array<JjForgeStatusResult["revisions"][number]> = [];
    const unavailable = new Set<string>();
    let truncated = false;
    let lookups = 0;
    for (const revision of selected) {
      if (!revision) continue;
      for (const bookmark of new Set(revision.bookmarks ?? [])) {
        if (lookups >= 32) {
          truncated = true;
          break;
        }
        lookups++;
        const read = yield* Effect.result(
          Effect.gen(function* () {
            const targets = yield* localTarget({ panel, bookmark });
            if (targets.length !== 1 || targets[0] !== revision.commitId) return;
            const records = yield* findChangeRequests({
              cwd: input.cwd,
              resolved,
              bookmark,
              state: "all",
            });
            if (records.length >= 20) truncated = true;
            const ordered = [...records].sort(
              (left, right) =>
                Number(right.state === "open") - Number(left.state === "open") ||
                right.number - left.number,
            );
            const record = ordered[0];
            if (!record) return;
            const ref = reference({ request: input, destination: resolved.destination, record });
            const summary = yield* reviews
              .summary(ref)
              .pipe(Effect.mapError(() => error("provider-failed")));
            const activity = yield* Effect.result(reviews.activity(ref));
            if (activity._tag === "Failure") unavailable.add(bookmark);
            statuses.push({
              commitId: revision.commitId,
              bookmark,
              reference: ref,
              summary,
              headMatches: record.headSha ? record.headSha === revision.commitId : null,
              unresolvedThreadCount:
                activity._tag === "Success"
                  ? activity.success.reviewThreads.filter((thread) => !thread.isResolved).length
                  : null,
              reviewThreadsTruncated:
                activity._tag === "Success"
                  ? Boolean(activity.success.reviewThreadsTruncated)
                  : false,
            });
          }),
        );
        if (read._tag === "Failure") unavailable.add(bookmark);
      }
    }
    yield* readWorkspace(input);
    return {
      destination: resolved.destination,
      revisions: statuses,
      unavailableBookmarks: [...unavailable],
      truncated,
    } satisfies JjForgeStatusResult;
  });
  return JjForgeService.of({ preview, publish, getStatus });
});

export const layer = Layer.effect(JjForgeService, make);
