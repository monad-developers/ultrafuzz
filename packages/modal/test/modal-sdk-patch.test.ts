import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { SandboxFilesystem } from "modal";
import { describe, expect, it, vi } from "vitest";

const PIPE_BOUNDARY_BYTES = 40 * 1024;

describe("patched Modal sandbox filesystem", () => {
  it("drains a large download while waiting for the remote process", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ultrafuzz-modal-download-"));
    const destination = path.join(root, "result.tgz");
    const payload = Buffer.alloc(PIPE_BOUNDARY_BYTES * 4, 0x5a);
    const process = backpressuredReadProcess(payload, 0);
    const filesystem = new SandboxFilesystem(async () => process as never);

    try {
      await expect(withTimeout(filesystem.copyToLocal("/data/result.tgz", destination))).resolves.toBeUndefined();
      expect(fs.readFileSync(destination)).toEqual(payload);
      expect(process.wait).toHaveBeenCalledOnce();
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("does not publish partial output when the remote reader exits nonzero", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ultrafuzz-modal-download-failure-"));
    const destination = path.join(root, "result.tgz");
    const prior = Buffer.from("trusted prior publication\n", "utf8");
    fs.writeFileSync(destination, prior);
    const payload = Buffer.alloc(PIPE_BOUNDARY_BYTES * 4, 0x41);
    const process = backpressuredReadProcess(
      payload,
      7,
      Buffer.from('{"error_kind":"Other","message":"synthetic failure"}')
    );
    const filesystem = new SandboxFilesystem(async () => process as never);

    try {
      await expect(withTimeout(filesystem.copyToLocal("/data/result.tgz", destination))).rejects.toThrow(
        /synthetic failure/u
      );
      expect(fs.readFileSync(destination)).toEqual(prior);
      expect(fs.readdirSync(root)).toEqual(["result.tgz"]);
      expect(process.stderr.readBytes).toHaveBeenCalledOnce();
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

function backpressuredReadProcess(payload: Uint8Array, exitCode: number, stderr = new Uint8Array()) {
  let offset = 0;
  let markStdoutDrained!: () => void;
  const stdoutDrained = new Promise<void>((resolve) => {
    markStdoutDrained = resolve;
  });
  const stdout = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (offset === payload.byteLength) {
        controller.close();
        markStdoutDrained();
        return;
      }
      const end = Math.min(offset + 16 * 1024, payload.byteLength);
      controller.enqueue(payload.slice(offset, end));
      offset = end;
    }
  });

  return {
    stdout,
    stderr: { readBytes: vi.fn(async () => stderr) },
    wait: vi.fn(async () => {
      await stdoutDrained;
      return exitCode;
    })
  };
}

async function withTimeout<T>(operation: Promise<T>): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => reject(new Error("download did not drain stdout concurrently")), 2_000);
      })
    ]);
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
}
