import { createHash } from "node:crypto";
import { readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";

import type { ModalPromptVariant } from "./defaults.js";

const CONDITION_MARKER = "<!-- ultrafuzz-modal-condition:no-fuzzing -->";

export const NO_FUZZING_PROMPT_SUFFIX = `${CONDITION_MARKER}

## Experiment condition: property-guided analysis without fuzzing

This task is part of the no-fuzzing condition. Keep the task's scope, property
lens, strategy assignment, target allocation, evidence standards, and findings
contract unchanged. Property-specification tasks must still identify and record
the same kinds of properties. Strategy tasks must use those properties to look
for concrete production bugs by inspecting code and reasoning through reachable
states, transitions, calculations, permissions, and external interactions.

Do not create, modify, materialize, aggregate, repair, compile, list, run, or
execute fuzz tests, invariant tests, randomized tests, property-based tests,
generated tests, test harnesses, or test-only helper contracts. Do not invoke a
fuzzer or a command whose purpose is compiling, listing, or executing tests.
Reading existing tests as project evidence is allowed.

Continue producing every required non-test artifact and normal finding output.
When a generated-test manifest is required, write the valid manifest with empty
\`generated_tests\` and \`support_files\` arrays. Review tasks must still dedupe,
triage, classify, and report findings, but must not run, repair, copy, or
aggregate tests. Support evidence-based findings with precise source and
execution-path reasoning instead of executable-test evidence.

This condition replaces any conflicting instruction elsewhere in this task to
author, modify, compile, run, repair, or collect tests.`;

export interface AppliedPromptVariant {
  prompt_variant: ModalPromptVariant;
  modified_files: number;
  suffix_sha256?: string;
}

export async function applyPromptVariant(
  projectRoot: string,
  promptVariant: ModalPromptVariant
): Promise<AppliedPromptVariant> {
  if (promptVariant === "default") return { prompt_variant: promptVariant, modified_files: 0 };

  const promptRoot = path.join(projectRoot, ".ultrafuzz", "prompts");
  const promptPaths = await markdownPromptPaths(promptRoot);
  let modifiedFiles = 0;
  for (const promptPath of promptPaths) {
    const prompt = await readFile(promptPath, "utf8");
    if (prompt.includes(CONDITION_MARKER)) continue;
    await writeFile(promptPath, `${prompt.trimEnd()}\n\n${NO_FUZZING_PROMPT_SUFFIX}\n`);
    modifiedFiles += 1;
  }
  if (modifiedFiles === 0) throw new Error("no task prompts accepted the no-fuzzing condition suffix");
  return {
    prompt_variant: promptVariant,
    modified_files: modifiedFiles,
    suffix_sha256: createHash("sha256").update(NO_FUZZING_PROMPT_SUFFIX).digest("hex")
  };
}

async function markdownPromptPaths(root: string): Promise<string[]> {
  const paths: string[] = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const entryPath = path.join(root, entry.name);
    if (entry.isDirectory()) paths.push(...(await markdownPromptPaths(entryPath)));
    else if (entry.isFile() && entry.name.endsWith(".md")) paths.push(entryPath);
  }
  return paths.sort();
}
