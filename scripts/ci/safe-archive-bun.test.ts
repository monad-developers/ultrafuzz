import { execFileSync } from "node:child_process";
import fs from "node:fs";
import type { FileHandle } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { expect, it } from "bun:test";

import { extractSafeTarArchive } from "../../packages/modal/src/safe-archive.js";

it("repeatedly extracts a synthetic archive without stalling Bun callbacks", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ultrafuzz-safe-archive-repeat-"));
  const source = path.join(root, "source");
  const archive = path.join(root, "synthetic.tar");
  try {
    fs.mkdirSync(path.join(source, "deep"), { recursive: true });
    fs.writeFileSync(path.join(source, "alpha.txt"), "alpha\n");
    fs.writeFileSync(path.join(source, "empty.txt"), "");
    fs.writeFileSync(path.join(source, "deep", "beta.txt"), "beta\n");
    fs.writeFileSync(path.join(source, "final-zero.txt"), "");
    execFileSync("tar", ["-cf", archive, "-C", source, "alpha.txt", "empty.txt", "deep/beta.txt", "final-zero.txt"]);

    for (let index = 0; index < 2_000; index += 1) {
      const destination = path.join(root, `destination-${String(index).padStart(5, "0")}`);
      fs.mkdirSync(destination);
      // The watchdog here guards against a genuine stall, not tight latency: on a loaded shared
      // CI runner a single scheduler pause routinely exceeds 500ms across 2,000 iterations and
      // failed the whole test (main run 32840972777). 5s per iteration still catches real stalls.
      await extractSafeTarArchive(archive, destination, {
        gzip: false,
        label: "synthetic repeated fixture",
        idleTimeoutMs: 5_000
      });
      expect(fs.readFileSync(path.join(destination, "alpha.txt"), "utf8")).toBe("alpha\n");
      expect(fs.readFileSync(path.join(destination, "empty.txt"), "utf8")).toBe("");
      expect(fs.readFileSync(path.join(destination, "deep", "beta.txt"), "utf8")).toBe("beta\n");
      expect(fs.readFileSync(path.join(destination, "final-zero.txt"), "utf8")).toBe("");
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}, 15_000);

it("rejects a synthetic archive stream that stops making progress", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ultrafuzz-safe-archive-stall-"));
  const source = path.join(root, "source");
  const completeArchive = path.join(root, "complete.tar");
  const stalledArchive = path.join(root, "stalled.tar");
  const destination = path.join(root, "destination");
  let writer: fs.WriteStream | undefined;
  try {
    fs.mkdirSync(source);
    fs.mkdirSync(destination);
    fs.writeFileSync(path.join(source, "alpha.txt"), "alpha\n");
    execFileSync("tar", ["-cf", completeArchive, "-C", source, "alpha.txt"]);
    execFileSync("mkfifo", [stalledArchive]);

    const archivePrefix = fs.readFileSync(completeArchive).subarray(0, 513);
    writer = fs.createWriteStream(stalledArchive);
    const extraction = extractSafeTarArchive(stalledArchive, destination, {
      gzip: false,
      label: "synthetic stalled fixture",
      idleTimeoutMs: 100
    });
    await new Promise<void>((resolve, reject) => {
      writer!.write(archivePrefix, (error) => {
        if (error) reject(error);
        else resolve();
      });
    });

    const startedAt = Date.now();
    await expect(extraction).rejects.toThrow("synthetic stalled fixture archive extraction made no progress for 100ms");
    expect(Date.now() - startedAt).toBeLessThan(2_000);
  } finally {
    writer?.destroy();
    fs.rmSync(root, { recursive: true, force: true });
  }
}, 5_000);

it("rejects when an asynchronous destination write stops making progress", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ultrafuzz-safe-archive-write-stall-"));
  const source = path.join(root, "source");
  const archive = path.join(root, "synthetic.tar");
  const destination = path.join(root, "destination");
  const originalOpen = fs.promises.open;
  let closeCalls = 0;
  try {
    fs.mkdirSync(source);
    fs.mkdirSync(destination);
    fs.writeFileSync(path.join(source, "alpha.txt"), "alpha\n");
    execFileSync("tar", ["-cf", archive, "-C", source, "alpha.txt"]);
    fs.promises.open = (async (target, flags, mode) => {
      const handle = await originalOpen(target, flags, mode);
      if (flags !== "wx") return handle;
      return {
        write: () => new Promise(() => undefined),
        close: async () => {
          closeCalls += 1;
          await handle.close();
        }
      } as FileHandle;
    }) as typeof fs.promises.open;

    const startedAt = Date.now();
    await expect(
      extractSafeTarArchive(archive, destination, {
        gzip: false,
        label: "synthetic write-stalled fixture",
        idleTimeoutMs: 100
      })
    ).rejects.toThrow("synthetic write-stalled fixture archive extraction made no progress for 100ms");
    expect(Date.now() - startedAt).toBeLessThan(2_000);
    expect(closeCalls).toBe(1);
  } finally {
    fs.promises.open = originalOpen;
    fs.rmSync(root, { recursive: true, force: true });
  }
}, 5_000);

it("closes an exclusive destination handle that opens after the deadline", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ultrafuzz-safe-archive-late-open-"));
  const source = path.join(root, "source");
  const archive = path.join(root, "synthetic.tar");
  const destination = path.join(root, "destination");
  const originalOpen = fs.promises.open;
  let closeCalls = 0;
  try {
    fs.mkdirSync(source);
    fs.mkdirSync(destination);
    fs.writeFileSync(path.join(source, "alpha.txt"), "alpha\n");
    execFileSync("tar", ["-cf", archive, "-C", source, "alpha.txt"]);
    fs.promises.open = (async (target, flags, mode) => {
      const handle = await originalOpen(target, flags, mode);
      if (flags !== "wx") return handle;
      const tracked = {
        write: handle.write.bind(handle),
        close: async () => {
          closeCalls += 1;
          await handle.close();
        }
      } as FileHandle;
      await new Promise((resolve) => setTimeout(resolve, 200));
      return tracked;
    }) as typeof fs.promises.open;

    await expect(
      extractSafeTarArchive(archive, destination, {
        gzip: false,
        label: "synthetic late-open fixture",
        idleTimeoutMs: 100
      })
    ).rejects.toThrow("synthetic late-open fixture archive extraction made no progress for 100ms");
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(closeCalls).toBe(1);
  } finally {
    fs.promises.open = originalOpen;
    fs.rmSync(root, { recursive: true, force: true });
  }
}, 5_000);
