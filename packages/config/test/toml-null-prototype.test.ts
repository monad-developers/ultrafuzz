import fs from "node:fs";

import type * as SmolToml from "smol-toml";
import { describe, expect, it, vi } from "vitest";

// smol-toml 1.9 builds every table with Object.create(null). The workspace
// lockfile resolves 1.7, but a packed install resolves the newest 1.x, so
// reproduce the 1.9 shape here.
vi.mock("smol-toml", async (importOriginal) => {
  const actual = await importOriginal<typeof SmolToml>();
  return { ...actual, parse: (text: string) => withNullPrototypes(actual.parse(text)) };
});

import { createDefaultResolvedConfig, parseProjectConfigToml } from "../src/index.js";

function withNullPrototypes(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withNullPrototypes);
  if (typeof value !== "object" || value === null || value instanceof Date) return value;
  const table = Object.create(null) as Record<string, unknown>;
  for (const [key, entry] of Object.entries(value)) table[key] = withNullPrototypes(entry);
  return table;
}

describe("TOML tables without a prototype", () => {
  it("load the shipped defaults and a project config", () => {
    const defaults = parseProjectConfigToml(fs.readFileSync(new URL("../defaults.toml", import.meta.url), "utf8"));
    expect(defaults.ok, JSON.stringify(defaults.diagnostics)).toBe(true);
    expect(createDefaultResolvedConfig().models.default).toBe("default");

    const project = parseProjectConfigToml(`
[models.fast]
agent = "CodexAgent"
model = "gpt-5.5"

[agents.CodexAgent]
auth = "subscription"
`);
    expect(project.ok, JSON.stringify(project.diagnostics)).toBe(true);
    if (!project.ok) return;
    expect(project.value.models?.profiles?.fast).toMatchObject({ agent: "CodexAgent", model: "gpt-5.5" });
  });
});
