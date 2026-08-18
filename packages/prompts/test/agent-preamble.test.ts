import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";

import { loadAgentPreambleTemplate, renderAgentPreambleTemplate } from "../src/index.js";

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

describe("agent preamble MDX", () => {
  it("preserves every accepted prepend byte and its first-attempt ordering", () => {
    const authorization = renderAgentPreambleTemplate("authorized-defensive-security-context");
    const boundary = renderAgentPreambleTemplate("untrusted-content-boundary");
    const runtime = renderAgentPreambleTemplate("topology-runtime-context", {
      timeout_seconds: "1800",
      finalization_reserve_seconds: "300",
      working_budget_seconds: "1500"
    });
    expect(sha256(authorization)).toBe("708458aee8dcfc26a35ca5778274b8f81146332ebc3227302aff8a98e60f2535");
    expect(sha256(boundary)).toBe("f25d5978ba27833deb062ebae4f7a21e9c3e7cc7ea48a0a49d49aceb3f9214a1");
    expect(sha256(runtime)).toBe("4a69d450f7e74b76233073dbc3937bf17030dbb961c1a9dc67d125ef344b74fc");

    const taskPrompt = "# Node-specific prompt\n\nDo the assigned work.";
    const withoutOperator = renderAgentPreambleTemplate("agent-prompt", {
      authorized_defensive_security_context: authorization,
      untrusted_content_boundary: boundary,
      runtime_context: runtime,
      operator_prompt: "",
      task_prompt: taskPrompt
    });
    const mandatoryPrefix = `${authorization}\n\n${boundary}\n\n${runtime}\n\n`;
    expect(withoutOperator).toBe(`${mandatoryPrefix}${taskPrompt}`);
    expect(Buffer.byteLength(mandatoryPrefix, "utf8")).toBe(1_233);
    expect(sha256(mandatoryPrefix)).toBe("2d185f87f5ca0aeb0150a7fd447e58888580b682c719ea7f85556e0fd693d7cf");

    const operatorPrompt = "Focus on authorization boundaries.";
    expect(
      renderAgentPreambleTemplate("agent-prompt", {
        authorized_defensive_security_context: authorization,
        untrusted_content_boundary: boundary,
        runtime_context: runtime,
        operator_prompt: `${operatorPrompt}\n\n`,
        task_prompt: taskPrompt
      })
    ).toBe(`${mandatoryPrefix}${operatorPrompt}\n\n${taskPrompt}`);
  });

  it("preserves the retry-only prepend and treats inserted values as data", () => {
    const previousFailure = "Error: deterministic verifier failure {{not_a_template_variable}}";
    const rendered = renderAgentPreambleTemplate("retry-failure", {
      previous_failure: previousFailure
    });
    expect(sha256(rendered)).toBe("64b67a40f0bc6c412d08b9ad692ed4c985bfed3c2f00f1fc1ca14615ba95b5bd");
    expect(rendered).toContain(previousFailure);
  });

  it("rejects missing and unknown composition variables", () => {
    expect(() => renderAgentPreambleTemplate("retry-failure")).toThrow(
      "missing agent preamble template variable: previous_failure"
    );
    expect(() =>
      renderAgentPreambleTemplate("untrusted-content-boundary", {
        unexpected: "value"
      })
    ).toThrow("unknown agent preamble template variable: unexpected");
    expect(loadAgentPreambleTemplate("agent-prompt")).toContain("{{operator_prompt}}{{task_prompt}}");
  });
});
