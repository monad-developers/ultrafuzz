import path from "node:path";

import { describe, expect, it } from "vitest";

import { invocationCwd, requireCliPath, resolveCliPath } from "../src/options.js";

describe("EVMBench CLI path options", () => {
  it("resolves relative paths from the original pnpm invocation directory", () => {
    const workspaceCwd = path.resolve("/workspace");
    const packageCwd = path.resolve("/workspace/packages/evmbench");

    expect(invocationCwd({ INIT_CWD: workspaceCwd }, packageCwd)).toBe(workspaceCwd);
    expect(resolveCliPath("harness", workspaceCwd)).toBe(path.join(workspaceCwd, "harness"));
    expect(requireCliPath("benchmarks/evmbench", "--benchmark-dir", workspaceCwd)).toBe(
      path.join(workspaceCwd, "benchmarks", "evmbench")
    );
  });
});
