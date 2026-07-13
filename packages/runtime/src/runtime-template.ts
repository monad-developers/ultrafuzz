import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const TEMPLATE_TOKEN = /__ULTRAFUZZ_[A-Z_]+__/gu;

export function loadRuntimeTemplate(relativePath: string): string {
  return fs.readFileSync(runtimeTemplatePath(relativePath), "utf8");
}

export function renderRuntimeTemplate(relativePath: string, replacements: Record<string, string>): string {
  const unused = new Set(Object.keys(replacements));
  const rendered = loadRuntimeTemplate(relativePath).replace(TEMPLATE_TOKEN, (token) => {
    const replacement = replacements[token];
    if (replacement === undefined) {
      throw new Error(`missing replacement for ${token} in runtime template ${relativePath}`);
    }
    unused.delete(token);
    return replacement;
  });
  if (unused.size > 0) {
    throw new Error(`runtime template ${relativePath} does not contain ${Array.from(unused).join(", ")}`);
  }
  return rendered;
}

export function renderSmithersPackageJson(): string {
  return `${JSON.stringify(
    {
      name: "ultrafuzz-smithers",
      private: true,
      type: "module",
      dependencies: {
        "smithers-orchestrator": "0.27.0",
        zod: "4.4.3"
      },
      devDependencies: {
        typescript: "6.0.3"
      }
    },
    null,
    2
  )}\n`;
}

function runtimeTemplatePath(relativePath: string): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const parts = relativePath.split("/");
  const candidates = [
    path.join(here, "templates", ...parts),
    path.resolve(here, "../src/templates", ...parts),
    path.resolve(here, "../../src/templates", ...parts)
  ];
  const found = candidates.find((candidate) => fs.existsSync(candidate));
  if (found === undefined) {
    throw new Error(`unable to locate runtime template ${relativePath} from ${here}`);
  }
  return found;
}
