import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { assertArtifactPublicationsContainNoSecrets } from "@ultrafuzz/artifacts";

import {
  applyWorkspacePatch,
  captureWorkspacePatch,
  captureWorkspaceTree,
  validateWorkspacePatchCapture
} from "../src/workspace-handoff.js";
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

test("classifies nested build, coverage and corpus output without dropping neighboring authored files", () => {
  const root = fixture();
  const downstream = path.join(temporaryRoot("ultrafuzz-generated-downstream-"), "workspace");
  const baseline = captureWorkspaceTree(root);
  const generated: Record<string, string> = {
    ".cov-work/out/Fixture.sol/Fixture.json": "{}",
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
    "custom-output/build-info/build.json": "{}",
    "custom-output/build-snapshot/snapshot.json": "{}",
    "custom-output/Fixture.sol/Fixture.json": "{}",
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
    "test/recon/notes.txt": "authored notes\n"
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
  write(root, ".recon/build-info/old.json", "{}\n");
  git(root, ["add", "-A"]);
  git(root, ["commit", "--quiet", "-m", "tracked fixture data"]);
  const baseline = captureWorkspaceTree(root);
  const originalIndex = git(root, ["write-tree"]);
  write(root, "lcov.info", "edited\n");
  fs.unlinkSync(path.join(root, ".recon/build-info/old.json"));
  write(root, ".recon/build-info/new.json", "{}\n");

  const captured = captureWorkspacePatch(root, baseline);
  assert.deepEqual(captured.manifest.files.map((entry) => entry.path).sort(), [
    ".recon/build-info/old.json",
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

test("still rejects configured and credential-shaped secrets in included authored files", () => {
  const values = [
    "fixture-configured-credential-value",
    "ghp_AbCdEf1234567890AbCdEf1234567890AbCd" // gitleaks:allow -- fixed synthetic scanner fixture
  ];
  for (const secret of values) {
    for (const filename of [".cov-work/Harness.t.sol", ".recon/config.json", "test/Replay.t.sol"]) {
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
  write(root, ".recon/.env.json", compilerDump);
  assert.throws(() => captureWorkspacePatch(root, baseline), /secret|sensitive|\.env/u);
});
