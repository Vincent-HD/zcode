import { createJjEnvironmentAtoms } from "@t3tools/client-runtime/state/jj";
import { connectionAtomRuntime } from "../connection/runtime";

export const jjEnvironment = createJjEnvironmentAtoms(connectionAtomRuntime);
