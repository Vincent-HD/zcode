import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import {
  type JjDescribeInput,
  type JjGetPanelInput,
  type JjMutationResult,
  type JjPanelError,
  type JjPanelReady,
  type JjRevertOperationInput,
  type JjRevisionDetails,
  type JjRunAction,
  type JjRunActionInput,
  WS_METHODS,
  WsRpcGroup,
  AuthOrchestrationReadScope,
  AuthSourceControlWriteScope,
  AuthFilesystemReadScope,
  clientRpcRequiredScopes,
} from "@t3tools/contracts";
import * as RpcTest from "effect/rpc/RpcTest";
import * as RpcAuthorization from "../auth/RpcAuthorization.ts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import * as JjPanelService from "./JjPanelService.ts";

class ProcessLog extends Context.Service<
  ProcessLog,
  { readonly jj: Array<ReadonlyArray<string>> }
>()("t3/jj/JjPanelService.test/ProcessLog") {}
// Records the service's own jj invocations; fixture setup commands are not counted.
const countingProcess = Layer.effect(
  VcsProcess.VcsProcess,
  Effect.gen(function* () {
    const inner = yield* VcsProcess.VcsProcess;
    const log = yield* ProcessLog;
    return VcsProcess.VcsProcess.of({
      run: (input) => {
        if (input.command === "jj" && !input.operation.includes(".test")) log.jj.push(input.args);
        return inner.run(input);
      },
    });
  }),
).pipe(Layer.provide(VcsProcess.layer));
const live = JjPanelService.layer.pipe(
  Layer.provideMerge(countingProcess),
  Layer.provideMerge(Layer.sync(ProcessLog, () => ({ jj: [] }))),
  Layer.provideMerge(NodeServices.layer),
);

/** The pre-graph panel shape: the working-copy ancestry plus every other row, with details. */
interface ViewRevision {
  readonly commitId: string;
  readonly changeId: string;
  readonly parentIds: ReadonlyArray<string>;
  readonly description: string;
  readonly files: JjRevisionDetails["files"];
  readonly conflictPaths: ReadonlyArray<string>;
  readonly author: JjRevisionDetails["author"];
  readonly immutable: boolean;
  readonly conflict: boolean;
  readonly empty: boolean;
  readonly current: boolean;
  readonly bookmarks: ReadonlyArray<string>;
  readonly remoteBookmarks: ReadonlyArray<string>;
}
type View = JjPanelReady & {
  readonly revisions: ReadonlyArray<ViewRevision>;
  readonly visibleRevisions: ReadonlyArray<ViewRevision>;
};

const fixture = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const process = yield* VcsProcess.VcsProcess;
  const raw = yield* JjPanelService.JjPanelService;
  const log = yield* ProcessLog;
  const cwd = yield* fs.makeTempDirectoryScoped({ prefix: "t3-jj-panel-test-" });
  const view = Effect.fn("JjPanelService.test.view")(function* (panel: JjPanelReady) {
    const detailed = yield* Effect.forEach(panel.rows, (row) =>
      raw.getRevision({ cwd: panel.cwd, commitId: row.commitId }).pipe(
        Effect.map((details): ViewRevision => ({
          commitId: row.commitId,
          changeId: row.changeId,
          parentIds: row.parentIds,
          description: details.description,
          files: details.files,
          conflictPaths: details.conflictPaths,
          author: details.author,
          immutable: row.immutable === true,
          conflict: row.conflict === true,
          empty: row.empty === true,
          current: row.current === true,
          bookmarks: row.bookmarks ?? [],
          remoteBookmarks: row.remoteBookmarks ?? [],
        })),
      ),
    );
    const byId = new Map(detailed.map((revision) => [revision.commitId, revision]));
    const ancestry = new Set<string>();
    const pending = [panel.workingCopyCommitId];
    while (pending.length) {
      const id = pending.shift();
      const revision = id === undefined ? undefined : byId.get(id);
      if (!revision || ancestry.has(revision.commitId)) continue;
      ancestry.add(revision.commitId);
      pending.push(...revision.parentIds);
    }
    const revisions = detailed.filter((revision) => ancestry.has(revision.commitId)).slice(0, 11);
    return {
      ...panel,
      revisions,
      visibleRevisions: detailed.filter((revision) => !revisions.includes(revision)),
    } satisfies View;
  });
  const viewResult = (result: Effect.Effect<JjMutationResult, JjPanelError>) =>
    result.pipe(
      Effect.flatMap((value) =>
        view(value.panel).pipe(Effect.map((panel) => ({ ...value, panel }))),
      ),
    );
  const service = {
    ...raw,
    describe: (input: JjDescribeInput) => viewResult(raw.describe(input)),
    revertOperation: (input: JjRevertOperationInput) => viewResult(raw.revertOperation(input)),
    runAction: (input: JjRunActionInput) => viewResult(raw.runAction(input)),
  };
  const cli = (args: ReadonlyArray<string>) =>
    process.run({
      operation: "JjPanelService.test",
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
  yield* cli(["git", "init"]);
  yield* cli(["config", "set", "--repo", "ui.editor", '"false"']);
  const ready = (input: JjGetPanelInput = { cwd }) =>
    raw.getPanel(input).pipe(
      Effect.filterOrElse(
        (value): value is JjPanelReady => value.status === "ready",
        () => Effect.die("Expected jj workspace"),
      ),
    );
  const panel = () => ready().pipe(Effect.flatMap(view));
  const expected = (value: Pick<JjPanelReady, "workspaceIdentity" | "operationId">) => ({
    cwd,
    workspaceIdentity: value.workspaceIdentity,
    expectedOperationId: value.operationId,
  });
  const action = (action: JjRunAction) =>
    panel().pipe(Effect.flatMap((before) => service.runAction({ ...expected(before), action })));
  return { fs, cwd, cli, raw, service, log, ready, view, panel, expected, action };
});

describe("JjPanelService real jj repositories", () => {
  it.live("pushes only the selected bookmark to a local bare remote without an undo receipt", () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      const remote = yield* f.fs.makeTempDirectoryScoped({ prefix: "t3-jj-push-remote-" });
      const process = yield* VcsProcess.VcsProcess;
      yield* process.run({
        operation: "JjPanelService.test.localRemote",
        command: "git",
        cwd: remote,
        args: ["init", "--bare"],
      });
      yield* f.cli(["git", "remote", "add", "sandbox", remote]);
      yield* f.cli(["describe", "-m", "local publication"]);
      yield* f.fs.writeFileString(`${f.cwd}/published.txt`, "local only\n");
      yield* f.cli(["bookmark", "set", "published", "-r", "@"]);
      yield* f.cli(["bookmark", "set", "unselected", "-r", "@"]);
      const before = yield* f.panel();
      const result = yield* f.action({
        type: "push",
        remote: "sandbox",
        bookmarkNames: ["published"],
      });
      expect(result.receipt.undoAvailable).toBe(false);
      const refs = yield* process.run({
        operation: "JjPanelService.test.localRemote",
        command: "git",
        cwd: remote,
        // Upstream names bare repositories only through --git-dir.
        args: [
          "--git-dir",
          remote,
          "for-each-ref",
          "--format=%(refname) %(objectname)",
          "refs/heads",
        ],
      });
      expect(refs.stdout.trim()).toBe(`refs/heads/published ${before.workingCopyCommitId}`);
    }).pipe(Effect.provide(live)),
  );
  it.live("separates local bookmarks from diverged remote bookmarks", () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      const remote = yield* f.fs.makeTempDirectoryScoped({ prefix: "t3-jj-remote-refs-" });
      const process = yield* VcsProcess.VcsProcess;
      yield* process.run({
        operation: "JjPanelService.test.localRemote",
        command: "git",
        cwd: remote,
        args: ["init", "--bare"],
      });
      yield* f.cli(["git", "remote", "add", "sandbox", remote]);
      yield* f.cli(["describe", "-m", "pushed"]);
      yield* f.cli(["bookmark", "set", "feature", "-r", "@"]);
      yield* f.cli(["git", "push", "--remote", "sandbox", "--bookmark", "feature"]);
      yield* f.cli(["new", "-m", "local only"]);
      yield* f.cli(["bookmark", "set", "feature", "-r", "@"]);
      const panel = yield* f.panel();
      expect(panel.revisions[0]?.bookmarks).toEqual(["feature"]);
      expect(panel.revisions[0]?.remoteBookmarks).toEqual([]);
      expect(panel.revisions[1]?.bookmarks).toEqual([]);
      expect(panel.revisions[1]?.remoteBookmarks).toEqual(["feature@sandbox"]);
      expect(panel.remotes).toEqual(["sandbox"]);
    }).pipe(Effect.provide(live)),
  );
  it.live(
    "reads nested cwd, structured filenames and the working copy with its ancestors as graph rows",
    () =>
      Effect.gen(function* () {
        const f = yield* fixture;
        for (let index = 0; index < 12; index++) yield* f.cli(["new", "-m", `ancestor ${index}`]);
        yield* f.fs.writeFileString(`${f.cwd}/odd\n"filename.txt`, "hello");
        yield* f.fs.makeDirectory(`${f.cwd}/nested`);
        const panel = yield* f.ready({ cwd: `${f.cwd}/nested` }).pipe(Effect.flatMap(f.view));
        expect(panel.rows).toHaveLength(14);
        expect(panel.revisions).toHaveLength(11);
        expect(panel.workspaceIdentity.workspaceRoot).toBe(f.cwd);
        expect(panel.revisions[0]?.files).toContainEqual({
          path: 'odd\n"filename.txt',
          status: "added",
        });
        expect(panel.revisions[0]?.current).toBe(true);
        expect(panel.revisions.filter((revision) => !revision.current)).toHaveLength(10);
        expect(panel.revisions[0]?.parentIds[0]).toBe(panel.revisions[1]?.commitId);
        expect(panel.rows[0]).toMatchObject({
          current: true,
          changePrefixLength: expect.any(Number),
        });
        expect(panel.rows.at(-1)).toMatchObject({ root: true, immutable: true, parentIds: [] });
        expect(panel.operationId).toHaveLength(128);
      }).pipe(Effect.provide(live)),
  );

  it.live(
    "describes multiline text with stdin, returns an owned receipt and reverts that operation",
    () =>
      Effect.gen(function* () {
        const f = yield* fixture;
        const before = yield* f.panel();
        const result = yield* f.service.describe({
          ...f.expected(before),
          revisionCommitId: before.workingCopyCommitId,
          description: "first\n\nsecond $(`literal`)\n",
        });
        expect(result.panel.revisions[0]?.description).toBe("first\n\nsecond $(`literal`)\n");
        expect(result.receipt.undoAvailable).toBe(true);
        const undone = yield* f.service.revertOperation({
          ...f.expected(result.panel),
          receiptId: result.receipt.receiptId,
          operationId: result.receipt.operationId,
        });
        expect(undone.panel.revisions[0]?.description).toBe("");
        expect(undone.receipt.undoAvailable).toBe(true);
        const forged = yield* f.service
          .revertOperation({
            ...f.expected(undone.panel),
            receiptId: "forged",
            operationId: undone.panel.operationId,
          })
          .pipe(Effect.flip);
        expect(forged.reason).toBe("invalid-receipt");
      }).pipe(Effect.provide(live)),
  );

  it.live(
    "rejects stale descriptions after external operations or file snapshots and mismatched workspace identity",
    () =>
      Effect.gen(function* () {
        const f = yield* fixture;
        const old = yield* f.panel();
        yield* f.cli(["describe", "-m", "external"]);
        const request = {
          ...f.expected(old),
          revisionCommitId: old.workingCopyCommitId,
          description: "overwrite",
        };
        expect((yield* f.service.describe(request).pipe(Effect.flip)).reason).toBe("stale-state");
        const fresh = yield* f.panel();
        yield* f.fs.writeFileString(`${f.cwd}/new-file`, "changed");
        expect(
          (yield* f.service
            .describe({
              ...request,
              ...f.expected(fresh),
              revisionCommitId: fresh.workingCopyCommitId,
            })
            .pipe(Effect.flip)).reason,
        ).toBe("stale-state");
        const current = yield* f.panel();
        expect(
          (yield* f.service
            .describe({
              ...request,
              ...f.expected(current),
              workspaceIdentity: { ...current.workspaceIdentity, workspaceId: "wrong" },
            })
            .pipe(Effect.flip)).reason,
        ).toBe("workspace-mismatch");
        expect(
          (yield* f.service
            .describe({ ...request, ...f.expected(current), revisionCommitId: "0".repeat(40) })
            .pipe(Effect.flip)).reason,
        ).toBe("immutable");
      }).pipe(Effect.provide(live)),
  );

  it.live(
    "squashes into an explicit ancestor, keeps destination description, abandons source and supports empty replacement",
    () =>
      Effect.gen(function* () {
        const f = yield* fixture;
        yield* f.cli(["describe", "-m", "destination"]);
        yield* f.cli(["new", "-m", "source"]);
        yield* f.fs.writeFileString(`${f.cwd}/file`, "content");
        const before = yield* f.panel();
        const destination = before.revisions[1];
        if (!destination) return yield* Effect.die("Missing ancestor");
        const result = yield* f.service.runAction({
          ...f.expected(before),
          action: {
            type: "squash",
            sourceCommitId: before.workingCopyCommitId,
            destinationCommitId: destination.commitId,
            mode: "into",
          },
        });
        expect(result.receipt.undoAvailable).toBe(true);
        expect(result.panel.revisions[0]?.empty).toBe(true);
        expect(result.panel.revisions[1]?.description).toBe("destination\n");
        expect(
          result.panel.revisions.some(
            (revision) => revision.changeId === before.revisions[0]?.changeId,
          ),
        ).toBe(false);
        yield* f.fs.writeFileString(`${f.cwd}/another`, "second");
        const next = yield* f.panel();
        const nextDestination = next.revisions[1];
        if (!nextDestination) return yield* Effect.die("Missing ancestor");
        const replaced = yield* f.service.runAction({
          ...f.expected(next),
          action: {
            type: "squash",
            sourceCommitId: next.workingCopyCommitId,
            destinationCommitId: nextDestination.commitId,
            mode: "into",
            messagePolicy: { type: "replace", description: "" },
          },
        });
        expect(replaced.panel.revisions[1]?.description).toBe("");
      }).pipe(Effect.provide(live)),
  );

  it.live("rejects squash from a conflicted merge but permits conflicted descriptions", () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      yield* f.fs.writeFileString(`${f.cwd}/file`, "base\n");
      yield* f.cli(["new", "-m", "left"]);
      yield* f.fs.writeFileString(`${f.cwd}/file`, "left\n");
      const left = (yield* f.panel()).workingCopyCommitId;
      yield* f.cli(["new", "@-", "-m", "right"]);
      yield* f.fs.writeFileString(`${f.cwd}/file`, "right\n");
      const right = (yield* f.panel()).workingCopyCommitId;
      yield* f.cli(["new", left, right, "-m", "merge"]);
      const merge = yield* f.panel();
      expect(merge.revisions[0]?.conflict).toBe(true);
      expect(merge.revisions[0]?.parentIds).toHaveLength(2);
      const described = yield* f.service.describe({
        ...f.expected(merge),
        revisionCommitId: merge.workingCopyCommitId,
        description: "conflicted description",
      });
      expect(described.panel.revisions[0]?.conflict).toBe(true);
      expect(
        (yield* f.service
          .runAction({
            ...f.expected(described.panel),
            action: {
              type: "squash",
              sourceCommitId: described.panel.workingCopyCommitId,
              destinationCommitId: left,
              mode: "into",
            },
          })
          .pipe(Effect.flip)).reason,
      ).toBe("conflicted");
    }).pipe(Effect.provide(live)),
  );

  it.live("withholds undo after an external operation and serializes sibling requests", () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      const before = yield* f.panel();
      const results = yield* Effect.forEach(
        ["one", "two"],
        (description) =>
          f.service
            .describe({
              ...f.expected(before),
              revisionCommitId: before.workingCopyCommitId,
              description,
            })
            .pipe(Effect.result),
        { concurrency: "unbounded" },
      );
      expect(results.filter((result) => result._tag === "Success")).toHaveLength(1);
      const result = results.find((value) => value._tag === "Success");
      if (!result || result._tag !== "Success")
        return yield* Effect.die("Missing successful result");
      yield* f.cli(["new"]);
      const current = yield* f.panel();
      expect(
        (yield* f.service
          .revertOperation({
            ...f.expected(current),
            operationId: result.success.receipt.operationId,
            receiptId: result.success.receipt.receiptId,
          })
          .pipe(Effect.flip)).reason,
      ).toBe("invalid-receipt");
    }).pipe(Effect.provide(live)),
  );

  it.live("rejects configured immutable ancestors and offers no undo for no-op describe", () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      yield* f.cli(["describe", "-m", "destination"]);
      yield* f.cli(["new", "-m", "source"]);
      yield* f.cli(["config", "set", "--repo", 'revset-aliases."immutable_heads()"', "@-"]);
      const before = yield* f.panel();
      const ancestor = before.revisions[1];
      if (!ancestor) return yield* Effect.die("Missing ancestor");
      expect(ancestor.immutable).toBe(true);
      expect(
        (yield* f.service
          .describe({
            ...f.expected(before),
            revisionCommitId: ancestor.commitId,
            description: "forbidden",
          })
          .pipe(Effect.flip)).reason,
      ).toBe("immutable");
      expect(
        (yield* f.service
          .runAction({
            ...f.expected(before),
            action: {
              type: "squash",
              sourceCommitId: before.workingCopyCommitId,
              destinationCommitId: ancestor.commitId,
              mode: "into",
            },
          })
          .pipe(Effect.flip)).reason,
      ).toBe("immutable");
      const unchanged = yield* f.service.describe({
        ...f.expected(before),
        revisionCommitId: before.workingCopyCommitId,
        description: "source\n",
      });
      expect(unchanged.receipt.undoAvailable).toBe(false);
      expect(unchanged.panel.operationId).toBe(before.operationId);
    }).pipe(Effect.provide(live)),
  );

  it.live(
    "enforces read versus write scopes through RPC middleware before real service execution",
    () =>
      Effect.gen(function* () {
        const f = yield* fixture;
        const before = yield* f.panel();
        const group = WsRpcGroup.omit(
          ...[...WsRpcGroup.requests.keys()].filter(
            (
              tag,
            ): tag is Exclude<
              keyof typeof RpcAuthorization.RPC_REQUIRED_SCOPES,
              typeof WS_METHODS.jjDescribe
            > => tag !== WS_METHODS.jjDescribe,
          ),
        );
        const handler = group.toLayerHandler(WS_METHODS.jjDescribe, f.raw.describe);
        const readClient = yield* RpcTest.makeClient(group).pipe(
          Effect.provide(
            Layer.mergeAll(handler, RpcAuthorization.layer([AuthOrchestrationReadScope])),
          ),
        );
        const input = {
          ...f.expected(before),
          revisionCommitId: before.workingCopyCommitId,
          description: "authorized",
        };
        expect(yield* readClient[WS_METHODS.jjDescribe](input).pipe(Effect.flip)).toMatchObject({
          requiredPermission: AuthSourceControlWriteScope,
        });
        expect((yield* f.panel()).operationId).toBe(before.operationId);
        const writeClient = yield* RpcTest.makeClient(group).pipe(
          Effect.provide(
            Layer.mergeAll(handler, RpcAuthorization.layer([AuthSourceControlWriteScope])),
          ),
        );
        const described = yield* writeClient[WS_METHODS.jjDescribe](input);
        expect(
          (yield* f.raw.getRevision({ cwd: f.cwd, commitId: described.panel.workingCopyCommitId }))
            .description,
        ).toBe("authorized\n");
        expect(RpcAuthorization.requiredScopeForRpcMethod(WS_METHODS.jjGetRevision)).toBe(
          AuthOrchestrationReadScope,
        );
        expect(RpcAuthorization.requiredScopeForRpcMethod(WS_METHODS.jjGetPanel)).toBe(
          AuthOrchestrationReadScope,
        );
        for (const method of [
          WS_METHODS.jjDescribe,
          WS_METHODS.jjRevertOperation,
          WS_METHODS.jjRunAction,
        ]) {
          expect(clientRpcRequiredScopes(method, undefined)).toEqual([AuthSourceControlWriteScope]);
          expect(RpcAuthorization.requiredScopeForRpcMethod(method)).toBe(
            AuthSourceControlWriteScope,
          );
        }
      }).pipe(Effect.provide(live)),
  );

  it.live("resolves linked workspace identity and Git-only unavailable state", () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      const second = `${f.cwd}/second`;
      yield* f.cli(["workspace", "add", second]);
      const first = yield* f.panel();
      const other = yield* f.service.getPanel({ cwd: second });
      expect(other.status).toBe("ready");
      if (other.status !== "ready") return;
      expect(other.workspaceIdentity.repositoryPath).toBe(first.workspaceIdentity.repositoryPath);
      expect(other.workspaceIdentity.workspaceId).not.toBe(first.workspaceIdentity.workspaceId);
      expect(other.workingCopyCommitId).not.toBe(first.workingCopyCommitId);
      const gitOnly = yield* f.fs.makeTempDirectoryScoped({ prefix: "t3-jj-git-only-" });
      const process = yield* VcsProcess.VcsProcess;
      yield* process.run({
        operation: "test.gitOnly",
        command: "git",
        args: ["init"],
        cwd: gitOnly,
      });
      expect(yield* f.service.getPanel({ cwd: gitOnly })).toEqual({
        status: "unavailable",
        cwd: gitOnly,
        reason: "not-jj-workspace",
      });
    }).pipe(Effect.provide(live)),
  );
});

describe("expanded JjPanelService actions", () => {
  it.live(
    "creates on immutable parents, commits without an editor and edits a non-ancestor child",
    () =>
      Effect.gen(function* () {
        const f = yield* fixture;
        const created = yield* f.action({ type: "new", parentCommitIds: ["0".repeat(40)] });
        expect(created.panel.revisions[0]?.parentIds).toEqual(["0".repeat(40)]);
        yield* f.fs.writeFileString(`${f.cwd}/file`, "committed\n");
        const committed = yield* f.action({
          type: "commit",
          description: "message\n\n$(`literal`)",
        });
        expect(committed.panel.revisions[0]?.empty).toBe(true);
        expect(committed.panel.revisions[1]?.description).toBe("message\n\n$(`literal`)\n");
        yield* f.cli(["describe", "-m", "child"]);
        const childPanel = yield* f.panel();
        const child = childPanel.workingCopyCommitId;
        const parent = childPanel.revisions[1];
        if (!parent) return yield* Effect.die("Missing parent");
        const edited = yield* f.action({ type: "edit", revisionCommitId: parent.commitId });
        expect(edited.panel.workingCopyCommitId).toBe(parent.commitId);
        expect(edited.panel.visibleRevisions?.some((revision) => revision.commitId === child)).toBe(
          true,
        );
        expect(
          (yield* f.action({ type: "edit", revisionCommitId: child })).panel.workingCopyCommitId,
        ).toBe(child);
        expect(yield* f.fs.readFileString(`${f.cwd}/file`)).toBe("committed\n");
        expect(
          (yield* f.action({ type: "edit", revisionCommitId: "0".repeat(40) }).pipe(Effect.flip))
            .reason,
        ).toBe("immutable");
      }).pipe(Effect.provide(live)),
  );

  it.live.each(["before", "after"] as const)(
    "inserts %s a revision and rewrites the expected edges",
    (position) =>
      Effect.gen(function* () {
        const f = yield* fixture;
        yield* f.cli(["describe", "-m", "target"]);
        const before = yield* f.panel();
        const target = before.revisions[0];
        if (!target) return yield* Effect.die("Missing target");
        const result = yield* f.action({
          type: "insert",
          revisionCommitIds: [target.commitId],
          position,
        });
        const inserted = result.panel.revisions[0];
        const rewrittenTarget = [
          ...result.panel.revisions,
          ...(result.panel.visibleRevisions ?? []),
        ].find((revision) => revision.changeId === target.changeId);
        expect(inserted?.description).toBe("");
        if (position === "before")
          expect(rewrittenTarget?.parentIds).toContain(result.panel.workingCopyCommitId);
        else expect(inserted?.parentIds).toContain(target.commitId);
      }).pipe(Effect.provide(live)),
  );

  it.live(
    "squashes selected literal files across mutable siblings and preserves unselected files",
    () =>
      Effect.gen(function* () {
        const f = yield* fixture;
        yield* f.cli(["describe", "-m", "destination"]);
        yield* f.fs.writeFileString(`${f.cwd}/destination`, "base\n");
        const destination = (yield* f.panel()).workingCopyCommitId;
        yield* f.cli(["new", "root()", "-m", "source"]);
        const odd = 'all() | glob:"*"\nfile';
        yield* f.fs.writeFileString(`${f.cwd}/${odd}`, "selected\n");
        yield* f.fs.writeFileString(`${f.cwd}/unselected`, "kept\n");
        const before = yield* f.panel();
        const result = yield* f.action({
          type: "squash",
          sourceCommitId: before.workingCopyCommitId,
          destinationCommitId: destination,
          mode: "into",
          paths: [odd],
        });
        expect(result.panel.revisions[0]?.files.map((file) => file.path)).toEqual(["unselected"]);
        const changedDestination = result.panel.visibleRevisions?.find(
          (revision) => revision.description === "destination\n",
        );
        expect(changedDestination?.files.map((file) => file.path)).toEqual(
          expect.arrayContaining(["destination", odd]),
        );
        expect(changedDestination?.files.some((file) => file.path === "unselected")).toBe(false);
      }).pipe(Effect.provide(live)),
  );

  it.live(
    "full squash accepts a sibling and squash onto creates a new child without rewriting destination",
    () =>
      Effect.gen(function* () {
        const f = yield* fixture;
        yield* f.cli(["describe", "-m", "destination"]);
        const destination = (yield* f.panel()).workingCopyCommitId;
        yield* f.cli(["new", "root()", "-m", "source"]);
        yield* f.fs.writeFileString(`${f.cwd}/source-file`, "data\n");
        const source = yield* f.panel();
        const result = yield* f.action({
          type: "squash",
          sourceCommitId: source.workingCopyCommitId,
          destinationCommitId: destination,
          mode: "into",
        });
        expect(
          result.panel.visibleRevisions?.some(
            (revision) => revision.changeId === source.revisions[0]?.changeId,
          ),
        ).toBe(false);
        yield* f.fs.writeFileString(`${f.cwd}/onto-file`, "onto\n");
        yield* f.cli(["describe", "-m", "onto source"]);
        const before = yield* f.panel();
        const onto = yield* f.action({
          type: "squash",
          sourceCommitId: before.workingCopyCommitId,
          destinationCommitId: "0".repeat(40),
          mode: "onto",
        });
        const squashed = [...onto.panel.revisions, ...(onto.panel.visibleRevisions ?? [])].find(
          (revision) => revision.files.some((file) => file.path === "onto-file"),
        );
        expect(squashed?.parentIds).toEqual(["0".repeat(40)]);
        expect(squashed?.description).toBe("onto source\n");
        expect(onto.receipt.undoAvailable).toBe(true);
      }).pipe(Effect.provide(live)),
  );

  it.live("absorbs real edits into their owning ancestor", () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      yield* f.fs.writeFileString(`${f.cwd}/file`, "one\ntwo\nthree\n");
      yield* f.cli(["describe", "-m", "owner"]);
      yield* f.cli(["new", "-m", "source"]);
      yield* f.fs.writeFileString(`${f.cwd}/file`, "one\nchanged\nthree\n");
      const before = yield* f.panel();
      const result = yield* f.action({
        type: "absorb",
        revisionCommitId: before.workingCopyCommitId,
        paths: ["file"],
      });
      expect(result.panel.revisions[0]?.empty).toBe(true);
      const owner = result.panel.revisions[1];
      if (!owner) return yield* Effect.die("Missing owner");
      const diff = yield* f.service.getDiff({
        ...f.expected(result.panel),
        revisionCommitId: owner.commitId,
        filePath: "file",
      });
      expect(diff.diff).toContain("+changed");
    }).pipe(Effect.provide(live)),
  );

  it.live.each(["revision", "branch"] as const)(
    "rebases a %s to a bounded visible sibling target",
    (mode) =>
      Effect.gen(function* () {
        const f = yield* fixture;
        yield* f.cli(["describe", "-m", "destination"]);
        const destination = (yield* f.panel()).workingCopyCommitId;
        yield* f.cli(["new", "root()", "-m", "branch base"]);
        const branchBase = (yield* f.panel()).revisions[0];
        yield* f.cli(["new", "-m", "source"]);
        const selectedSource = (yield* f.panel()).revisions[0];
        expect(selectedSource).toBeDefined();
        if (!selectedSource) return;
        yield* f.cli(["new", "-m", "descendant"]);
        yield* f.fs.writeFileString(`${f.cwd}/file`, "content\n");
        const result = yield* f.action({
          type: "rebase",
          revisionCommitId: selectedSource.commitId,
          destinationCommitIds: [destination],
          mode,
        });
        const revisions = [...result.panel.revisions, ...(result.panel.visibleRevisions ?? [])];
        const rewrittenSource = revisions.find(
          (revision) => revision.changeId === selectedSource.changeId,
        );
        expect(rewrittenSource?.parentIds).toEqual([destination]);
        expect(result.panel.revisions[0]?.parentIds).toEqual([
          mode === "branch" ? rewrittenSource?.commitId : branchBase?.commitId,
        ]);
        const base = revisions.find((revision) => revision.changeId === branchBase?.changeId);
        expect(base?.parentIds).toEqual(["0".repeat(40)]);
        expect(yield* f.fs.readFileString(`${f.cwd}/file`)).toBe("content\n");
      }).pipe(Effect.provide(live)),
  );

  it.live("duplicates onto explicit parents, merges parents and abandons visible revisions", () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      yield* f.cli(["describe", "-m", "base"]);
      const base = (yield* f.panel()).workingCopyCommitId;
      yield* f.cli(["new"]);
      yield* f.fs.writeFileString(`${f.cwd}/file`, "content\n");
      yield* f.cli(["describe", "-m", "source"]);
      const before = yield* f.panel();
      const source = before.revisions[0];
      const duplicated = yield* f.action({
        type: "duplicate",
        revisionCommitId: before.workingCopyCommitId,
        destinationCommitIds: [base],
      });
      const copy = duplicated.panel.visibleRevisions?.find(
        (revision) => revision.description === "source\n" && revision.changeId !== source?.changeId,
      );
      if (!copy) return yield* Effect.die("Missing duplicate");
      expect(copy.files).toContainEqual({ path: "file", status: "added" });
      const merged = yield* f.action({
        type: "merge",
        parentCommitIds: [before.workingCopyCommitId, copy.commitId],
      });
      expect(merged.panel.revisions[0]?.parentIds).toEqual(
        expect.arrayContaining([before.workingCopyCommitId, copy.commitId]),
      );
      const abandoned = yield* f.action({ type: "abandon", revisionCommitIds: [copy.commitId] });
      expect(
        [...abandoned.panel.revisions, ...(abandoned.panel.visibleRevisions ?? [])].some(
          (revision) => revision.commitId === copy.commitId,
        ),
      ).toBe(false);
    }).pipe(Effect.provide(live)),
  );

  it.live(
    "restores exact modified and removed files from a nested cwd and rejects directories or missing paths",
    () =>
      Effect.gen(function* () {
        const f = yield* fixture;
        yield* f.fs.makeDirectory(`${f.cwd}/nested`);
        yield* f.fs.writeFileString(`${f.cwd}/nested/file`, "base\n");
        const odd = 'odd\n"name';
        yield* f.fs.writeFileString(`${f.cwd}/${odd}`, "odd base\n");
        yield* f.cli(["new"]);
        yield* f.fs.writeFileString(`${f.cwd}/nested/file`, "changed\n");
        yield* f.fs.remove(`${f.cwd}/${odd}`);
        const before = yield* f.panel();
        for (const paths of [["nested"], ["missing"], ["../escape"]]) {
          const failure = yield* f.service
            .runAction({
              ...f.expected(before),
              action: { type: "restore", revisionCommitId: before.workingCopyCommitId, paths },
            })
            .pipe(Effect.flip);
          expect(["invalid-path", "invalid-target"]).toContain(failure.reason);
          expect((yield* f.panel()).operationId).toBe(before.operationId);
        }
        const restored = yield* f.service.runAction({
          ...f.expected(before),
          cwd: `${f.cwd}/nested`,
          action: {
            type: "restore",
            revisionCommitId: before.workingCopyCommitId,
            paths: ["nested/file", odd],
          },
        });
        expect(restored.panel.revisions[0]?.empty).toBe(true);
        expect(yield* f.fs.readFileString(`${f.cwd}/nested/file`)).toBe("base\n");
        expect(yield* f.fs.readFileString(`${f.cwd}/${odd}`)).toBe("odd base\n");
      }).pipe(Effect.provide(live)),
  );

  it.live(
    "reverts the last action and blocks Undo past working-copy edits instead of discarding them",
    () =>
      Effect.gen(function* () {
        const f = yield* fixture;
        yield* f.cli(["describe", "-m", "external"]);
        const before = yield* f.panel();
        expect(before.undo?.description).toMatch(/^describe commit /);
        expect(before.redo).toBeUndefined();
        const undone = yield* f.action({ type: "undo" });
        expect(undone.panel.revisions[0]?.description).toBe("");
        expect(undone.panel.redo?.description).toMatch(/^describe commit /);
        const redone = yield* f.action({ type: "redo" });
        expect(redone.panel.revisions[0]?.description).toBe("external\n");
        expect(redone.panel.redo).toBeUndefined();

        yield* f.cli(["bookmark", "create", "mark", "-r", "@"]);
        const unmarked = yield* f.action({ type: "undo" });
        expect(unmarked.panel.revisions[0]?.bookmarks).toEqual([]);
        expect((yield* f.panel()).operationId).toBe(unmarked.panel.operationId);

        yield* f.cli(["bookmark", "create", "mark", "-r", "@"]);
        yield* f.fs.writeFileString(`${f.cwd}/kept`, "agent edit\n");
        expect((yield* f.panel()).undo).toMatchObject({ blocked: true });
        expect((yield* f.action({ type: "undo" }).pipe(Effect.flip)).reason).toBe(
          "history-blocked",
        );
        expect(yield* f.fs.readFileString(`${f.cwd}/kept`)).toBe("agent edit\n");
        expect(
          (yield* f.service
            .runAction({ ...f.expected(before), action: { type: "undo" } })
            .pipe(Effect.flip)).reason,
        ).toBe("stale-state");
        expect(
          (yield* f.service
            .runAction({
              ...f.expected(redone.panel),
              workspaceIdentity: { ...redone.panel.workspaceIdentity, workspaceId: "wrong" },
              action: { type: "redo" },
            })
            .pipe(Effect.flip)).reason,
        ).toBe("workspace-mismatch");
      }).pipe(Effect.provide(live)),
  );

  it.live("sets, advances and deletes an exact local bookmark", () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      const before = yield* f.panel();
      const name = "topic/core";
      const set = yield* f.action({
        type: "bookmark-set",
        name,
        revisionCommitId: before.workingCopyCommitId,
      });
      expect(set.panel.revisions[0]?.bookmarks).toContain(name);
      const child = yield* f.action({ type: "new", parentCommitIds: [before.workingCopyCommitId] });
      const advanced = yield* f.action({
        type: "bookmark-advance",
        name,
        revisionCommitId: child.panel.workingCopyCommitId,
      });
      expect(advanced.panel.revisions[0]?.bookmarks).toContain(name);
      const deleted = yield* f.action({ type: "bookmark-delete", name });
      expect(deleted.panel.revisions[0]?.bookmarks).not.toContain(name);
    }).pipe(Effect.provide(live)),
  );

  it.live(
    "exposes conflicted paths and permits edit/restore while blocking squash, absorb and commit",
    () =>
      Effect.gen(function* () {
        const f = yield* fixture;
        yield* f.fs.writeFileString(`${f.cwd}/file`, "base\n");
        yield* f.cli(["new", "-m", "left"]);
        yield* f.fs.writeFileString(`${f.cwd}/file`, "left\n");
        const left = (yield* f.panel()).workingCopyCommitId;
        yield* f.cli(["new", "@-", "-m", "right"]);
        yield* f.fs.writeFileString(`${f.cwd}/file`, "right\n");
        const right = (yield* f.panel()).workingCopyCommitId;
        const merged = yield* f.action({ type: "merge", parentCommitIds: [left, right] });
        expect(merged.panel.revisions[0]?.conflict).toBe(true);
        expect(merged.panel.revisions[0]?.conflictPaths).toEqual(["file"]);
        const edited = yield* f.action({
          type: "edit",
          revisionCommitId: merged.panel.workingCopyCommitId,
        });
        expect(edited.panel.revisions[0]?.conflict).toBe(true);
        const restored = yield* f.action({
          type: "restore",
          revisionCommitId: edited.panel.workingCopyCommitId,
          paths: ["file"],
        });
        expect(restored.panel.revisions[0]?.conflict).toBe(true);
        for (const action of [
          { type: "commit", description: "blocked" },
          { type: "absorb", revisionCommitId: restored.panel.workingCopyCommitId },
          {
            type: "squash",
            sourceCommitId: restored.panel.workingCopyCommitId,
            destinationCommitId: left,
            mode: "into",
          },
        ] satisfies ReadonlyArray<JjRunAction>) {
          expect((yield* f.action(action).pipe(Effect.flip)).reason).toBe("conflicted");
        }
      }).pipe(Effect.provide(live)),
  );

  it.live("reads pinned immutable diffs and exact literal selections, and reports truncation", () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      const odd = 'all() | glob:"*"\nfile';
      yield* f.fs.writeFileString(`${f.cwd}/${odd}`, "selected\n");
      yield* f.fs.writeFileString(`${f.cwd}/other`, "excluded\n");
      const original = (yield* f.panel()).workingCopyCommitId;
      yield* f.cli(["new"]);
      yield* f.cli(["config", "set", "--repo", 'revset-aliases."immutable_heads()"', "@-"]);
      const panel = yield* f.panel();
      expect(panel.revisions[1]?.immutable).toBe(true);
      expect(panel.revisions[1]?.author).toMatchObject({
        name: "Test",
        email: "test@example.invalid",
        timestamp: expect.any(String),
      });
      const diff = yield* f.service.getDiff({
        ...f.expected(panel),
        revisionCommitId: original,
        filePath: odd,
      });
      expect(diff).toMatchObject({
        operationId: panel.operationId,
        commitId: original,
        truncated: false,
      });
      expect(diff.diff).toContain("+selected");
      expect(diff.diff).not.toContain("excluded");
      expect((yield* f.panel()).operationId).toBe(panel.operationId);
      expect(
        (yield* f.service
          .getDiff({ ...f.expected(panel), revisionCommitId: original, filePath: "missing" })
          .pipe(Effect.flip)).reason,
      ).toBe("invalid-path");
      yield* f.cli(["config", "set", "--repo", "snapshot.max-new-file-size", "2000000"]);
      yield* f.fs.writeFileString(`${f.cwd}/large`, "x".repeat(1_100_000));
      const largePanel = yield* f.panel();
      const large = yield* f.service.getDiff({
        ...f.expected(largePanel),
        revisionCommitId: largePanel.workingCopyCommitId,
        filePath: "large",
      });
      expect(large.truncated).toBe(true);
      expect(large.diff.length).toBeLessThanOrEqual(1_000_000);
    }).pipe(Effect.provide(live)),
  );

  it.live("reads a diff pinned to its operation after the workspace moves on", () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      yield* f.fs.writeFileString(`${f.cwd}/file`, "pinned\n");
      const panel = yield* f.ready();
      yield* f.cli(["describe", "-m", "moved"]);
      yield* f.fs.writeFileString(`${f.cwd}/file`, "moved\n");
      const diff = yield* f.raw.getDiff({
        ...f.expected(panel),
        revisionCommitId: panel.workingCopyCommitId,
      });
      expect(diff.diff).toContain("+pinned");
      expect(diff.operationId).toBe(panel.operationId);
      const moved = yield* f.ready();
      const compared = yield* f.raw.getDiff({
        ...f.expected(moved),
        revisionCommitId: moved.workingCopyCommitId,
        fromCommitId: panel.workingCopyCommitId,
      });
      expect(compared.diff).toContain("-pinned");
      expect(compared.diff).toContain("+moved");
    }).pipe(Effect.provide(live)),
  );
});

describe("expanded JJ RPC permissions", () => {
  it.live(
    "guards action and publication RPCs before service execution and allows read-only diffs",
    () =>
      Effect.gen(function* () {
        const f = yield* fixture;
        yield* f.fs.writeFileString(`${f.cwd}/file`, "readable\n");
        const before = yield* f.panel();
        const group = WsRpcGroup.omit(
          ...[...WsRpcGroup.requests.keys()].filter(
            (
              tag,
            ): tag is Exclude<
              keyof typeof RpcAuthorization.RPC_REQUIRED_SCOPES,
              typeof WS_METHODS.jjRunAction | typeof WS_METHODS.jjGetDiff
            > => tag !== WS_METHODS.jjRunAction && tag !== WS_METHODS.jjGetDiff,
          ),
        );
        const handlers = Layer.mergeAll(
          group.toLayerHandler(WS_METHODS.jjRunAction, f.raw.runAction),
          group.toLayerHandler(WS_METHODS.jjGetDiff, f.service.getDiff),
        );
        const reader = yield* RpcTest.makeClient(group).pipe(
          Effect.provide(
            Layer.mergeAll(handlers, RpcAuthorization.layer([AuthFilesystemReadScope])),
          ),
        );
        expect(
          (yield* reader[WS_METHODS.jjGetDiff]({
            ...f.expected(before),
            revisionCommitId: before.workingCopyCommitId,
            filePath: "file",
          })).diff,
        ).toContain("+readable");
        const denied = yield* reader[WS_METHODS.jjRunAction]({
          ...f.expected(before),
          action: { type: "commit", description: "denied" },
        }).pipe(Effect.flip);
        expect(denied).toMatchObject({ requiredPermission: AuthSourceControlWriteScope });
        const deniedPush = yield* reader[WS_METHODS.jjRunAction]({
          ...f.expected(before),
          action: { type: "push", bookmarkNames: ["main"], remote: "origin" },
        }).pipe(Effect.flip);
        expect(deniedPush).toMatchObject({ requiredPermission: AuthSourceControlWriteScope });
        expect((yield* f.panel()).operationId).toBe(before.operationId);
        expect(RpcAuthorization.requiredScopeForRpcMethod(WS_METHODS.jjGetDiff)).toBe(
          AuthFilesystemReadScope,
        );
        expect(clientRpcRequiredScopes(WS_METHODS.jjGetDiff, undefined)).toEqual([
          AuthFilesystemReadScope,
        ]);
        expect(
          clientRpcRequiredScopes(WS_METHODS.jjRunAction, { action: { type: "push" } }),
        ).toEqual([AuthSourceControlWriteScope]);
        const writer = yield* RpcTest.makeClient(group).pipe(
          Effect.provide(
            Layer.mergeAll(handlers, RpcAuthorization.layer([AuthSourceControlWriteScope])),
          ),
        );
        const committed = yield* writer[WS_METHODS.jjRunAction]({
          ...f.expected(before),
          action: { type: "commit", description: "authorized" },
        });
        const committedParent = committed.panel.rows.find((row) => row.summary === "authorized");
        expect(committed.panel.rows[0]).toMatchObject({
          current: true,
          parentIds: [committedParent?.commitId],
        });
      }).pipe(Effect.provide(live)),
  );
});

describe("expanded JJ immutable guards", () => {
  it.live(
    "blocks rewriting immutable revisions while allowing new children and immutable duplicate reads",
    () =>
      Effect.gen(function* () {
        const f = yield* fixture;
        yield* f.fs.writeFileString(`${f.cwd}/file`, "immutable base\n");
        yield* f.cli(["describe", "-m", "immutable"]);
        yield* f.cli(["new", "-m", "mutable"]);
        yield* f.cli(["config", "set", "--repo", 'revset-aliases."immutable_heads()"', "@-"]);
        const before = yield* f.panel();
        const immutable = before.revisions[1];
        if (!immutable) return yield* Effect.die("Missing immutable ancestor");
        expect(immutable.immutable).toBe(true);
        for (const action of [
          { type: "edit", revisionCommitId: immutable.commitId },
          { type: "restore", revisionCommitId: immutable.commitId, paths: ["file"] },
          { type: "absorb", revisionCommitId: immutable.commitId },
          {
            type: "rebase",
            revisionCommitId: immutable.commitId,
            destinationCommitIds: ["0".repeat(40)],
            mode: "revision",
          },
          { type: "abandon", revisionCommitIds: [immutable.commitId] },
          {
            type: "squash",
            sourceCommitId: immutable.commitId,
            destinationCommitId: before.workingCopyCommitId,
            mode: "onto",
          },
          {
            type: "squash",
            sourceCommitId: before.workingCopyCommitId,
            destinationCommitId: immutable.commitId,
            mode: "into",
          },
          { type: "insert", revisionCommitIds: [immutable.commitId], position: "before" },
        ] satisfies ReadonlyArray<JjRunAction>) {
          expect((yield* f.action(action).pipe(Effect.flip)).reason).toBe("immutable");
          expect((yield* f.panel()).operationId).toBe(before.operationId);
        }
        const duplicate = yield* f.action({
          type: "duplicate",
          revisionCommitId: immutable.commitId,
        });
        expect(
          duplicate.panel.visibleRevisions?.some(
            (revision) => revision.description === "immutable\n" && !revision.immutable,
          ),
        ).toBe(true);
        const created = yield* f.action({ type: "new", parentCommitIds: [immutable.commitId] });
        expect(created.panel.revisions[0]?.parentIds).toEqual([immutable.commitId]);
      }).pipe(Effect.provide(live)),
  );
});

const subcommands = new Set(["op", "log", "config", "git", "diff", "workspace", "describe"]);
const commandsOf = (calls: ReadonlyArray<ReadonlyArray<string>>) =>
  calls.map((args) => args.find((arg) => subcommands.has(arg)) ?? args.join(" ")).toSorted();

describe("JjPanelService graph log", () => {
  it.live(
    "reads the log in one pinned call and answers unchanged refreshes with one snapshot",
    () =>
      Effect.gen(function* () {
        const f = yield* fixture;
        yield* f.cli(["describe", "-m", "base"]);
        yield* f.cli(["new", "-m", "top"]);
        f.log.jj.length = 0;
        const cold = yield* f.ready();
        expect(commandsOf(f.log.jj)).toEqual(["config", "git", "log", "op", "workspace"]);
        expect(cold.revset).toBe("builtin_log()");
        expect(cold.rows.map((row) => row.summary)).toEqual(["top", "base", ""]);
        expect(cold.rows[0]).toMatchObject({ current: true, empty: true });
        expect(cold.rows[0]?.immutable).toBeUndefined();

        f.log.jj.length = 0;
        const unchanged = yield* f.raw.getPanel({
          cwd: f.cwd,
          knownOperationId: cold.operationId,
          loadedCount: cold.rows.length,
        });
        expect(unchanged).toEqual({
          status: "unchanged",
          cwd: f.cwd,
          operationId: cold.operationId,
        });
        expect(commandsOf(f.log.jj)).toEqual(["op"]);

        yield* f.fs.writeFileString(`${f.cwd}/file`, "edited\n");
        f.log.jj.length = 0;
        const edited = yield* f.raw.getPanel({
          cwd: f.cwd,
          knownOperationId: cold.operationId,
          loadedCount: cold.rows.length,
        });
        expect(edited).toMatchObject({ status: "ready", offset: 0 });
        expect(commandsOf(f.log.jj)).toEqual(["git", "log", "op"]);

        yield* f.fs.writeFileString(`${f.cwd}/file`, "concurrent\n");
        f.log.jj.length = 0;
        const pair = yield* Effect.all(
          [f.ready({ cwd: f.cwd, revset: "all()" }), f.ready({ cwd: f.cwd, revset: "all()" })],
          {
            concurrency: "unbounded",
          },
        );
        expect(pair[0].operationId).toBe(pair[1].operationId);
        expect(commandsOf(f.log.jj).filter((command) => command !== "git")).toEqual(["log", "op"]);
      }).pipe(Effect.provide(live)),
  );

  it.live("keeps jj invocations flat on a 300-revision history", () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      const process = yield* VcsProcess.VcsProcess;
      const cwd = yield* f.fs.makeTempDirectoryScoped({ prefix: "t3-jj-panel-large-" });
      const git = (args: ReadonlyArray<string>, stdin?: string) =>
        process.run({
          operation: "JjPanelService.test.git",
          command: "git",
          cwd,
          args,
          ...(stdin === undefined ? {} : { stdin }),
        });
      yield* git(["init", "--quiet"]);
      // fast-import builds the history in one process; one jj command per commit would take minutes.
      const commits = Array.from({ length: 300 }, (_, index) => {
        const message = `commit ${index}`;
        return [
          `commit refs/heads/${index % 50 === 49 ? `branch-${index}` : "main"}`,
          `mark :${index + 1}`,
          `committer Bench <bench@example.invalid> ${1_700_000_000 + index} +0000`,
          `data ${message.length}`,
          message,
          ...(index > 0 ? [`from :${index % 50 === 0 && index > 0 ? index - 1 : index}`] : []),
          `M 644 inline file-${index % 7}.txt`,
          `data ${String(index).length}`,
          String(index),
          "",
        ].join("\n");
      });
      yield* git(["fast-import", "--quiet"], `${commits.join("\n")}\n`);
      yield* git(["checkout", "--quiet", "main"]);
      yield* process.run({
        operation: "JjPanelService.test",
        command: "jj",
        cwd,
        args: ["git", "init", "--colocate", "--quiet"],
      });
      const view = { cwd, revset: "all()" };
      f.log.jj.length = 0;
      const first = yield* f.ready(view);
      expect(first.rows).toHaveLength(100);
      expect(first.hasMore).toBe(true);
      expect(commandsOf(f.log.jj)).toEqual(["git", "log", "op", "workspace"]);
      f.log.jj.length = 0;
      const more = yield* f.ready({
        ...view,
        limit: 200,
        knownOperationId: first.operationId,
        loadedCount: 100,
      });
      expect(more).toMatchObject({ offset: 100, hasMore: true });
      expect(more.rows).toHaveLength(100);
      expect(commandsOf(f.log.jj)).toEqual(["log", "op"]);
      f.log.jj.length = 0;
      expect(
        (yield* f.raw.getPanel({
          ...view,
          limit: 200,
          knownOperationId: first.operationId,
          loadedCount: 200,
        })).status,
      ).toBe("unchanged");
      expect(commandsOf(f.log.jj)).toEqual(["op"]);
    }).pipe(Effect.provide(live)),
  );

  it.live("pages through the log by appending from the loaded count", () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      for (let index = 0; index < 6; index++) yield* f.cli(["new", "-m", `step ${index}`]);
      const view = { cwd: f.cwd, revset: "all()" };
      const first = yield* f.ready({ ...view, limit: 3 });
      expect(first).toMatchObject({ offset: 0, hasMore: true });
      expect(first.rows).toHaveLength(3);
      const second = yield* f.ready({
        ...view,
        limit: 6,
        knownOperationId: first.operationId,
        loadedCount: 3,
      });
      expect(second).toMatchObject({ offset: 3, hasMore: true });
      expect(second.rows.map((row) => row.summary)).toEqual(["step 2", "step 1", "step 0"]);
      const last = yield* f.ready({
        ...view,
        limit: 20,
        knownOperationId: first.operationId,
        loadedCount: 6,
      });
      expect(last).toMatchObject({ offset: 6, hasMore: false });
      expect(last.rows.at(-1)?.root).toBe(true);
      expect(
        (yield* f.raw.getPanel({
          ...view,
          limit: 20,
          knownOperationId: first.operationId,
          loadedCount: 8,
        })).status,
      ).toBe("unchanged");
    }).pipe(Effect.provide(live)),
  );

  it.live("routes edges through hidden ancestry to the nearest listed revision", () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      yield* f.cli(["describe", "-m", "a"]);
      yield* f.cli(["new", "-m", "b"]);
      yield* f.cli(["new", "-m", "c"]);
      const elided = yield* f.ready({ cwd: f.cwd, revset: "@ | root()" });
      expect(elided.rows.map((row) => row.summary)).toEqual(["c", ""]);
      expect(elided.rows[0]?.edges).toEqual([{ commitId: "0".repeat(40), elided: true }]);
      expect(elided.rows[0]?.edgesTruncated).toBeUndefined();
      const truncated = yield* f.ready({ cwd: f.cwd, revset: "@" });
      expect(truncated.rows[0]).toMatchObject({ edges: [], edgesTruncated: true });
      const direct = yield* f.ready({ cwd: f.cwd, revset: "all()" });
      expect(direct.rows.every((row) => row.edges === undefined)).toBe(true);
    }).pipe(Effect.provide(live)),
  );

  it.live("reports invalid revsets with jj's own explanation", () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      const failure = yield* f.raw.getPanel({ cwd: f.cwd, revset: "nope(" }).pipe(Effect.flip);
      expect(failure.reason).toBe("invalid-revset");
      expect(failure.detail).toMatch(/revset/i);
      expect(
        (yield* f.raw.getPanel({ cwd: f.cwd, revset: "all()\n" }).pipe(Effect.flip)).reason,
      ).toBe("invalid-revset");
    }).pipe(Effect.provide(live)),
  );

  it.live("marks divergent changes with their offsets and caches commit details", () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      yield* f.fs.writeFileString(`${f.cwd}/file`, "content\n");
      yield* f.cli(["describe", "-m", "base"]);
      const operation = (yield* f.ready()).operationId;
      yield* f.cli(["describe", "-m", "one"]);
      yield* f.cli(["--at-operation", operation, "describe", "-m", "two"]);
      const panel = yield* f.ready();
      const divergent = panel.rows.filter((row) => row.divergent);
      expect(divergent.map((row) => row.changeOffset).toSorted()).toEqual([0, 1]);
      expect(new Set(divergent.map((row) => row.changeId)).size).toBe(1);
      const commitId = divergent[0]?.commitId ?? "";
      f.log.jj.length = 0;
      const details = yield* f.raw.getRevision({ cwd: f.cwd, commitId });
      expect(details.files).toEqual([{ path: "file", status: "added" }]);
      yield* f.raw.getRevision({ cwd: f.cwd, commitId });
      expect(f.log.jj).toHaveLength(1);
    }).pipe(Effect.provide(live)),
  );
});

describe("JjPanelService row mapping", () => {
  const commitId = "a".repeat(40);
  const parent = "b".repeat(40);
  const other = "c".repeat(40);
  const output = (
    overrides: Partial<{ flags: string; inRevset: ReadonlyArray<boolean>; offset: number | null }>,
  ) =>
    [
      commitId,
      "k".repeat(32),
      [parent, other],
      overrides.inRevset ?? [true, true],
      "summary",
      { name: "A", email: "a@example.invalid", timestamp: "2026-01-01T00:00:00Z" },
      2,
      3,
      overrides.offset ?? null,
      overrides.flags ?? "",
      [
        ["main", null],
        ["main", "origin"],
      ],
      ["v1", "v1"],
      [],
    ] as const;

  it("omits false flags, splits remote bookmarks and dedupes tags", () => {
    expect(JjPanelService.toLogRow(output({ flags: "ci" }), undefined)).toEqual({
      commitId,
      changeId: "k".repeat(32),
      parentIds: [parent, other],
      summary: "summary",
      author: { name: "A", email: "a@example.invalid", timestamp: "2026-01-01T00:00:00Z" },
      changePrefixLength: 2,
      commitPrefixLength: 3,
      current: true,
      immutable: true,
      bookmarks: ["main"],
      remoteBookmarks: ["main@origin"],
      tags: ["v1"],
    });
  });

  it("keeps the change offset only for divergent rows", () => {
    expect(JjPanelService.toLogRow(output({ offset: 1 }), undefined).changeOffset).toBeUndefined();
    expect(JjPanelService.toLogRow(output({ flags: "d", offset: 1 }), undefined)).toMatchObject({
      divergent: true,
      changeOffset: 1,
    });
  });

  it.each([
    {
      nearest: [parent, "d".repeat(40)],
      edges: [{ commitId: parent }, { commitId: "d".repeat(40), elided: true }],
      truncated: undefined,
    },
    { nearest: [], edges: [], truncated: true },
    { nearest: "truncated" as const, edges: [{ commitId: parent }], truncated: true },
  ])("maps nearest ancestors $nearest to graph edges", ({ nearest, edges, truncated }) => {
    const row = JjPanelService.toLogRow(output({ inRevset: [true, false] }), nearest);
    expect(row.edges).toEqual(edges);
    expect(row.edgesTruncated).toBe(truncated);
  });

  it("extracts jj's error and first cause", () => {
    expect(
      JjPanelService.jjErrorDetail(
        "Warning: x\nError: Failed to parse revset: Syntax error\nCaused by:  --> 1:5\n",
      ),
    ).toBe("Failed to parse revset: Syntax error Caused by:  --> 1:5");
    expect(JjPanelService.jjErrorDetail("plain failure")).toBeUndefined();
  });
});

describe("JjPanelService operation history", () => {
  // Newest first, like `jj op log`. Flags: s = snapshot, o = another workspace.
  const ops = (
    ...entries: ReadonlyArray<readonly [id: string, description: string, flags?: string]>
  ) =>
    [...entries, ["0", "add workspace 'default'"] as const].map(
      ([id, description, flags = ""]) => ({
        id,
        parents: ["f"],
        username: "test",
        description,
        is_snapshot: flags.includes("s"),
        workspace_name: flags.includes("o") ? "other" : "default",
      }),
    );
  const entry = (operationId: string, description: string) => ({
    operationId,
    description,
  });

  const blocked = (operationId: string, description: string) => ({
    ...entry(operationId, description),
    blocked: true,
  });

  it.each([
    {
      name: "ignores other workspaces' snapshots",
      operations: ops(["b", "snapshot working copy", "so"], ["a", "new"]),
      expected: { undo: entry("a", "new") },
    },
    {
      name: "blocks past this workspace's snapshots",
      operations: ops(["b", "snapshot working copy", "s"], ["a", "new"]),
      expected: { undo: blocked("a", "new") },
    },
    {
      name: "blocks past other workspaces' actions",
      operations: ops(["b", "edit", "o"], ["a", "new"]),
      expected: { undo: blocked("a", "new") },
    },
    {
      name: "walks back past undone operations",
      operations: ops(["d", "revert operation b"], ["b", "describe"], ["a", "new"]),
      expected: { undo: entry("a", "new"), redo: entry("d", "describe") },
    },
    {
      name: "redoes the most recently undone operation first",
      operations: ops(
        ["e", "revert operation a"],
        ["d", "revert operation b"],
        ["b", "describe"],
        ["a", "new"],
      ),
      expected: { redo: entry("e", "new") },
    },
    {
      name: "undoes a redone operation and keeps the remaining redo",
      operations: ops(
        ["f1", "revert operation e"],
        ["e", "revert operation a"],
        ["d", "revert operation b"],
        ["b", "describe"],
        ["a", "new"],
      ),
      expected: { undo: entry("a", "new"), redo: entry("d", "describe") },
    },
    {
      name: "drops redo after a new action",
      operations: ops(
        ["e", "rebase"],
        ["d", "revert operation b"],
        ["b", "describe"],
        ["a", "new"],
      ),
      expected: { undo: entry("e", "rebase") },
    },
    {
      name: "stops at the workspace creation",
      operations: ops(["a", "snapshot working copy", "s"]),
      expected: {},
    },
  ])("$name", ({ operations, expected }) => {
    expect(JjPanelService.operationHistory(operations, "default")).toEqual(expected);
  });
});
