import { describe, expect, it } from "vitest";
import { parsePromptFrontmatter, PromptError } from "../src/index.js";

describe("prompt frontmatter", () => {
  it("parses Markdown-compatible prompt frontmatter", () => {
    const parsed = parsePromptFrontmatter("---\nid: boundary-tests\ndisplay_name: Boundary Tests\n---\n# Body");

    expect(parsed.frontmatter).toMatchObject({
      id: "boundary-tests",
      display_name: "Boundary Tests"
    });
    expect(parsed.body).toBe("# Body");
  });

  it("rejects unsupported additional fields", () => {
    expect(() => parsePromptFrontmatter("---\nid: x\nowner: user\n---\nBody")).toThrow(PromptError);
  });

  it("rejects removed category frontmatter", () => {
    expect(() => parsePromptFrontmatter("---\nid: x\ncategory: custom\n---\nBody")).toThrow(/category/);
  });
});
