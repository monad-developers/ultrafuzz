import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { assertArtifactPublicationsContainNoSecrets } from "@ultrafuzz/artifacts";

import { isGeneratedWorkspaceOutput } from "../src/workspace-generated-output.js";
import {
  applyWorkspacePatch,
  captureWorkspacePatch,
  captureWorkspaceTree,
  validateWorkspacePatchCapture
} from "../src/workspace-handoff.js";
import { foundryHarnessArtifact } from "./fixtures/foundry-artifact.js";
import { captureLegacyWorkspacePatch } from "./fixtures/legacy-workspace-patch.js";
import { temporaryRoot } from "./temporary-root.js";

function git(root: string, args: string[]): string {
  return execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
}

function write(root: string, relativePath: string, contents: string): void {
  const filename = path.join(root, relativePath);
  fs.mkdirSync(path.dirname(filename), { recursive: true });
  fs.writeFileSync(filename, contents);
}

function fixture(): string {
  const root = temporaryRoot("ultrafuzz-generated-output-");
  git(root, ["init", "--quiet", "--initial-branch=main"]);
  git(root, ["config", "user.name", "Ultrafuzz test"]);
  git(root, ["config", "user.email", "ultrafuzz@example.invalid"]);
  write(root, "foundry.toml", "[profile.default]\n");
  git(root, ["add", "foundry.toml"]);
  git(root, ["commit", "--quiet", "-m", "fixture"]);
  return root;
}

const compilerDump = JSON.stringify({ input: { language: "Solidity", sources: {} }, output: { contracts: {} } });

function compilerArtifact(source: string, type: string, name = "testExample"): string {
  const abi = foundryHarnessArtifact.abi.map((entry) => ({ ...entry, name }));
  const metadata = {
    ...foundryHarnessArtifact.metadata,
    output: { ...foundryHarnessArtifact.metadata.output, abi },
    settings: { ...foundryHarnessArtifact.metadata.settings, compilationTarget: { [source]: type } }
  };
  return JSON.stringify({
    ...foundryHarnessArtifact,
    abi,
    metadata,
    rawMetadata: JSON.stringify(metadata),
    methodIdentifiers: { [`${name}()`]: "3f5a4a2a" }
  });
}

test("classifies nested build, coverage and corpus output without dropping neighboring authored files", () => {
  const root = fixture();
  const downstream = path.join(temporaryRoot("ultrafuzz-generated-downstream-"), "workspace");
  const baseline = captureWorkspaceTree(root);
  const generated: Record<string, string> = {
    ".cov-work/out/Fixture.sol/Fixture.json": compilerArtifact("src/Fixture.sol", "Fixture"),
    ".cov-work/compilation.json": compilerDump,
    ".recon/build.json": compilerDump,
    ".recon/compiler-input.json": compilerDump,
    ".recon/compiler-output.json": compilerDump,
    ".recon/recon-coverage.json": "{}",
    ".recon/corpus/seed.json": "[]",
    ".recon/covered.123.html": "<html>coverage</html>",
    "lcov.info": "SF:src/Fixture.sol\nDA:1,1\nend_of_record\n",
    "test/recon/coverage.lcov": "SF:src/Fixture.sol\nDA:1,1\nend_of_record\n",
    "test/recon/recon-corpus/seed.bin": "corpus",
    "test/recon/echidna/coverage/seed.txt": "corpus",
    "custom-output/out/build-info/0123456789abcdef.json": "{}",
    ".recon/build-snapshot/0123456789abcdef.json": "{}",
    "custom-output/out/Fixture.sol/Fixture.json": compilerArtifact("src/Fixture.sol", "Fixture"),
    ".cov-work/cache/solidity-files-cache.json": "{}"
  };
  const authored: Record<string, string> = {
    "test/recon/Handlers.t.sol": "contract Handlers {}\n",
    ".cov-work/out/Authored.t.sol": "contract Authored {}\n",
    ".recon/Replay.t.sol": "contract Replay {}\n",
    ".recon/corpus/Replay.t.sol": "contract ReplayCorpus {}\n",
    ".cov-work/config.json": '{"test":"test/recon"}\n',
    ".recon/settings.json": compilerDump,
    "echidna-config/config.json": '{"testMode":"assertion"}\n',
    "test/fixtures/compiler-output.json": compilerDump,
    "test/recon/notes.txt": "authored notes\n",
    "test/recon/out/config.json": '{"workers":1}\n',
    "test/recon/out/Harness.t.sol": "contract Harness {}\n",
    "test/fixtures/Fixture.sol/cases.json": '{"cases":[1,2,3]}\n',
    "test/fixtures/Fixture.sol/README.txt": "authored fixture description\n",
    "test/fixtures/build-info/cases.json": '{"cases":[1,2,3]}\n',
    "test/fixtures/build-snapshot/config.json": '{"workers":1}\n',
    "test/fixtures/build-info/0123456789abcdef.json": '{"cases":[1,2,3]}\n',
    "test/fixtures/out/Fixture.sol/cases.json": '{"cases":[1,2,3]}\n',
    "test/fixtures/out/Fixture.sol/Fixture.json": '{"cases":[1,2,3]}\n',
    ".cov-work/out/Fixture.sol/cases.json": '{"cases":[1,2,3]}\n',
    "custom-output/Fixture.sol/Fixture.json": compilerArtifact("src/Fixture.sol", "Fixture")
  };
  for (const [filename, contents] of Object.entries({ ...generated, ...authored })) write(root, filename, contents);

  const captured = captureWorkspacePatch(root, baseline);
  assert.deepEqual(captured.manifest.files.map((entry) => entry.path).sort(), Object.keys(authored).sort());
  assert.equal(captured.manifest.excluded_files, undefined, "classification runs before any overflow recovery");
  assert.equal(captureWorkspaceTree(root), captured.manifest.result_tree);
  validateWorkspacePatchCapture(root, captured, ["src", "contracts"]);
  git(root, ["worktree", "add", "--quiet", "--detach", downstream, "HEAD"]);
  applyWorkspacePatch(downstream, captured, ["src", "contracts"]);
  assert.equal(captureWorkspaceTree(downstream), captured.manifest.result_tree);
  for (const [filename, contents] of Object.entries(authored)) {
    assert.equal(fs.readFileSync(path.join(downstream, filename), "utf8"), contents, filename);
  }
  for (const filename of Object.keys(generated)) {
    assert.equal(fs.existsSync(path.join(downstream, filename)), false, filename);
    assert.equal(fs.existsSync(path.join(root, filename)), true, "capture must not delete scratch");
  }
});

test("recognizes Foundry test, script, interface and multiple-type artifacts without source/type basename equality", () => {
  const root = fixture();
  const baseline = captureWorkspaceTree(root);
  const layouts = [
    ["test/Harness.t.sol", "Harness"],
    ["script/Deploy.s.sol", "Deploy"],
    ["src/Fixture.sol", "Fixture"],
    ["src/Fixture.sol", "DifferentName"],
    ["src/Interfaces.sol", "IFixture"]
  ] as const;
  for (const directory of [".cov-work/out", ".recon/out", "nested/out"]) {
    for (const [source, type] of layouts) {
      write(root, `${directory}/${path.basename(source)}/${type}.json`, compilerArtifact(source, type));
    }
  }
  // Abstract contracts/interfaces have empty bytecode; it is still generated.
  write(
    root,
    ".cov-work/out/Interfaces.sol/IFixture.json",
    JSON.stringify({
      ...foundryHarnessArtifact,
      bytecode: { object: "0x" },
      deployedBytecode: { object: "0x" },
      metadata: {
        ...foundryHarnessArtifact.metadata,
        settings: { compilationTarget: { "src/Interfaces.sol": "IFixture" } }
      }
    })
  );
  write(root, "test/Harness.t.sol", "contract Harness {}\n");
  const captured = captureWorkspacePatch(root, baseline);
  assert.deepEqual(captured.manifest.files, [{ path: "test/Harness.t.sol" }]);
  assert.equal(captured.manifest.excluded_files, undefined);
  assert.equal(captureWorkspaceTree(root), captured.manifest.result_tree);
});

test("keeps real-layout Foundry metadata out of the fail-closed secret gate below the patch limit", () => {
  const root = fixture();
  const configuredSecret = "fixture-configured-credential-value";
  const fakeCredential = "ghp_AbCdEf1234567890AbCdEf1234567890AbCd"; // gitleaks:allow -- fixed synthetic scanner fixture
  write(root, "src/Fixture.sol", `contract DifferentName { function ${fakeCredential}() public pure {} }\n`);
  git(root, ["add", "src/Fixture.sol"]);
  git(root, ["commit", "--quiet", "-m", "synthetic compiler input"]);
  const baseline = captureWorkspaceTree(root);
  write(root, "test/Harness.t.sol", "contract Harness { function testExample() public pure { assert(true); } }\n");
  write(root, ".cov-work/out/Harness.t.sol/Harness.json", JSON.stringify(foundryHarnessArtifact));
  write(root, ".cov-work/out/Fixture.sol/Fixture.json", compilerArtifact("src/Fixture.sol", "Fixture"));
  write(
    root,
    ".cov-work/out/Fixture.sol/DifferentName.json",
    compilerArtifact("src/Fixture.sol", "DifferentName", fakeCredential)
  );
  const legacy = captureLegacyWorkspacePatch(root, baseline);
  assert.ok(Buffer.byteLength(legacy.patch) < 16 * 1024 * 1024);
  assert.equal(legacy.patch.includes(configuredSecret), false);
  assert.throws(
    () =>
      assertArtifactPublicationsContainNoSecrets(new Map([["workspace.patch", Buffer.from(legacy.patch)]]), [
        configuredSecret
      ]),
    /artifact publication contains sensitive data/u
  );

  const captured = captureWorkspacePatch(root, baseline);
  assert.deepEqual(captured.manifest.files, [{ path: "test/Harness.t.sol" }]);
  assert.ok(Buffer.byteLength(captured.patch) < 1024);
  assert.doesNotThrow(() =>
    assertArtifactPublicationsContainNoSecrets(new Map([["workspace.patch", Buffer.from(captured.patch)]]), [
      configuredSecret
    ])
  );
  validateWorkspacePatchCapture(root, captured, ["src", "contracts"]);
});

test("retains ambiguous compiler-looking JSON and bounds inspection of oversized candidates", () => {
  const root = fixture();
  const baseline = captureWorkspaceTree(root);
  const candidates = [
    "{}",
    "{incomplete",
    JSON.stringify({ ...foundryHarnessArtifact, abi: null }),
    JSON.stringify({ ...foundryHarnessArtifact, bytecode: "0x6000" }),
    JSON.stringify({ ...foundryHarnessArtifact, deployedBytecode: null }),
    JSON.stringify({ ...foundryHarnessArtifact, metadata: null }),
    compilerArtifact("test/Other.t.sol", "Harness"),
    compilerArtifact("test/Harness.t.sol", "Other"),
    JSON.stringify(foundryHarnessArtifact).replace('"abi":', '"abi":[],"abi":')
  ];
  const paths = candidates.map((contents, index) => {
    const filename = `case-${index}/out/Harness.t.sol/Harness.json`;
    write(root, filename, contents);
    assert.equal(isGeneratedWorkspaceOutput(root, filename), false, filename);
    return filename;
  });
  assert.deepEqual(
    captureWorkspacePatch(root, baseline).manifest.files.map((entry) => entry.path),
    paths.sort()
  );

  const oversized = "large/out/Harness.t.sol/Harness.json";
  write(root, oversized, JSON.stringify(foundryHarnessArtifact));
  fs.truncateSync(path.join(root, oversized), 1024 * 1024 * 1024);
  assert.equal(
    isGeneratedWorkspaceOutput(root, oversized),
    false,
    "oversized candidates stay eligible for measured overflow recovery"
  );
});

test("keeps a below-limit generated compiler dump out of the fail-closed artifact secret gate", () => {
  const root = fixture();
  const baseline = captureWorkspaceTree(root);
  const configuredSecret = "fixture-configured-credential-value";
  const fakeCredential = "ghp_AbCdEf1234567890AbCdEf1234567890AbCd"; // gitleaks:allow -- fixed synthetic scanner fixture
  const generated = JSON.stringify({
    input: { language: "Solidity", sources: {} },
    output: { metadata: fakeCredential, padding: "x".repeat(16_599_800) }
  });
  assert.ok(Buffer.byteLength(generated) < 16 * 1024 * 1024);
  assert.equal(generated.includes(configuredSecret), false);
  // Prove the synthetic signature is rejected without spending scanner time on
  // the repeated padding; the full below-limit dump exercises capture below.
  const contaminatedMetadata = Buffer.from(JSON.stringify({ metadata: fakeCredential }));
  assert.throws(
    () =>
      assertArtifactPublicationsContainNoSecrets(new Map([["workspace.patch", contaminatedMetadata]]), [
        configuredSecret
      ]),
    /artifact publication contains sensitive data/u
  );
  write(root, ".cov-work/compilation.json", generated);
  write(root, "test/Harness.t.sol", "contract Harness {}\n");

  const captured = captureWorkspacePatch(root, baseline);
  assert.deepEqual(captured.manifest.files, [{ path: "test/Harness.t.sol" }]);
  assert.ok(Buffer.byteLength(captured.patch) < 1024);
  assert.doesNotThrow(() =>
    assertArtifactPublicationsContainNoSecrets(new Map([["workspace.patch", Buffer.from(captured.patch)]]), [
      configuredSecret
    ])
  );
  validateWorkspacePatchCapture(root, captured, ["src", "contracts"]);
});

test("preserves tracked edits and deletions even when their paths look generated", () => {
  const root = fixture();
  write(root, "lcov.info", "original\n");
  write(root, ".recon/build-info/0123456789abcdef.json", "{}\n");
  git(root, ["add", "-A"]);
  git(root, ["commit", "--quiet", "-m", "tracked fixture data"]);
  const baseline = captureWorkspaceTree(root);
  const originalIndex = git(root, ["write-tree"]);
  write(root, "lcov.info", "edited\n");
  fs.unlinkSync(path.join(root, ".recon/build-info/0123456789abcdef.json"));
  write(root, ".recon/build-info/fedcba9876543210.json", "{}\n");

  const captured = captureWorkspacePatch(root, baseline);
  assert.deepEqual(captured.manifest.files.map((entry) => entry.path).sort(), [
    ".recon/build-info/0123456789abcdef.json",
    "lcov.info"
  ]);
  assert.match(captured.patch, /deleted file mode/u);
  assert.match(captured.patch, /\+edited/u);
  assert.equal(git(root, ["write-tree"]), originalIndex, "capture must not modify the real Git index");
  validateWorkspacePatchCapture(root, captured, ["src", "contracts"]);
});

test("replays authored scratch JSON across generations even when it acquires compiler output fields", () => {
  const root = fixture();
  const downstream = path.join(temporaryRoot("ultrafuzz-generated-chain-"), "workspace");
  const baseline = captureWorkspaceTree(root);
  write(root, ".recon/config.json", '{"workers":1}\n');
  const first = captureWorkspacePatch(root, baseline);
  write(root, ".recon/config.json", compilerDump);
  const second = captureWorkspacePatch(root, first.manifest.result_tree);
  assert.deepEqual(second.manifest.files, [{ path: ".recon/config.json" }]);
  git(root, ["worktree", "add", "--quiet", "--detach", downstream, "HEAD"]);
  applyWorkspacePatch(downstream, first, ["src", "contracts"]);
  applyWorkspacePatch(downstream, second, ["src", "contracts"]);
  assert.equal(captureWorkspaceTree(downstream), second.manifest.result_tree);
  assert.equal(fs.readFileSync(path.join(downstream, ".recon/config.json"), "utf8"), compilerDump);
});

test("preserves authenticated authored JSON when it becomes a compiler artifact, including secrets and deletions", () => {
  const root = fixture();
  const downstream = path.join(temporaryRoot("ultrafuzz-generated-shaped-chain-"), "workspace");
  const filename = ".cov-work/out/Harness.t.sol/Harness.json";
  const baseline = captureWorkspaceTree(root);
  write(root, filename, '{"cases":[1,2,3]}\n');
  const first = captureWorkspacePatch(root, baseline);
  assert.deepEqual(first.manifest.files, [{ path: filename }]);
  write(root, filename, JSON.stringify(foundryHarnessArtifact));
  const second = captureWorkspacePatch(root, first.manifest.result_tree);
  assert.deepEqual(second.manifest.files, [{ path: filename }]);
  git(root, ["worktree", "add", "--quiet", "--detach", downstream, "HEAD"]);
  applyWorkspacePatch(downstream, first, ["src", "contracts"]);
  applyWorkspacePatch(downstream, second, ["src", "contracts"]);
  assert.equal(captureWorkspaceTree(downstream, { trees: [second.manifest.result_tree] }), second.manifest.result_tree);

  const configuredSecret = "fixture-configured-credential-value";
  write(root, filename, compilerArtifact("test/Harness.t.sol", "Harness", configuredSecret));
  const contaminated = captureWorkspacePatch(root, second.manifest.result_tree);
  assert.deepEqual(contaminated.manifest.files, [{ path: filename }]);
  assert.throws(
    () =>
      assertArtifactPublicationsContainNoSecrets(new Map([["workspace.patch", Buffer.from(contaminated.patch)]]), [
        configuredSecret
      ]),
    /artifact publication contains sensitive data/u
  );
  fs.unlinkSync(path.join(root, filename));
  const deleted = captureWorkspacePatch(root, second.manifest.result_tree);
  assert.deepEqual(deleted.manifest.files, [{ path: filename }]);
  applyWorkspacePatch(downstream, deleted, ["src", "contracts"]);
  assert.equal(fs.existsSync(path.join(downstream, filename)), false);
});

test("replays retained v1 generated entries and preserves their authority across updates and deletions", () => {
  const root = fixture();
  const downstream = path.join(temporaryRoot("ultrafuzz-legacy-downstream-"), "workspace");
  const baseline = captureWorkspaceTree(root);
  git(root, ["worktree", "add", "--quiet", "--detach", downstream, "HEAD"]);
  write(root, ".recon/build.json", "{}\n");
  write(root, "lcov.info", "legacy coverage\n");
  write(root, ".cov-work/out/Harness.t.sol/Harness.json", JSON.stringify(foundryHarnessArtifact));
  write(root, "test/Harness.t.sol", "contract Harness {}\n");
  const first = captureLegacyWorkspacePatch(root, baseline);
  validateWorkspacePatchCapture(downstream, first, ["src", "contracts"]);
  applyWorkspacePatch(downstream, first, ["src", "contracts"]);
  assert.equal(captureWorkspaceTree(downstream, { trees: [first.manifest.result_tree] }), first.manifest.result_tree);
  applyWorkspacePatch(downstream, first, ["src", "contracts"]);

  // New scratch is not grandfathered merely because a retained handoff exists.
  write(downstream, ".cov-work/compiler-output.json", "new scratch\n");
  assert.equal(captureWorkspaceTree(downstream, { trees: [first.manifest.result_tree] }), first.manifest.result_tree);
  write(downstream, ".recon/build.json", "modified legacy data\n");
  assert.throws(() => applyWorkspacePatch(downstream, first, ["src", "contracts"]), /base tree mismatch/u);
  write(downstream, ".recon/build.json", "{}\n");

  // This new-runtime patch inherits the legacy generated entries through its
  // base tree, without naming them in its own changed-file manifest.
  write(root, "test/Harness.t.sol", "contract Harness { uint256 x; }\n");
  const second = captureWorkspacePatch(root, first.manifest.result_tree);
  assert.deepEqual(second.manifest.files, [{ path: "test/Harness.t.sol" }]);
  applyWorkspacePatch(downstream, second, ["src", "contracts"]);
  assert.equal(captureWorkspaceTree(downstream, { trees: [second.manifest.result_tree] }), second.manifest.result_tree);
  const configuredSecret = "fixture-configured-credential-value";
  write(root, ".recon/build.json", JSON.stringify({ credential: configuredSecret }));
  const contaminated = captureWorkspacePatch(root, second.manifest.result_tree);
  assert.deepEqual(contaminated.manifest.files, [{ path: ".recon/build.json" }]);
  assert.throws(
    () =>
      assertArtifactPublicationsContainNoSecrets(new Map([["workspace.patch", Buffer.from(contaminated.patch)]]), [
        configuredSecret
      ]),
    /artifact publication contains sensitive data/u
  );
  fs.unlinkSync(path.join(root, ".recon/build.json"));
  const third = captureWorkspacePatch(root, second.manifest.result_tree);
  assert.deepEqual(third.manifest.files, [{ path: ".recon/build.json" }]);
  applyWorkspacePatch(downstream, third, ["src", "contracts"]);
  assert.equal(captureWorkspaceTree(downstream, { trees: [third.manifest.result_tree] }), third.manifest.result_tree);
  assert.equal(fs.existsSync(path.join(downstream, ".recon/build.json")), false);
  assert.equal(fs.readFileSync(path.join(downstream, "lcov.info"), "utf8"), "legacy coverage\n");
  assert.equal(
    fs.readFileSync(path.join(downstream, ".cov-work/out/Harness.t.sol/Harness.json"), "utf8"),
    JSON.stringify(foundryHarnessArtifact)
  );
});

test("still rejects configured and credential-shaped secrets in included authored files", () => {
  const values = [
    "fixture-configured-credential-value",
    "ghp_AbCdEf1234567890AbCdEf1234567890AbCd" // gitleaks:allow -- fixed synthetic scanner fixture
  ];
  for (const secret of values) {
    for (const filename of [
      ".cov-work/Harness.t.sol",
      ".recon/config.json",
      "test/Replay.t.sol",
      "test/recon/out/config.json",
      "test/fixtures/Fixture.sol/cases.json",
      ".cov-work/out/Fixture.sol/Fixture.json",
      "test/fixtures/out/Fixture.sol/cases.json"
    ]) {
      const root = fixture();
      const baseline = captureWorkspaceTree(root);
      write(root, filename, JSON.stringify({ fixture: secret }));
      const captured = captureWorkspacePatch(root, baseline);
      assert.deepEqual(captured.manifest.files, [{ path: filename }]);
      assert.throws(
        () =>
          assertArtifactPublicationsContainNoSecrets(new Map([["workspace.patch", Buffer.from(captured.patch)]]), [
            values[0] ?? ""
          ]),
        /artifact publication contains sensitive data/u,
        filename
      );
    }
  }
});

test("leaves invalid scratch JSON and unsafe generated-looking paths to normal validation", () => {
  const root = fixture();
  const baseline = captureWorkspaceTree(root);
  write(root, ".recon/config.json", "{incomplete");
  assert.deepEqual(captureWorkspacePatch(root, baseline).manifest.files, [{ path: ".recon/config.json" }]);
  fs.symlinkSync("foundry.toml", path.join(root, "lcov.info"));
  assert.throws(() => captureWorkspacePatch(root, baseline), /symlink/u);
  fs.unlinkSync(path.join(root, "lcov.info"));
  const artifact = ".cov-work/out/Harness.t.sol/Harness.json";
  fs.mkdirSync(path.dirname(path.join(root, artifact)), { recursive: true });
  fs.symlinkSync(path.join(root, "foundry.toml"), path.join(root, artifact));
  assert.equal(isGeneratedWorkspaceOutput(root, artifact), false);
  assert.throws(() => captureWorkspacePatch(root, baseline), /symlink/u);
  fs.unlinkSync(path.join(root, artifact));
  write(root, ".recon/.env.json", compilerDump);
  assert.throws(() => captureWorkspacePatch(root, baseline), /secret|sensitive|\.env/u);
});
