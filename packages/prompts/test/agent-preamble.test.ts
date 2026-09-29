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
    expect(sha256(runtime)).toBe("05b91daad522fea769116af2bbeb0aa1224129f8192b235ef2d7f8e4973ccfd2");

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
    expect(Buffer.byteLength(mandatoryPrefix, "utf8")).toBe(1_478);
    expect(sha256(mandatoryPrefix)).toBe("8b796bcd9dd9b811a0a655c928ad58badf1a037e79d9cc9097917a846804bb5f");

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

  it("tells agents to write friction entries into the run's friction directory", () => {
    const template = loadAgentPreambleTemplate("friction-log");
    // The directory is the only variable: nothing reaches the agent through the environment.
    expect(new Set([...template.matchAll(/\{\{\s*([A-Za-z0-9_]+)\s*\}\}/gu)].map((match) => match[1]))).toEqual(
      new Set(["friction_log_directory"])
    );
    expect(template).not.toMatch(/ULTRAFUZZ_FRICTION_LOG|\$[A-Z_]{3,}/u);
    const directory = "/runs/example/friction/.agents/friction-log";
    const fragment = renderAgentPreambleTemplate("friction-log", { friction_log_directory: directory });
    expect(fragment).toContain(`${directory}/<UTC time as YYYYMMDDHHMMSS>-`);
    expect(fragment).toContain("/friction.md");
    // The entry front matter and its five sections, in order.
    expect(fragment).toMatch(/---\ntitle: '[^\n]+'\nseverity: '[^\n]+'\n---/u);
    const sections = [
      "Expected Behavior",
      "Current Behavior",
      "Possible Solution",
      "Minimal Reproducible Example",
      "Context"
    ];
    const positions = sections.map((section) => fragment.indexOf(`## ${section}`));
    expect(positions.every((position) => position >= 0)).toBe(true);
    expect([...positions].sort((left, right) => left - right)).toEqual(positions);
    expect(fragment).toMatch(/Never include target source, findings/u);
    expect(Buffer.byteLength(fragment, "utf8")).toBeLessThanOrEqual(1_536);
  });

  it("treats inserted values as data", () => {
    // The inserted value names another bound variable; a second expansion pass would turn it into 1500.
    const rendered = renderAgentPreambleTemplate("topology-runtime-context", {
      timeout_seconds: "{{working_budget_seconds}}",
      finalization_reserve_seconds: "300",
      working_budget_seconds: "1500"
    });
    expect(rendered).toContain("- Timeout: {{working_budget_seconds}} seconds total.");
  });

  it("rejects missing and unknown composition variables", () => {
    expect(() => renderAgentPreambleTemplate("topology-runtime-context")).toThrow(
      "missing agent preamble template variable: timeout_seconds"
    );
    expect(() =>
      renderAgentPreambleTemplate("untrusted-content-boundary", {
        unexpected: "value"
      })
    ).toThrow("unknown agent preamble template variable: unexpected");
    expect(loadAgentPreambleTemplate("agent-prompt")).toContain("{{operator_prompt}}{{task_prompt}}");
  });
});
