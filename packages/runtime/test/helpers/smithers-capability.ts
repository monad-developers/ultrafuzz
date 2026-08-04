import { bindSmithersExecutableCapability } from "../../src/smithers-executable-capability.js";

/** Test-only direct capability; this file is excluded from the runtime build. */
export function createSmithersTestEnvironment(
  executable: string,
  env: Record<string, string | undefined> = {}
): Record<string, string | undefined> {
  return bindSmithersExecutableCapability({ ...env }, executable);
}
