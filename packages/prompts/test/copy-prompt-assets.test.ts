import { execFile } from "node:child_process";
import { existsSync, readdirSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const script = path.join(packageRoot, "scripts", "copy-prompt-assets.mjs");
const canonicalRoot = path.resolve(packageRoot, "../../.ultrafuzz/prompts");
const publishedRoot = path.join(packageRoot, "dist", "assets", "prompts");

function relativeFiles(root: string): string[] {
  const walk = (directory: string): string[] =>
    readdirSync(directory, { withFileTypes: true }).flatMap((entry) =>
      entry.isDirectory()
        ? walk(path.join(directory, entry.name))
        : [path.relative(root, path.join(directory, entry.name))]
    );
  return walk(root).sort();
}

describe("prompt asset publication", () => {
  it("publishes a complete tree even when several dependents build the package at once", async () => {
    // `pnpm -r test` builds this package from several dependents concurrently. Copying in place
    // would let one process delete the destination while another is mid-copy, which fails the
    // build with ENOENT and can leave a half-written asset tree behind.
    const results = await Promise.allSettled(
      Array.from({ length: 8 }, () => execFileAsync(process.execPath, [script], { cwd: packageRoot }))
    );
    const failures = results
      .filter((result): result is PromiseRejectedResult => result.status === "rejected")
      .map((result) => String(result.reason));
    expect(failures).toEqual([]);

    const expected = relativeFiles(canonicalRoot);
    expect(relativeFiles(publishedRoot)).toEqual(expected);
    for (const relativePath of expected) {
      expect(readFileSync(path.join(publishedRoot, relativePath), "utf8")).toBe(
        readFileSync(path.join(canonicalRoot, relativePath), "utf8")
      );
    }

    // No staging or superseded directory survives a concurrent publication.
    const leftovers = readdirSync(path.dirname(publishedRoot)).filter((entry) => entry.startsWith(".prompts."));
    expect(leftovers).toEqual([]);
    expect(existsSync(publishedRoot)).toBe(true);
  });

  it("republishes after the destination is removed", async () => {
    rmSync(publishedRoot, { recursive: true, force: true });
    await execFileAsync(process.execPath, [script], { cwd: packageRoot });
    expect(relativeFiles(publishedRoot)).toEqual(relativeFiles(canonicalRoot));
  });
});
