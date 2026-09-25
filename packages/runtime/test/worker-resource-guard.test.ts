import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { temporaryRoot } from "./temporary-root.js";

test(
  "worker resource guard terminates aggregate descendant RSS and records the classification",
  {
    skip: process.platform !== "linux"
  },
  () => {
    const root = temporaryRoot("ultrafuzz-worker-resource-");
    const marker = path.join(root, "termination.json");
    const guard = [
      path.resolve("src/templates/smithers/agents/worker-resource-guard.tsx"),
      path.resolve("packages/runtime/src/templates/smithers/agents/worker-resource-guard.tsx")
    ].find((candidate) => fs.existsSync(candidate));
    assert.ok(guard);
    const allocator = [
      'const { spawn } = require("node:child_process");',
      'spawn(process.execPath, ["-e", "const held = Buffer.alloc(128 * 1024 * 1024, 1); setInterval(() => void held, 1000)"], { stdio: "ignore" });',
      "setInterval(() => {}, 1000);"
    ].join(" ");
    const result = spawnSync(
      "bun",
      [
        guard,
        "--memory-mib",
        "80",
        "--cpu",
        "1",
        "--task-id",
        "tree-limit",
        "--marker",
        marker,
        "--",
        process.execPath,
        "-e",
        allocator
      ],
      { encoding: "utf8", timeout: 15_000 }
    );

    assert.equal(result.status, 86, `${result.stdout}\n${result.stderr}`);
    assert.match(result.stderr, /WORKER_RESOURCE_EXHAUSTED/u);
    const classified = JSON.parse(fs.readFileSync(marker, "utf8")) as Record<string, unknown>;
    assert.equal(classified.classification, "WORKER_RESOURCE_EXHAUSTED");
    assert.equal(classified.task_id, "tree-limit");
    assert.ok(Number(classified.observed_process_tree_rss_bytes) > 80 * 1024 * 1024);
    assert.ok(Number(classified.process_count) >= 2);
  }
);
