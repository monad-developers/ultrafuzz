import { describe, expect, it } from "vitest";
import {
  diffPromptIdentity,
  isPlainPromptFrontmatterObject,
  parsePromptFrontmatter,
  PromptError
} from "../src/index.js";

describe("prompt frontmatter", () => {
  it("parses Markdown-compatible prompt frontmatter", () => {
    const parsed = parsePromptFrontmatter("---\nid: boundary-tests\ndisplay_name: Boundary Tests\n---\n# Body");

    expect(parsed.frontmatter).toMatchObject({
      id: "boundary-tests",
      display_name: "Boundary Tests"
    });
    expect(parsed.body).toBe("# Body");
  });

  it("rejects unsupported additional fields by default", () => {
    expect(() => parsePromptFrontmatter("---\nid: x\nowner: user\n---\nBody")).toThrow(PromptError);
  });

  it("can preserve documented unknown frontmatter when explicitly allowed", () => {
    const parsed = parsePromptFrontmatter("---\nid: x\nowner: user\n---\nBody", {
      allowUnknownFields: true
    });

    expect(parsed.unknownFrontmatter).toEqual({ owner: "user" });
  });

  it("rejects removed category frontmatter", () => {
    expect(() => parsePromptFrontmatter("---\nid: x\ncategory: custom\n---\nBody")).toThrow(/category/);
  });

  it("accepts only prototype-safe plain frontmatter mappings", () => {
    expect(isPlainPromptFrontmatterObject({ id: "plain" })).toBe(true);
    expect(isPlainPromptFrontmatterObject(Object.assign(Object.create(null) as object, { id: "null-prototype" }))).toBe(
      true
    );
    expect(isPlainPromptFrontmatterObject(Object.create({ inherited: "value" }) as object)).toBe(false);
    expect(
      isPlainPromptFrontmatterObject(
        new Proxy(
          {},
          {
            getPrototypeOf() {
              throw new Error("prototype trap");
            }
          }
        )
      )
    ).toBe(false);
  });

  it("treats display_name changes as labels only", () => {
    const before = "---\nid: boundary-tests\ndisplay_name: Boundary Tests\n---\nBody";
    const after = "---\nid: boundary-tests\ndisplay_name: Boundary Tests v2\n---\nBody";

    expect(diffPromptIdentity(before, after)).toEqual({
      idChanged: false,
      displayNameChanged: true,
      executionIdentityChanged: false,
      displayNameOnly: true
    });
  });
});
