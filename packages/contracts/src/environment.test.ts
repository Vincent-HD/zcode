import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import { ExecutionEnvironmentDescriptor } from "./environment.ts";

const decodeDescriptor = Schema.decodeUnknownSync(ExecutionEnvironmentDescriptor);

const descriptor = {
  environmentId: "environment-1",
  label: "Local",
  platform: { os: "darwin", arch: "arm64" },
  serverVersion: "0.0.32",
  capabilities: { repositoryIdentity: true },
} as const;

describe("ExecutionEnvironmentDescriptor", () => {
  it("decodes old, recognized and future manual installation descriptors", () => {
    expect(decodeDescriptor(descriptor).capabilities.serverInstallation).toBeUndefined();
    for (const installation of [{ kind: "npx" }, { kind: "npm-global", prefix: "/opt/node" }]) {
      expect(
        decodeDescriptor({
          ...descriptor,
          capabilities: { ...descriptor.capabilities, serverInstallation: installation },
        }).capabilities.serverInstallation,
      ).toEqual(installation);
    }
    for (const installation of [{ kind: "future-manager" }, { kind: "npm-global" }]) {
      expect(
        decodeDescriptor({
          ...descriptor,
          capabilities: { ...descriptor.capabilities, serverInstallation: installation },
        }).capabilities.serverInstallation,
      ).toBeUndefined();
    }
  });

  it("requires an advertised Jujutsu panel capability under version skew", () => {
    expect(decodeDescriptor(descriptor).capabilities.jjPanel).toBeUndefined();
    expect(decodeDescriptor(descriptor).capabilities.jjPanelActions).toBeUndefined();
    expect(decodeDescriptor(descriptor).capabilities.jjPanelDiff).toBeUndefined();
    expect(decodeDescriptor(descriptor).capabilities.jjPanelForge).toBeUndefined();
    expect(
      decodeDescriptor({
        ...descriptor,
        capabilities: { ...descriptor.capabilities, jjPanel: true },
      }).capabilities.jjPanel,
    ).toBe(true);
  });

  it("advertises expanded Jujutsu actions, diff and publication independently from panel reads", () => {
    const capabilities = decodeDescriptor({
      ...descriptor,
      capabilities: {
        ...descriptor.capabilities,
        jjPanel: true,
        jjPanelActions: true,
        jjPanelDiff: true,
        jjPanelForge: true,
      },
    }).capabilities;
    expect(capabilities.jjPanelActions).toBe(true);
    expect(capabilities.jjPanelDiff).toBe(true);
    expect(capabilities.jjPanelForge).toBe(true);
  });
});
