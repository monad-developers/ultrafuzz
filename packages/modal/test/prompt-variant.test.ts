import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { applyPromptVariant, NO_FUZZING_PROMPT_SUFFIX } from "../src/prompt-variant.js";

async function promptFixture(): Promise<{ root: string; prompts: string[] }> {
  const root = await mkdtemp(path.join(tmpdir(), "ultrafuzz-prompt-condition-"));
  const promptRoot = path.join(root, ".ultrafuzz", "prompts");
  const prompts = [
    path.join(promptRoot, "properties", "specify.md"),
    path.join(promptRoot, "strategies", "round-trip.md"),
    path.join(promptRoot, "review", "final-report.md")
  ];
  for (const prompt of prompts) {
    await mkdir(path.dirname(prompt), { recursive: true });
    await writeFile(prompt, `---\nid: ${path.basename(prompt, ".md")}\n---\n\nOriginal task.\n`);
  }
  await writeFile(path.join(promptRoot, "template.mdx"), "Template remains unchanged.\n");
  return { root, prompts };
}

describe("Modal benchmark prompt conditions", () => {
  it("leaves every prompt byte-for-byte unchanged in the default condition", async () => {
    const { root, prompts } = await promptFixture();
    const before = await Promise.all(prompts.map((prompt) => readFile(prompt)));

    expect(await applyPromptVariant(root, "default")).toEqual({ prompt_variant: "default", modified_files: 0 });
    const after = await Promise.all(prompts.map((prompt) => readFile(prompt)));

    expect(after).toEqual(before);
  });

  it("appends the no-fuzzing condition last to every task prompt only", async () => {
    const { root, prompts } = await promptFixture();

    const applied = await applyPromptVariant(root, "no-fuzzing");

    expect(applied).toMatchObject({ prompt_variant: "no-fuzzing", modified_files: prompts.length });
    expect(applied.suffix_sha256).toMatch(/^[a-f0-9]{64}$/u);
    for (const prompt of prompts) {
      const content = await readFile(prompt, "utf8");
      expect(content.endsWith(`${NO_FUZZING_PROMPT_SUFFIX}\n`)).toBe(true);
      expect(content).toContain("Original task.");
    }
    expect(await readFile(path.join(root, ".ultrafuzz", "prompts", "template.mdx"), "utf8")).toBe(
      "Template remains unchanged.\n"
    );
  });
});
