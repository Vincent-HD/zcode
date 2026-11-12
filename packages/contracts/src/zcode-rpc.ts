import * as Schema from "effect/Schema";
import * as Rpc from "effect/rpc/Rpc";
import {
  AuthFilesystemReadScope,
  AuthSourceControlWriteScope,
  EnvironmentAuthorizationError,
} from "./auth.ts";
import {
  JjDescribeInput,
  JjDiffResult,
  JjGetDiffInput,
  JjGetPanelInput,
  JjGetRevisionInput,
  JjMutationResult,
  JjPanelError,
  JjPanelSnapshot,
  JjRevisionDetails,
  JjRevertOperationInput,
  JjRunActionInput,
} from "./jj.ts";
import {
  JjForgeError,
  JjForgePlan,
  JjForgePreviewInput,
  JjForgePublishInput,
  JjForgePublishResult,
  JjForgeStatusInput,
  JjForgeStatusResult,
} from "./jj-forge.ts";

export const ZCODE_WS_METHODS = {
  jjGetPanel: "jj.getPanel",
  jjGetRevision: "jj.getRevision",
  jjRunAction: "jj.runAction",
  jjGetDiff: "jj.getDiff",
  jjForgePreview: "jj.forgePreview",
  jjForgePublish: "jj.forgePublish",
  jjForgeStatus: "jj.forgeStatus",
  jjDescribe: "jj.describe",
  jjRevertOperation: "jj.revertOperation",
} as const;

const JjPanelRpcError = Schema.Union([JjPanelError, EnvironmentAuthorizationError]);
const JjForgeRpcError = Schema.Union([JjForgeError, EnvironmentAuthorizationError]);

export const ZCODE_WS_RPCS = [
  Rpc.make(ZCODE_WS_METHODS.jjGetPanel, {
    payload: JjGetPanelInput,
    success: JjPanelSnapshot,
    error: JjPanelRpcError,
  }),
  Rpc.make(ZCODE_WS_METHODS.jjGetRevision, {
    payload: JjGetRevisionInput,
    success: JjRevisionDetails,
    error: JjPanelRpcError,
  }),
  Rpc.make(ZCODE_WS_METHODS.jjRunAction, {
    payload: JjRunActionInput,
    success: JjMutationResult,
    error: JjPanelRpcError,
  }),
  Rpc.make(ZCODE_WS_METHODS.jjForgePreview, {
    payload: JjForgePreviewInput,
    success: JjForgePlan,
    error: JjForgeRpcError,
  }),
  Rpc.make(ZCODE_WS_METHODS.jjForgePublish, {
    payload: JjForgePublishInput,
    success: JjForgePublishResult,
    error: JjForgeRpcError,
  }),
  Rpc.make(ZCODE_WS_METHODS.jjForgeStatus, {
    payload: JjForgeStatusInput,
    success: JjForgeStatusResult,
    error: JjForgeRpcError,
  }),
  Rpc.make(ZCODE_WS_METHODS.jjGetDiff, {
    payload: JjGetDiffInput,
    success: JjDiffResult,
    error: JjPanelRpcError,
  }),
  Rpc.make(ZCODE_WS_METHODS.jjDescribe, {
    payload: JjDescribeInput,
    success: JjMutationResult,
    error: JjPanelRpcError,
  }),
  Rpc.make(ZCODE_WS_METHODS.jjRevertOperation, {
    payload: JjRevertOperationInput,
    success: JjMutationResult,
    error: JjPanelRpcError,
  }),
] as const;

export const ZCODE_CLIENT_GUARDED_RPC_SCOPES = {
  [ZCODE_WS_METHODS.jjRunAction]: AuthSourceControlWriteScope,
  [ZCODE_WS_METHODS.jjForgePublish]: AuthSourceControlWriteScope,
  [ZCODE_WS_METHODS.jjGetDiff]: AuthFilesystemReadScope,
  [ZCODE_WS_METHODS.jjDescribe]: AuthSourceControlWriteScope,
  [ZCODE_WS_METHODS.jjRevertOperation]: AuthSourceControlWriteScope,
} as const;
