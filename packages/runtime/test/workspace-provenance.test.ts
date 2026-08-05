import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createRunLayout, getNodeArtifactDir, writeArtifactManifest } from "@ultrafuzz/artifacts";
import { MAX_EXPANDED_TOPOLOGY_NODES } from "@ultrafuzz/topology";

import {
  assertAgentWorkspaceProvenance,
  assertSingleLinkRegularFile,
  assertWorkspaceBaseCommit,
  assertWorkspaceSourceAttestationClosure,
  cleanNativeWorkspaceOutputRoots,
  cleanWorkspaceOutputRootsForRetry,
  persistLegacyWorkspaceSourceClaim,
  persistWorkspaceSourceAttestation,
  readWorkspaceSourceAttestation,
  resolveCheckedOutCommit,
  WORKSPACE_SOURCE_ATTESTATION_FILE,
  writeWorkspaceSourceAttestation,
  type ExpectedWorkspaceSourceTask
} from "../src/workspace-provenance.js";

test("workspace provenance resolves detached HEAD and rejects a different exact base", () => {
  const repository = fs.mkdtempSync(path.join(os.tmpdir(), "ufz-workspace-provenance-"));
  git(repository, ["init"]);
  git(repository, ["config", "user.name", "Ultrafuzz Test"]);
  git(repository, ["config", "user.email", "ultrafuzz-test@example.com"]);

  fs.writeFileSync(path.join(repository, "target.txt"), "first\n", "utf8");
  git(repository, ["add", "target.txt"]);
  git(repository, ["commit", "-m", "first"]);
  const first = git(repository, ["rev-parse", "HEAD"]);

  fs.writeFileSync(path.join(repository, "target.txt"), "second\n", "utf8");
  git(repository, ["commit", "-am", "second"]);
  const second = git(repository, ["rev-parse", "HEAD"]);
  git(repository, ["checkout", "--detach", first]);

  assert.equal(resolveCheckedOutCommit(repository), first);
  assert.deepEqual(assertWorkspaceBaseCommit(repository, first), {
    baseCommit: first,
    initialHead: first
  });
  assert.deepEqual(assertAgentWorkspaceProvenance(repository, first, repository), {
    baseCommit: first,
    initialHead: first,
    agentRootVerified: true,
    trackedClean: true
  });
  assert.throws(() => assertWorkspaceBaseCommit(repository, second), /worktree started at .* expected/u);
  assert.throws(
    () => assertAgentWorkspaceProvenance(repository, first, fs.mkdtempSync(path.join(os.tmpdir(), "ufz-wrong-root-"))),
    /agent root does not match/u
  );
  const allowedArtifacts = path.join(repository, "artifacts", "task-a");
  fs.mkdirSync(allowedArtifacts, { recursive: true });
  fs.writeFileSync(path.join(allowedArtifacts, "runner-owned.json"), "{}\n", "utf8");
  assert.equal(assertAgentWorkspaceProvenance(repository, first, repository, [allowedArtifacts]).trackedClean, true);
  fs.writeFileSync(path.join(repository, "untracked-source.sol"), "contract Unexpected {}\n", "utf8");
  assert.throws(
    () => assertAgentWorkspaceProvenance(repository, first, repository, [allowedArtifacts]),
    /unexpected untracked source/u
  );
  fs.unlinkSync(path.join(repository, "untracked-source.sol"));
  fs.writeFileSync(path.join(repository, "target.txt"), "dirty\n", "utf8");
  assert.throws(
    () => assertAgentWorkspaceProvenance(repository, first, repository),
    /tracked changes before agent execution/u
  );
});

test("workspace provenance permits ignored tool output and exact task-owned roots across retries", () => {
  const repository = fs.mkdtempSync(path.join(os.tmpdir(), "ufz-workspace-native-output-"));
  git(repository, ["init"]);
  git(repository, ["config", "user.name", "Ultrafuzz Test"]);
  git(repository, ["config", "user.email", "ultrafuzz-test@example.com"]);
  fs.writeFileSync(
    path.join(repository, ".gitignore"),
    [
      "node_modules/",
      "cache/",
      "out/",
      ".cache/",
      "dist/",
      "__pycache__/",
      ".venv/",
      "build/",
      ".pytest_cache/",
      ".build/"
    ].join("\n") + "\n",
    "utf8"
  );
  fs.writeFileSync(path.join(repository, "target.sol"), "contract Target {}\n", "utf8");
  git(repository, ["add", ".gitignore", "target.sol"]);
  git(repository, ["commit", "-m", "fixture"]);
  const revision = git(repository, ["rev-parse", "HEAD"]);

  const artifactRoot = path.join(repository, "artifacts", "attempt-one");
  const testRoot = path.join(repository, "test");
  const generatedTestRoot = path.join(testRoot, "foundry", "strategy-one");
  fs.mkdirSync(artifactRoot, { recursive: true });
  fs.mkdirSync(generatedTestRoot, { recursive: true });
  fs.writeFileSync(path.join(artifactRoot, "findings.json"), "[]\n", "utf8");
  fs.writeFileSync(path.join(generatedTestRoot, "Generated.t.sol"), "contract Generated {}\n", "utf8");
  for (const relative of [
    "node_modules/tool/index.js",
    "cache/foundry.json",
    "out/Target.json",
    ".cache/hardhat.json",
    "dist/bundle.js",
    "__pycache__/module.pyc",
    ".venv/installed-package",
    "build/contract.json",
    ".pytest_cache/state",
    ".build/vyper.json",
    "packages/app/node_modules/dependency/index.js",
    "packages/app/dist/bundle.js",
    "tests/unit/__pycache__/module.pyc"
  ]) {
    const output = path.join(repository, relative);
    fs.mkdirSync(path.dirname(output), { recursive: true });
    fs.writeFileSync(output, "runtime output\n", "utf8");
  }

  const allowedRoots = [artifactRoot, generatedTestRoot];
  assert.equal(assertAgentWorkspaceProvenance(repository, revision, repository, allowedRoots).trackedClean, true);
  // Native caches survive a model retry; the next pre-agent check must still
  // reach the agent while task-owned roots remain narrowly scoped.
  fs.rmSync(path.join(generatedTestRoot, "Generated.t.sol"));
  assert.equal(assertAgentWorkspaceProvenance(repository, revision, repository, allowedRoots).trackedClean, true);

  const siblingTest = path.join(repository, "test", "foundry", "strategy-two", "Unexpected.t.sol");
  fs.mkdirSync(path.dirname(siblingTest), { recursive: true });
  fs.writeFileSync(siblingTest, "contract Unexpected {}\n", "utf8");
  assert.throws(
    () => assertAgentWorkspaceProvenance(repository, revision, repository, allowedRoots),
    /unexpected untracked source/u
  );
  fs.rmSync(path.join(repository, "test", "foundry", "strategy-two"), { recursive: true });

  const unexpectedSource = path.join(repository, "contracts", "Unexpected.sol");
  fs.mkdirSync(path.dirname(unexpectedSource), { recursive: true });
  fs.writeFileSync(unexpectedSource, "contract Unexpected {}\n", "utf8");
  assert.throws(
    () => assertAgentWorkspaceProvenance(repository, revision, repository, allowedRoots),
    /unexpected untracked source/u
  );
  fs.rmSync(path.join(repository, "contracts"), { recursive: true });

  const linkedRoot = path.join(repository, "test", "foundry", "linked-strategy");
  fs.symlinkSync(generatedTestRoot, linkedRoot, "dir");
  assert.throws(
    () => assertAgentWorkspaceProvenance(repository, revision, repository, [artifactRoot, linkedRoot]),
    /allowed untracked root is unsafe/u
  );
});

test("retry cleanup removes nested repositories only below the exact task output root", () => {
  const repository = fs.mkdtempSync(path.join(os.tmpdir(), "ufz-workspace-retry-clean-"));
  git(repository, ["init"]);
  git(repository, ["config", "user.name", "Ultrafuzz Test"]);
  git(repository, ["config", "user.email", "ultrafuzz-test@example.com"]);
  fs.writeFileSync(path.join(repository, "target.sol"), "contract Target {}\n", "utf8");
  git(repository, ["add", "target.sol"]);
  git(repository, ["commit", "-m", "fixture"]);

  const generatedTestRoot = path.join(repository, "test", "foundry", "strategy-one");
  const nestedRepository = path.join(generatedTestRoot, "nested-fixture");
  const siblingRoot = path.join(repository, "test", "foundry", "strategy-two");
  fs.mkdirSync(nestedRepository, { recursive: true });
  fs.mkdirSync(siblingRoot, { recursive: true });
  git(nestedRepository, ["init"]);
  git(nestedRepository, ["config", "user.name", "Ultrafuzz Test"]);
  git(nestedRepository, ["config", "user.email", "ultrafuzz-test@example.com"]);
  fs.writeFileSync(path.join(nestedRepository, "Nested.t.sol"), "contract Nested {}\n", "utf8");
  git(nestedRepository, ["add", "Nested.t.sol"]);
  git(nestedRepository, ["commit", "-m", "nested fixture"]);
  const siblingTest = path.join(siblingRoot, "Sibling.t.sol");
  fs.writeFileSync(siblingTest, "contract Sibling {}\n", "utf8");

  cleanWorkspaceOutputRootsForRetry(repository, ["test/foundry/strategy-one"]);

  assert.equal(fs.existsSync(nestedRepository), false);
  assert.equal(fs.readFileSync(siblingTest, "utf8"), "contract Sibling {}\n");
});

test("native output cleanup removes preseeded and prior-retry bytes while preserving tracked files", () => {
  const repository = fs.mkdtempSync(path.join(os.tmpdir(), "ufz-native-clean-"));
  git(repository, ["init"]);
  git(repository, ["config", "user.name", "Ultrafuzz Test"]);
  git(repository, ["config", "user.email", "ultrafuzz-test@example.com"]);
  fs.mkdirSync(path.join(repository, "cache"));
  fs.writeFileSync(path.join(repository, "cache", "tracked.txt"), "tracked\n", "utf8");
  git(repository, ["add", "cache/tracked.txt"]);
  git(repository, ["commit", "-m", "fixture"]);

  const roots = [
    ".build",
    ".cache",
    ".pytest_cache",
    ".venv",
    "__pycache__",
    "build",
    "cache",
    "dist",
    "node_modules",
    "out"
  ];
  for (const root of roots) {
    const output = path.join(repository, root, "preseeded", "state.bin");
    fs.mkdirSync(path.dirname(output), { recursive: true });
    fs.writeFileSync(output, "attacker-controlled prior output\n", "utf8");
  }
  const nestedRoots = ["packages/app/node_modules", "packages/app/dist", "tests/unit/__pycache__"];
  for (const root of nestedRoots) {
    const output = path.join(repository, root, "preseeded", "state.bin");
    fs.mkdirSync(path.dirname(output), { recursive: true });
    fs.writeFileSync(output, "attacker-controlled prior output\n", "utf8");
  }

  cleanNativeWorkspaceOutputRoots(repository);

  assert.equal(fs.readFileSync(path.join(repository, "cache", "tracked.txt"), "utf8"), "tracked\n");
  for (const root of roots) {
    assert.equal(fs.existsSync(path.join(repository, root, "preseeded", "state.bin")), false, root);
  }
  for (const root of nestedRoots) {
    assert.equal(fs.existsSync(path.join(repository, root, "preseeded", "state.bin")), false, root);
  }
});

test("native output cleanup recursively removes stale bytes from materialized gitlinks", () => {
  const fixture = createGitlinkFixture();
  const nestedRepository = path.join(fixture.repository, "vendor", "nested");
  const stale = path.join(nestedRepository, "node_modules", "dependency", "state.bin");
  fs.mkdirSync(path.dirname(stale), { recursive: true });
  fs.writeFileSync(stale, "prior retry state\n", "utf8");

  assert.equal(
    assertAgentWorkspaceProvenance(fixture.repository, fixture.revision, fixture.repository).trackedClean,
    true
  );
  cleanNativeWorkspaceOutputRoots(fixture.repository);

  assert.equal(fs.existsSync(stale), false);
  assert.equal(fs.readFileSync(path.join(nestedRepository, "source.sol"), "utf8"), "contract Nested {}\n");
  assert.equal(
    assertAgentWorkspaceProvenance(fixture.repository, fixture.revision, fixture.repository).trackedClean,
    true
  );
});

test("native output cleanup fails closed on a root link and never traverses a nested link", () => {
  const repository = fs.mkdtempSync(path.join(os.tmpdir(), "ufz-native-clean-links-"));
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "ufz-native-clean-outside-"));
  git(repository, ["init"]);
  git(repository, ["config", "user.name", "Ultrafuzz Test"]);
  git(repository, ["config", "user.email", "ultrafuzz-test@example.com"]);
  fs.writeFileSync(path.join(repository, "target.txt"), "tracked\n", "utf8");
  git(repository, ["add", "target.txt"]);
  git(repository, ["commit", "-m", "fixture"]);
  fs.writeFileSync(path.join(outside, "outside.txt"), "must remain\n", "utf8");

  fs.symlinkSync(outside, path.join(repository, ".cache"), "dir");
  assert.throws(() => cleanNativeWorkspaceOutputRoots(repository), /native tool output root is unsafe/u);
  assert.equal(fs.readFileSync(path.join(outside, "outside.txt"), "utf8"), "must remain\n");

  fs.unlinkSync(path.join(repository, ".cache"));
  fs.mkdirSync(path.join(repository, ".cache"));
  fs.symlinkSync(outside, path.join(repository, ".cache", "nested"), "dir");
  cleanNativeWorkspaceOutputRoots(repository);
  assert.equal(fs.existsSync(path.join(repository, ".cache", "nested")), false);
  assert.equal(fs.readFileSync(path.join(outside, "outside.txt"), "utf8"), "must remain\n");
});

test(
  "native output cleanup and provenance reject non-UTF-8 paths without accepting lossy aliases",
  { skip: process.platform === "win32" },
  () => {
    const repository = fs.mkdtempSync(path.join(os.tmpdir(), "ufz-native-clean-bytes-"));
    git(repository, ["init"]);
    git(repository, ["config", "user.name", "Ultrafuzz Test"]);
    git(repository, ["config", "user.email", "ultrafuzz-test@example.com"]);
    fs.writeFileSync(path.join(repository, "target.sol"), "contract Target {}\n", "utf8");
    git(repository, ["add", "target.sol"]);
    git(repository, ["commit", "-m", "fixture"]);
    const revision = git(repository, ["rev-parse", "HEAD"]);
    const invalidRoot = Buffer.concat([
      Buffer.from(`${repository}${path.sep}nested-`, "utf8"),
      Buffer.from([0xff]),
      Buffer.from(`${path.sep}node_modules${path.sep}pkg`, "utf8")
    ]);
    const poisonedState = Buffer.concat([invalidRoot, Buffer.from(`${path.sep}state.bin`, "utf8")]);
    fs.mkdirSync(invalidRoot, { recursive: true });
    fs.writeFileSync(poisonedState, "prior retry state\n", "utf8");

    assert.throws(() => cleanNativeWorkspaceOutputRoots(repository), /path is not valid UTF-8/u);
    assert.equal(fs.existsSync(poisonedState), true);
    assert.throws(() => assertAgentWorkspaceProvenance(repository, revision, repository), /path is not valid UTF-8/u);
  }
);

test(
  "retry cleanup bounds its Git subprocess with the shared monotonic deadline",
  { skip: process.platform === "win32" },
  () => {
    const repository = fs.mkdtempSync(path.join(os.tmpdir(), "ufz-workspace-retry-deadline-"));
    git(repository, ["init"]);
    git(repository, ["config", "user.name", "Ultrafuzz Test"]);
    git(repository, ["config", "user.email", "ultrafuzz-test@example.com"]);
    fs.writeFileSync(path.join(repository, "target.sol"), "contract Target {}\n", "utf8");
    git(repository, ["add", "target.sol"]);
    git(repository, ["commit", "-m", "fixture"]);
    const outputRoot = path.join(repository, "test", "generated");
    fs.mkdirSync(outputRoot, { recursive: true });
    fs.writeFileSync(path.join(outputRoot, "Generated.t.sol"), "contract Generated {}\n", "utf8");
    const wrapperRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ufz-workspace-clean-wrapper-"));
    const wrapperPath = path.join(wrapperRoot, "git");
    const marker = path.join(wrapperRoot, "clean-started");
    const realGit = execFileSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).trim();
    fs.writeFileSync(
      wrapperPath,
      [
        "#!/bin/sh",
        'case " $* " in',
        `  *" clean "*) : > ${shellQuote(marker)} ;;`,
        "esac",
        `exec ${shellQuote(realGit)} "$@"`,
        ""
      ].join("\n"),
      { encoding: "utf8", mode: 0o755 }
    );
    const originalPath = process.env.PATH;
    const originalNow = process.hrtime.bigint;
    process.env.PATH = `${wrapperRoot}${path.delimiter}${originalPath ?? ""}`;
    process.hrtime.bigint = () => (fs.existsSync(marker) ? 121_000_000_000n : 0n);
    try {
      assert.throws(
        () => cleanWorkspaceOutputRootsForRetry(repository, ["test/generated"]),
        /tracked source verification exceeded the 120000ms elapsed-time limit/u
      );
    } finally {
      process.hrtime.bigint = originalNow;
      if (originalPath === undefined) delete process.env.PATH;
      else process.env.PATH = originalPath;
      fs.rmSync(wrapperRoot, { force: true, recursive: true });
    }
  }
);

test("workspace provenance ignores repository exclusion policy and allows only fixed native output roots", () => {
  const repository = fs.mkdtempSync(path.join(os.tmpdir(), "ufz-workspace-ignore-policy-"));
  git(repository, ["init"]);
  git(repository, ["config", "user.name", "Ultrafuzz Test"]);
  git(repository, ["config", "user.email", "ultrafuzz-test@example.com"]);
  fs.mkdirSync(path.join(repository, "nested"), { recursive: true });
  fs.writeFileSync(path.join(repository, ".gitignore"), "cache/\nlib/\ndocs/\n*.json\n", "utf8");
  fs.writeFileSync(path.join(repository, "nested", ".gitignore"), "generated/\n", "utf8");
  fs.writeFileSync(path.join(repository, "target.sol"), "contract Target {}\n", "utf8");
  git(repository, ["add", ".gitignore", "nested/.gitignore", "target.sol"]);
  git(repository, ["commit", "-m", "fixture"]);
  const revision = git(repository, ["rev-parse", "HEAD"]);

  const nativeCache = path.join(repository, "cache", "foundry.json");
  fs.mkdirSync(path.dirname(nativeCache), { recursive: true });
  fs.writeFileSync(nativeCache, "native tool output\n", "utf8");
  assert.equal(assertAgentWorkspaceProvenance(repository, revision, repository).trackedClean, true);

  for (const relative of ["lib/Evil.sol", "docs/Evil.sol", "nested/generated/compiler.json", "unexpected.json"]) {
    const ignoredSource = path.join(repository, relative);
    fs.mkdirSync(path.dirname(ignoredSource), { recursive: true });
    fs.writeFileSync(ignoredSource, "untrusted ignored addition\n", "utf8");
    assert.throws(
      () => assertAgentWorkspaceProvenance(repository, revision, repository),
      /unexpected untracked source/u,
      relative
    );
    fs.unlinkSync(ignoredSource);
  }

  const infoExclude = path.join(repository, ".git", "info", "exclude");
  fs.writeFileSync(infoExclude, "hidden-by-info.sol\n", "utf8");
  fs.writeFileSync(path.join(repository, "hidden-by-info.sol"), "contract HiddenByInfo {}\n", "utf8");
  assert.throws(() => assertAgentWorkspaceProvenance(repository, revision, repository), /unexpected untracked source/u);
  fs.unlinkSync(path.join(repository, "hidden-by-info.sol"));

  const configuredExclude = path.join(repository, ".git", "configured-excludes");
  fs.writeFileSync(configuredExclude, "hidden-by-config.sol\n", "utf8");
  git(repository, ["config", "core.excludesFile", configuredExclude]);
  fs.writeFileSync(path.join(repository, "hidden-by-config.sol"), "contract HiddenByConfig {}\n", "utf8");
  assert.throws(() => assertAgentWorkspaceProvenance(repository, revision, repository), /unexpected untracked source/u);
  fs.unlinkSync(path.join(repository, "hidden-by-config.sol"));

  const rogueDirectory = path.join(repository, "rogue");
  fs.mkdirSync(rogueDirectory);
  fs.writeFileSync(path.join(rogueDirectory, ".gitignore"), "*\n", "utf8");
  fs.writeFileSync(path.join(rogueDirectory, "Hidden.sol"), "contract HiddenByUntrackedIgnore {}\n", "utf8");
  assert.throws(
    () => assertAgentWorkspaceProvenance(repository, revision, repository),
    /untracked \.gitignore outside its outputs/u
  );
});

test("workspace provenance rejects index flags that can mask tracked mutations", () => {
  const repository = fs.mkdtempSync(path.join(os.tmpdir(), "ufz-workspace-index-flags-"));
  git(repository, ["init"]);
  git(repository, ["config", "user.name", "Ultrafuzz Test"]);
  git(repository, ["config", "user.email", "ultrafuzz-test@example.com"]);
  fs.writeFileSync(path.join(repository, "target.sol"), "contract Target {}\n", "utf8");
  git(repository, ["add", "target.sol"]);
  git(repository, ["commit", "-m", "fixture"]);
  const revision = git(repository, ["rev-parse", "HEAD"]);

  git(repository, ["update-index", "--assume-unchanged", "target.sol"]);
  fs.writeFileSync(path.join(repository, "target.sol"), "contract AssumeHidden {}\n", "utf8");
  assert.throws(
    () => assertAgentWorkspaceProvenance(repository, revision, repository),
    /assume-unchanged or skip-worktree index flags/u
  );

  git(repository, ["update-index", "--no-assume-unchanged", "target.sol"]);
  git(repository, ["checkout", "--", "target.sol"]);
  git(repository, ["update-index", "--skip-worktree", "target.sol"]);
  fs.writeFileSync(path.join(repository, "target.sol"), "contract SkipHidden {}\n", "utf8");
  assert.throws(
    () => assertAgentWorkspaceProvenance(repository, revision, repository),
    /assume-unchanged or skip-worktree index flags/u
  );
});

test("workspace provenance ignores replace refs that redefine the expected HEAD tree", () => {
  const repository = fs.mkdtempSync(path.join(os.tmpdir(), "ufz-workspace-replace-ref-"));
  git(repository, ["init"]);
  git(repository, ["config", "user.name", "Ultrafuzz Test"]);
  git(repository, ["config", "user.email", "ultrafuzz-test@example.com"]);
  fs.writeFileSync(path.join(repository, "target.sol"), "contract Expected {}\n", "utf8");
  git(repository, ["add", "target.sol"]);
  git(repository, ["commit", "-m", "expected"]);
  const expectedRevision = git(repository, ["rev-parse", "HEAD"]);

  fs.writeFileSync(path.join(repository, "target.sol"), "contract Replacement {}\n", "utf8");
  git(repository, ["commit", "-am", "replacement"]);
  const replacementRevision = git(repository, ["rev-parse", "HEAD"]);
  git(repository, ["checkout", "--detach", expectedRevision]);
  git(repository, ["replace", expectedRevision, replacementRevision]);
  git(repository, ["read-tree", replacementRevision]);
  git(repository, ["checkout-index", "--all", "--force"]);

  // The default object view resolves the expected commit through the malicious
  // replacement, while provenance checks must compare against its real tree.
  assert.equal(
    execFileSync("git", ["show", "HEAD:target.sol"], {
      cwd: repository,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"]
    }),
    "contract Replacement {}\n"
  );
  assert.equal(resolveCheckedOutCommit(repository), expectedRevision);
  assert.throws(
    () => assertAgentWorkspaceProvenance(repository, expectedRevision, repository),
    /tracked changes before agent execution/u
  );
});

test(
  "workspace provenance cannot lazy-fetch missing objects through an external protocol",
  { skip: process.platform === "win32" },
  () => {
    const parent = fs.mkdtempSync(path.join(os.tmpdir(), "ufz-workspace-promisor-"));
    const repository = path.join(parent, "repository");
    const marker = path.join(parent, "external-helper-ran");
    fs.mkdirSync(repository);
    git(repository, ["init"]);
    git(repository, ["config", "user.name", "Ultrafuzz Test"]);
    git(repository, ["config", "user.email", "ultrafuzz-test@example.com"]);
    fs.writeFileSync(path.join(repository, "target.sol"), "contract Target {}\n", "utf8");
    git(repository, ["add", "target.sol"]);
    git(repository, ["commit", "-m", "fixture"]);
    const revision = git(repository, ["rev-parse", "HEAD"]);
    const tree = git(repository, ["rev-parse", "HEAD^{tree}"]);

    git(repository, ["config", "core.repositoryformatversion", "1"]);
    git(repository, ["config", "extensions.partialClone", "origin"]);
    git(repository, ["config", "remote.origin.promisor", "true"]);
    git(repository, ["config", "remote.origin.partialclonefilter", "blob:none"]);
    git(repository, ["config", "remote.origin.url", `ext::touch ${marker}`]);
    git(repository, ["config", "protocol.ext.allow", "always"]);
    fs.unlinkSync(path.join(repository, ".git", "objects", tree.slice(0, 2), tree.slice(2)));

    assert.throws(() =>
      execFileSync("git", ["ls-tree", "HEAD"], {
        cwd: repository,
        stdio: "ignore"
      })
    );
    assert.equal(fs.existsSync(marker), true, "fixture must invoke its configured lazy-fetch command");
    fs.unlinkSync(marker);

    assert.throws(
      () => assertAgentWorkspaceProvenance(repository, revision, repository),
      /tracked changes before agent execution/u
    );
    assert.equal(fs.existsSync(marker), false);
  }
);

test(
  "workspace provenance pins its tree and index checks to the expected commit",
  { skip: process.platform === "win32" },
  () => {
    const repository = fs.mkdtempSync(path.join(os.tmpdir(), "ufz-workspace-commit-switch-"));
    git(repository, ["init"]);
    git(repository, ["config", "user.name", "Ultrafuzz Test"]);
    git(repository, ["config", "user.email", "ultrafuzz-test@example.com"]);
    fs.writeFileSync(path.join(repository, "target.sol"), "contract Target {}\n", "utf8");
    git(repository, ["add", "target.sol"]);
    git(repository, ["commit", "-m", "expected"]);
    const expectedRevision = git(repository, ["rev-parse", "HEAD"]);
    fs.writeFileSync(path.join(repository, "evil.sol"), "contract Evil {}\n", "utf8");
    git(repository, ["add", "evil.sol"]);
    git(repository, ["commit", "-m", "malicious"]);
    const maliciousRevision = git(repository, ["rev-parse", "HEAD"]);
    git(repository, ["checkout", "--detach", expectedRevision]);

    withGitMutationAfterCommand(repository, "ls-files -v -z", maliciousRevision, "reset", (marker) => {
      assert.throws(
        () => assertAgentWorkspaceProvenance(repository, expectedRevision, repository),
        /tracked changes before agent execution/u
      );
      assert.equal(fs.existsSync(marker), true);
    });
  }
);

test("workspace provenance verifies HEAD again after the complete scan", { skip: process.platform === "win32" }, () => {
  const repository = fs.mkdtempSync(path.join(os.tmpdir(), "ufz-workspace-final-head-"));
  git(repository, ["init"]);
  git(repository, ["config", "user.name", "Ultrafuzz Test"]);
  git(repository, ["config", "user.email", "ultrafuzz-test@example.com"]);
  fs.writeFileSync(path.join(repository, "target.sol"), "contract Target {}\n", "utf8");
  git(repository, ["add", "target.sol"]);
  git(repository, ["commit", "-m", "expected"]);
  const expectedRevision = git(repository, ["rev-parse", "HEAD"]);
  git(repository, ["commit", "--allow-empty", "-m", "same tree, different commit"]);
  const secondRevision = git(repository, ["rev-parse", "HEAD"]);
  git(repository, ["checkout", "--detach", expectedRevision]);

  withGitMutationAfterCommand(repository, "ls-files --others --full-name -z", secondRevision, "reset", (marker) => {
    assert.throws(
      () => assertAgentWorkspaceProvenance(repository, expectedRevision, repository),
      /tracked changes before agent execution/u
    );
    assert.equal(fs.existsSync(marker), true);
  });
});

test(
  "workspace provenance enumerates untracked files against the expected tree instead of the mutable index",
  { skip: process.platform === "win32" },
  () => {
    const repository = fs.mkdtempSync(path.join(os.tmpdir(), "ufz-workspace-private-index-"));
    git(repository, ["init"]);
    git(repository, ["config", "user.name", "Ultrafuzz Test"]);
    git(repository, ["config", "user.email", "ultrafuzz-test@example.com"]);
    fs.writeFileSync(path.join(repository, "target.sol"), "contract Target {}\n", "utf8");
    git(repository, ["add", "target.sol"]);
    git(repository, ["commit", "-m", "expected"]);
    const expectedRevision = git(repository, ["rev-parse", "HEAD"]);
    fs.writeFileSync(path.join(repository, "evil.sol"), "contract Evil {}\n", "utf8");
    git(repository, ["add", "evil.sol"]);
    git(repository, ["commit", "-m", "malicious index"]);
    const maliciousRevision = git(repository, ["rev-parse", "HEAD"]);
    git(repository, ["checkout", "--detach", expectedRevision]);
    fs.writeFileSync(path.join(repository, "evil.sol"), "contract Evil {}\n", "utf8");

    withGitMutationAfterCommand(
      repository,
      "ls-tree -r -z --full-name --full-tree --abbrev=40",
      maliciousRevision,
      "index",
      (marker) => {
        assert.throws(
          () => assertAgentWorkspaceProvenance(repository, expectedRevision, repository),
          /unexpected untracked source/u
        );
        assert.equal(fs.existsSync(marker), true);
      }
    );
  }
);

test("workspace provenance anchors Git checks to the actual task worktree", () => {
  const repository = fs.mkdtempSync(path.join(os.tmpdir(), "ufz-workspace-core-worktree-"));
  const linkedParent = fs.mkdtempSync(path.join(os.tmpdir(), "ufz-workspace-linked-parent-"));
  const linkedWorktree = path.join(linkedParent, "task-worktree");
  const cleanSibling = fs.mkdtempSync(path.join(os.tmpdir(), "ufz-workspace-clean-sibling-"));
  git(repository, ["init"]);
  git(repository, ["config", "user.name", "Ultrafuzz Test"]);
  git(repository, ["config", "user.email", "ultrafuzz-test@example.com"]);
  fs.writeFileSync(path.join(repository, "target.sol"), "contract Expected {}\n", "utf8");
  git(repository, ["add", "target.sol"]);
  git(repository, ["commit", "-m", "expected"]);
  const expectedRevision = git(repository, ["rev-parse", "HEAD"]);
  git(repository, ["config", "extensions.worktreeConfig", "true"]);
  git(repository, ["worktree", "add", "--detach", linkedWorktree, expectedRevision]);
  fs.copyFileSync(path.join(linkedWorktree, "target.sol"), path.join(cleanSibling, "target.sol"));

  git(linkedWorktree, ["config", "--worktree", "core.worktree", cleanSibling]);
  git(linkedWorktree, ["update-index", "--refresh"]);
  fs.writeFileSync(path.join(linkedWorktree, "target.sol"), "contract RedirectedCheck {}\n", "utf8");

  // An unanchored Git command honors core.worktree and checks the clean sibling.
  assert.doesNotThrow(() =>
    execFileSync("git", ["diff-index", "--quiet", "HEAD", "--"], {
      cwd: linkedWorktree,
      stdio: "ignore"
    })
  );
  assert.throws(
    () => assertAgentWorkspaceProvenance(linkedWorktree, expectedRevision, linkedWorktree),
    /tracked changes before agent execution/u
  );
});

test("workspace provenance hashes tracked content instead of trusting mutable stat policy", () => {
  const repository = fs.mkdtempSync(path.join(os.tmpdir(), "ufz-workspace-stat-cache-"));
  git(repository, ["init"]);
  git(repository, ["config", "user.name", "Ultrafuzz Test"]);
  git(repository, ["config", "user.email", "ultrafuzz-test@example.com"]);
  const targetPath = path.join(repository, "target.sol");
  const original = "contract Target {}\n";
  const replacement = "contract Mutant {}\n";
  assert.equal(Buffer.byteLength(original), Buffer.byteLength(replacement));
  fs.writeFileSync(targetPath, original, "utf8");
  const trustedMtime = new Date("2020-01-01T00:00:00.000Z");
  fs.utimesSync(targetPath, trustedMtime, trustedMtime);
  git(repository, ["add", "target.sol"]);
  git(repository, ["commit", "-m", "fixture"]);
  const revision = git(repository, ["rev-parse", "HEAD"]);
  const originalStat = fs.statSync(targetPath);

  git(repository, ["config", "core.trustctime", "false"]);
  git(repository, ["config", "core.checkStat", "minimal"]);
  fs.writeFileSync(targetPath, replacement, "utf8");
  fs.utimesSync(targetPath, originalStat.atime, originalStat.mtime);

  // The attacker-controlled stat policy trusts the restored whole-second mtime
  // and equal size, demonstrating why provenance must hash the actual bytes.
  assert.doesNotThrow(() =>
    execFileSync("git", ["diff-index", "--quiet", "HEAD", "--"], {
      cwd: repository,
      stdio: "ignore"
    })
  );
  assert.throws(
    () => assertAgentWorkspaceProvenance(repository, revision, repository),
    /tracked changes before agent execution/u
  );
});

test(
  "workspace provenance revalidates an earlier tracked file after hashing the complete tree",
  { skip: process.platform !== "linux" || !fs.existsSync("/proc/self/fd") },
  () => {
    const repository = fs.mkdtempSync(path.join(os.tmpdir(), "ufz-workspace-whole-tree-race-"));
    git(repository, ["init"]);
    git(repository, ["config", "user.name", "Ultrafuzz Test"]);
    git(repository, ["config", "user.email", "ultrafuzz-test@example.com"]);
    const firstPath = path.join(repository, "aaa.txt");
    const laterPath = path.join(repository, "zzz.bin");
    const marker = path.join(repository, ".git", "whole-tree-mutation-complete");
    const trusted = "trusted\n";
    const mutated = "mutant!\n";
    assert.equal(Buffer.byteLength(trusted), Buffer.byteLength(mutated));
    fs.writeFileSync(firstPath, trusted, "utf8");
    const laterDescriptor = fs.openSync(laterPath, "w");
    try {
      fs.ftruncateSync(laterDescriptor, 64 * 1024 * 1024);
    } finally {
      fs.closeSync(laterDescriptor);
    }
    git(repository, ["add", "aaa.txt", "zzz.bin"]);
    git(repository, ["commit", "-m", "fixture"]);
    const revision = git(repository, ["rev-parse", "HEAD"]);

    const mutator = spawn(
      process.execPath,
      [
        "-e",
        [
          'const fs = require("node:fs");',
          "const fdRoot = `/proc/${process.env.UFZ_PARENT_PID}/fd`;",
          "const deadline = Date.now() + 10_000;",
          "while (Date.now() < deadline) {",
          "  let open = false;",
          "  try {",
          "    open = fs.readdirSync(fdRoot).some((fd) => {",
          "      try { return fs.readlinkSync(`${fdRoot}/${fd}`) === process.env.UFZ_LATER_PATH; }",
          "      catch { return false; }",
          "    });",
          "  } catch {}",
          "  if (open) {",
          '    fs.writeFileSync(process.env.UFZ_FIRST_PATH, "mutant!\\n");',
          '    fs.writeFileSync(process.env.UFZ_MARKER, "done\\n");',
          "    process.exit(0);",
          "  }",
          "  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1);",
          "}",
          "process.exit(2);"
        ].join("\n")
      ],
      {
        env: {
          ...process.env,
          UFZ_FIRST_PATH: firstPath,
          UFZ_LATER_PATH: laterPath,
          UFZ_MARKER: marker,
          UFZ_PARENT_PID: String(process.pid)
        },
        stdio: "ignore"
      }
    );
    try {
      assert.throws(
        () => assertAgentWorkspaceProvenance(repository, revision, repository),
        /tracked changes before agent execution/u
      );
      assert.equal(fs.existsSync(marker), true);
      assert.equal(fs.readFileSync(firstPath, "utf8"), mutated);
    } finally {
      mutator.kill();
    }
  }
);

test("workspace provenance shares its tracked-entry budget across nested gitlinks", () => {
  const fixture = createGitlinkFixture();

  assert.equal(
    assertAgentWorkspaceProvenance(fixture.repository, fixture.revision, fixture.repository).trackedClean,
    true
  );
  assert.throws(
    () =>
      assertAgentWorkspaceProvenance(fixture.repository, fixture.revision, fixture.repository, [], {
        maxTrackedEntries: 1
      }),
    /tracked source verification exceeded the 1-entry limit/u
  );
  assert.throws(
    () =>
      assertAgentWorkspaceProvenance(fixture.repository, fixture.revision, fixture.repository, [], {
        maxTrackedEntries: 100_001
      }),
    /tracked entries limit must be an integer from 0 through 100000/u
  );
});

test("workspace provenance accepts an empty worktree gitlink and verifies it after materialization", () => {
  const child = fs.mkdtempSync(path.join(os.tmpdir(), "ufz-worktree-submodule-child-"));
  git(child, ["init"]);
  git(child, ["config", "user.name", "Ultrafuzz Test"]);
  git(child, ["config", "user.email", "ultrafuzz-test@example.com"]);
  fs.writeFileSync(path.join(child, "source.sol"), "contract Child {}\n", "utf8");
  git(child, ["add", "source.sol"]);
  git(child, ["commit", "-m", "child fixture"]);

  const parent = fs.mkdtempSync(path.join(os.tmpdir(), "ufz-worktree-submodule-parent-"));
  git(parent, ["init"]);
  git(parent, ["config", "user.name", "Ultrafuzz Test"]);
  git(parent, ["config", "user.email", "ultrafuzz-test@example.com"]);
  git(parent, ["-c", "protocol.file.allow=always", "submodule", "add", child, "lib/child"]);
  git(parent, ["commit", "-am", "parent fixture"]);
  const revision = git(parent, ["rev-parse", "HEAD"]);
  const checkoutParent = fs.mkdtempSync(path.join(os.tmpdir(), "ufz-worktree-submodule-checkout-"));
  const checkout = path.join(checkoutParent, "worktree");
  git(parent, ["worktree", "add", "--detach", checkout, revision]);
  const gitlink = path.join(checkout, "lib", "child");

  assert.deepEqual(fs.readdirSync(gitlink), []);
  assert.equal(assertAgentWorkspaceProvenance(checkout, revision, checkout).trackedClean, true);

  fs.writeFileSync(path.join(gitlink, "untrusted.sol"), "contract Untrusted {}\n", "utf8");
  assert.throws(() => cleanNativeWorkspaceOutputRoots(checkout), /populated tracked gitlink is not a repository/u);
  assert.equal(fs.existsSync(path.join(gitlink, "untrusted.sol")), true);
  assert.throws(
    () => assertAgentWorkspaceProvenance(checkout, revision, checkout),
    /tracked changes before agent execution/u
  );
  fs.unlinkSync(path.join(gitlink, "untrusted.sol"));

  git(checkout, ["-c", "protocol.file.allow=always", "submodule", "update", "--init", "--recursive"]);
  assert.equal(assertAgentWorkspaceProvenance(checkout, revision, checkout).trackedClean, true);
  fs.writeFileSync(path.join(gitlink, "source.sol"), "contract MutatedChild {}\n", "utf8");
  assert.throws(
    () => assertAgentWorkspaceProvenance(checkout, revision, checkout),
    /tracked changes before agent execution/u
  );
});

test(
  "workspace provenance rejects a non-UTF-8 tracked path before it can alias a valid gitlink",
  { skip: process.platform === "win32" },
  () => {
    const child = fs.mkdtempSync(path.join(os.tmpdir(), "ufz-gitlink-bytes-child-"));
    git(child, ["init"]);
    git(child, ["config", "user.name", "Ultrafuzz Test"]);
    git(child, ["config", "user.email", "ultrafuzz-test@example.com"]);
    fs.writeFileSync(path.join(child, "source.sol"), "contract Child {}\n", "utf8");
    git(child, ["add", "source.sol"]);
    git(child, ["commit", "-m", "child fixture"]);
    const childRevision = git(child, ["rev-parse", "HEAD"]);

    const repository = fs.mkdtempSync(path.join(os.tmpdir(), "ufz-gitlink-bytes-parent-"));
    git(repository, ["init"]);
    git(repository, ["config", "user.name", "Ultrafuzz Test"]);
    git(repository, ["config", "user.email", "ultrafuzz-test@example.com"]);
    const validRelative = "lib-\uFFFD";
    const invalidRelative = Buffer.concat([Buffer.from("lib-", "utf8"), Buffer.from([0xff])]);
    const indexRecords = Buffer.concat([
      Buffer.from(`160000 commit ${childRevision}\t${validRelative}\0`, "utf8"),
      Buffer.from(`160000 commit ${childRevision}\t`, "utf8"),
      invalidRelative,
      Buffer.from([0])
    ]);
    execFileSync("git", ["update-index", "-z", "--index-info"], {
      cwd: repository,
      input: indexRecords,
      stdio: ["pipe", "pipe", "pipe"]
    });
    git(repository, ["commit", "-m", "gitlink byte aliases"]);
    const revision = git(repository, ["rev-parse", "HEAD"]);
    fs.mkdirSync(path.join(repository, validRelative));
    const invalidRoot = Buffer.concat([Buffer.from(`${repository}${path.sep}`, "utf8"), invalidRelative]);
    fs.mkdirSync(invalidRoot);
    fs.writeFileSync(
      Buffer.concat([invalidRoot, Buffer.from(`${path.sep}source.sol`, "utf8")]),
      "contract MutatedChild {}\n",
      "utf8"
    );

    assert.throws(
      () => assertAgentWorkspaceProvenance(repository, revision, repository),
      /checked-out source tree path is not valid UTF-8/u
    );
  }
);

test("workspace provenance shares its Git tree-listing byte budget across nested gitlinks", () => {
  const fixture = createGitlinkFixture();
  const listingArguments = ["ls-tree", "-r", "-z", "--full-name", "--full-tree", "--abbrev=40"];
  const parentListingBytes = execFileSync("git", [...listingArguments, fixture.revision], {
    cwd: fixture.repository
  }).byteLength;
  const nestedRepository = path.join(fixture.repository, "vendor", "nested");
  const nestedRevision = git(nestedRepository, ["rev-parse", "HEAD"]);
  const nestedListingBytes = execFileSync("git", [...listingArguments, nestedRevision], {
    cwd: nestedRepository
  }).byteLength;

  assert.ok(parentListingBytes > 0);
  assert.ok(nestedListingBytes > 0);
  assert.throws(
    () =>
      assertAgentWorkspaceProvenance(fixture.repository, fixture.revision, fixture.repository, [], {
        maxGitListingBytes: parentListingBytes
      }),
    new RegExp(`exceeded the ${String(parentListingBytes)}-byte recursive Git listing limit`, "u")
  );
  assert.equal(
    assertAgentWorkspaceProvenance(fixture.repository, fixture.revision, fixture.repository, [], {
      maxGitListingBytes: parentListingBytes + nestedListingBytes
    }).trackedClean,
    true
  );
  assert.throws(
    () =>
      assertAgentWorkspaceProvenance(fixture.repository, fixture.revision, fixture.repository, [], {
        maxGitListingBytes: 16 * 1024 * 1024 + 1
      }),
    /Git listing bytes limit must be an integer from 0 through 16777216/u
  );
});

test("workspace provenance accounts cumulative tracked bytes across nested gitlinks before reading", () => {
  const fixture = createGitlinkFixture();

  assert.throws(
    () =>
      assertAgentWorkspaceProvenance(fixture.repository, fixture.revision, fixture.repository, [], {
        maxTrackedBytes: 0
      }),
    /tracked source verification exceeded the 0-byte limit/u
  );
});

test("workspace provenance bounds the total recursive gitlink count", () => {
  const fixture = createGitlinkFixture();

  assert.throws(
    () =>
      assertAgentWorkspaceProvenance(fixture.repository, fixture.revision, fixture.repository, [], {
        maxGitlinks: 0
      }),
    /tracked source verification exceeded the 0-gitlink limit/u
  );
});

test("workspace provenance bounds recursive gitlink depth independently of count", () => {
  const fixture = createGitlinkFixture();

  assert.throws(
    () =>
      assertAgentWorkspaceProvenance(fixture.repository, fixture.revision, fixture.repository, [], {
        maxGitlinkDepth: 0
      }),
    /tracked source verification exceeded the 0-level gitlink depth limit/u
  );
});

test(
  "workspace provenance rejects a tracked directory symlink that contains mutable gitlink source",
  { skip: process.platform === "win32" },
  () => {
    const fixture = createGitlinkFixture();
    fs.symlinkSync("vendor", path.join(fixture.repository, "vendor-alias"));
    git(fixture.repository, ["add", "vendor-alias"]);
    git(fixture.repository, ["commit", "-m", "tracked gitlink ancestor alias"]);
    const revision = git(fixture.repository, ["rev-parse", "HEAD"]);
    const nestedOutput = path.join(fixture.repository, "vendor", "nested", "out");
    fs.mkdirSync(nestedOutput);
    fs.writeFileSync(path.join(nestedOutput, "generated.txt"), "mutable nested output\n", "utf8");

    assert.throws(
      () => assertAgentWorkspaceProvenance(fixture.repository, revision, fixture.repository),
      /tracked symlink target exposes mutable gitlink source/u
    );
  }
);

test(
  "workspace provenance charges derived symlink-directory paths to its recursive entry budget",
  { skip: process.platform === "win32" },
  () => {
    const repository = fs.mkdtempSync(path.join(os.tmpdir(), "ufz-workspace-derived-path-budget-"));
    git(repository, ["init"]);
    git(repository, ["config", "user.name", "Ultrafuzz Test"]);
    git(repository, ["config", "user.email", "ultrafuzz-test@example.com"]);
    fs.mkdirSync(path.join(repository, "pinned"));
    fs.writeFileSync(path.join(repository, "pinned", "target.sol"), "contract Target {}\n", "utf8");
    fs.symlinkSync("pinned", path.join(repository, "pinned-alias"));
    git(repository, ["add", "pinned", "pinned-alias"]);
    git(repository, ["commit", "-m", "tracked directory alias"]);
    const revision = git(repository, ["rev-parse", "HEAD"]);

    assert.throws(
      () =>
        assertAgentWorkspaceProvenance(repository, revision, repository, [], {
          maxTrackedEntries: 2
        }),
      /tracked source verification exceeded the 2-entry limit/u
    );
  }
);

test(
  "workspace provenance checks its elapsed-time budget for every tracked-file chunk",
  { skip: process.platform !== "linux" || !fs.existsSync("/proc/self/fd") },
  () => {
    const repository = fs.mkdtempSync(path.join(os.tmpdir(), "ufz-workspace-hash-deadline-"));
    git(repository, ["init"]);
    git(repository, ["config", "user.name", "Ultrafuzz Test"]);
    git(repository, ["config", "user.email", "ultrafuzz-test@example.com"]);
    const targetPath = path.join(repository, "target.sol");
    fs.writeFileSync(targetPath, "contract Target {}\n", "utf8");
    git(repository, ["add", "target.sol"]);
    git(repository, ["commit", "-m", "fixture"]);
    const revision = git(repository, ["rev-parse", "HEAD"]);
    const originalNow = process.hrtime.bigint;

    // All Git checks observe time zero. Once the verifier opens the tracked
    // file, the next per-chunk checkpoint crosses the deterministic deadline.
    process.hrtime.bigint = () => (processHasOpenFile(targetPath) ? 2_000_000_000n : 0n);
    try {
      assert.throws(
        () =>
          assertAgentWorkspaceProvenance(repository, revision, repository, [], {
            maxElapsedMilliseconds: 1_000
          }),
        /tracked source verification exceeded the 1000ms elapsed-time limit/u
      );
    } finally {
      process.hrtime.bigint = originalNow;
    }
  }
);

test(
  "workspace provenance shares its elapsed-time budget with the initial commit check",
  { skip: process.platform === "win32" },
  () => {
    const repository = fs.mkdtempSync(path.join(os.tmpdir(), "ufz-workspace-head-deadline-"));
    git(repository, ["init"]);
    git(repository, ["config", "user.name", "Ultrafuzz Test"]);
    git(repository, ["config", "user.email", "ultrafuzz-test@example.com"]);
    fs.writeFileSync(path.join(repository, "target.sol"), "contract Target {}\n", "utf8");
    git(repository, ["add", "target.sol"]);
    git(repository, ["commit", "-m", "fixture"]);
    const revision = git(repository, ["rev-parse", "HEAD"]);
    const wrapperRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ufz-workspace-head-wrapper-"));
    const wrapperPath = path.join(wrapperRoot, "git");
    const marker = path.join(wrapperRoot, "initial-head-checked");
    const realGit = execFileSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).trim();
    fs.writeFileSync(
      wrapperPath,
      [
        "#!/bin/sh",
        'case " $* " in',
        `  *" rev-parse "*) : > ${shellQuote(marker)} ;;`,
        "esac",
        `exec ${shellQuote(realGit)} "$@"`,
        ""
      ].join("\n"),
      { encoding: "utf8", mode: 0o755 }
    );
    const originalPath = process.env.PATH;
    const originalNow = process.hrtime.bigint;
    process.env.PATH = `${wrapperRoot}${path.delimiter}${originalPath ?? ""}`;
    process.hrtime.bigint = () => (fs.existsSync(marker) ? 2_000_000_000n : 0n);
    try {
      assert.throws(
        () => resolveCheckedOutCommit(repository, { maxElapsedMilliseconds: 1_000 }),
        /tracked source verification exceeded the 1000ms elapsed-time limit/u
      );
      assert.equal(fs.existsSync(marker), true);
      fs.unlinkSync(marker);
      assert.throws(
        () =>
          assertAgentWorkspaceProvenance(repository, revision, repository, [], {
            maxElapsedMilliseconds: 1_000
          }),
        /tracked source verification exceeded the 1000ms elapsed-time limit/u
      );
      assert.equal(fs.existsSync(marker), true);
    } finally {
      process.hrtime.bigint = originalNow;
      if (originalPath === undefined) delete process.env.PATH;
      else process.env.PATH = originalPath;
      fs.rmSync(wrapperRoot, { force: true, recursive: true });
    }
  }
);

test(
  "workspace provenance never executes repository-controlled Git hooks",
  { skip: process.platform === "win32" },
  () => {
    const parent = fs.mkdtempSync(path.join(os.tmpdir(), "ufz-workspace-git-hook-"));
    const repository = path.join(parent, "repository");
    const hooksRoot = path.join(parent, "attacker-hooks");
    const marker = path.join(parent, "hook-executed");
    const privateIndex = path.join(parent, "fixture-index");
    fs.mkdirSync(repository);
    fs.mkdirSync(hooksRoot);
    git(repository, ["init"]);
    git(repository, ["config", "user.name", "Ultrafuzz Test"]);
    git(repository, ["config", "user.email", "ultrafuzz-test@example.com"]);
    fs.writeFileSync(path.join(repository, "target.sol"), "contract Target {}\n", "utf8");
    git(repository, ["add", "target.sol"]);
    git(repository, ["commit", "-m", "fixture"]);
    const revision = git(repository, ["rev-parse", "HEAD"]);
    fs.writeFileSync(path.join(hooksRoot, "post-index-change"), `#!/bin/sh\n: > ${shellQuote(marker)}\n`, {
      encoding: "utf8",
      mode: 0o755
    });
    git(repository, ["config", "core.hooksPath", hooksRoot]);

    execFileSync("git", ["read-tree", "--reset", revision], {
      cwd: repository,
      env: { ...process.env, GIT_INDEX_FILE: privateIndex },
      stdio: "ignore"
    });
    assert.equal(fs.existsSync(marker), true);
    fs.unlinkSync(marker);

    assert.equal(assertAgentWorkspaceProvenance(repository, revision, repository).trackedClean, true);
    assert.equal(fs.existsSync(marker), false);
  }
);

test(
  "workspace provenance rejects hard-linked tracked files even when Git is clean",
  { skip: process.platform === "win32" },
  () => {
    const parent = fs.mkdtempSync(path.join(os.tmpdir(), "ufz-workspace-tracked-hardlink-"));
    const repository = path.join(parent, "repository");
    fs.mkdirSync(repository);
    git(repository, ["init"]);
    git(repository, ["config", "user.name", "Ultrafuzz Test"]);
    git(repository, ["config", "user.email", "ultrafuzz-test@example.com"]);
    const targetPath = path.join(repository, "target.sol");
    fs.writeFileSync(targetPath, "contract Target {}\n", "utf8");
    git(repository, ["add", "target.sol"]);
    git(repository, ["commit", "-m", "fixture"]);
    const revision = git(repository, ["rev-parse", "HEAD"]);

    const outsidePath = path.join(parent, "outside.sol");
    fs.linkSync(targetPath, outsidePath);
    assert.equal(fs.lstatSync(targetPath).nlink, 2);
    assert.doesNotThrow(() =>
      execFileSync("git", ["diff-index", "--quiet", "HEAD", "--"], {
        cwd: repository,
        stdio: "ignore"
      })
    );
    assert.throws(
      () => assertAgentWorkspaceProvenance(repository, revision, repository),
      /tracked changes before agent execution/u
    );
  }
);

test(
  "workspace provenance rejects a tracked regular file replaced by an outside symlink",
  { skip: process.platform === "win32" },
  () => {
    const parent = fs.mkdtempSync(path.join(os.tmpdir(), "ufz-workspace-tracked-symlink-"));
    const repository = path.join(parent, "repository");
    fs.mkdirSync(repository);
    git(repository, ["init"]);
    git(repository, ["config", "user.name", "Ultrafuzz Test"]);
    git(repository, ["config", "user.email", "ultrafuzz-test@example.com"]);
    const contents = "contract Target {}\n";
    const targetPath = path.join(repository, "target.sol");
    fs.writeFileSync(targetPath, contents, "utf8");
    git(repository, ["add", "target.sol"]);
    git(repository, ["commit", "-m", "fixture"]);
    const revision = git(repository, ["rev-parse", "HEAD"]);

    const outsidePath = path.join(parent, "outside.sol");
    fs.writeFileSync(outsidePath, contents, "utf8");
    fs.unlinkSync(targetPath);
    fs.symlinkSync(outsidePath, targetPath);
    assert.equal(fs.readFileSync(targetPath, "utf8"), contents);
    assert.throws(
      () => assertAgentWorkspaceProvenance(repository, revision, repository),
      /tracked changes before agent execution/u
    );
  }
);

test(
  "workspace provenance accepts a committed symlink to pinned in-worktree source",
  { skip: process.platform === "win32" },
  () => {
    const repository = fs.mkdtempSync(path.join(os.tmpdir(), "ufz-workspace-safe-source-link-"));
    git(repository, ["init"]);
    git(repository, ["config", "user.name", "Ultrafuzz Test"]);
    git(repository, ["config", "user.email", "ultrafuzz-test@example.com"]);
    fs.writeFileSync(path.join(repository, "target.sol"), "contract Target {}\n", "utf8");
    fs.symlinkSync("target.sol", path.join(repository, "target-link.sol"));
    git(repository, ["add", "target.sol", "target-link.sol"]);
    git(repository, ["commit", "-m", "fixture"]);
    const revision = git(repository, ["rev-parse", "HEAD"]);

    assert.equal(assertAgentWorkspaceProvenance(repository, revision, repository).trackedClean, true);
  }
);

test(
  "workspace provenance rejects committed symlinks to outside, dangling, or mutable source",
  { skip: process.platform === "win32" },
  () => {
    const cases = [
      { name: "absolute", target: (parent: string) => path.join(parent, "outside.sol") },
      { name: "escaping", target: () => "../outside.sol" },
      { name: "dangling", target: () => "missing.sol" },
      { name: "native-output", target: () => "out/generated.sol" }
    ] as const;
    for (const unsafe of cases) {
      const parent = fs.mkdtempSync(path.join(os.tmpdir(), `ufz-workspace-unsafe-link-${unsafe.name}-`));
      const repository = path.join(parent, "repository");
      fs.mkdirSync(repository);
      git(repository, ["init"]);
      git(repository, ["config", "user.name", "Ultrafuzz Test"]);
      git(repository, ["config", "user.email", "ultrafuzz-test@example.com"]);
      fs.writeFileSync(path.join(parent, "outside.sol"), "contract Outside {}\n", "utf8");
      if (unsafe.name === "native-output") {
        fs.mkdirSync(path.join(repository, "out"));
        fs.writeFileSync(path.join(repository, "out", "generated.sol"), "contract Generated {}\n", "utf8");
      }
      fs.symlinkSync(unsafe.target(parent), path.join(repository, "target-link.sol"));
      git(repository, [
        "add",
        ...(unsafe.name === "native-output" ? ["-f", "out/generated.sol"] : []),
        "target-link.sol"
      ]);
      git(repository, ["commit", "-m", "fixture"]);
      const revision = git(repository, ["rev-parse", "HEAD"]);

      if (unsafe.name === "escaping") {
        fs.writeFileSync(path.join(parent, "outside.sol"), "contract Mutated {}\n", "utf8");
      }
      assert.throws(
        () => assertAgentWorkspaceProvenance(repository, revision, repository),
        /tracked changes before agent execution/u,
        unsafe.name
      );
    }
  }
);

test(
  "workspace provenance forces trusted file mode and symlink semantics",
  { skip: process.platform === "win32" },
  () => {
    const modeRepository = fs.mkdtempSync(path.join(os.tmpdir(), "ufz-workspace-file-mode-"));
    git(modeRepository, ["init"]);
    git(modeRepository, ["config", "user.name", "Ultrafuzz Test"]);
    git(modeRepository, ["config", "user.email", "ultrafuzz-test@example.com"]);
    const modeTarget = path.join(modeRepository, "target.sol");
    fs.writeFileSync(modeTarget, "contract Target {}\n", { encoding: "utf8", mode: 0o644 });
    git(modeRepository, ["add", "target.sol"]);
    git(modeRepository, ["commit", "-m", "fixture"]);
    const modeRevision = git(modeRepository, ["rev-parse", "HEAD"]);

    git(modeRepository, ["config", "core.fileMode", "false"]);
    fs.chmodSync(modeTarget, 0o755);
    git(modeRepository, ["update-index", "--refresh"]);
    assert.doesNotThrow(() =>
      execFileSync("git", ["diff-index", "--quiet", "HEAD", "--"], {
        cwd: modeRepository,
        stdio: "ignore"
      })
    );
    assert.throws(
      () => assertAgentWorkspaceProvenance(modeRepository, modeRevision, modeRepository),
      /tracked changes before agent execution/u
    );

    const symlinkRepository = fs.mkdtempSync(path.join(os.tmpdir(), "ufz-workspace-symlink-mode-"));
    git(symlinkRepository, ["init"]);
    git(symlinkRepository, ["config", "user.name", "Ultrafuzz Test"]);
    git(symlinkRepository, ["config", "user.email", "ultrafuzz-test@example.com"]);
    fs.writeFileSync(path.join(symlinkRepository, "target.sol"), "contract Target {}\n", "utf8");
    const linkPath = path.join(symlinkRepository, "target-link.sol");
    fs.symlinkSync("target.sol", linkPath);
    git(symlinkRepository, ["add", "target.sol", "target-link.sol"]);
    git(symlinkRepository, ["commit", "-m", "fixture"]);
    const symlinkRevision = git(symlinkRepository, ["rev-parse", "HEAD"]);

    git(symlinkRepository, ["config", "core.symlinks", "false"]);
    fs.unlinkSync(linkPath);
    fs.writeFileSync(linkPath, "target.sol", "utf8");
    git(symlinkRepository, ["update-index", "--refresh"]);
    assert.doesNotThrow(() =>
      execFileSync("git", ["diff-index", "--quiet", "HEAD", "--"], {
        cwd: symlinkRepository,
        stdio: "ignore"
      })
    );
    assert.throws(
      () => assertAgentWorkspaceProvenance(symlinkRepository, symlinkRevision, symlinkRepository),
      /tracked changes before agent execution/u
    );
  }
);

test(
  "workspace provenance hashes raw tracked bytes without clean filters",
  { skip: process.platform === "win32" },
  () => {
    const repository = fs.mkdtempSync(path.join(os.tmpdir(), "ufz-workspace-clean-filter-"));
    git(repository, ["init"]);
    git(repository, ["config", "user.name", "Ultrafuzz Test"]);
    git(repository, ["config", "user.email", "ultrafuzz-test@example.com"]);
    git(repository, ["config", "filter.constant.clean", "sed 's/.*/trusted contents/'"]);
    fs.writeFileSync(path.join(repository, ".gitattributes"), "tracked.txt filter=constant\n", "utf8");
    const trackedPath = path.join(repository, "tracked.txt");
    fs.writeFileSync(trackedPath, "trusted contents\n", "utf8");
    git(repository, ["add", ".gitattributes", "tracked.txt"]);
    git(repository, ["commit", "-m", "fixture"]);
    const revision = git(repository, ["rev-parse", "HEAD"]);

    fs.writeFileSync(trackedPath, "malicious bytes\n", "utf8");
    git(repository, ["add", "tracked.txt"]);
    assert.equal(fs.readFileSync(trackedPath, "utf8"), "malicious bytes\n");
    assert.doesNotThrow(() =>
      execFileSync("git", ["diff-index", "--quiet", "HEAD", "--"], {
        cwd: repository,
        stdio: "ignore"
      })
    );
    assert.throws(
      () => assertAgentWorkspaceProvenance(repository, revision, repository),
      /tracked changes before agent execution/u
    );
  }
);

test("artifact normalization guard rejects hardlink substitution without changing the outside inode", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ufz-artifact-hardlink-"));
  const artifactDir = path.join(root, "artifacts");
  const outsidePath = path.join(root, "outside.json");
  const artifactPath = path.join(artifactDir, "findings.json");
  const original = "outside bytes must remain unchanged\n";
  fs.mkdirSync(artifactDir);
  fs.writeFileSync(outsidePath, original, "utf8");
  assert.doesNotThrow(() => assertSingleLinkRegularFile(outsidePath));
  fs.linkSync(outsidePath, artifactPath);

  assert.throws(() => {
    assertSingleLinkRegularFile(artifactPath, "artifact-contract failure: hard-linked artifact");
    fs.writeFileSync(artifactPath, "normalized artifact\n", "utf8");
  }, /hard-linked artifact/u);
  assert.equal(fs.readFileSync(outsidePath, "utf8"), original);
});

test("workspace source attestations survive restart and merge an exact fan-in closure", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ufz-workspace-attestation-"));
  const revision = "a".repeat(40);
  const artifactDirs = Object.fromEntries(
    ["root", "left", "right", "final"].map((attemptId) => {
      const artifactDir = path.join(root, attemptId);
      fs.mkdirSync(artifactDir);
      return [attemptId, artifactDir];
    })
  ) as Record<"root" | "left" | "right" | "final", string>;
  const rootTask = expected("root");
  const leftTask = expected("left");
  const rightTask = expected("right");
  const finalTask = expected("final");

  persist(artifactDirs.root, revision, rootTask, [], [rootTask]);
  persist(artifactDirs.left, revision, leftTask, [artifactDirs.root], [rootTask, leftTask]);
  persist(artifactDirs.right, revision, rightTask, [artifactDirs.root], [rootTask, rightTask]);

  // The final merge reads only durable dependency files; no process-local map
  // or prior JavaScript object is retained across this boundary.
  const final = persist(
    artifactDirs.final,
    revision,
    finalTask,
    [artifactDirs.left, artifactDirs.right],
    [rootTask, leftTask, rightTask, finalTask]
  );
  assert.deepEqual(
    final.tasks.map((task) => task.attempt_id),
    ["final", "left", "right", "root"]
  );
  assert.deepEqual(
    readWorkspaceSourceAttestation({
      artifactDir: artifactDirs.final,
      targetRevision: revision,
      expectedTasks: [rootTask, leftTask, rightTask, finalTask]
    }),
    final
  );

  fs.unlinkSync(path.join(artifactDirs.left, WORKSPACE_SOURCE_ATTESTATION_FILE));
  assert.throws(
    () =>
      persist(
        artifactDirs.final,
        revision,
        finalTask,
        [artifactDirs.left, artifactDirs.right],
        [rootTask, leftTask, rightTask, finalTask]
      ),
    /workspace source attestation does not exist/u
  );
});

test("workspace source attestations are valid canonical artifact manifest entries", () => {
  assert.equal(WORKSPACE_SOURCE_ATTESTATION_FILE, "ultrafuzz-workspace-source-attestation.json");
  const layout = createRunLayout({
    projectRoot: fs.mkdtempSync(path.join(os.tmpdir(), "ufz-attestation-manifest-")),
    runId: "run-one"
  });
  const artifactDir = getNodeArtifactDir(layout, "attempt-one", { create: true });
  const revision = "a".repeat(40);
  writeWorkspaceSourceAttestation(artifactDir, {
    schema_version: "ultrafuzz.workspace-source-attestation.v2",
    target_revision: revision,
    task_count: 1,
    tasks: [attested(expected("attempt-one"), revision)]
  });

  const manifest = writeArtifactManifest({ layout, nodeId: "attempt-one" });

  assert.deepEqual(
    manifest.files.map((file) => file.path),
    [WORKSPACE_SOURCE_ATTESTATION_FILE]
  );
});

test("workspace source attestation ordering is independent of localeCompare", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ufz-workspace-attestation-ascii-sort-"));
  const revision = "d".repeat(40);
  const rootTask = expected("Z-root");
  const childTask = expected("a-child");
  const legacyRoot = path.join(root, "legacy-root");
  const legacyChild = path.join(root, "legacy-child");
  const currentRoot = path.join(root, "current-root");
  const currentChild = path.join(root, "current-child");
  for (const directory of [legacyRoot, legacyChild, currentRoot, currentChild]) fs.mkdirSync(directory);

  const workspace = {
    baseCommit: revision,
    initialHead: revision,
    agentRootVerified: true as const,
    trackedClean: true as const
  };
  persistLegacyWorkspaceSourceClaim({
    artifactDir: legacyRoot,
    targetRevision: revision,
    current: { ...rootTask, workspace },
    dependencyArtifactDirs: [],
    expectedTasks: [rootTask]
  });
  persist(currentRoot, revision, rootTask, [], [rootTask]);

  const originalLocaleCompare = String.prototype.localeCompare;
  Object.defineProperty(String.prototype, "localeCompare", {
    configurable: true,
    value() {
      throw new Error("localeCompare must not define attestation ordering");
    },
    writable: true
  });
  try {
    const legacy = persistLegacyWorkspaceSourceClaim({
      artifactDir: legacyChild,
      targetRevision: revision,
      current: { ...childTask, workspace },
      dependencyArtifactDirs: [legacyRoot],
      expectedTasks: [rootTask, childTask]
    });
    const current = persist(currentChild, revision, childTask, [currentRoot], [rootTask, childTask]);

    assert.deepEqual(
      legacy.tasks.map((task) => task.attempt_id),
      ["Z-root", "a-child"]
    );
    assert.deepEqual(
      current.tasks.map((task) => task.attempt_id),
      ["Z-root", "a-child"]
    );
  } finally {
    Object.defineProperty(String.prototype, "localeCompare", {
      configurable: true,
      value: originalLocaleCompare,
      writable: true
    });
  }
});

test("workspace source attestations reject contradictory fan-in, hardlinks, and substituted roots", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ufz-workspace-attestation-safety-"));
  const revision = "b".repeat(40);
  const rootDir = path.join(root, "root");
  const leftDir = path.join(root, "left");
  const rightDir = path.join(root, "right");
  const finalDir = path.join(root, "final");
  for (const directory of [rootDir, leftDir, rightDir, finalDir]) fs.mkdirSync(directory);
  const rootTask = expected("root");
  const leftTask = expected("left");
  const rightTask = expected("right");
  const finalTask = expected("final");
  persist(rootDir, revision, rootTask, [], [rootTask]);
  persist(leftDir, revision, leftTask, [rootDir], [rootTask, leftTask]);
  const right = persist(rightDir, revision, rightTask, [rootDir], [rootTask, rightTask]);
  right.tasks.find((task) => task.attempt_id === "root")!.node_id = "contradictory-root";
  writeWorkspaceSourceAttestation(rightDir, right);
  assert.throws(
    () => persist(finalDir, revision, finalTask, [leftDir, rightDir], [rootTask, leftTask, rightTask, finalTask]),
    /contradictory attestation/u
  );

  const evidencePath = path.join(leftDir, WORKSPACE_SOURCE_ATTESTATION_FILE);
  fs.linkSync(evidencePath, path.join(leftDir, "attestation-hardlink"));
  assert.throws(
    () => readWorkspaceSourceAttestation({ artifactDir: leftDir, targetRevision: revision }),
    /cannot be hard-linked/u
  );
  fs.unlinkSync(path.join(leftDir, "attestation-hardlink"));

  const moved = path.join(root, "moved-left");
  fs.renameSync(leftDir, moved);
  fs.symlinkSync(moved, leftDir, "dir");
  assert.throws(
    () => readWorkspaceSourceAttestation({ artifactDir: leftDir, targetRevision: revision }),
    /artifact root is unsafe/u
  );

  assert.throws(
    () =>
      writeWorkspaceSourceAttestation(finalDir, {
        schema_version: "ultrafuzz.workspace-source-attestation.v2",
        target_revision: "not-a-commit",
        task_count: 1,
        tasks: [attested(finalTask, "not-a-commit")]
      }),
    /source attestation target is invalid/u
  );
});

test("workspace source attestation closure matches the supported expanded-topology limit", () => {
  assert.equal(MAX_EXPANDED_TOPOLOGY_NODES, 4_096);
  const artifactDir = fs.mkdtempSync(path.join(os.tmpdir(), "ufz-workspace-attestation-limit-"));
  const revision = "c".repeat(40);
  const expectedTasks = Array.from({ length: MAX_EXPANDED_TOPOLOGY_NODES }, (_, index) =>
    expected(`attempt-${String(index).padStart(4, "0")}`)
  );
  const tasks = expectedTasks.map((task) => attested(task, revision));
  const attestation = {
    schema_version: "ultrafuzz.workspace-source-attestation.v2" as const,
    target_revision: revision,
    task_count: tasks.length,
    tasks
  };

  assert.doesNotThrow(() => assertWorkspaceSourceAttestationClosure(attestation, expectedTasks));
  writeWorkspaceSourceAttestation(artifactDir, attestation);
  assert.equal(
    readWorkspaceSourceAttestation({ artifactDir, targetRevision: revision, expectedTasks }).task_count,
    MAX_EXPANDED_TOPOLOGY_NODES
  );

  const overflowTask = expected("attempt-4096");
  assert.throws(
    () =>
      writeWorkspaceSourceAttestation(artifactDir, {
        ...attestation,
        task_count: MAX_EXPANDED_TOPOLOGY_NODES + 1,
        tasks: [...tasks, attested(overflowTask, revision)]
      }),
    /source attestation metadata is invalid/u
  );
});

function withGitMutationAfterCommand(
  repository: string,
  trigger: string,
  revision: string,
  mutation: "index" | "reset",
  run: (marker: string) => void
): void {
  const wrapperRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ufz-git-wrapper-"));
  const wrapperPath = path.join(wrapperRoot, "git");
  const marker = path.join(wrapperRoot, "mutation-complete");
  const realGit = execFileSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).trim();
  const mutationCommand =
    mutation === "reset"
      ? `${shellQuote(realGit)} -C ${shellQuote(repository)} reset --hard ${shellQuote(revision)}`
      : `${shellQuote(realGit)} -C ${shellQuote(repository)} read-tree ${shellQuote(revision)}`;
  fs.writeFileSync(
    wrapperPath,
    [
      "#!/bin/sh",
      `${shellQuote(realGit)} "$@"`,
      "status=$?",
      `case " $* " in`,
      `  *" ${trigger} "*)`,
      `    if [ "$status" -eq 0 ] && [ ! -e ${shellQuote(marker)} ]; then`,
      "      unset GIT_INDEX_FILE",
      `      if ${mutationCommand} >/dev/null 2>&1; then`,
      `        : > ${shellQuote(marker)}`,
      "      else",
      "        exit 97",
      "      fi",
      "    fi",
      "    ;;",
      "esac",
      'exit "$status"',
      ""
    ].join("\n"),
    { encoding: "utf8", mode: 0o755 }
  );
  const originalPath = process.env.PATH;
  process.env.PATH = `${wrapperRoot}${path.delimiter}${originalPath ?? ""}`;
  try {
    run(marker);
  } finally {
    if (originalPath === undefined) delete process.env.PATH;
    else process.env.PATH = originalPath;
    fs.rmSync(wrapperRoot, { force: true, recursive: true });
  }
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function createGitlinkFixture(): { repository: string; revision: string } {
  const repository = fs.mkdtempSync(path.join(os.tmpdir(), "ufz-workspace-budget-gitlink-"));
  git(repository, ["init"]);
  git(repository, ["config", "user.name", "Ultrafuzz Test"]);
  git(repository, ["config", "user.email", "ultrafuzz-test@example.com"]);
  const nestedRepository = path.join(repository, "vendor", "nested");
  fs.mkdirSync(nestedRepository, { recursive: true });
  git(nestedRepository, ["init"]);
  git(nestedRepository, ["config", "user.name", "Ultrafuzz Test"]);
  git(nestedRepository, ["config", "user.email", "ultrafuzz-test@example.com"]);
  fs.writeFileSync(path.join(nestedRepository, "source.sol"), "contract Nested {}\n", "utf8");
  git(nestedRepository, ["add", "source.sol"]);
  git(nestedRepository, ["commit", "-m", "nested fixture"]);
  const nestedRevision = git(nestedRepository, ["rev-parse", "HEAD"]);

  git(repository, ["update-index", "--add", "--cacheinfo", `160000,${nestedRevision},vendor/nested`]);
  git(repository, ["commit", "-m", "gitlink fixture"]);
  return { repository, revision: git(repository, ["rev-parse", "HEAD"]) };
}

function processHasOpenFile(filePath: string): boolean {
  return fs.readdirSync("/proc/self/fd").some((descriptor) => {
    try {
      return fs.readlinkSync(path.join("/proc/self/fd", descriptor)) === filePath;
    } catch {
      return false;
    }
  });
}

function git(repository: string, args: string[]): string {
  return execFileSync("git", args, {
    cwd: repository,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"]
  })
    .trim()
    .toLowerCase();
}

function expected(attemptId: string): ExpectedWorkspaceSourceTask {
  return { attemptId, nodeId: attemptId };
}

function attested(task: ExpectedWorkspaceSourceTask, revision: string) {
  const receiptDigest = createHash("sha256").update(`receipt:${task.attemptId}`).digest("hex");
  const outputDigest = createHash("sha256").update(`output:${task.attemptId}`).digest("hex");
  const manifestDigest = createHash("sha256").update(`manifest:${task.attemptId}`).digest("hex");
  return {
    attempt_id: task.attemptId,
    ledger_attempt_id: `ledger-${task.attemptId}`,
    node_id: task.nodeId,
    expected_base_commit: revision,
    initial_head: revision,
    agent_root_verified: true as const,
    tracked_clean: true as const,
    workflow_run_id: "workflow-run",
    workflow_execution_id: "execution-one",
    controller_invocation_id: "controller-one",
    checkpoint_generation_id: "checkpoint-one",
    executor_retry_id: `retry-${task.attemptId}`,
    verifier_task_id: `verify:${task.attemptId}`,
    verifier_receipt_digest: receiptDigest,
    smithers_output_path: `review/verifier-receipts/${task.attemptId}/retry-${task.attemptId}.smithers-output.json`,
    smithers_output_sha256: outputDigest,
    output_manifest_digest: manifestDigest
  };
}

function persist(
  artifactDir: string,
  revision: string,
  current: ExpectedWorkspaceSourceTask,
  dependencyArtifactDirs: string[],
  expectedTasks: ExpectedWorkspaceSourceTask[]
) {
  return persistWorkspaceSourceAttestation({
    artifactDir,
    targetRevision: revision,
    current: attested(current, revision),
    dependencyArtifactDirs,
    expectedTasks
  });
}
