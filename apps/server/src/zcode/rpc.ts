import { AuthOrchestrationReadScope, ZCODE_WS_METHODS } from "@t3tools/contracts";

// Mutating and filesystem methods inherit their scopes from ZCODE_CLIENT_GUARDED_RPC_SCOPES.
export const ZCODE_RPC_REQUIRED_SCOPES = {
  [ZCODE_WS_METHODS.jjGetPanel]: AuthOrchestrationReadScope,
  [ZCODE_WS_METHODS.jjGetRevision]: AuthOrchestrationReadScope,
  [ZCODE_WS_METHODS.jjForgePreview]: AuthOrchestrationReadScope,
  [ZCODE_WS_METHODS.jjForgeStatus]: AuthOrchestrationReadScope,
} as const;

export const ZCODE_RPC_AGGREGATES = {
  [ZCODE_WS_METHODS.jjGetPanel]: "jj",
  [ZCODE_WS_METHODS.jjGetRevision]: "jj",
  [ZCODE_WS_METHODS.jjRunAction]: "jj",
  [ZCODE_WS_METHODS.jjGetDiff]: "jj",
  [ZCODE_WS_METHODS.jjForgePreview]: "jj",
  [ZCODE_WS_METHODS.jjForgePublish]: "jj",
  [ZCODE_WS_METHODS.jjForgeStatus]: "jj",
  [ZCODE_WS_METHODS.jjDescribe]: "jj",
  [ZCODE_WS_METHODS.jjRevertOperation]: "jj",
} as const;
