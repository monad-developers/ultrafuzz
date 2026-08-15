import assert from "node:assert/strict";
import { test } from "node:test";

import {
  assertHttpsGitRemote,
  assertSafeGitOperand,
  assertSafeGitRef,
  CONTROLLER_GIT_PROTOCOL_CONFIG,
  controllerGitArguments
} from "../src/index.js";

test("controller Git policy explicitly permits only HTTPS transports", () => {
  assert.deepEqual(CONTROLLER_GIT_PROTOCOL_CONFIG, [
    "-c",
    "protocol.allow=never",
    "-c",
    "protocol.https.allow=always",
    "-c",
    "protocol.ext.allow=never",
    "-c",
    "protocol.file.allow=never"
  ]);
  assert.deepEqual(controllerGitArguments(["ls-remote", "--", "https://github.com/example/repo.git", "HEAD"]), [
    ...CONTROLLER_GIT_PROTOCOL_CONFIG,
    "ls-remote",
    "--",
    "https://github.com/example/repo.git",
    "HEAD"
  ]);
});

test("Git operands reject option and remote-helper injection", () => {
  assert.equal(assertSafeGitOperand("origin", "remote"), "origin");
  for (const value of [
    "-upload-pack=malware",
    "ext::sh -c malware",
    "file::/etc/passwd",
    "bad\0remote",
    "bad\nremote"
  ]) {
    assert.throws(() => assertSafeGitOperand(value, "remote"), /safe Git operand/u);
  }
});

test("controller remotes are canonical credential-free HTTPS URLs", () => {
  assert.equal(assertHttpsGitRemote("https://github.com/example/repo.git"), "https://github.com/example/repo.git");
  for (const value of [
    "ssh://git@github.com/example/repo.git",
    "git://github.com/example/repo.git",
    "file:///tmp/repo",
    "ext::sh -c malware",
    "https://user:secret@github.com/example/repo.git",
    "-https://github.com/example/repo.git"
  ]) {
    assert.throws(() => assertHttpsGitRemote(value), /Git (?:operand|repository)|HTTPS/u);
  }
});

test("Git refs reject option-like and revision-expression inputs", () => {
  for (const value of ["main", "release/v0.1.0", "a".repeat(40)]) assert.equal(assertSafeGitRef(value), value);
  for (const value of [
    "--help",
    "HEAD^{tree}",
    "main..other",
    "refs/heads/.hidden",
    "bad ref",
    "main\n",
    "topic.lock"
  ]) {
    assert.throws(() => assertSafeGitRef(value), /Git ref/u);
  }
});
