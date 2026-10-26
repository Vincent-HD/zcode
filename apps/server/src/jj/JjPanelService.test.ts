import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import {
  type JjPanelReady,
  type JjRunAction,
  WS_METHODS,
  WsRpcGroup,
  AuthOrchestrationReadScope,
  AuthSourceControlWriteScope,
  AuthFilesystemReadScope,
  clientRpcRequiredScopes,
} from "@t3tools/contracts";
import * as RpcTest from "effect/rpc/RpcTest";
import * as RpcAuthorization from "../auth/RpcAuthorization.ts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import * as JjPanelService from "./JjPanelService.ts";

const live = JjPanelService.layer.pipe(
  Layer.provideMerge(VcsProcess.layer),
  Layer.provideMerge(NodeServices.layer),
);
const fixture = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const process = yield* VcsProcess.VcsProcess;
  const service = yield* JjPanelService.JjPanelService;
  const cwd = yield* fs.makeTempDirectoryScoped({ prefix: "t3-jj-panel-test-" });
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
  const panel = () =>
    service.getPanel({ cwd }).pipe(
      Effect.filterOrElse(
        (value): value is JjPanelReady => value.status === "ready",
        () => Effect.die("Expected jj workspace"),
      ),
    );
  const expected = (value: JjPanelReady) => ({
    cwd,
    workspaceIdentity: value.workspaceIdentity,
    expectedOperationId: value.operationId,
  });
  const action = (action: JjRunAction) =>
    panel().pipe(Effect.flatMap((before) => service.runAction({ ...expected(before), action })));
  return { fs, cwd, cli, service, panel, expected, action };
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
    "reads nested cwd, structured filenames and the working copy and ten ancestors with parent edges",
    () =>
      Effect.gen(function* () {
        const f = yield* fixture;
        for (let index = 0; index < 12; index++) yield* f.cli(["new", "-m", `ancestor ${index}`]);
        yield* f.fs.writeFileString(`${f.cwd}/odd\n"filename.txt`, "hello");
        yield* f.fs.makeDirectory(`${f.cwd}/nested`);
        const panel = yield* f.service.getPanel({ cwd: `${f.cwd}/nested` });
        expect(panel.status).toBe("ready");
        if (panel.status !== "ready") return;
        expect(panel.revisions).toHaveLength(11);
        expect(panel.workspaceIdentity.workspaceRoot).toBe(f.cwd);
        expect(panel.revisions[0]?.files).toContainEqual({
          path: 'odd\n"filename.txt',
          status: "added",
        });
        expect(panel.revisions[0]?.current).toBe(true);
        expect(panel.revisions.filter((revision) => !revision.current)).toHaveLength(10);
        expect(panel.revisions[0]?.parentIds[0]).toBe(panel.revisions[1]?.commitId);
        expect(panel.visibleRevisions?.length).toBeGreaterThan(0);
        expect(
          panel.visibleRevisions?.every(
            (revision) =>
              !panel.revisions.some((ancestor) => ancestor.commitId === revision.commitId),
          ),
        ).toBe(true);
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
        const result = yield* f.service.squash({
          ...f.expected(before),
          sourceCommitId: before.workingCopyCommitId,
          destinationCommitId: destination.commitId,
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
        const replaced = yield* f.service.squash({
          ...f.expected(next),
          sourceCommitId: next.workingCopyCommitId,
          destinationCommitId: nextDestination.commitId,
          messagePolicy: { type: "replace", description: "" },
        });
        expect(replaced.panel.revisions[1]?.description).toBe("");
      }).pipe(Effect.provide(live)),
  );

  it.live(
    "rejects squash into a non-ancestor merge sibling and conflicted endpoints, but permits conflicted descriptions",
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
            .squash({
              ...f.expected(described.panel),
              sourceCommitId: described.panel.workingCopyCommitId,
              destinationCommitId: left,
            })
            .pipe(Effect.flip)).reason,
        ).toBe("conflicted");
        expect(
          (yield* f.service
            .squash({
              ...f.expected(described.panel),
              sourceCommitId: left,
              destinationCommitId: right,
            })
            .pipe(Effect.flip)).reason,
        ).toBe("invalid-target");
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
          .squash({
            ...f.expected(before),
            sourceCommitId: before.workingCopyCommitId,
            destinationCommitId: ancestor.commitId,
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
        const handler = group.toLayerHandler(WS_METHODS.jjDescribe, f.service.describe);
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
        expect(
          (yield* writeClient[WS_METHODS.jjDescribe](input)).panel.revisions[0]?.description,
        ).toBe("authorized\n");
        expect(RpcAuthorization.requiredScopeForRpcMethod(WS_METHODS.jjGetPanel)).toBe(
          AuthOrchestrationReadScope,
        );
        for (const method of [
          WS_METHODS.jjDescribe,
          WS_METHODS.jjSquash,
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
        const before = yield* f.panel();
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
    "undoes and redoes an external operation with pinned freshness independently of panel receipts",
    () =>
      Effect.gen(function* () {
        const f = yield* fixture;
        yield* f.cli(["describe", "-m", "external"]);
        const before = yield* f.panel();
        const undone = yield* f.action({ type: "undo" });
        expect(undone.panel.revisions[0]?.description).toBe("");
        const redone = yield* f.action({ type: "redo" });
        expect(redone.panel.revisions[0]?.description).toBe("external\n");
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
      expect(
        (yield* f.service
          .getDiff({ ...f.expected(panel), revisionCommitId: original })
          .pipe(Effect.flip)).reason,
      ).toBe("stale-state");
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

  it.live("bounds additional mutable choices while preserving the current/ancestor list", () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      for (let index = 0; index < 67; index++)
        yield* f.cli(["new", "root()", "--no-edit", "-m", `sibling ${index}`]);
      const panel = yield* f.panel();
      expect(panel.revisions).toHaveLength(2);
      expect(panel.visibleRevisions).toHaveLength(64);
      expect(panel.visibleRevisionsTruncated).toBe(true);
      expect(panel.visibleRevisions?.every((revision) => !revision.immutable)).toBe(true);
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
          group.toLayerHandler(WS_METHODS.jjRunAction, f.service.runAction),
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
        expect(committed.panel.revisions[1]?.description).toBe("authorized\n");
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
