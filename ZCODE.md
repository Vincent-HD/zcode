# Z Code fork rules

Z Code is a personal fork of T3 Code (`origin` = `Vincent-HD/zcode`, `upstream` = `pingdotgg/t3code`).
These rules override the upstream guidance in `AGENTS.md` wherever they conflict.

## Never upstream

Everything in this fork stays personal. Do not open upstream PRs, issues, or discussions, do not
propose fork features or extension points to upstream, and do not shape code for upstream review.

## Minimize the upstream surface

Every line changed in an upstream file is a future rebase conflict. Before touching upstream code:

1. Put the feature in fork-owned files (`apps/server/src/zcode/`, `apps/web/src/zcode/`, and the
   feature folders listed below). Upstream files only get a call into them.
2. Plug in as high as possible: where upstream _declares_ its list, registry, layer, RPC group, or
   menu, append one fork entry. Never branch in the middle of upstream logic when a declaration
   site can carry it.
3. One entry point per upstream file, ideally one line: an import plus a spread, a layer merge, or a
   single element. Keep fork logic out of upstream components, stores, and hooks.
4. Prefer adding over editing: new props, new union members, and new array entries rebase cleanly;
   rewritten upstream lines do not.
5. Do not edit upstream tests. Test fork behavior in fork-owned test files.
6. Upstream workflows stay byte-identical. They are disabled in the GitHub repository; rerun
   `scripts/zcode-disable-upstream-workflows.sh` after every rebase push, because workflows added
   upstream arrive enabled. Fork CI lives in `.github/workflows/zcode-custom-tests.yml`.

When a feature cannot follow these rules, say so and get sign-off before patching upstream logic.

## Upstream entry points

The complete list of places where the fork touches upstream files. Keep it exact: add a row when
you add an entry point and delete it when you remove one. After a rebase, these are the only places
to re-check.

| Feature                        | Upstream file                                               | Entry point                                                                                                                                                                                                       |
| ------------------------------ | ----------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Jujutsu RPCs                   | `packages/contracts/src/rpc.ts`                             | `...ZCODE_WS_METHODS` in `WS_METHODS`; `...ZCODE_WS_RPCS` in `WsRpcGroup`                                                                                                                                         |
| Jujutsu RPCs                   | `packages/contracts/src/clientRpcPermissions.ts`            | `...ZCODE_CLIENT_GUARDED_RPC_SCOPES` in `CLIENT_GUARDED_RPC_SCOPES`                                                                                                                                               |
| Jujutsu capabilities           | `packages/contracts/src/environment.ts`                     | `...zcodeEnvironmentCapabilityFields` in `ExecutionEnvironmentCapabilities`                                                                                                                                       |
| Fork contracts                 | `packages/contracts/src/index.ts`                           | `export * from "./zcode.ts"`                                                                                                                                                                                      |
| Jujutsu services               | `apps/server/src/server.ts`                                 | `ZcodeServer.layer` merged first into `layerVcs`                                                                                                                                                                  |
| Jujutsu RPCs                   | `apps/server/src/ws.ts`                                     | `...(yield* makeZcodeWsHandlers)` in the handler map                                                                                                                                                              |
| Jujutsu RPCs                   | `apps/server/src/auth/RpcAuthorization.ts`                  | `...ZCODE_RPC_REQUIRED_SCOPES` in `RPC_REQUIRED_SCOPES`                                                                                                                                                           |
| Jujutsu RPCs                   | `apps/server/src/observability/RpcInstrumentation.ts`       | `...ZCODE_RPC_AGGREGATES` in `RPC_AGGREGATES`                                                                                                                                                                     |
| Jujutsu capabilities           | `apps/server/src/environment/ServerEnvironment.ts`          | `...ZCODE_ENVIRONMENT_CAPABILITIES` in the descriptor capabilities                                                                                                                                                |
| Jujutsu panel                  | `apps/web/src/rightPanelStore.ts`                           | `...ZCODE_RIGHT_PANEL_KINDS`; `ZcodeRightPanelSurface` union member; fork guard in `singletonSurface`                                                                                                             |
| Jujutsu panel                  | `apps/web/src/closedViewStore.ts`                           | fork guard in `isClosedViewEntry`                                                                                                                                                                                 |
| Jujutsu panel                  | `apps/web/src/reopenClosedView.ts`                          | workspace guard before the surface checks                                                                                                                                                                         |
| Jujutsu panel                  | `apps/web/src/components/RightPanelTabs.tsx`                | `zcodeLaunchers` prop spread into both launcher lists; fork guards in `surfaceTitle` and `SurfaceIcon`                                                                                                            |
| Jujutsu panel                  | `apps/web/src/components/chat/RightPanelSurfaceContent.tsx` | `zcode` prop; fork guard rendering `ZcodeRightPanelSurfaceContent`                                                                                                                                                |
| Jujutsu diff                   | `apps/web/src/diffPanelStore.ts`                            | `JjDiffPanelSelection` member of `DiffPanelSelection`                                                                                                                                                             |
| Jujutsu diff                   | `apps/web/src/components/chat/useRightPanelActions.ts`      | `openSelectedJjDiff` line in `addDiffSurface`                                                                                                                                                                     |
| Jujutsu diff                   | `apps/web/src/components/DiffPanel.tsx`                     | `useJjDiff` call; `jjDiff` fallbacks in the selection-derived values, scope menu, and empty states                                                                                                                |
| All features                   | `apps/web/src/components/ChatView.tsx`                      | `useZcodeChatView`; `isJjDiffSelection` in the diff-reset effect; `diffAvailable`; props `zcodeLaunchers`, `zcode`, `zcodeTemporary`, `isTemporaryConversation`, `usageFooter`; `draftId` for `useComposerResume` |
| Temporary conversations        | `apps/web/src/components/threadActionMenu.logic.ts`         | `ZcodeThreadActionMenuId`; `isTemporary` state; `...ZCODE_THREAD_ACTIONS_WITHOUT_OPERATE`; `...zcodeThreadActionMenuItems(state)`                                                                                 |
| Temporary conversations        | `apps/web/src/hooks/useThreadActionMenu.ts`                 | `isTemporary` state; `handleZcodeThreadRefAction` before the action switch                                                                                                                                        |
| Temporary conversations        | `apps/web/src/components/Sidebar.tsx`                       | `isTemporary` state; `handleZcodeThreadAction` before the action switch                                                                                                                                           |
| Temporary conversations        | `apps/web/src/hooks/useThreadActions.ts`                    | `clearZcodeThreadState` in `clearDeletedThreadPanelState`; `ZcodeDeleteThreadOptions`; `deleteWorktree` guard                                                                                                     |
| Temporary conversations        | `apps/web/src/components/chat/ChatHeader.tsx`               | `zcodeTemporary` prop; `useZcodeTemporaryHeader`; draft context menu; draft title branch; title badge; `ZcodeTemporaryHeaderActions`                                                                              |
| Temporary conversations        | `apps/web/src/components/ThreadRouteView.tsx`               | `useTemporaryMarkerPromotion`; discard guards in the missing-thread effect and draft redirect                                                                                                                     |
| Temporary conversations        | `apps/web/src/components/chat/useComposerSend.ts`           | `useTemporaryComposerSend` and its `zcodeSend.*` calls                                                                                                                                                            |
| Temporary conversations        | `apps/web/src/components/chat/useComposerResume.ts`         | optional `draftId` input; discard guard                                                                                                                                                                           |
| Temporary conversations        | `apps/web/src/components/chat/composerCommandKey.ts`        | `isTemporaryConversation` input passed to `composerSubmissionIntentForKey`                                                                                                                                        |
| Temporary conversations        | `apps/web/src/composer-logic.ts`                            | `isTemporaryConversation` input; `blocksTemporaryShortcut` check                                                                                                                                                  |
| Temporary conversations, usage | `apps/web/src/components/chat/ChatComposer.tsx`             | `isTemporaryConversation` and `usageFooter` props                                                                                                                                                                 |
| Usage                          | `apps/web/src/components/chat/TimelineAssistantRows.tsx`    | `AssistantTurnUsage` in `AssistantMessageMeta`                                                                                                                                                                    |
| Usage                          | `packages/provider-cursor/src/server/adapter.ts`            | `recordCursorTurnUpdate`; `recordCursorRunUsage`; `...cursorTurnUsageFields(input)`                                                                                                                               |
| Fork rules                     | `AGENTS.md`                                                 | pointer to this file                                                                                                                                                                                              |
| Fork docs                      | `README.md`                                                 | fork section above the original README                                                                                                                                                                            |
