import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import {
  ProjectId,
  PullRequestSummary,
  PullRequestActivity,
  PullRequestUnavailableError,
  WS_METHODS,
  WsRpcGroup,
  AuthOrchestrationReadScope,
  AuthFilesystemWriteScope,
  AuthSourceControlWriteScope,
  clientRpcRequiredScopes,
  type ChangeRequest,
  SourceControlProviderKind,
} from "@t3tools/contracts";
import type { JjForgePreviewInput } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as RpcTest from "effect/rpc/RpcTest";
import * as RpcAuthorization from "../auth/RpcAuthorization.ts";
import * as PullRequestService from "../pullRequest/PullRequestService.ts";
import * as SourceControlProvider from "@t3tools/source-control-core/server/SourceControlProvider";
import * as SourceControlProviderRegistry from "../sourceControl/SourceControlProviderRegistry.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import * as JjPanelService from "./JjPanelService.ts";
import * as JjForgeService from "./JjForgeService.ts";

const decodeSummary = Schema.decodeEffect(PullRequestSummary);
const decodeActivity = Schema.decodeEffect(PullRequestActivity);

const fixture = (
  options: {
    kind?: SourceControlProviderKind;
    records?: ReadonlyArray<ChangeRequest>;
    defaultRemote?: string;
    reviews?: Pick<PullRequestService.PullRequestService["Service"], "summary" | "activity">;
  } = {},
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const process = yield* VcsProcess.VcsProcess;
    const jj = yield* JjPanelService.JjPanelService;
    const cwd = yield* fs.makeTempDirectoryScoped({ prefix: "t3-jj-forge-test-" });
    const cli = (args: ReadonlyArray<string>) =>
      process.run({
        operation: "JjForgeService.test",
        command: "jj",
        cwd,
        args: [
          "--no-pager",
          "--color=never",
          "--config",
          'user.name="Test"',
          "--config",
          'user.email="test@example.invalid"',
          ...args,
        ],
      });
    yield* cli(["git", "init", "--colocate"]);
    // The only remote repository created by a test is local and is never pushed to.
    const remote = yield* fs.makeTempDirectoryScoped({ prefix: "t3-jj-forge-remote-" });
    yield* process.run({
      operation: "JjForgeService.test",
      command: "git",
      cwd: remote,
      args: ["init", "--bare"],
    });
    yield* cli(["git", "remote", "add", "sandbox", remote]);
    const kind = options.kind ?? SourceControlProviderKind.make("github");
    const host = kind === "gitlab" ? "gitlab.com" : "github.com";
    const remoteUrl = `https://${host}/owner/repo.git`;
    yield* cli(["git", "remote", "add", "origin", remoteUrl]);
    yield* cli(["describe", "-m", "first\n\nfirst body"]);
    yield* cli(["bookmark", "set", "first", "-r", "@"]);
    yield* cli(["new", "-m", "second"]);
    yield* cli(["bookmark", "set", "second", "-r", "@"]);
    const snapshot = yield* jj.getPanel({ cwd });
    if (snapshot.status !== "ready") return yield* Effect.die("Expected JJ workspace");
    const first = snapshot.revisions.find((revision) => revision.description.startsWith("first"));
    const second = snapshot.revisions.find((revision) => revision.description.startsWith("second"));
    if (!first || !second) return yield* Effect.die("Expected revision chain");
    const request: JjForgePreviewInput = {
      cwd,
      workspaceIdentity: snapshot.workspaceIdentity,
      expectedOperationId: snapshot.operationId,
      projectId: ProjectId.make("project"),
      remote: "origin",
      mode: "linear-stack",
      baseBookmark: "main",
      selections: [
        { commitId: first.commitId, bookmark: "first" },
        { commitId: second.commitId, bookmark: "second" },
      ],
    };
    const forbidden = () =>
      Effect.die("A test attempted an external write or unsupported provider operation");
    const reads: Array<string> = [];
    // Only the external forge boundary is substituted; workspace reads use the real JJ service.
    const limits: Array<number | undefined> = [];
    const provider = SourceControlProvider.SourceControlProvider.of({
      kind,
      ...(kind === SourceControlProviderKind.make("github")
        ? {
            headBranchProbe: ({ headSelectors }) => ({
              headSelectors: headSelectors.filter((selector) => !selector.includes(":")),
              limit: 100,
            }),
          }
        : {}),
      listChangeRequests: (input) => {
        reads.push(input.headSelector);
        limits.push(input.limit);
        return Effect.succeed(
          (options.records ?? []).filter((record) =>
            input.headSelector.endsWith(record.headRefName),
          ),
        );
      },
      getChangeRequest: forbidden,
      createChangeRequest: forbidden,
      getRepositoryCloneUrls: forbidden,
      createRepository: forbidden,
      getDefaultBranch: () => Effect.succeed("main"),
      checkoutChangeRequest: forbidden,
    });
    const registry = Layer.mock(SourceControlProviderRegistry.SourceControlProviderRegistry)({
      resolveLink: () => undefined,
      resolveHandle: (input) =>
        Effect.succeed({
          provider,
          context: input.context ?? {
            provider: { kind, name: kind, baseUrl: `https://${host}` },
            remoteName: options.defaultRemote ?? "origin",
            remoteUrl,
          },
        }),
    });
    const forge = yield* JjForgeService.JjForgeService.pipe(
      Effect.provide(
        JjForgeService.layer.pipe(
          Layer.provide(registry),
          Layer.provide(Layer.mock(PullRequestService.PullRequestService)(options.reviews ?? {})),
        ),
      ),
    );
    return {
      cwd,
      remote,
      cli,
      jj,
      forge,
      request,
      snapshot,
      reads,
      limits,
      first,
      second,
      process,
    };
  });
const live = JjPanelService.layer.pipe(
  Layer.provideMerge(VcsProcess.layer),
  Layer.provideMerge(NodeServices.layer),
);
const record = (input: {
  head: string;
  base: string;
  crossRepository?: boolean;
}): ChangeRequest => ({
  provider: SourceControlProviderKind.make("github"),
  number: 12,
  title: "Existing",
  url: "https://github.com/owner/repo/pull/12",
  headRefName: input.head,
  baseRefName: input.base,
  state: "open",
  updatedAt: Option.none(),
  isCrossRepository: input.crossRepository ?? false,
});

describe("JJ forge service with real JJ workspaces and unused local remotes", () => {
  it.live("denies publication with filesystem-only write grants before executing the service", () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      const group = WsRpcGroup.omit(
        ...[...WsRpcGroup.requests.keys()].filter(
          (
            tag,
          ): tag is Exclude<
            keyof typeof RpcAuthorization.RPC_REQUIRED_SCOPES,
            typeof WS_METHODS.jjForgePublish
          > => tag !== WS_METHODS.jjForgePublish,
        ),
      );
      const handler = group.toLayerHandler(WS_METHODS.jjForgePublish, f.forge.publish);
      const reader = yield* RpcTest.makeClient(group).pipe(
        Effect.provide(
          Layer.mergeAll(
            handler,
            RpcAuthorization.layer([AuthOrchestrationReadScope, AuthFilesystemWriteScope]),
          ),
        ),
      );
      const input = {
        ...f.request,
        expectedDestination: {
          provider: SourceControlProviderKind.make("github"),
          remote: "origin",
          host: "github.com",
          repository: "another/repository",
        },
      } satisfies Parameters<typeof f.forge.publish>[0];
      const denied = yield* reader[WS_METHODS.jjForgePublish](input).pipe(Effect.flip);
      expect(denied).toMatchObject({ requiredPermission: AuthSourceControlWriteScope });
      expect(f.reads).toEqual([]);
      expect(clientRpcRequiredScopes(WS_METHODS.jjForgePublish, undefined)).toEqual([
        AuthSourceControlWriteScope,
      ]);
      const writer = yield* RpcTest.makeClient(group).pipe(
        Effect.provide(
          Layer.mergeAll(handler, RpcAuthorization.layer([AuthSourceControlWriteScope])),
        ),
      );
      const validated = yield* writer[WS_METHODS.jjForgePublish](input).pipe(Effect.flip);
      expect(validated).toMatchObject({ reason: "destination-mismatch" });
      expect(f.reads).toEqual(["first", "second"]);
      expect(f.limits).toEqual([100, 100]);
      const after = yield* f.jj.getPanel({ cwd: f.cwd });
      expect(after.status === "ready" && after.operationId).toBe(f.snapshot.operationId);
    }).pipe(Effect.provide(live)),
  );
  it.live("previews exact head/base pairs without changing the operation or publishing", () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      const plan = yield* f.forge.preview(f.request);
      expect(plan.layers.map((layer) => [layer.bookmark, layer.baseBookmark])).toEqual([
        ["first", "main"],
        ["second", "first"],
      ]);
      expect(plan.destination).toEqual({
        provider: SourceControlProviderKind.make("github"),
        host: "github.com",
        repository: "owner/repo",
        remote: "origin",
      });
      expect(f.reads).toEqual(["first", "second"]);
      const after = yield* f.jj.getPanel({ cwd: f.cwd });
      expect(after.status === "ready" && after.operationId).toBe(f.snapshot.operationId);
      const refs = yield* f.process.run({
        operation: "JjForgeService.test",
        command: "git",
        cwd: f.remote,
        // Upstream names bare repositories only through --git-dir.
        args: ["--git-dir", f.remote, "for-each-ref"],
      });
      expect(refs.stdout).toBe("");
    }).pipe(Effect.provide(live)),
  );
  it.live("reuses an existing compatible request and excludes a fork's same-name head", () =>
    Effect.gen(function* () {
      const f = yield* fixture({
        records: [
          record({ head: "first", base: "main" }),
          record({ head: "second", base: "first", crossRepository: true }),
        ],
      });
      const plan = yield* f.forge.preview(f.request);
      expect(plan.layers[0]?.existing?.number).toBe(12);
      expect(plan.layers[1]?.existing).toBeNull();
    }).pipe(Effect.provide(live)),
  );
  it.live("rejects a mismatched existing base before any push even for an inverted stack", () =>
    Effect.gen(function* () {
      const f = yield* fixture({ records: [record({ head: "first", base: "second" })] });
      const result = yield* Effect.result(
        f.forge.publish({
          ...f.request,
          expectedDestination: {
            provider: SourceControlProviderKind.make("github"),
            host: "github.com",
            repository: "owner/repo",
            remote: "origin",
          },
        }),
      );
      expect(result._tag === "Failure" && result.failure.reason).toBe("retarget-required");
      const after = yield* f.jj.getPanel({ cwd: f.cwd });
      expect(after.status === "ready" && after.operationId).toBe(f.snapshot.operationId);
    }).pipe(Effect.provide(live)),
  );
  it.live("rejects freshness and workspace identity mismatches before forge reads", () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      const mismatch = yield* Effect.result(
        f.forge.preview({
          ...f.request,
          workspaceIdentity: { ...f.request.workspaceIdentity, workspaceId: "another" },
        }),
      );
      expect(mismatch._tag === "Failure" && mismatch.failure.reason).toBe("workspace-mismatch");
      yield* f.cli(["describe", "-m", "changed outside panel"]);
      const stale = yield* Effect.result(f.forge.preview(f.request));
      expect(stale._tag === "Failure" && stale.failure.reason).toBe("stale-state");
      expect(f.reads).toEqual([]);
    }).pipe(Effect.provide(live)),
  );
  it.live("does not treat a local remote as an authenticated forge", () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      const result = yield* Effect.result(f.forge.preview({ ...f.request, remote: "sandbox" }));
      expect(result._tag === "Failure" && result.failure.reason).toBe("unsupported-forge");
      expect(f.reads).toEqual([]);
    }).pipe(Effect.provide(live)),
  );
  it.live("rejects unsupported creation providers before writing", () =>
    Effect.gen(function* () {
      const f = yield* fixture({ kind: SourceControlProviderKind.make("bitbucket") });
      const result = yield* Effect.result(f.forge.preview(f.request));
      expect(result._tag === "Failure" && result.failure.reason).toBe("unsupported-forge");
      expect(f.reads).toEqual([]);
    }).pipe(Effect.provide(live)),
  );
  it.live("supports the default GitLab context but refuses a different checkout destination", () =>
    Effect.gen(function* () {
      const f = yield* fixture({ kind: SourceControlProviderKind.make("gitlab") });
      const plan = yield* f.forge.preview(f.request);
      expect(plan.destination.provider).toBe("gitlab");
      expect(f.reads).toEqual(["first", "second"]);
      const other = yield* fixture({
        kind: SourceControlProviderKind.make("gitlab"),
        defaultRemote: "upstream",
      });
      const result = yield* Effect.result(other.forge.preview(other.request));
      expect(result._tag === "Failure" && result.failure.reason).toBe("unsupported-destination");
      expect(other.reads).toEqual([]);
    }).pipe(Effect.provide(live)),
  );
  it.live("checks the actual local bookmark target after an external bookmark move", () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      // Revision metadata alone cannot establish that a bookmark is local or unconflicted.
      yield* f.cli(["bookmark", "set", "first", "-r", "@"]);
      const current = yield* f.jj.getPanel({ cwd: f.cwd });
      if (current.status !== "ready") return yield* Effect.die("Expected JJ workspace");
      const result = yield* Effect.result(
        f.forge.preview({ ...f.request, expectedOperationId: current.operationId }),
      );
      expect(result._tag === "Failure" && result.failure.reason).toBe("missing-bookmark");
      expect(f.reads).toEqual([]);
    }).pipe(Effect.provide(live)),
  );
  it.live("uses existing review summaries and counts unresolved threads with head mismatch", () =>
    Effect.gen(function* () {
      const summary = yield* decodeSummary({
        provider: SourceControlProviderKind.make("github"),
        projectId: "project",
        repository: "owner/repo",
        number: 12,
        title: "Existing",
        url: "https://github.com/owner/repo/pull/12",
        state: "open",
        headBranch: "first",
        baseBranch: "main",
        updatedAt: "2026-10-14T00:00:00.000Z",
        reviewDecision: "review-required",
      });
      const activity = yield* decodeActivity({
        comments: [],
        commentCount: 0,
        commentsTruncated: false,
        commits: [],
        reviewThreadsTruncated: true,
        reviewThreads: [false, false, true].map((isResolved, index) => ({
          id: `thread-${index}`,
          path: "file.ts",
          line: 1,
          side: "right",
          isResolved,
          isOutdated: false,
          comments: [],
        })),
      });
      const f = yield* fixture({
        records: [{ ...record({ head: "first", base: "main" }), headSha: "e".repeat(40) }],
        reviews: {
          summary: () => Effect.succeed(summary),
          activity: () => Effect.succeed(activity),
        },
      });
      const status = yield* f.forge.getStatus({
        ...f.request,
        revisionCommitIds: [f.first.commitId, f.first.commitId, f.second.commitId],
      });
      expect(status.revisions).toHaveLength(1);
      expect(status.revisions[0]).toMatchObject({
        bookmark: "first",
        reference: {
          projectId: "project",
          host: "github.com",
          repository: "owner/repo",
          number: 12,
        },
        headMatches: false,
        unresolvedThreadCount: 2,
        reviewThreadsTruncated: true,
        summary: { reviewDecision: "review-required" },
      });
    }).pipe(Effect.provide(live)),
  );
  it.live("keeps status readable when review activity is unavailable", () =>
    Effect.gen(function* () {
      const summary = yield* decodeSummary({
        provider: SourceControlProviderKind.make("github"),
        projectId: "project",
        repository: "owner/repo",
        number: 12,
        title: "Existing",
        url: "https://github.com/owner/repo/pull/12",
        state: "open",
        headBranch: "first",
        baseBranch: "main",
        updatedAt: "2026-10-14T00:00:00.000Z",
      });
      const f = yield* fixture({
        records: [record({ head: "first", base: "main" })],
        reviews: {
          summary: () => Effect.succeed(summary),
          activity: () =>
            Effect.fail(new PullRequestUnavailableError({ reason: "provider-unsupported" })),
        },
      });
      const status = yield* f.forge.getStatus({
        ...f.request,
        revisionCommitIds: [f.first.commitId],
      });
      expect(status.revisions[0]?.headMatches).toBeNull();
      expect(status.revisions[0]?.unresolvedThreadCount).toBeNull();
      expect(status.unavailableBookmarks).toEqual(["first"]);
    }).pipe(Effect.provide(live)),
  );
  it.live("bounds forge lookups even when no bookmark has a PR", () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      const names = Array.from({ length: 34 }, (_, index) => `extra-${index}`);
      yield* f.cli(["bookmark", "set", ...names, "-r", f.first.commitId]);
      const panel = yield* f.jj.getPanel({ cwd: f.cwd });
      if (panel.status !== "ready") return yield* Effect.die("Expected JJ workspace");
      const status = yield* f.forge.getStatus({
        ...f.request,
        expectedOperationId: panel.operationId,
        revisionCommitIds: [f.first.commitId],
      });
      expect(f.reads).toHaveLength(32);
      expect(status.revisions).toEqual([]);
      expect(status.truncated).toBe(true);
    }).pipe(Effect.provide(live)),
  );
});
