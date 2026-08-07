import { statSync } from "node:fs";
import { fileURLToPath } from "node:url";

/** Resolve packaged prompt assets first while retaining source-tree development. */
export function builtInPromptRoot(): string {
  const packaged = fileURLToPath(new URL("./assets/prompts/", import.meta.url));
  if (isDirectory(packaged)) {
    return packaged;
  }
  const sourceTree = fileURLToPath(new URL("../../../.ultrafuzz/prompts/", import.meta.url));
  if (isDirectory(sourceTree)) {
    return sourceTree;
  }
  throw new Error(`built-in prompt assets were not found in the package (${packaged}) or source tree (${sourceTree})`);
}

function isDirectory(candidate: string): boolean {
  try {
    return statSync(candidate).isDirectory();
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      return false;
    }
    throw error;
  }
}
