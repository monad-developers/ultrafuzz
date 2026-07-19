import { describe, expect, it } from "vitest";

import { convertAuditMarkdownGroundTruth } from "../src/ground-truth.js";

describe("Modal audit Markdown conversion", () => {
  it("deduplicates index links and detailed headings", () => {
    const converted = convertAuditMarkdownGroundTruth(
      [
        "| H-9001 | [[H-9001] - Example condition alpha](#h-9001-example-condition-alpha) |",
        "| M-9002 | [[M-9002] - Example condition beta](#m-9002-example-condition-beta) |",
        "## [H-9001] - Example condition alpha",
        "## [M-9002] - Example condition beta"
      ].join("\n"),
      2
    );

    expect(converted.bugs).toEqual([
      { id: "H-9001", title: "Example condition alpha", severity: "high" },
      { id: "M-9002", title: "Example condition beta", severity: "medium" }
    ]);
  });

  it("enforces the expected finding count", () => {
    expect(() => convertAuditMarkdownGroundTruth("## [L-9003] - Example condition", 2)).toThrow(
      "expected 2 ground-truth findings, found 1"
    );
  });

  it("accepts audit headings without punctuation after the issue ID", () => {
    expect(convertAuditMarkdownGroundTruth("## [H-9004] Example condition")).toEqual({
      bugs: [{ id: "H-9004", title: "Example condition", severity: "high" }]
    });
  });
});
