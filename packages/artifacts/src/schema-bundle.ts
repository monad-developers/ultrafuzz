import fs from "node:fs";
import path from "node:path";

import {
  artifactSchemaDirectory,
  artifactSchemaRegistry,
  readRegularFileSnapshot,
  registeredSchemaForPath
} from "./schema-registry.js";

/**
 * Materialize the checked-in JSON schemas where an isolated task workspace
 * can read them. The package ships the source JSON files alongside dist/, so
 * this works both from the source tree and from the production image.
 */
export function materializePromptSchemas(destination: string): string[] {
  const source = artifactSchemaDirectory();
  const target = path.resolve(destination);
  assertNoSymlinkComponents(target);
  const sourceStat = fs.lstatSync(source);
  if (!sourceStat.isDirectory() || sourceStat.isSymbolicLink()) {
    throw new Error(`prompt schema source is unavailable: ${source}`);
  }
  if (fs.existsSync(target)) {
    const targetStat = fs.lstatSync(target);
    if (!targetStat.isDirectory() || targetStat.isSymbolicLink()) {
      throw new Error(`prompt schema destination is unsafe: ${target}`);
    }
    fs.chmodSync(target, 0o700);
  } else {
    fs.mkdirSync(target, { recursive: true, mode: 0o700 });
  }

  const copied: string[] = [];
  for (const schema of artifactSchemaRegistry()) {
    const name = schema.filename;
    const sourcePath = path.join(source, name);
    const targetPath = path.join(target, name);
    const sourceEntry = fs.lstatSync(sourcePath);
    if (!sourceEntry.isFile() || sourceEntry.isSymbolicLink() || sourceEntry.nlink !== 1) {
      throw new Error(`prompt schema source entry is unsafe: ${sourcePath}`);
    }
    if (fs.existsSync(targetPath)) {
      const targetEntry = fs.lstatSync(targetPath);
      if (!targetEntry.isFile() || targetEntry.isSymbolicLink() || targetEntry.nlink !== 1) {
        throw new Error(`prompt schema destination entry is unsafe: ${targetPath}`);
      }
      if (
        !readRegularFileSnapshot(targetPath, 16 * 1024 * 1024).equals(
          readRegularFileSnapshot(sourcePath, 16 * 1024 * 1024)
        )
      ) {
        throw new Error(`prompt schema destination differs from checked-in source: ${targetPath}`);
      }
    } else {
      fs.copyFileSync(sourcePath, targetPath);
    }
    fs.chmodSync(targetPath, 0o400);
    if (registeredSchemaForPath(targetPath)?.sha256 !== schema.sha256) {
      throw new Error(`prompt schema destination failed its pinned digest check: ${targetPath}`);
    }
    copied.push(targetPath);
  }
  if (copied.length === 0) throw new Error(`prompt schema source is empty: ${source}`);
  // Keep the schema files read-only while allowing the owning task/worktree
  // cleanup to unlink and recreate the directory.
  fs.chmodSync(target, 0o700);
  return copied;
}

function assertNoSymlinkComponents(candidate: string): void {
  const absolute = path.resolve(candidate);
  let current = path.parse(absolute).root;
  for (const segment of absolute.slice(current.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    if (fs.existsSync(current) && fs.lstatSync(current).isSymbolicLink()) {
      throw new Error(`prompt schema destination crosses a symlink: ${current}`);
    }
  }
}
