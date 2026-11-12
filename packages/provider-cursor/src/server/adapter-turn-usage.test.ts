import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import type { InteractionUpdate } from "@cursor/sdk";
import {
  EnvironmentId,
  MessageId,
  NodeId,
  ProjectId,
  ProviderInstanceId,
  ProviderSessionId,
  RunAttemptId,
  RunId,
  ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

import * as TestProviderHost from "@t3tools/provider-testing/TestProviderHost";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import { makeCursorAdapterV2 } from "./adapter.ts";
import * as CursorAgentSdk from "./CursorAgentSdk.ts";

describe("CursorAdapterV2 turn usage", () => {
  it.effect.each([
    { status: "finished", model: undefined, lateModel: undefined, missingUsage: false },
    { status: "cancelled", model: "claude-opus-4-6", lateModel: undefined, missingUsage: false },
    { status: "error", model: "custom-fable", lateModel: undefined, missingUsage: false },
    { status: "finished", model: undefined, lateModel: "gpt-6-sol", missingUsage: false },
    { status: "finished", model: "gpt-6-sol", lateModel: null, missingUsage: false },
    { status: "finished", model: undefined, lateModel: undefined, missingUsage: true },
  ] as const)(
    "projects Cursor tasks and unfinished tools: $status, late model $lateModel, missing usage $missingUsage",
    ({ status, model, lateModel, missingUsage }) =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const workspace = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "cursor-v2-lifecycle-",
        });
        const instanceId = ProviderInstanceId.make("cursor");
        const threadId = ThreadId.make("cursor-lifecycle-thread");
        const mcpSessions = yield* McpProviderSessions.McpProviderSessions;
        yield* mcpSessions.set({
          environmentId: EnvironmentId.make("cursor-lifecycle-environment"),
          threadId,
          providerSessionId: "cursor-lifecycle-session",
          providerInstanceId: instanceId,
          endpoint: "http://127.0.0.1:43123/mcp",
          authorizationHeader: "Bearer synthetic-cursor-token",
          browserToolsAvailable: true,
        });
        let sentWithMcpOverride = true;
        const modelSelection = { instanceId, model: "composer-2.5" };
        const runtimePolicy = ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
          runtimeMode: "full-access",
          interactionMode: "default",
          cwd: workspace,
        });
        const adapter = yield* makeCursorAdapterV2({
          instanceId,
          environment: { HOME: workspace },
        }).pipe(
          Effect.provideService(CursorAgentSdk.CursorAgentSdkRunner, {
            assertComplete: Effect.void,
            open: () =>
              Effect.succeed({
                agentId: "native-cursor-lifecycle",
                listMessages: Effect.succeed([]),
                close: Effect.void,
                send: (input) =>
                  Effect.gen(function* () {
                    sentWithMcpOverride = Object.hasOwn(input.options ?? {}, "mcpServers");
                    // Recorded tasks stream partial args before start, then end without completion; live runs cannot force this.
                    const taskToolCall = {
                      type: "task" as const,
                      args: {
                        description: "Review",
                        prompt: "Review the code.",
                        subagentType: { kind: "unspecified" },
                        ...(model === undefined ? {} : { model }),
                        agentId: "cursor-task-agent",
                        mode: "unspecified" as const,
                      },
                    };
                    const updates =
                      lateModel !== undefined
                        ? (["tool-call-started", "tool-call-completed"] as const)
                        : (["partial-tool-call", "tool-call-started"] as const);
                    for (const type of updates) {
                      yield* input.onDelta!({
                        type,
                        modelCallId: "model-call",
                        callId: "task-call",
                        toolCall: {
                          ...taskToolCall,
                          args: {
                            ...taskToolCall.args,
                            ...(type === "tool-call-completed"
                              ? { model: lateModel ?? undefined }
                              : {}),
                          },
                        },
                      });
                    }
                    const readUpdates: ReadonlyArray<InteractionUpdate> = [
                      {
                        type: "tool-call-started",
                        modelCallId: "native-model-call",
                        callId: "read-secret",
                        toolCall: { type: "read", args: { path: "secret.txt" } },
                      },
                      ...(["tool-call-started", "tool-call-completed"] as const).map((type) => ({
                        type,
                        modelCallId: "native-model-call",
                        callId: "read-open",
                        toolCall: {
                          type: "read" as const,
                          args: { path: "open.txt" },
                          ...(type === "tool-call-completed"
                            ? {
                                result: {
                                  status: "success" as const,
                                  value: { fileSize: 3, content: "ok\n", totalLines: 1 },
                                },
                              }
                            : {}),
                        },
                      })),
                    ];
                    for (const update of readUpdates) {
                      yield* input.onDelta!(update);
                    }
                    yield* input.onDelta!({
                      type: "turn-ended",
                      ...(missingUsage
                        ? {}
                        : {
                            usage: {
                              inputTokens: 100,
                              outputTokens: 40,
                              cacheReadTokens: 60,
                              cacheWriteTokens: 20,
                              reasoningTokens: 10,
                            },
                          }),
                    }).pipe(Effect.orDie);
                    return {
                      agentId: "native-cursor-lifecycle",
                      runId: "native-cursor-run",
                      wait: Effect.succeed({
                        id: "native-cursor-run",
                        requestId: "native-request",
                        status,
                        model: { id: "composer-2.5" },
                        durationMs: 1,
                        ...(status === "error"
                          ? {}
                          : {
                              usage: {
                                inputTokens: 100,
                                outputTokens: 40,
                                cacheReadTokens: 60,
                                cacheWriteTokens: 20,
                                reasoningTokens: 10,
                                totalTokens: 220,
                              },
                            }),
                      }),
                      cancel: Effect.void,
                    };
                  }).pipe(Effect.orDie),
              }),
          }),
          Effect.provide(TestProviderHost.layer({ cwd: workspace })),
        );
        const runtime = yield* adapter.openSession({
          threadId,
          providerSessionId: ProviderSessionId.make("cursor-lifecycle-session"),
          modelSelection,
          runtimePolicy,
        });
        const providerThread = yield* runtime.ensureThread({
          threadId,
          modelSelection,
          runtimePolicy,
        });
        const now = yield* DateTime.now;
        yield* runtime.startTurn({
          threadId,
          providerThread,
          modelSelection,
          runtimePolicy,
          runId: RunId.make("cursor-lifecycle-run"),
          runOrdinal: 1,
          providerTurnOrdinal: 1,
          attemptId: RunAttemptId.make("cursor-lifecycle-attempt"),
          rootNodeId: NodeId.make("cursor-lifecycle-root"),
          appThread: {
            id: threadId,
            projectId: ProjectId.make("cursor-lifecycle-project"),
            createdBy: "user",
            creationSource: "web",
            title: "Cursor lifecycle",
            providerInstanceId: instanceId,
            modelSelection,
            runtimeMode: "full-access",
            interactionMode: "default",
            branch: null,
            worktreePath: null,
            activeProviderThreadId: providerThread.id,
            lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
            forkedFrom: null,
            createdAt: now,
            updatedAt: now,
            archivedAt: null,
            settledOverride: null,
            settledAt: null,
            lastVisitedAt: null,
            deletedAt: null,
          },
          message: {
            messageId: MessageId.make("cursor-lifecycle-message"),
            createdBy: "user",
            creationSource: "web",
            text: "Review the code.",
            attachments: [],
          },
        });
        const events = yield* runtime.events.pipe(
          Stream.takeUntil((event) => event.type === "turn.terminal"),
          Stream.runCollect,
        );
        assert.isTrue(sentWithMcpOverride);
        const rows = events.filter((event) => event.type === "subagent.updated");
        assert.equal(rows[0]?.subagent.status, "running");
        assert.equal(rows[0]?.subagent.model, model ?? null);
        assert.equal(rows.at(-1)?.subagent.model, lateModel ?? model ?? null);
        assert.equal(
          rows.at(-1)?.subagent.status,
          lateModel !== undefined
            ? "completed"
            : status === "finished"
              ? "idle"
              : status === "cancelled"
                ? "cancelled"
                : "failed",
        );
        assert.isNotNull(rows.at(-1)?.subagent.completedAt);
        const unfinished =
          status === "finished" ? "interrupted" : status === "error" ? "failed" : "cancelled";
        const finalReads = new Map<string, { status: string; output: unknown; done: boolean }>();
        for (const event of events) {
          if (
            event.type === "turn_item.updated" &&
            event.turnItem.type === "dynamic_tool" &&
            event.turnItem.toolName === "Read"
          ) {
            finalReads.set(String(event.turnItem.title), {
              status: event.turnItem.status,
              output: event.turnItem.output,
              done: event.turnItem.completedAt !== null,
            });
          }
        }
        const finalNodes = new Map<string, string>();
        for (const event of events) {
          if (event.type === "node.updated" && event.node.kind === "tool_call") {
            finalNodes.set(String(event.node.nativeItemRef?.nativeId), event.node.status);
          }
        }
        assert.deepEqual(Object.fromEntries(finalReads), {
          "Read secret.txt": { status: unfinished, output: undefined, done: true },
          "Read open.txt": {
            status: "completed",
            output: { fileSize: 3, content: "ok\n", totalLines: 1 },
            done: true,
          },
        });
        assert.deepEqual(Object.fromEntries(finalNodes), {
          "read-secret": unfinished,
          "read-open": "completed",
        });
        const turns = events.filter((event) => event.type === "provider_turn.updated");
        assert.isUndefined(turns[0]?.providerTurn.turnTokenUsage);
        assert.deepEqual(
          turns.at(-1)?.providerTurn.turnTokenUsage,
          status === "error"
            ? { usageScope: "main_agent", usageStatus: "unavailable", hasSubagents: true }
            : {
                usageScope: "main_agent",
                usageStatus: status === "finished" && !missingUsage ? "complete" : "partial",
                inputTokens: 180,
                outputTokens: 40,
                cachedInputTokens: 60,
                cacheCreationTokens: 20,
                reasoningTokens: 10,
                hasSubagents: true,
              },
        );
      }).pipe(
        Effect.scoped,
        Effect.provide(
          Layer.mergeAll(NodeServices.layer, IdAllocator.layer, McpProviderSessions.layer),
        ),
      ),
  );
});
