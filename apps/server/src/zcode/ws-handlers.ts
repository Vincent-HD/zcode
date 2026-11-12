import {
  ZCODE_WS_METHODS,
  type JjDescribeInput,
  type JjForgePreviewInput,
  type JjForgePublishInput,
  type JjForgeStatusInput,
  type JjGetDiffInput,
  type JjGetPanelInput,
  type JjGetRevisionInput,
  type JjRevertOperationInput,
  type JjRunActionInput,
  type JjSquashInput,
} from "@t3tools/contracts";
import type * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import * as JjForgeService from "../jj/JjForgeService.ts";
import * as JjPanelService from "../jj/JjPanelService.ts";

// Optional lookup keeps the fork services out of layerWsRpc's requirements, so upstream ws tests
// need no fork mocks; server.ts always provides them through the fork layer.
const resolveOptional = Effect.fnUntraced(function* <I, S>(key: Context.Key<I, S>) {
  const service = yield* Effect.serviceOption(key);
  return <A, E>(use: (service: S) => Effect.Effect<A, E>) =>
    Option.match(service, {
      onNone: () => Effect.die(`Z Code service ${key.key} is not provided`),
      onSome: use,
    });
});

export const makeZcodeWsHandlers = Effect.gen(function* () {
  const jjPanel = yield* resolveOptional(JjPanelService.JjPanelService);
  const jjForge = yield* resolveOptional(JjForgeService.JjForgeService);
  return {
    [ZCODE_WS_METHODS.jjGetPanel]: (input: JjGetPanelInput) =>
      jjPanel((service) => service.getPanel(input)),
    [ZCODE_WS_METHODS.jjGetRevision]: (input: JjGetRevisionInput) =>
      jjPanel((service) => service.getRevision(input)),
    [ZCODE_WS_METHODS.jjRunAction]: (input: JjRunActionInput) =>
      jjPanel((service) => service.runAction(input)),
    [ZCODE_WS_METHODS.jjGetDiff]: (input: JjGetDiffInput) =>
      jjPanel((service) => service.getDiff(input)),
    [ZCODE_WS_METHODS.jjDescribe]: (input: JjDescribeInput) =>
      jjPanel((service) => service.describe(input)),
    [ZCODE_WS_METHODS.jjSquash]: (input: JjSquashInput) =>
      jjPanel((service) => service.squash(input)),
    [ZCODE_WS_METHODS.jjRevertOperation]: (input: JjRevertOperationInput) =>
      jjPanel((service) => service.revertOperation(input)),
    [ZCODE_WS_METHODS.jjForgePreview]: (input: JjForgePreviewInput) =>
      jjForge((service) => service.preview(input)),
    [ZCODE_WS_METHODS.jjForgePublish]: (input: JjForgePublishInput) =>
      jjForge((service) => service.publish(input)),
    [ZCODE_WS_METHODS.jjForgeStatus]: (input: JjForgeStatusInput) =>
      jjForge((service) => service.getStatus(input)),
  };
});
