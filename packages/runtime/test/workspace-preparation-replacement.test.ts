import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { temporaryRoot } from "./temporary-root.js";
import {
  hasPendingWorkspacePreparationReplacement,
  replaceWorkspacePreparationEvidence,
  writeWorkspacePreparationAuthority
} from "../src/workspace-preparation-replacement.js";

function replacementFixture(
  body: (root: string, input: Parameters<typeof replaceWorkspacePreparationEvidence>[0]) => void
): void {
  const root = temporaryRoot("uf-preparation-replacement-");
  try {
    fs.mkdirSync(path.join(root, "artifacts", "worker"), { recursive: true });
    fs.mkdirSync(path.join(root, "snapshots", "worker"), { recursive: true });
    fs.writeFileSync(path.join(root, "artifacts", "worker", "baseline.json"), "old baseline\n");
    fs.writeFileSync(path.join(root, "artifacts", "worker", "preparation.json"), "old preparation\n");
    fs.writeFileSync(path.join(root, "snapshots", "worker", "source.sol"), "old source\n");
    body(root, {
      runRoot: root,
      attemptId: "worker",
      replacementTree: "a".repeat(40),
      dependencySha256: "b".repeat(64),
      paths: ["artifacts/worker/baseline.json", "artifacts/worker/preparation.json", "snapshots/worker"],
      replacementFiles: [
        { path: "artifacts/worker/baseline.json", bytes: "new baseline\n" },
        { path: "artifacts/worker/preparation.json", bytes: "new preparation\n" }
      ],
      validatePrevious: () => undefined,
      rebuild: () => undefined
    });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

test("preparation replacement resumes after each archived store and preserves every old byte", () => {
  for (const interruptAfterMove of [1, 2, 3])
    replacementFixture((root, input) => {
      const rename = fs.renameSync;
      let moves = 0;
      try {
        fs.renameSync = ((source, destination) => {
          rename(source, destination);
          if (String(destination).includes(`${path.sep}archive${path.sep}`) && ++moves === interruptAfterMove)
            throw new Error("interrupted archive");
        }) as typeof fs.renameSync;
        assert.throws(() => replaceWorkspacePreparationEvidence(input), /interrupted archive/u);
      } finally {
        fs.renameSync = rename;
      }
      assert.equal(hasPendingWorkspacePreparationReplacement(root, "worker"), true);
      replaceWorkspacePreparationEvidence({
        ...input,
        validatePrevious: () => assert.fail("old state is already archived")
      });
      assert.equal(hasPendingWorkspacePreparationReplacement(root, "worker"), false);
      assert.equal(fs.readFileSync(path.join(root, "artifacts/worker/baseline.json"), "utf8"), "new baseline\n");
      assert.equal(fs.readFileSync(path.join(root, "artifacts/worker/preparation.json"), "utf8"), "new preparation\n");
      assert.equal(fs.existsSync(path.join(root, "snapshots/worker")), false);
      const archiveRoot = path.join(root, "workspace-preparation-replacements/worker");
      const completed = fs.readdirSync(archiveRoot).find((entry) => entry.startsWith("completed-"));
      assert.ok(completed);
      assert.equal(
        fs.readFileSync(path.join(archiveRoot, completed, "archive/snapshots/worker/source.sol"), "utf8"),
        "old source\n"
      );
    });
});

test("preparation replacement resumes interrupted replay and each evidence publication", () => {
  replacementFixture((root, input) => {
    assert.throws(
      () =>
        replaceWorkspacePreparationEvidence({
          ...input,
          rebuild: () => {
            throw new Error("interrupted replay");
          }
        }),
      /interrupted replay/u
    );
    assert.equal(hasPendingWorkspacePreparationReplacement(root, "worker"), true);
    replaceWorkspacePreparationEvidence(input);
  });
  for (const target of ["baseline.json", "preparation.json"])
    replacementFixture((root, input) => {
      const rename = fs.renameSync;
      try {
        fs.renameSync = ((source, destination) => {
          rename(source, destination);
          if (String(destination) === path.join(root, "artifacts/worker", target))
            throw new Error("interrupted publication");
        }) as typeof fs.renameSync;
        assert.throws(() => replaceWorkspacePreparationEvidence(input), /interrupted publication/u);
      } finally {
        fs.renameSync = rename;
      }
      replaceWorkspacePreparationEvidence(input);
      assert.equal(hasPendingWorkspacePreparationReplacement(root, "worker"), false);
    });
});

test("preparation replacement rejects changed authority, archived bytes and conflicting recreated stores", () => {
  for (const fault of ["authority", "archive", "recreated"] as const)
    replacementFixture((root, input) => {
      assert.throws(
        () =>
          replaceWorkspacePreparationEvidence({
            ...input,
            rebuild: () => {
              throw new Error("stop");
            }
          }),
        /stop/u
      );
      const archive = path.join(
        root,
        "workspace-preparation-replacements/worker/pending/archive/snapshots/worker/source.sol"
      );
      if (fault === "archive") fs.writeFileSync(archive, "tampered archive\n");
      if (fault === "recreated")
        fs.writeFileSync(path.join(root, "artifacts/worker/baseline.json"), "unexpected baseline\n");
      let rebuilt = false;
      assert.throws(
        () =>
          replaceWorkspacePreparationEvidence({
            ...input,
            dependencySha256: fault === "authority" ? "c".repeat(64) : input.dependencySha256,
            rebuild: () => {
              rebuilt = true;
            }
          }),
        /authority changed|evidence changed|conflicting preparation/u
      );
      assert.equal(rebuilt, false);
    });
});

test("preparation replacement refuses malformed or unsafe evidence before moving any source", () => {
  for (const fault of ["validation", "symlink", "hardlink"] as const)
    replacementFixture((root, input) => {
      if (fault === "symlink")
        fs.symlinkSync(path.join(root, "artifacts/worker/baseline.json"), path.join(root, "snapshots/worker/unsafe"));
      if (fault === "hardlink")
        fs.linkSync(path.join(root, "artifacts/worker/baseline.json"), path.join(root, "snapshots/worker/unsafe"));
      assert.throws(
        () =>
          replaceWorkspacePreparationEvidence({
            ...input,
            validatePrevious: () => {
              if (fault === "validation") throw new Error("malformed evidence");
            }
          }),
        /malformed evidence|unsafe preparation/u
      );
      assert.equal(fs.readFileSync(path.join(root, "artifacts/worker/baseline.json"), "utf8"), "old baseline\n");
      assert.equal(fs.readFileSync(path.join(root, "artifacts/worker/preparation.json"), "utf8"), "old preparation\n");
    });
});

test("preparation replacement preserves an interrupted uncommitted plan and retries without moving unknown staging", () => {
  replacementFixture((root, input) => {
    const rename = fs.renameSync;
    try {
      fs.renameSync = ((source, destination) => {
        if (String(destination).endsWith("/pending/replacement.json"))
          throw new Error("killed before plan publication");
        rename(source, destination);
      }) as typeof fs.renameSync;
      assert.throws(() => replaceWorkspacePreparationEvidence(input), /killed before plan publication/u);
    } finally {
      fs.renameSync = rename;
    }
    const pending = path.join(root, "workspace-preparation-replacements/worker/pending");
    const temporary = fs.readdirSync(pending)[0];
    assert.ok(temporary);
    const original = fs.readFileSync(path.join(pending, temporary));
    assert.equal(hasPendingWorkspacePreparationReplacement(root, "worker"), false);
    assert.equal(fs.readFileSync(path.join(root, "artifacts/worker/baseline.json"), "utf8"), "old baseline\n");
    replaceWorkspacePreparationEvidence(input);
    const parent = path.dirname(pending);
    const uncommitted = fs.readdirSync(parent).find((entry) => entry.startsWith("uncommitted-"));
    assert.ok(uncommitted);
    assert.deepEqual(fs.readFileSync(path.join(parent, uncommitted, temporary)), original);
  });
  replacementFixture((root, input) => {
    fs.mkdirSync(path.join(root, "workspace-preparation-replacements/worker/pending/archive"), { recursive: true });
    assert.throws(() => replaceWorkspacePreparationEvidence(input), /unrecognized pending/u);
    assert.equal(fs.readFileSync(path.join(root, "artifacts/worker/baseline.json"), "utf8"), "old baseline\n");
  });
});

test("preparation durability retains existing unsupported-directory fsync behavior", () => {
  for (const code of ["EINVAL", "ENOTSUP", "EOPNOTSUPP"])
    replacementFixture((root, input) => {
      const fsync = fs.fsyncSync;
      let directories = 0;
      let files = 0;
      try {
        fs.fsyncSync = (descriptor) => {
          if (fs.fstatSync(descriptor).isDirectory()) {
            directories += 1;
            throw Object.assign(new Error("unsupported directory fsync"), { code });
          }
          files += 1;
          fsync(descriptor);
        };
        writeWorkspacePreparationAuthority(root, "worker", input.replacementTree, input.dependencySha256);
        replaceWorkspacePreparationEvidence(input);
      } finally {
        fs.fsyncSync = fsync;
      }
      assert.ok(directories > 0);
      assert.ok(files > 0);
      assert.equal(hasPendingWorkspacePreparationReplacement(root, "worker"), false);
      assert.equal(fs.readFileSync(path.join(root, "artifacts/worker/baseline.json"), "utf8"), "new baseline\n");
    });
});

test("preparation durability still rejects directory IO errors and every file-fsync failure", () => {
  for (const [directory, code] of [
    [true, "EIO"],
    [false, "EIO"],
    [false, "EINVAL"],
    [false, "ENOTSUP"],
    [false, "EOPNOTSUPP"]
  ] as const)
    replacementFixture((root, input) => {
      const fsync = fs.fsyncSync;
      try {
        fs.fsyncSync = (descriptor) => {
          if (fs.fstatSync(descriptor).isDirectory() === directory)
            throw Object.assign(new Error("failed fsync"), { code });
          fsync(descriptor);
        };
        assert.throws(
          () => writeWorkspacePreparationAuthority(root, "worker", input.replacementTree, input.dependencySha256),
          { code }
        );
        assert.throws(() => replaceWorkspacePreparationEvidence(input), { code });
      } finally {
        fs.fsyncSync = fsync;
      }
      assert.equal(fs.readFileSync(path.join(root, "artifacts/worker/baseline.json"), "utf8"), "old baseline\n");
      assert.equal(fs.readFileSync(path.join(root, "artifacts/worker/preparation.json"), "utf8"), "old preparation\n");
    });
});
