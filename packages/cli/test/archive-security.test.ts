import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import AdmZip from "adm-zip";

import { BundleArchive, MAX_BUNDLE_ARCHIVE_BYTES } from "../src/benchmark-analysis/lib/archive.js";

const roots: string[] = [];

test.afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

test("benchmark ZIP parsing rejects the CVE-2026-39244 forged allocation without expanding it", () => {
  const archivePath = temporaryPath("forged-size.zip");
  fs.writeFileSync(
    archivePath,
    craftForgedSizeZip("handoff/current-state.json", 3 * 1024 * 1024 * 1024, Buffer.from("A"))
  );

  const archive = new BundleArchive(archivePath);
  assert.throws(
    () => archive.readBuffer("handoff/current-state.json", Number.MAX_SAFE_INTEGER),
    /CRC32|invalid|entry|size/iu
  );
});

test("benchmark ZIP parsing rejects truncated and oversized compressed inputs", () => {
  assert.equal(MAX_BUNDLE_ARCHIVE_BYTES, 256 * 1024 * 1024);
  const valid = validBundle();
  const truncatedPath = temporaryPath("truncated.zip");
  fs.writeFileSync(truncatedPath, valid.subarray(0, valid.length - 10));
  assert.throws(() => new BundleArchive(truncatedPath));

  const oversizedPath = temporaryPath("oversized.zip");
  fs.writeFileSync(oversizedPath, Buffer.alloc(0));
  fs.truncateSync(oversizedPath, MAX_BUNDLE_ARCHIVE_BYTES + 1);
  assert.throws(() => new BundleArchive(oversizedPath), /exceeds|too large|maximum/iu);
});

test("benchmark ZIP parsing rejects duplicate and aliased central-directory names", () => {
  const duplicatePath = temporaryPath("duplicate.zip");
  fs.writeFileSync(duplicatePath, duplicateCentralDirectoryEntry(validBundle(), "handoff/current-state.json"));
  assert.throws(() => new BundleArchive(duplicatePath), /duplicate ZIP member/u);

  const aliased = new AdmZip();
  aliased.addFile("handoff/current-state.json", Buffer.from("{}\n"));
  aliased.addFile("x/handoff/current-state.json", Buffer.from("{}\n"));
  const aliasPath = temporaryPath("alias.zip");
  fs.writeFileSync(
    aliasPath,
    renameCentralDirectoryEntry(aliased.toBuffer(), "x/handoff/current-state.json", "./handoff/current-state.json")
  );
  assert.throws(() => new BundleArchive(aliasPath), /non-canonical ZIP member/u);
});

test("benchmark ZIP parsing applies selected-entry expansion budgets before extraction", () => {
  const zip = new AdmZip();
  zip.addFile("handoff/current-state.json", Buffer.alloc(2 * 1024 * 1024, 0x20));
  const archivePath = temporaryPath("ratio.zip");
  fs.writeFileSync(archivePath, zip.toBuffer());
  const archive = new BundleArchive(archivePath);
  assert.throws(() => archive.readBuffer("handoff/current-state.json", 1024), /exceeds 1024 bytes/u);
});

function temporaryPath(name: string): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ultrafuzz-archive-security-"));
  roots.push(root);
  return path.join(root, name);
}

function validBundle(): Buffer {
  const zip = new AdmZip();
  zip.addFile("handoff/current-state.json", Buffer.from("{}\n"));
  return zip.toBuffer();
}

function craftForgedSizeZip(nameValue: string, declaredSize: number, content: Buffer): Buffer {
  const name = Buffer.from(nameValue);
  const local = Buffer.concat([
    u32(0x04034b50),
    u16(20),
    u16(0),
    u16(0),
    u16(0),
    u16(0),
    u32(0),
    u32(content.length),
    u32(declaredSize),
    u16(name.length),
    u16(0),
    name,
    content
  ]);
  const central = Buffer.concat([
    u32(0x02014b50),
    u16(20),
    u16(20),
    u16(0),
    u16(0),
    u16(0),
    u16(0),
    u32(0),
    u32(content.length),
    u32(declaredSize),
    u16(name.length),
    u16(0),
    u16(0),
    u16(0),
    u16(0),
    u32(0),
    u32(0),
    name
  ]);
  const end = Buffer.concat([
    u32(0x06054b50),
    u16(0),
    u16(0),
    u16(1),
    u16(1),
    u32(central.length),
    u32(local.length),
    u16(0)
  ]);
  return Buffer.concat([local, central, end]);
}

function u16(value: number): Buffer {
  const bytes = Buffer.alloc(2);
  bytes.writeUInt16LE(value >>> 0);
  return bytes;
}

function u32(value: number): Buffer {
  const bytes = Buffer.alloc(4);
  bytes.writeUInt32LE(value >>> 0);
  return bytes;
}

function duplicateCentralDirectoryEntry(zipBytes: Buffer, entryName: string): Buffer {
  const { centralOffset, centralSize, endOffset } = centralDirectory(zipBytes);
  let offset = centralOffset;
  let selected: Buffer | undefined;
  while (offset < centralOffset + centralSize) {
    assert.equal(zipBytes.readUInt32LE(offset), 0x02014b50);
    const nameLength = zipBytes.readUInt16LE(offset + 28);
    const extraLength = zipBytes.readUInt16LE(offset + 30);
    const commentLength = zipBytes.readUInt16LE(offset + 32);
    const recordLength = 46 + nameLength + extraLength + commentLength;
    const name = zipBytes.subarray(offset + 46, offset + 46 + nameLength).toString("utf8");
    if (name === entryName) selected = Buffer.from(zipBytes.subarray(offset, offset + recordLength));
    offset += recordLength;
  }
  assert.ok(selected);
  const end = Buffer.from(zipBytes.subarray(endOffset));
  end.writeUInt16LE(end.readUInt16LE(8) + 1, 8);
  end.writeUInt16LE(end.readUInt16LE(10) + 1, 10);
  end.writeUInt32LE(centralSize + selected.length, 12);
  return Buffer.concat([zipBytes.subarray(0, endOffset), selected, end]);
}

function renameCentralDirectoryEntry(zipBytes: Buffer, entryName: string, replacement: string): Buffer {
  assert.equal(Buffer.byteLength(entryName), Buffer.byteLength(replacement));
  const copy = Buffer.from(zipBytes);
  const { centralOffset, centralSize } = centralDirectory(copy);
  let offset = centralOffset;
  while (offset < centralOffset + centralSize) {
    assert.equal(copy.readUInt32LE(offset), 0x02014b50);
    const nameLength = copy.readUInt16LE(offset + 28);
    const extraLength = copy.readUInt16LE(offset + 30);
    const commentLength = copy.readUInt16LE(offset + 32);
    const nameStart = offset + 46;
    const name = copy.subarray(nameStart, nameStart + nameLength).toString("utf8");
    if (name === entryName) {
      copy.write(replacement, nameStart, nameLength, "utf8");
      return copy;
    }
    offset += 46 + nameLength + extraLength + commentLength;
  }
  assert.fail(`missing ZIP central-directory entry ${entryName}`);
}

function centralDirectory(zipBytes: Buffer): { centralOffset: number; centralSize: number; endOffset: number } {
  for (let offset = zipBytes.length - 22; offset >= Math.max(0, zipBytes.length - 65_557); offset -= 1) {
    if (zipBytes.readUInt32LE(offset) === 0x06054b50) {
      return {
        centralOffset: zipBytes.readUInt32LE(offset + 16),
        centralSize: zipBytes.readUInt32LE(offset + 12),
        endOffset: offset
      };
    }
  }
  throw new Error("ZIP end-of-central-directory record is missing");
}
