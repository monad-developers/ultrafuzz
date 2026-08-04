import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Materialize the checked-in JSON schemas where an isolated task workspace
 * can read them. The package ships the source JSON files alongside dist/, so
 * this works both from the source tree and from the production image.
 */
export function materializePromptSchemas(destination: string): string[] {
  const moduleDirectory = path.dirname(fileURLToPath(import.meta.url));
  const source = [
    path.resolve(moduleDirectory, "..", "schema"),
    path.resolve(moduleDirectory, "..", "..", "schema")
  ].find((candidate) => fs.existsSync(candidate));
  if (source === undefined) {
    throw new Error(`prompt schema source is unavailable near ${moduleDirectory}`);
  }
  const target = path.resolve(destination);
  const sourceStat = fs.lstatSync(source);
  if (!sourceStat.isDirectory() || sourceStat.isSymbolicLink()) {
    throw new Error(`prompt schema source is unavailable: ${source}`);
  }
  if (fs.existsSync(target)) {
    const targetStat = fs.lstatSync(target);
    if (!targetStat.isDirectory() || targetStat.isSymbolicLink()) {
      throw new Error(`prompt schema destination is unsafe: ${target}`);
    }
  } else {
    fs.mkdirSync(target, { recursive: true, mode: 0o700 });
  }

  const copied: string[] = [];
  for (const name of fs
    .readdirSync(source)
    .filter((entry) => entry.endsWith(".schema.json"))
    .sort()) {
    const sourcePath = path.join(source, name);
    const targetPath = path.join(target, name);
    const sourceEntry = fs.lstatSync(sourcePath);
    if (!sourceEntry.isFile() || sourceEntry.isSymbolicLink()) {
      throw new Error(`prompt schema source entry is unsafe: ${sourcePath}`);
    }
    if (fs.existsSync(targetPath)) {
      const targetEntry = fs.lstatSync(targetPath);
      if (!targetEntry.isFile() || targetEntry.isSymbolicLink()) {
        throw new Error(`prompt schema destination entry is unsafe: ${targetPath}`);
      }
    }
    fs.copyFileSync(sourcePath, targetPath);
    fs.chmodSync(targetPath, 0o600);
    copied.push(targetPath);
  }
  if (copied.length === 0) throw new Error(`prompt schema source is empty: ${source}`);
  return copied;
}
