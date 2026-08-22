import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { writeDeterministicTarGzip } from "../src/deterministic-archive.js";

const temporaryRoots: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  for (const root of temporaryRoots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function temporaryRoot(prefix: string): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  temporaryRoots.push(root);
  return root;
}

describe("deterministic archive descriptor traversal", () => {
  it("produces identical bytes for the same safe tree", async () => {
    const temporary = temporaryRoot("ultrafuzz-deterministic-archive-");
    const source = path.join(temporary, "source");
    fs.mkdirSync(path.join(source, "nested"), { recursive: true });
    fs.writeFileSync(path.join(source, "root.txt"), "root\n");
    fs.writeFileSync(path.join(source, "nested", "child.txt"), "child\n");
    const first = path.join(temporary, "first.tar.gz");
    const second = path.join(temporary, "second.tar.gz");

    await writeDeterministicTarGzip(source, first);
    await writeDeterministicTarGzip(source, second);

    expect(fs.readFileSync(first)).toEqual(fs.readFileSync(second));
  });

  it("rejects an intermediate directory swapped to an outside symlink during traversal", async () => {
    const temporary = temporaryRoot("ultrafuzz-deterministic-archive-race-");
    const source = path.join(temporary, "source");
    const outside = path.join(temporary, "outside");
    const originalDirectory = path.join(source, "inside");
    const movedDirectory = path.join(source, "inside-original");
    fs.mkdirSync(originalDirectory, { recursive: true });
    fs.mkdirSync(outside);
    fs.writeFileSync(path.join(originalDirectory, "safe.txt"), "safe\n");
    fs.writeFileSync(path.join(outside, "secret.txt"), "must not cross the archive boundary\n");
    const output = path.join(temporary, "result.tar.gz");
    const originalLstat = fs.lstatSync.bind(fs) as typeof fs.lstatSync;
    let swapped = false;
    vi.spyOn(fs, "lstatSync").mockImplementation(((target: fs.PathLike, options?: fs.StatSyncOptions) => {
      const result = originalLstat(target, options);
      if (!swapped && path.basename(String(target)) === "inside") {
        swapped = true;
        fs.renameSync(originalDirectory, movedDirectory);
        fs.symlinkSync(outside, originalDirectory, "dir");
      }
      return result;
    }) as typeof fs.lstatSync);

    await expect(writeDeterministicTarGzip(source, output)).rejects.toThrow(
      /deterministic archive (?:excludes links|directory changed)/u
    );
    expect(swapped).toBe(true);
    expect(fs.existsSync(output)).toBe(false);
  });

  it("opens a file nonblocking before rejecting a regular-file-to-FIFO swap", async () => {
    const temporary = temporaryRoot("ultrafuzz-deterministic-archive-fifo-race-");
    const source = path.join(temporary, "source");
    const input = path.join(source, "input.txt");
    const movedInput = path.join(source, "input-original.txt");
    fs.mkdirSync(source);
    fs.writeFileSync(input, "input\n");
    const output = path.join(temporary, "result.tar.gz");
    const originalOpen = fs.openSync.bind(fs) as typeof fs.openSync;
    let fifoPeer: number | undefined;
    let swapped = false;
    let usedNonblockingOpen = false;
    vi.spyOn(fs, "openSync").mockImplementation(((target: fs.PathLike, flags: fs.OpenMode, mode?: fs.Mode) => {
      if (!swapped && path.basename(String(target)) === "input.txt") {
        swapped = true;
        fs.renameSync(input, movedInput);
        execFileSync("mkfifo", [input]);
        fifoPeer = originalOpen(input, fs.constants.O_RDWR | fs.constants.O_NONBLOCK);
        usedNonblockingOpen =
          typeof flags === "number" && (flags & fs.constants.O_NONBLOCK) === fs.constants.O_NONBLOCK;
      }
      return originalOpen(target, flags, mode);
    }) as typeof fs.openSync);

    try {
      await expect(writeDeterministicTarGzip(source, output)).rejects.toThrow("deterministic archive file is unsafe");
    } finally {
      if (fifoPeer !== undefined) fs.closeSync(fifoPeer);
    }
    expect(swapped).toBe(true);
    expect(usedNonblockingOpen).toBe(true);
    expect(fs.existsSync(output)).toBe(false);
  });

  it("rejects an output nested inside the source tree", async () => {
    const temporary = temporaryRoot("ultrafuzz-deterministic-archive-nested-output-");
    const source = path.join(temporary, "source");
    fs.mkdirSync(source);
    fs.writeFileSync(path.join(source, "input.txt"), "input\n");
    const output = path.join(source, "result.tar.gz");

    await expect(writeDeterministicTarGzip(source, output)).rejects.toThrow(
      "deterministic archive output must remain outside the archive root"
    );
    expect(fs.existsSync(output)).toBe(false);
  });

  it("rejects an output whose symlinked parent resolves inside the source tree", async () => {
    const temporary = temporaryRoot("ultrafuzz-deterministic-archive-aliased-output-");
    const source = path.join(temporary, "source");
    const sourceAlias = path.join(temporary, "source-alias");
    fs.mkdirSync(source);
    fs.writeFileSync(path.join(source, "input.txt"), "input\n");
    fs.symlinkSync(source, sourceAlias, "dir");
    const output = path.join(sourceAlias, "result.tar.gz");

    await expect(writeDeterministicTarGzip(source, output)).rejects.toThrow(
      "deterministic archive output must remain outside the archive root"
    );
    expect(fs.existsSync(path.join(source, "result.tar.gz"))).toBe(false);
  });

  it("preserves an incumbent output when exclusive creation fails", async () => {
    const temporary = temporaryRoot("ultrafuzz-deterministic-archive-existing-output-");
    const source = path.join(temporary, "source");
    fs.mkdirSync(source);
    fs.writeFileSync(path.join(source, "input.txt"), "input\n");
    const output = path.join(temporary, "result.tar.gz");
    fs.writeFileSync(output, "incumbent\n");

    await expect(writeDeterministicTarGzip(source, output)).rejects.toMatchObject({ code: "EEXIST" });
    expect(fs.readFileSync(output, "utf8")).toBe("incumbent\n");
  });

  it("rejects a caller-visible output file replaced after descriptor normalization", async () => {
    const temporary = temporaryRoot("ultrafuzz-deterministic-archive-output-swap-");
    const source = path.join(temporary, "source");
    fs.mkdirSync(source);
    fs.writeFileSync(path.join(source, "input.txt"), "input\n");
    const output = path.join(temporary, "result.tar.gz");
    const displacedOutput = path.join(temporary, "displaced.tar.gz");
    const originalFsync = fs.fsyncSync.bind(fs);
    let swapped = false;
    vi.spyOn(fs, "fsyncSync").mockImplementation((descriptor) => {
      originalFsync(descriptor);
      if (!swapped) {
        swapped = true;
        fs.renameSync(output, displacedOutput);
        fs.writeFileSync(output, "replacement\n");
      }
    });

    await expect(writeDeterministicTarGzip(source, output)).rejects.toThrow(
      "deterministic archive output changed while it was written"
    );
    expect(swapped).toBe(true);
    expect(fs.readFileSync(output, "utf8")).toBe("replacement\n");
    expect(fs.existsSync(displacedOutput)).toBe(true);
  });

  it("rejects a caller-visible output parent replaced after descriptor normalization", async () => {
    const temporary = temporaryRoot("ultrafuzz-deterministic-archive-output-parent-swap-");
    const source = path.join(temporary, "source");
    const outputParent = path.join(temporary, "output");
    const displacedParent = path.join(temporary, "output-displaced");
    fs.mkdirSync(source);
    fs.mkdirSync(outputParent);
    fs.writeFileSync(path.join(source, "input.txt"), "input\n");
    const output = path.join(outputParent, "result.tar.gz");
    const originalFsync = fs.fsyncSync.bind(fs);
    let swapped = false;
    vi.spyOn(fs, "fsyncSync").mockImplementation((descriptor) => {
      originalFsync(descriptor);
      if (!swapped) {
        swapped = true;
        fs.renameSync(outputParent, displacedParent);
        fs.mkdirSync(outputParent);
        fs.writeFileSync(output, "replacement\n");
      }
    });

    await expect(writeDeterministicTarGzip(source, output)).rejects.toThrow(
      "deterministic archive output changed while it was written"
    );
    expect(swapped).toBe(true);
    expect(fs.readFileSync(output, "utf8")).toBe("replacement\n");
    expect(fs.existsSync(path.join(displacedParent, "result.tar.gz"))).toBe(false);
  });
});
