import { WS_METHODS } from "@t3tools/contracts";
import { Atom } from "effect/reactivity";
import type { EnvironmentRegistry } from "../connection/registry.ts";
import { createEnvironmentRpcCommand } from "./runtime.ts";

export const createJjEnvironmentAtoms = <R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) => ({
  forgePreview: createEnvironmentRpcCommand(runtime, {
    label: "environment-data:jj:forge-preview",
    tag: WS_METHODS.jjForgePreview,
  }),
  forgePublish: createEnvironmentRpcCommand(runtime, {
    label: "environment-data:jj:forge-publish",
    tag: WS_METHODS.jjForgePublish,
  }),
  forgeStatus: createEnvironmentRpcCommand(runtime, {
    label: "environment-data:jj:forge-status",
    tag: WS_METHODS.jjForgeStatus,
  }),
  runAction: createEnvironmentRpcCommand(runtime, {
    label: "environment-data:jj:run-action",
    tag: WS_METHODS.jjRunAction,
  }),
  getDiff: createEnvironmentRpcCommand(runtime, {
    label: "environment-data:jj:get-diff",
    tag: WS_METHODS.jjGetDiff,
  }),
  getPanel: createEnvironmentRpcCommand(runtime, {
    label: "environment-data:jj:get-panel",
    tag: WS_METHODS.jjGetPanel,
  }),
  describe: createEnvironmentRpcCommand(runtime, {
    label: "environment-data:jj:describe",
    tag: WS_METHODS.jjDescribe,
  }),
  squash: createEnvironmentRpcCommand(runtime, {
    label: "environment-data:jj:squash",
    tag: WS_METHODS.jjSquash,
  }),
  revertOperation: createEnvironmentRpcCommand(runtime, {
    label: "environment-data:jj:revert-operation",
    tag: WS_METHODS.jjRevertOperation,
  }),
});
