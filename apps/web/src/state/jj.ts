import { WS_METHODS } from "@t3tools/contracts";
import { createEnvironmentRpcCommand } from "@t3tools/client-runtime/state/runtime";
import { connectionAtomRuntime } from "../connection/runtime";

export const jjEnvironment = {
  forgePreview: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "environment-data:jj:forge-preview",
    tag: WS_METHODS.jjForgePreview,
  }),
  forgePublish: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "environment-data:jj:forge-publish",
    tag: WS_METHODS.jjForgePublish,
  }),
  forgeStatus: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "environment-data:jj:forge-status",
    tag: WS_METHODS.jjForgeStatus,
  }),
  runAction: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "environment-data:jj:run-action",
    tag: WS_METHODS.jjRunAction,
  }),
  getDiff: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "environment-data:jj:get-diff",
    tag: WS_METHODS.jjGetDiff,
  }),
  getPanel: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "environment-data:jj:get-panel",
    tag: WS_METHODS.jjGetPanel,
  }),
  getRevision: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "environment-data:jj:get-revision",
    tag: WS_METHODS.jjGetRevision,
  }),
  describe: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "environment-data:jj:describe",
    tag: WS_METHODS.jjDescribe,
  }),
  squash: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "environment-data:jj:squash",
    tag: WS_METHODS.jjSquash,
  }),
  revertOperation: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "environment-data:jj:revert-operation",
    tag: WS_METHODS.jjRevertOperation,
  }),
};
