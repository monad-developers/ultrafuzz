import { describe, expect, it } from "vitest";

import { MODAL_SANDBOX_TIMEOUT_MS } from "../src/defaults.js";
import {
  REMOTE_CONFIG_PATH,
  persistentWorkspaceRoot,
  remoteAuthPath,
  resolvePersistentRemoteRoot
} from "../src/layout.js";

describe("Modal storage layout", () => {
  it("persists workspaces while keeping config and auth ephemeral", () => {
    expect(persistentWorkspaceRoot("run-1", "model-1")).toBe("/data/run-1/model-1/workspace");
    expect(REMOTE_CONFIG_PATH).toBe("/run/ultrafuzz-config/benchmark.json");
    expect(remoteAuthPath("openai")).toBe("/run/ultrafuzz-auth/codex/auth.json");
    expect(remoteAuthPath("anthropic")).toBe("/run/ultrafuzz-auth/claude/.credentials.json");
  });

  it("uses a sixteen-hour sandbox timeout", () => {
    expect(MODAL_SANDBOX_TIMEOUT_MS).toBe(16 * 60 * 60 * 1000);
  });

  it("maps only trusted /data children through the resolved Modal mount", () => {
    expect(resolvePersistentRemoteRoot("/data/run-1/model-1", "/resolved-volume")).toBe(
      "/resolved-volume/run-1/model-1"
    );
    expect(() => resolvePersistentRemoteRoot("/other/run-1", "/resolved-volume")).toThrow("must be a child of /data");
  });
});
