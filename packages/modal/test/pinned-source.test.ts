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
  readPinnedSourceProof
} from "../src/pinned-source.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("pinned benchmark source", () => {
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
