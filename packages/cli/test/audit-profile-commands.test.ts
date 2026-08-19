import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { packagedTopology } from "@ultrafuzz/config";

import { runCli } from "../src/index.js";

interface Capture {
  stdout: string;
  stderr: string;
  code: number;
}

function tempProject(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "ufz-cli-profile-"));
}

async function cli(project: string, argv: string[]): Promise<Capture> {
  let stdout = "";
  let stderr = "";
  const code = await runCli([...argv, "--project", project], {
    cwd: project,
    env: {},
    stdout: {
      write: (chunk: string | Uint8Array) => {
        stdout += String(chunk);
        return true;
      }
    },
    stderr: {
      write: (chunk: string | Uint8Array) => {
        stderr += String(chunk);
        return true;
      }
    }
  });
  return { stdout, stderr, code };
}

function data(capture: Capture): Record<string, unknown> {
  return (JSON.parse(capture.stdout) as { data: Record<string, unknown> }).data;
}

test("profile list and detail expose the catalog and effective project policy", async () => {
  const project = tempProject();
  assert.equal((await cli(project, ["init", "--force"])).code, 0);

  const listed = await cli(project, ["config", "audit-profiles", "--json"]);
  assert.equal(listed.code, 0, listed.stderr);
  const listData = data(listed) as {
    schema_version: number;
    default_profile: string;
    catalog_digest: string;
    profiles: Array<{ id: string }>;
  };
  assert.equal(listData.schema_version, 2);
  assert.equal(listData.default_profile, "default");
  assert.match(listData.catalog_digest, /^[0-9a-f]{64}$/u);
  assert.deepEqual(
    listData.profiles.map((profile) => profile.id),
    ["default", "exhaustive", "invariant-only", "low-cost", "smoke"]
  );

  const detailed = await cli(project, ["config", "audit-profile", "smoke", "--json"]);
  assert.equal(detailed.code, 0, detailed.stderr);
  const detailData = data(detailed) as {
    catalog_schema_version: number;
    declared_topology_path: string;
    effective_topology_path: string;
    topology_path_origin: string;
    effective_settings: Record<string, number>;
  };
  assert.equal(detailData.catalog_schema_version, 2);
  assert.equal(detailData.declared_topology_path, "topologies/smoke.yml");
  assert.equal(detailData.effective_topology_path, "topologies/smoke.yml");
  assert.equal(detailData.topology_path_origin, "audit-profile");
  assert.equal(detailData.effective_settings.strategy_loops, 1);
});

test("topology list, show, and copy use the packaged assets safely", async () => {
  const project = tempProject();
  const listed = await cli(project, ["topology", "list", "--json"]);
  assert.equal(listed.code, 0, listed.stderr);
  const listData = data(listed) as {
    topologies: Array<{ id: string; logical_nodes: number; digest: string }>;
  };
  assert.deepEqual(
    listData.topologies.map((topology) => topology.id),
    ["full", "smoke", "invariant-only"]
  );
  assert.equal(
    listData.topologies.every((topology) => topology.logical_nodes > 2),
    true
  );
  assert.equal(
    listData.topologies.every((topology) => /^[0-9a-f]{64}$/u.test(topology.digest)),
    true
  );

  const shown = await cli(project, ["topology", "show", "invariant-only", "--json"]);
  assert.equal(shown.code, 0, shown.stderr);
  const shownData = data(shown) as { source: string; digest: string };
  assert.match(shownData.source, /id: stateful-invariant-campaign/u);
  assert.equal(shownData.digest, packagedTopology("invariant-only").digest);

  const destination = path.join(project, ".ultrafuzz", "topology.yml");
  const copied = await cli(project, ["topology", "copy", "invariant-only", ".ultrafuzz/topology.yml", "--json"]);
  assert.equal(copied.code, 0, copied.stderr);
  assert.deepEqual(fs.readFileSync(destination), fs.readFileSync(packagedTopology("invariant-only").path));

  const refused = await cli(project, ["topology", "copy", "smoke", ".ultrafuzz/topology.yml", "--json"]);
  assert.equal(refused.code, 1);
  assert.match(refused.stdout, /pass --force to overwrite/u);

  const forced = await cli(project, ["topology", "copy", "smoke", ".ultrafuzz/topology.yml", "--force", "--json"]);
  assert.equal(forced.code, 0, forced.stderr);
  assert.deepEqual(fs.readFileSync(destination), fs.readFileSync(packagedTopology("smoke").path));

  const escaped = await cli(project, ["topology", "copy", "smoke", "../outside.yml", "--json"]);
  assert.equal(escaped.code, 1);
  assert.equal(fs.existsSync(path.join(project, "..", "outside.yml")), false);
});

test("validate accepts CLI profile and topology overrides with the documented precedence", async () => {
  const project = tempProject();
  assert.equal((await cli(project, ["init", "--force"])).code, 0);
  fs.writeFileSync(path.join(project, ".ultrafuzz", "topology.yml"), "not: [valid\n", "utf8");

  const profile = await cli(project, ["validate", "--audit-profile", "smoke", "--json"]);
  assert.equal(profile.code, 0, profile.stderr);
  assert.equal((data(profile).topology as { origin: string }).origin, "audit-profile");

  const copied = await cli(project, ["topology", "copy", "full", ".ultrafuzz/full.yml", "--json"]);
  assert.equal(copied.code, 0, copied.stderr);
  const overridden = await cli(project, [
    "validate",
    "--audit-profile",
    "smoke",
    "--topology-path",
    ".ultrafuzz/full.yml",
    "--json"
  ]);
  assert.equal(overridden.code, 0, overridden.stderr);
  assert.equal((data(overridden).topology as { origin: string }).origin, "runtime-override");
});
