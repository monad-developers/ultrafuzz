import { execFileSync, spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  GITHUB_HTTPS_SUBMODULE_CONFIG,
  inspectPinnedSource,
  materializePinnedSource,
  PINNED_SOURCE_BRANCH,
  PINNED_SOURCE_REF,
  readPinnedSourceProof,
  type PinnedHoldout
} from "../src/pinned-source.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("pinned benchmark source", () => {
  it("rejects duplicate keys in a persisted pinned-source proof", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ultrafuzz-pinned-proof-"));
    roots.push(root);
    const proofPath = path.join(root, "proof.json");
    const commit = "a".repeat(40);
    const proof = {
      schema_version: "ultrafuzz.pinned-source-proof.v2",
      commit,
      tree: "b".repeat(40),
      base_ref: PINNED_SOURCE_REF,
      refs: [{ name: PINNED_SOURCE_REF, object: commit }],
      remotes: [],
      revision_count: 1,
      commit_object_count: 1,
      submodules: null
    };
    const serialized = JSON.stringify(proof);
    const field = `"commit":"${commit}"`;
    const duplicate = serialized.replace(field, `${field},"commit":"${"c".repeat(40)}"`);
    expect(duplicate).not.toBe(serialized);
    fs.writeFileSync(proofPath, duplicate, { mode: 0o600 });

    await expect(readPinnedSourceProof(proofPath)).rejects.toThrow(/duplicate|strict JSON/u);
  });

  it("rewrites only GitHub SSH submodule transports to HTTPS", () => {
    const resolve = (url: string): string =>
      execFileSync("git", [...GITHUB_HTTPS_SUBMODULE_CONFIG, "ls-remote", "--get-url", url], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"]
      }).trim();

    expect(resolve("git@github.com:Recon-Fuzz/chimera.git")).toBe("https://github.com/Recon-Fuzz/chimera.git");
    expect(resolve("ssh://git@github.com/Recon-Fuzz/setup-helpers.git")).toBe(
      "https://github.com/Recon-Fuzz/setup-helpers.git"
    );
    expect(resolve("https://github.com/Recon-Fuzz/chimera.git")).toBe("https://github.com/Recon-Fuzz/chimera.git");
    expect(resolve("git@gitlab.com:Recon-Fuzz/chimera.git")).toBe("git@gitlab.com:Recon-Fuzz/chimera.git");
    expect(resolve("git@github.com.example:Recon-Fuzz/chimera.git")).toBe(
      "git@github.com.example:Recon-Fuzz/chimera.git"
    );
    expect(resolve("ssh://git@github.com.example/Recon-Fuzz/chimera.git")).toBe(
      "ssh://git@github.com.example/Recon-Fuzz/chimera.git"
    );
  });

  it("uses bounded git revision queries for source proof inspection", () => {
    const source = fs.readFileSync(new URL("../src/pinned-source.ts", import.meta.url), "utf8");

    expect(source).toContain('["rev-list", "--all", "--count"]');
    expect(source).toContain('["rev-list", "--all", "--max-count=1"]');
    expect(source).toContain("git fsck --connectivity-only --unreachable --no-reflogs --no-progress");
    expect(source).not.toContain("--batch-all-objects");
  });

  it("materializes only the requested commit without the remote default branch or later objects", async () => {
    const fixture = sourceRepository();
    const destination = path.join(fixture.root, "sanitized");
    const proofPath = path.join(fixture.root, "proof.json");

    const proof = await materializePinnedSource({
      repository: fixture.repository,
      revision: fixture.pinned,
      destination,
      proofPath
    });

    expect(proof).toMatchObject({
      commit: fixture.pinned,
      base_ref: PINNED_SOURCE_REF,
      revision_count: 1,
      commit_object_count: 1,
      remotes: [],
      refs: [{ name: PINNED_SOURCE_REF, object: fixture.pinned }]
    });
    expect(git(destination, ["branch", "--show-current"])).toBe(PINNED_SOURCE_BRANCH);
    expect(git(destination, ["remote"])).toBe("");
    expect(fs.readFileSync(path.join(destination, ".git", "config"), "utf8")).not.toContain(fixture.repository);
    const submoduleConfig = spawnSync("git", ["config", "--local", "--get-regexp", "^submodule\\."], {
      cwd: destination,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"]
    });
    expect(submoduleConfig.status).toBe(1);
    expect(submoduleConfig.stdout).toBe("");
    expect(git(destination, ["rev-list", "--all"])).toBe(fixture.pinned);
    expect(() => git(destination, ["show", fixture.later])).toThrow();
    expect(await readPinnedSourceProof(proofPath)).toEqual(proof);
    await expect(inspectPinnedSource(destination, fixture.pinned)).resolves.toEqual(proof);

    fs.writeFileSync(path.join(destination, "untracked.txt"), "worker configuration\n");
    git(destination, ["branch", "ultrafuzz/run/attempt"]);
    await expect(
      inspectPinnedSource(destination, fixture.pinned, undefined, {
        allowDirty: true,
        allowUltrafuzzWorktreeRefs: true
      })
    ).resolves.toMatchObject({ commit: fixture.pinned, revision_count: 1 });
  });

  it("rejects a pinned checkout with hidden unreachable commit objects", async () => {
    const fixture = sourceRepository();
    const destination = path.join(fixture.root, "hidden-commit");
    await materializePinnedSource({
      repository: fixture.repository,
      revision: fixture.pinned,
      destination
    });

    git(destination, ["config", "user.name", "Ultrafuzz test"]);
    git(destination, ["config", "user.email", "test@example.invalid"]);
    git(destination, ["checkout", "--quiet", "-b", "hidden"]);
    fs.writeFileSync(path.join(destination, "source.txt"), "hidden commit\n");
    git(destination, ["add", "source.txt"]);
    git(destination, ["commit", "--quiet", "-m", "hidden"]);
    git(destination, ["checkout", "--quiet", PINNED_SOURCE_BRANCH]);
    git(destination, ["branch", "-D", "hidden"]);

    await expect(inspectPinnedSource(destination, fixture.pinned)).rejects.toThrow(/isolation verification/u);
  });

  it("hydrates recursive submodules at the recorded gitlink revisions", async () => {
    const fixture = submoduleSourceRepository();
    expect(gitlinkHash(fixture.repository, "vendor/dependency")).toBe(fixture.submoduleCommit);
    expect(gitlinkHash(fixture.submodule, "nested/child")).toBe(fixture.nestedCommit);
    const destination = path.join(fixture.root, "sanitized-submodule");

    const previousAllowedProtocols = process.env.GIT_ALLOW_PROTOCOL;
    const previousPath = process.env.PATH;
    const gitProbe = installGitInvocationProbe(fixture.root);
    process.env.GIT_ALLOW_PROTOCOL = "file";
    process.env.PATH = `${gitProbe.bin}${path.delimiter}${previousPath ?? ""}`;
    let proof: Awaited<ReturnType<typeof materializePinnedSource>>;
    try {
      proof = await materializePinnedSource({
        repository: fixture.repository,
        revision: fixture.pinned,
        destination
      });
    } finally {
      if (previousAllowedProtocols === undefined) delete process.env.GIT_ALLOW_PROTOCOL;
      else process.env.GIT_ALLOW_PROTOCOL = previousAllowedProtocols;
      if (previousPath === undefined) delete process.env.PATH;
      else process.env.PATH = previousPath;
    }

    expect(fs.readFileSync(path.join(destination, "vendor/dependency/dependency.txt"), "utf8")).toBe(
      "pinned dependency\n"
    );
    expect(gitlinkHash(destination, "vendor/dependency")).toBe(fixture.submoduleCommit);
    expect(fs.readFileSync(path.join(destination, "vendor/dependency/nested/child/child.txt"), "utf8")).toBe(
      "nested dependency\n"
    );
    expect(fs.existsSync(path.join(destination, ".git", "modules"))).toBe(false);
    expect(fs.existsSync(path.join(destination, "vendor/dependency/.git"))).toBe(false);
    expect(fs.existsSync(path.join(destination, "vendor/dependency/nested/child/.git"))).toBe(false);
    expect(git(destination, ["remote"])).toBe("");
    const persistedUrlConfig = spawnSync("git", ["config", "--local", "--get-regexp", "^url\\."], {
      cwd: destination,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"]
    });
    expect(persistedUrlConfig.status).toBe(1);
    expect(persistedUrlConfig.stdout).toBe("");
    const persistedSubmoduleConfig = spawnSync("git", ["config", "--local", "--get-regexp", "^submodule\\."], {
      cwd: destination,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"]
    });
    expect(persistedSubmoduleConfig.status).toBe(1);
    expect(persistedSubmoduleConfig.stdout).toBe("");
    const invocations = fs.readFileSync(gitProbe.log, "utf8").trim().split("\n").filter(Boolean);
    expect(invocations).toContain([...GITHUB_HTTPS_SUBMODULE_CONFIG, "submodule", "sync", "--recursive"].join(" "));
    expect(invocations).toContain(
      [...GITHUB_HTTPS_SUBMODULE_CONFIG, "submodule", "update", "--init", "--recursive", "--depth", "1"].join(" ")
    );
    expect(proof).toMatchObject({ commit: fixture.pinned, revision_count: 1, remotes: [] });
    expect(proof.schema_version).toBe("ultrafuzz.pinned-source-proof.v2");
    expect(proof.submodules).toMatchObject({
      manifest_location: "git-common-dir",
      source_commit: fixture.pinned,
      source_tree: git(destination, ["rev-parse", "HEAD^{tree}"]),
      top_level_roots: ["vendor/dependency"],
      entry_count: expect.any(Number),
      file_count: expect.any(Number),
      total_file_bytes: expect.any(Number)
    });
    expect(proof.submodules?.recursive_gitlinks.map(({ path: entryPath, commit }) => [entryPath, commit])).toEqual([
      ["vendor/dependency", fixture.submoduleCommit],
      ["vendor/dependency/nested/child", fixture.nestedCommit]
    ]);
    expect(proof.submodules?.recursive_gitlinks.every((entry) => /^[0-9a-f]{40}$/u.test(entry.tree))).toBe(true);
    const manifestPath = path.join(destination, ".git", "ultrafuzz", "pinned-submodules", `${fixture.pinned}.json`);
    expect(fs.existsSync(manifestPath)).toBe(true);
    expect(fs.existsSync(path.join(destination, ".ultrafuzz", "cache", "pinned-submodules.json"))).toBe(false);
    expect(crypto.createHash("sha256").update(fs.readFileSync(manifestPath)).digest("hex")).toBe(
      proof.submodules?.manifest_sha256
    );
    expect(git(destination, ["status", "--porcelain=v1", "--untracked-files=all"])).toBe("");
    await expect(inspectPinnedSource(destination, fixture.pinned)).resolves.toEqual(proof);
    fs.appendFileSync(manifestPath, " ");
    await expect(inspectPinnedSource(destination, fixture.pinned)).rejects.toThrow(/manifest is not canonical/u);
  }, 15_000);

  it("fails closed for symbolic refs and revisions that are not full commits", async () => {
    const fixture = sourceRepository();

    await expect(
      materializePinnedSource({
        repository: fixture.repository,
        revision: "main",
        destination: path.join(fixture.root, "symbolic")
      })
    ).rejects.toThrow(/full 40-character commit/u);
  });

  it("removes a partial destination when source verification fails", async () => {
    const fixture = sourceRepository();
    const destination = path.join(fixture.root, "mismatch");

    await expect(
      materializePinnedSource({
        repository: fixture.repository,
        revision: "f".repeat(40),
        destination
      })
    ).rejects.toThrow();
    expect(fs.existsSync(destination)).toBe(false);
  });

  it("withholds declared reference paths and binds them to the benchmark commit", async () => {
    const fixture = referenceSourceRepository();
    const destination = path.join(fixture.root, "withheld");

    // A materialized checkout has no committer identity, and CI and the Modal
    // image have no global one either, so the hold-out commit must carry its
    // own. Suppress ambient configuration to keep that honest.
    const previousGitConfig = {
      global: process.env.GIT_CONFIG_GLOBAL,
      system: process.env.GIT_CONFIG_SYSTEM,
      noSystem: process.env.GIT_CONFIG_NOSYSTEM
    };
    process.env.GIT_CONFIG_GLOBAL = "/dev/null";
    process.env.GIT_CONFIG_SYSTEM = "/dev/null";
    process.env.GIT_CONFIG_NOSYSTEM = "1";
    let proof: Awaited<ReturnType<typeof materializePinnedSource>>;
    try {
      proof = await materializePinnedSource({
        repository: fixture.repository,
        revision: fixture.pinned,
        destination,
        heldOutPaths: ["reference"]
      });
    } finally {
      for (const [name, value] of [
        ["GIT_CONFIG_GLOBAL", previousGitConfig.global],
        ["GIT_CONFIG_SYSTEM", previousGitConfig.system],
        ["GIT_CONFIG_NOSYSTEM", previousGitConfig.noSystem]
      ] as const) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    }

    // The answer key is gone; everything else survives untouched.
    expect(fs.existsSync(path.join(destination, "reference"))).toBe(false);
    expect(fs.readFileSync(path.join(destination, "src", "protocol.txt"), "utf8")).toBe("protocol\n");
    expect(fs.readFileSync(path.join(destination, "tests", "unit.txt"), "utf8")).toBe("unit\n");

    // HEAD is a parentless hold-out revision and the benchmark commit is gone,
    // so the single-revision isolation invariants still hold.
    expect(proof.commit).not.toBe(fixture.pinned);
    expect(proof.revision_count).toBe(1);
    expect(proof.commit_object_count).toBe(1);
    expect(() => git(destination, ["rev-parse", "HEAD^"])).toThrow();
    expect(git(destination, ["branch", "--show-current"])).toBe(PINNED_SOURCE_BRANCH);
    expect(proof.refs).toEqual([{ name: PINNED_SOURCE_REF, object: proof.commit }]);
    expect(git(destination, ["status", "--porcelain=v1", "--untracked-files=all"])).toBe("");

    expect(proof.held_out).toMatchObject({
      source_commit: fixture.pinned,
      commit: proof.commit,
      tree: proof.tree,
      paths: ["reference"]
    });

    // The withheld bytes must be unrecoverable, not merely deleted.
    expect(() => git(destination, ["show", `${fixture.pinned}:reference/Properties.sol`])).toThrow();
    expect(() => git(destination, ["cat-file", "-e", fixture.pinned])).toThrow();
    for (const entry of proof.held_out?.entries ?? []) {
      expect(() => git(destination, ["cat-file", "-e", entry.blob])).toThrow();
    }
    expect(git(destination, ["reflog"])).toBe("");
    expect(git(destination, ["fsck", "--unreachable", "--no-progress"])).toBe("");
    expect(proof.held_out?.entries.map((entry) => entry.path)).toEqual([
      "reference/Properties.sol",
      "reference/nested/Handlers.sol"
    ]);
    for (const entry of proof.held_out?.entries ?? []) {
      expect(entry.blob).toMatch(/^[0-9a-f]{40}$/u);
      expect(entry.size).toBeGreaterThan(0);
    }

    // A caller that only knows the benchmark commit still verifies the checkout.
    await expect(inspectPinnedSource(destination, fixture.pinned)).resolves.toEqual(proof);
  }, 15_000);

  it("leaves a target without a hold-out declaration unchanged", async () => {
    const fixture = referenceSourceRepository();
    const destination = path.join(fixture.root, "intact");

    const proof = await materializePinnedSource({
      repository: fixture.repository,
      revision: fixture.pinned,
      destination
    });

    expect(proof.held_out).toBeNull();
    expect(proof.commit).toBe(fixture.pinned);
    expect(proof.revision_count).toBe(1);
    expect(fs.existsSync(path.join(destination, "reference", "Properties.sol"))).toBe(true);
  }, 15_000);

  it("fails closed when a hold-out declaration matches no tracked path", async () => {
    const fixture = referenceSourceRepository();
    const destination = path.join(fixture.root, "absent");

    await expect(
      materializePinnedSource({
        repository: fixture.repository,
        revision: fixture.pinned,
        destination,
        heldOutPaths: ["reference-that-does-not-exist"]
      })
    ).rejects.toThrow(/matched no tracked path/u);
    expect(fs.existsSync(destination)).toBe(false);
  }, 15_000);

  it("rejects hold-out declarations that escape the checkout", async () => {
    const fixture = referenceSourceRepository();

    for (const heldOut of [["../outside"], ["/etc"], [".git"], ["reference/../../escape"]]) {
      await expect(
        materializePinnedSource({
          repository: fixture.repository,
          revision: fixture.pinned,
          destination: path.join(fixture.root, "escape"),
          heldOutPaths: heldOut
        })
      ).rejects.toThrow(/hold-out path must/u);
    }
  }, 15_000);

  it("rejects a hold-out revision that was rewritten after materialization", async () => {
    const fixture = referenceSourceRepository();
    const destination = path.join(fixture.root, "widened");

    await materializePinnedSource({
      repository: fixture.repository,
      revision: fixture.pinned,
      destination,
      heldOutPaths: ["reference"]
    });

    // A materialized checkout carries no committer identity of its own.
    git(destination, ["config", "user.name", "Ultrafuzz test"]);
    git(destination, ["config", "user.email", "test@example.invalid"]);
    // Withhold a protocol file without recording it, then re-verify.
    git(destination, ["rm", "-r", "--quiet", "--", "src"]);
    git(destination, ["commit", "--quiet", "--no-verify", "--amend", "--no-edit"]);
    await expect(inspectPinnedSource(destination, fixture.pinned)).rejects.toThrow(
      /not the expected parentless revision/u
    );
  }, 15_000);

  it("rejects a tampered hold-out record", async () => {
    const fixture = referenceSourceRepository();
    const destination = path.join(fixture.root, "tampered");

    await materializePinnedSource({
      repository: fixture.repository,
      revision: fixture.pinned,
      destination,
      heldOutPaths: ["reference"]
    });
    const recordPath = path.join(destination, ".git", "ultrafuzz-pinned-holdout.json");
    const record = JSON.parse(fs.readFileSync(recordPath, "utf8")) as PinnedHoldout;
    const rewrite = (value: Partial<PinnedHoldout>): void =>
      fs.writeFileSync(recordPath, JSON.stringify({ ...record, ...value }, null, 2), "utf8");

    // Declaring nothing would make the audit vacuous.
    rewrite({ entries: [], paths: [] });
    await expect(inspectPinnedSource(destination, fixture.pinned)).rejects.toThrow(/record is invalid/u);

    // Naming a path that is still present claims a hold-out that never happened.
    rewrite({ entries: [{ path: "src/protocol.txt", blob: "a".repeat(40), size: 9 }] });
    await expect(inspectPinnedSource(destination, fixture.pinned)).rejects.toThrow(/still tracked/u);

    // Naming a blob that is still readable is not a hold-out either.
    const readable = git(destination, ["rev-parse", "HEAD:src/protocol.txt"]);
    rewrite({ entries: [{ path: "reference/Properties.sol", blob: readable, size: 9 }] });
    await expect(inspectPinnedSource(destination, fixture.pinned)).rejects.toThrow(/still readable/u);

    // Claiming descent from a commit that is not the benchmark commit.
    rewrite({ source_commit: "a".repeat(40) });
    await expect(inspectPinnedSource(destination, fixture.pinned)).rejects.toThrow(
      /not the expected parentless revision/u
    );
  }, 20_000);
});

function sourceRepository(): { root: string; repository: string; pinned: string; later: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ultrafuzz-pinned-source-"));
  roots.push(root);
  const repository = path.join(root, "source");
  fs.mkdirSync(repository);
  git(repository, ["init", "--quiet", "--initial-branch=main"]);
  git(repository, ["config", "user.name", "Ultrafuzz test"]);
  git(repository, ["config", "user.email", "test@example.invalid"]);
  fs.writeFileSync(path.join(repository, "source.txt"), "pinned\n");
  git(repository, ["add", "source.txt"]);
  git(repository, ["commit", "--quiet", "-m", "pinned"]);
  const pinned = git(repository, ["rev-parse", "HEAD"]);
  fs.writeFileSync(path.join(repository, "source.txt"), "later\n");
  fs.writeFileSync(path.join(repository, "later-only.txt"), "must stay unreachable\n");
  git(repository, ["add", "."]);
  git(repository, ["commit", "--quiet", "-m", "later"]);
  return { root, repository, pinned, later: git(repository, ["rev-parse", "HEAD"]) };
}

/** A benchmark that ships a reference solution beside the protocol under test. */
function referenceSourceRepository(): { root: string; repository: string; pinned: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ultrafuzz-pinned-holdout-"));
  roots.push(root);
  const repository = path.join(root, "source");
  fs.mkdirSync(path.join(repository, "src"), { recursive: true });
  fs.mkdirSync(path.join(repository, "tests"), { recursive: true });
  fs.mkdirSync(path.join(repository, "reference", "nested"), { recursive: true });
  git(repository, ["init", "--quiet", "--initial-branch=main"]);
  git(repository, ["config", "user.name", "Ultrafuzz test"]);
  git(repository, ["config", "user.email", "test@example.invalid"]);
  fs.writeFileSync(path.join(repository, "src", "protocol.txt"), "protocol\n");
  fs.writeFileSync(path.join(repository, "tests", "unit.txt"), "unit\n");
  fs.writeFileSync(path.join(repository, "reference", "Properties.sol"), "invariant answer key\n");
  fs.writeFileSync(path.join(repository, "reference", "nested", "Handlers.sol"), "reference handlers\n");
  git(repository, ["add", "."]);
  git(repository, ["commit", "--quiet", "-m", "benchmark"]);
  return { root, repository, pinned: git(repository, ["rev-parse", "HEAD"]) };
}

function submoduleSourceRepository(): {
  root: string;
  repository: string;
  pinned: string;
  submoduleCommit: string;
  submodule: string;
  nestedCommit: string;
} {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ultrafuzz-pinned-submodule-"));
  roots.push(root);
  const nested = path.join(root, "nested");
  fs.mkdirSync(nested);
  git(nested, ["init", "--quiet", "--initial-branch=main"]);
  git(nested, ["config", "user.name", "Ultrafuzz test"]);
  git(nested, ["config", "user.email", "test@example.invalid"]);
  fs.writeFileSync(path.join(nested, "child.txt"), "nested dependency\n");
  git(nested, ["add", "child.txt"]);
  git(nested, ["commit", "--quiet", "-m", "nested dependency"]);
  const nestedCommit = git(nested, ["rev-parse", "HEAD"]);

  const submodule = path.join(root, "dependency");
  fs.mkdirSync(submodule);
  git(submodule, ["init", "--quiet", "--initial-branch=main"]);
  git(submodule, ["config", "user.name", "Ultrafuzz test"]);
  git(submodule, ["config", "user.email", "test@example.invalid"]);
  fs.writeFileSync(path.join(submodule, "dependency.txt"), "pinned dependency\n");
  git(submodule, ["add", "dependency.txt"]);
  git(submodule, ["commit", "--quiet", "-m", "dependency"]);
  git(submodule, ["-c", "protocol.file.allow=always", "submodule", "add", "--quiet", "../nested", "nested/child"]);
  git(submodule, ["commit", "--quiet", "-am", "nested submodule"]);
  const submoduleCommit = git(submodule, ["rev-parse", "HEAD"]);
  fs.writeFileSync(path.join(nested, "child.txt"), "later nested dependency\n");
  git(nested, ["commit", "--quiet", "-am", "later nested dependency"]);

  const repository = path.join(root, "source");
  fs.mkdirSync(repository);
  git(repository, ["init", "--quiet", "--initial-branch=main"]);
  git(repository, ["config", "user.name", "Ultrafuzz test"]);
  git(repository, ["config", "user.email", "test@example.invalid"]);
  fs.writeFileSync(path.join(repository, "source.txt"), "pinned\n");
  git(repository, ["add", "source.txt"]);
  git(repository, ["commit", "--quiet", "-m", "source"]);
  git(repository, [
    "-c",
    "protocol.file.allow=always",
    "submodule",
    "add",
    "--quiet",
    "../dependency",
    "vendor/dependency"
  ]);
  git(repository, ["commit", "--quiet", "-am", "submodule"]);
  const pinned = git(repository, ["rev-parse", "HEAD"]);
  fs.writeFileSync(path.join(submodule, "dependency.txt"), "later dependency\n");
  git(submodule, ["add", "dependency.txt"]);
  git(submodule, ["commit", "--quiet", "-m", "later dependency"]);
  return { root, repository, pinned, submoduleCommit, submodule, nestedCommit };
}

function installGitInvocationProbe(root: string): { bin: string; log: string } {
  const realGit = executableOnPath("git");
  const bin = path.join(root, "git-probe-bin");
  const wrapper = path.join(bin, "git");
  const log = path.join(root, "git-invocations.jsonl");
  fs.mkdirSync(bin);
  fs.writeFileSync(
    wrapper,
    ["#!/bin/sh", `printf '%s\\n' "$*" >> ${shellQuote(log)}`, `exec ${shellQuote(realGit)} "$@"`, ""].join("\n"),
    { mode: 0o700 }
  );
  return { bin, log };
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

function executableOnPath(name: string): string {
  for (const directory of (process.env.PATH ?? "").split(path.delimiter)) {
    const candidate = path.join(directory, name);
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return candidate;
    } catch {
      // Continue searching the path.
    }
  }
  throw new Error(`${name} is not executable on PATH`);
}

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"]
  }).trim();
}

function gitlinkHash(repository: string, relativePath: string): string {
  const metadata = git(repository, ["ls-tree", "HEAD", relativePath]).split("\t")[0];
  const hash = metadata?.split(" ")[2];
  if (hash === undefined) throw new Error(`gitlink ${relativePath} is missing from ${repository}`);
  return hash;
}
