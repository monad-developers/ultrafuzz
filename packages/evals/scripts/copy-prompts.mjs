import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const source = path.join(root, "src", "evaluator");
const target = path.join(root, "dist", "evaluator");
const promptFiles = fs.readdirSync(source).filter((fileName) => fileName.endsWith(".mdx"));

if (promptFiles.length === 0) {
  throw new Error("no evaluator prompt files found");
}

fs.mkdirSync(target, { recursive: true });
for (const fileName of promptFiles) {
  fs.copyFileSync(path.join(source, fileName), path.join(target, fileName));
}
