import { cpSync, mkdirSync, rmSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const source = fileURLToPath(new URL("../../../.ultrafuzz/prompts/", import.meta.url));
const destination = fileURLToPath(new URL("../dist/assets/prompts/", import.meta.url));

if (!statSync(source).isDirectory()) {
  throw new Error(`canonical prompt asset root is not a directory: ${source}`);
}

rmSync(destination, { recursive: true, force: true });
mkdirSync(path.dirname(destination), { recursive: true });
cpSync(source, destination, { recursive: true, force: true });
