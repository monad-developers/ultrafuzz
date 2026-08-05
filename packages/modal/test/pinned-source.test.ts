import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
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

  it("hydrates submodules at the gitlink revisions recorded by the pinned commit", async () => {
    const fixture = submoduleSourceRepository();
    const destination = path.join(fixture.root, "sanitized-submodule");

    const previousAllowedProtocols = process.env.GIT_ALLOW_PROTOCOL;
    process.env.GIT_ALLOW_PROTOCOL = "file";
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
    }

    expect(fs.readFileSync(path.join(destination, "vendor/dependency/dependency.txt"), "utf8")).toBe(
      "pinned dependency\n"
    );
    expect(git(path.join(destination, "vendor/dependency"), ["rev-parse", "HEAD"])).toBe(fixture.submoduleCommit);
    expect(proof).toMatchObject({ commit: fixture.pinned, revision_count: 1, remotes: [] });
    await expect(inspectPinnedSource(destination, fixture.pinned)).resolves.toEqual(proof);
  });

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
} {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ultrafuzz-pinned-submodule-"));
  roots.push(root);
  const submodule = path.join(root, "dependency");
  fs.mkdirSync(submodule);
  git(submodule, ["init", "--quiet", "--initial-branch=main"]);
  git(submodule, ["config", "user.name", "Ultrafuzz test"]);
  git(submodule, ["config", "user.email", "test@example.invalid"]);
  fs.writeFileSync(path.join(submodule, "dependency.txt"), "pinned dependency\n");
  git(submodule, ["add", "dependency.txt"]);
  git(submodule, ["commit", "--quiet", "-m", "dependency"]);
  const submoduleCommit = git(submodule, ["rev-parse", "HEAD"]);

  const repository = path.join(root, "source");
  fs.mkdirSync(repository);
  git(repository, ["init", "--quiet", "--initial-branch=main"]);
  git(repository, ["config", "user.name", "Ultrafuzz test"]);
  git(repository, ["config", "user.email", "test@example.invalid"]);
  fs.writeFileSync(path.join(repository, "source.txt"), "pinned\n");
  git(repository, ["add", "source.txt"]);
  git(repository, ["commit", "--quiet", "-m", "source"]);
  git(repository, ["-c", "protocol.file.allow=always", "submodule", "add", "--quiet", submodule, "vendor/dependency"]);
  git(repository, ["commit", "--quiet", "-am", "submodule"]);
  const pinned = git(repository, ["rev-parse", "HEAD"]);
  return { root, repository, pinned, submoduleCommit };
}

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"]
  }).trim();
}
