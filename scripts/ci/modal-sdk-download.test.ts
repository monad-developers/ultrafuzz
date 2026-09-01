import { describe, expect, it } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { copyModalSandboxFileToLocal } from "../../packages/modal/dist/modal-download.js";

const PAYLOAD_BYTES = 4 * 1024 * 1024 + 257 * 1024;
const HELPER_ENTRYPOINT = path.resolve("packages/modal/test/modal-download-helper-fixture.mjs");
const FILTERED_PARENT_ENV = {
  PATH: process.env.PATH,
  HTTPS_PROXY: "http://fixture.invalid:8443",
  OPENROUTER_API_KEY: "must-not-reach-helper",
  OP_SERVICE_ACCOUNT_TOKEN: "must-not-reach-helper",
  UNRELATED_CONTROLLER_SECRET: "must-not-reach-helper",
  NODE_OPTIONS: "--unrelated-controller-option"
};

describe("Modal SDK downloads under Bun", () => {
  it("delegates copyToLocal transfers larger than pipe buffers to Node", async () => {
    expect(process.versions.bun).toBeDefined();
    const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "ultrafuzz-modal-bun-download-"));
    const destination = path.join(root, "result.tgz");
    let calledDirectly = false;
    try {
      await copyModalSandboxFileToLocal(
        {
          sandboxId: "sandbox-fixture",
          filesystem: {
            copyToLocal: async () => {
              calledDirectly = true;
              throw new Error("Bun must not consume Modal binary streams directly");
            }
          }
        },
        "/data/result.tgz",
        destination,
        { tokenId: "fixture-token-id", tokenSecret: "fixture-token-secret" },
        {
          helperEntrypoint: HELPER_ENTRYPOINT,
          env: FILTERED_PARENT_ENV
        }
      );

      expect(calledDirectly).toBe(false);
      expect(fs.statSync(destination).size).toBe(PAYLOAD_BYTES);
      expect(fs.readFileSync(destination).equals(Buffer.alloc(PAYLOAD_BYTES, 0x5a))).toBe(true);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("bounds helper stderr and leaves an existing destination untouched on failure", async () => {
    const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "ultrafuzz-modal-bun-download-failure-"));
    const destination = path.join(root, "result.tgz");
    const prior = Buffer.from("trusted prior publication\n", "utf8");
    fs.writeFileSync(destination, prior);
    try {
      let failure: unknown;
      try {
        await copyModalSandboxFileToLocal(
          {
            sandboxId: "sandbox-fixture",
            filesystem: { copyToLocal: async () => undefined }
          },
          "/data/stderr-failure",
          destination,
          { tokenId: "fixture-token-id", tokenSecret: "fixture-token-secret" },
          { helperEntrypoint: HELPER_ENTRYPOINT, env: FILTERED_PARENT_ENV }
        );
      } catch (error) {
        failure = error;
      }

      expect(failure).toBeInstanceOf(Error);
      expect((failure as Error & { cause?: { code?: string } }).cause?.code).toBe("ERR_CHILD_PROCESS_STDIO_MAXBUFFER");
      expect(fs.readFileSync(destination)).toEqual(prior);
      expect(fs.readdirSync(root)).toEqual(["result.tgz"]);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
