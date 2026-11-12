import { expect, it } from "@effect/vitest";
import { vi } from "vite-plus/test";
import {
  AuthFilesystemReadScope,
  AuthOrchestrationOperateScope,
  AuthSourceControlWriteScope,
  EnvironmentId,
  WS_METHODS,
  type AuthEnvironmentScope,
  type AuthSessionState,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { Atom, AtomRegistry, AsyncResult } from "effect/reactivity";
import { EnvironmentRegistry } from "../connection/registry.ts";
import { createCommandPermissions } from "./commandPermissions.ts";

vi.mock("./session.ts", () => ({
  createEnvironmentSessionAtoms: () => ({ sessionStateAtom: sessions }),
}));
const sessions = Atom.family((_id: EnvironmentId) =>
  Atom.make<AsyncResult.AsyncResult<AuthSessionState, string>>(AsyncResult.initial()),
);
const env = EnvironmentId.make("target");
const other = EnvironmentId.make("other");
const grant = (scopes: ReadonlyArray<AuthEnvironmentScope>): AuthSessionState => ({
  authenticated: true,
  auth: {
    policy: "remote-reachable",
    bootstrapMethods: [],
    sessionMethods: [],
    sessionCookieName: "test",
  },
  scopes,
  permissions: scopes,
});
const runtime = Atom.runtime(
  Layer.succeed(EnvironmentRegistry, {
    run: (_id: EnvironmentId, effect: Effect.Effect<unknown>) => effect,
  } as unknown as EnvironmentRegistry["Service"]),
);
const setup = Effect.gen(function* () {
  const registry = AtomRegistry.make();
  registry.mount(sessions(env));
  yield* Effect.addFinalizer(() => Effect.sync(() => registry.dispose()));
  return registry;
});

it.effect("requires the destination source-control grant for every Jujutsu rewrite", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const registry = yield* setup;
      registry.set(sessions(env), AsyncResult.success(grant([AuthOrchestrationOperateScope])));
      registry.set(sessions(other), AsyncResult.success(grant([AuthSourceControlWriteScope])));
      for (const tag of [
        WS_METHODS.jjDescribe,
        WS_METHODS.jjSquash,
        WS_METHODS.jjRevertOperation,
        WS_METHODS.jjRunAction,
        WS_METHODS.jjForgePublish,
      ]) {
        const command = createCommandPermissions(runtime, tag);
        expect(registry.get(command.permissionAtom(env))).toBe(false);
        const denied = yield* command.authorize(registry, env).pipe(Effect.flip);
        expect(denied.requiredPermission).toBe(AuthSourceControlWriteScope);
        expect(registry.get(command.permissionAtom(other))).toBe(true);
        yield* command.authorize(registry, other);
      }
    }),
  ),
);

it.effect("requires the destination filesystem grant for Jujutsu diff reads", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const registry = yield* setup;
      registry.set(sessions(env), AsyncResult.success(grant([AuthSourceControlWriteScope])));
      registry.set(sessions(other), AsyncResult.success(grant([AuthFilesystemReadScope])));
      const command = createCommandPermissions(runtime, WS_METHODS.jjGetDiff);
      expect(registry.get(command.permissionAtom(env))).toBe(false);
      expect((yield* command.authorize(registry, env).pipe(Effect.flip)).requiredPermission).toBe(
        AuthFilesystemReadScope,
      );
      expect(registry.get(command.permissionAtom(other))).toBe(true);
      yield* command.authorize(registry, other);
    }),
  ),
);
