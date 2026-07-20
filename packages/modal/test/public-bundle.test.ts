import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  MAX_PUBLIC_BENCHMARK_BUNDLE_BYTES,
  createPublicBenchmarkBundle,
  extractPublicBenchmarkBundle,
  parsePublicBenchmarkBundle,
  readPublicBenchmarkBundle
} from "../src/public-bundle.js";

const TEST_LINEAGE = {
  logical_run_id: "fixture-run",
  generation: 1,
  fingerprints: { config: "1".repeat(64), source: "2".repeat(64), image: "3".repeat(64) },
  model_fingerprint: "4".repeat(64)
};

describe("public Modal benchmark bundles", () => {
  it("hashes, validates, and extracts the scored generation and public reports", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ultrafuzz-public-bundle-"));
    const rowIds = ["target-a-runner-trial-1", "target-b-runner-trial-1"];
    const files = completePublicSources(root, rowIds);

    const bundle = createPublicBenchmarkBundle({
      benchmark: "evmbench",
      lane: "smoke",
      modelSlug: "gpt-5-6-luna",
      model: "gpt-5.6-luna",
      reasoning: "high",
      candidateCommit: "a".repeat(40),
      evalRunId: "eval-1",
      lineage: TEST_LINEAGE,
      createdAt: "2026-07-19T00:00:00.000Z",
      files
    });
    const output = path.join(root, "output");
    extractPublicBenchmarkBundle(bundle, output);
    for (const rowId of rowIds) {
      expect(fs.readFileSync(path.join(output, "reports", rowId, "report.json"), "utf8")).toContain("issues");
      expect(fs.readFileSync(path.join(output, "reports", rowId, "report.md"), "utf8")).toContain("Report");
      expect(fs.readFileSync(path.join(output, "reports", rowId, "findings.normalized.json"), "utf8")).toBe("[]\n");
    }
  });

  it("rejects traversal, duplicate paths, and tampered contents", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ultrafuzz-public-bundle-"));
    const bundle = createPublicBenchmarkBundle({
      benchmark: "ultrafuzz-bench",
      lane: "smoke",
      modelSlug: "claude-sonnet-5",
      model: "claude-sonnet-5",
      reasoning: "high",
      candidateCommit: "b".repeat(40),
      evalRunId: "eval-2",
      lineage: TEST_LINEAGE,
      files: completePublicSources(root, ["target-a-runner-trial-1"])
    });
    expect(() => parsePublicBenchmarkBundle({ ...bundle, files: [...bundle.files, bundle.files[0]] })).toThrow(
      /duplicate/u
    );
    expect(() =>
      parsePublicBenchmarkBundle({
        ...bundle,
        files: bundle.files.map((file, index) =>
          index === 0 ? { ...file, contents_base64: Buffer.from("tampered").toString("base64") } : file
        )
      })
    ).toThrow(/integrity/u);
    expect(() =>
      parsePublicBenchmarkBundle({
        ...bundle,
        files: bundle.files.map((file, index) => (index === 0 ? { ...file, path: "../eval.json" } : file))
      })
    ).toThrow();
  });

  it("bounds encoded file payloads and rejects an oversized local bundle before reading it", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ultrafuzz-public-bundle-size-"));
    const bundle = createPublicBenchmarkBundle({
      benchmark: "evmbench",
      lane: "smoke",
      modelSlug: "gpt-5-6-luna",
      model: "gpt-5.6-luna",
      reasoning: "high",
      candidateCommit: "9".repeat(40),
      evalRunId: "eval-size-bounds",
      lineage: TEST_LINEAGE,
      files: completePublicSources(root, ["target-a-runner-trial-1"])
    });
    const maxFileBase64Characters = 4 * Math.ceil((5 * 1024 * 1024) / 3);

    expect(() =>
      parsePublicBenchmarkBundle({
        ...bundle,
        files: bundle.files.map((file, index) =>
          index === 0 ? { ...file, contents_base64: "A".repeat(maxFileBase64Characters + 1) } : file
        )
      })
    ).toThrow(/too big/iu);

    const oversizedBundle = path.join(root, "oversized-public-results.json");
    const descriptor = fs.openSync(oversizedBundle, "wx", 0o600);
    try {
      fs.ftruncateSync(descriptor, MAX_PUBLIC_BENCHMARK_BUNDLE_BYTES + 1);
    } finally {
      fs.closeSync(descriptor);
    }
    expect(() => readPublicBenchmarkBundle(oversizedBundle)).toThrow(/exceeds the size limit/u);
  });

  it("requires the complete report triplet for every exact matrix row", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ultrafuzz-public-bundle-rows-"));
    const rowIds = ["target-a-runner-trial-1", "target-b-runner-trial-1"];
    const bundle = createPublicBenchmarkBundle({
      benchmark: "evmbench",
      lane: "smoke",
      modelSlug: "gpt-5-6-luna",
      model: "gpt-5.6-luna",
      reasoning: "high",
      candidateCommit: "e".repeat(40),
      evalRunId: "eval-row-coverage",
      lineage: TEST_LINEAGE,
      files: completePublicSources(root, rowIds)
    });

    for (const required of ["report.md", "report.json", "findings.normalized.json"]) {
      expect(() =>
        parsePublicBenchmarkBundle({
          ...bundle,
          files: bundle.files.filter((file) => file.path !== `reports/${rowIds[1]}/${required}`)
        })
      ).toThrow(new RegExp(`missing reports/${rowIds[1]}/${required.replace(".", "\\.")}`, "u"));
    }
  });

  it("rejects reports whose row directory is absent from the embedded matrix", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ultrafuzz-public-bundle-unexpected-row-"));
    const bundle = createPublicBenchmarkBundle({
      benchmark: "evmbench",
      lane: "smoke",
      modelSlug: "gpt-5-6-luna",
      model: "gpt-5.6-luna",
      reasoning: "high",
      candidateCommit: "f".repeat(40),
      evalRunId: "eval-unexpected-row",
      lineage: TEST_LINEAGE,
      files: completePublicSources(root, ["target-a-runner-trial-1"])
    });
    const report = bundle.files.find((file) => file.path.endsWith("/report.md"));
    if (report === undefined) throw new Error("missing report fixture");

    expect(() =>
      parsePublicBenchmarkBundle({
        ...bundle,
        files: [...bundle.files, { ...report, path: "reports/not-in-matrix/report.md" }]
      })
    ).toThrow(/unexpected matrix row/u);
  });

  it("rejects unsafe or duplicate row IDs in the embedded matrix", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ultrafuzz-public-bundle-matrix-id-"));
    const files = completePublicSources(root, ["target-a-runner-trial-1"]);
    const matrix = files.find((file) => file.path === "eval/matrix.json");
    if (matrix === undefined) throw new Error("missing matrix fixture");
    const input = {
      benchmark: "evmbench" as const,
      lane: "smoke" as const,
      modelSlug: "gpt-5-6-luna",
      model: "gpt-5.6-luna",
      reasoning: "high",
      candidateCommit: "1".repeat(40),
      evalRunId: "eval-invalid-matrix",
      lineage: TEST_LINEAGE,
      files
    };

    fs.writeFileSync(matrix.source, '[{"id":"../not-safe"}]\n');
    expect(() => createPublicBenchmarkBundle(input)).toThrow(/invalid ID/u);

    fs.writeFileSync(matrix.source, '[{"id":"target-a-runner-trial-1"},{"id":"target-a-runner-trial-1"}]\n');
    expect(() => createPublicBenchmarkBundle(input)).toThrow(/repeats row ID/u);
  });

  it("refuses to follow an agent-controlled report symlink", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ultrafuzz-public-bundle-symlink-"));
    const outside = path.join(os.tmpdir(), `ultrafuzz-secret-${process.pid}`);
    const report = path.join(root, "report.json");
    fs.writeFileSync(outside, "API_KEY=must-not-be-published\n");
    fs.symlinkSync(outside, report);

    expect(() =>
      createPublicBenchmarkBundle({
        benchmark: "evmbench",
        lane: "smoke",
        modelSlug: "gpt-5-6-luna",
        model: "gpt-5.6-luna",
        reasoning: "high",
        candidateCommit: "c".repeat(40),
        evalRunId: "eval-symlink",
        lineage: TEST_LINEAGE,
        files: [{ path: "reports/target-a/report.json", root, source: report }]
      })
    ).toThrow(/symlink/u);
  });

  it("refuses a pre-existing intermediate output symlink without writing through it", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ultrafuzz-public-bundle-output-intermediate-"));
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "ultrafuzz-public-bundle-outside-intermediate-"));
    const output = path.join(root, "output");
    fs.mkdirSync(output);
    fs.writeFileSync(path.join(outside, "sentinel.txt"), "unchanged\n");
    fs.symlinkSync(outside, path.join(output, "eval"));
    const bundle = createPublicBenchmarkBundle({
      benchmark: "evmbench",
      lane: "smoke",
      modelSlug: "gpt-5-6-luna",
      model: "gpt-5.6-luna",
      reasoning: "high",
      candidateCommit: "2".repeat(40),
      evalRunId: "eval-output-intermediate-symlink",
      lineage: TEST_LINEAGE,
      files: completePublicSources(root, ["target-a-runner-trial-1"])
    });

    expect(() => extractPublicBenchmarkBundle(bundle, output)).toThrow(/output contains a symbolic link/u);
    expect(fs.readFileSync(path.join(outside, "sentinel.txt"), "utf8")).toBe("unchanged\n");
    expect(fs.existsSync(path.join(outside, "eval.json"))).toBe(false);
  });

  it("refuses a pre-existing final output symlink without overwriting its target", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ultrafuzz-public-bundle-output-final-"));
    const outside = path.join(root, "outside-eval.json");
    const output = path.join(root, "output");
    fs.mkdirSync(path.join(output, "eval"), { recursive: true });
    fs.writeFileSync(outside, "outside remains unchanged\n");
    fs.symlinkSync(outside, path.join(output, "eval", "eval.json"));
    const bundle = createPublicBenchmarkBundle({
      benchmark: "evmbench",
      lane: "smoke",
      modelSlug: "gpt-5-6-luna",
      model: "gpt-5.6-luna",
      reasoning: "high",
      candidateCommit: "3".repeat(40),
      evalRunId: "eval-output-final-symlink",
      lineage: TEST_LINEAGE,
      files: completePublicSources(root, ["target-a-runner-trial-1"])
    });

    expect(() => extractPublicBenchmarkBundle(bundle, output)).toThrow(/output contains a symbolic link/u);
    expect(fs.readFileSync(outside, "utf8")).toBe("outside remains unchanged\n");
  });

  it("refuses a symlink in the requested output parent without creating files outside it", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ultrafuzz-public-bundle-output-parent-"));
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "ultrafuzz-public-bundle-outside-parent-"));
    const redirectedParent = path.join(root, "redirected-parent");
    fs.symlinkSync(outside, redirectedParent);
    const output = path.join(redirectedParent, "nested", "output");
    const bundle = createPublicBenchmarkBundle({
      benchmark: "evmbench",
      lane: "smoke",
      modelSlug: "gpt-5-6-luna",
      model: "gpt-5.6-luna",
      reasoning: "high",
      candidateCommit: "5".repeat(40),
      evalRunId: "eval-output-parent-symlink",
      lineage: TEST_LINEAGE,
      files: completePublicSources(root, ["target-a-runner-trial-1"])
    });

    expect(() => extractPublicBenchmarkBundle(bundle, output)).toThrow(/output parent.*symbolic link/u);
    expect(fs.existsSync(path.join(outside, "nested"))).toBe(false);
  });

  it("replaces a regular existing output tree without retaining stale files", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ultrafuzz-public-bundle-output-replace-"));
    const output = path.join(root, "output");
    fs.mkdirSync(path.join(output, "old"), { recursive: true });
    fs.writeFileSync(path.join(output, "old", "stale.txt"), "remove me\n");
    const bundle = createPublicBenchmarkBundle({
      benchmark: "ultrafuzz-bench",
      lane: "smoke",
      modelSlug: "claude-sonnet-5",
      model: "claude-sonnet-5",
      reasoning: "high",
      candidateCommit: "4".repeat(40),
      evalRunId: "eval-output-replacement",
      lineage: TEST_LINEAGE,
      files: completePublicSources(root, ["target-a-runner-trial-1"])
    });

    extractPublicBenchmarkBundle(bundle, output);

    expect(fs.existsSync(path.join(output, "old"))).toBe(false);
    expect(fs.readFileSync(path.join(output, "eval", "eval.json"), "utf8")).toContain("fixture-eval");
  });

  it("fails closed when a public source contains generic or exact injected secrets", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ultrafuzz-public-bundle-secret-"));
    const source = path.join(root, "report.md");
    const bundleInput = {
      benchmark: "evmbench" as const,
      lane: "smoke" as const,
      modelSlug: "gpt-5-6-luna",
      model: "gpt-5.6-luna",
      reasoning: "high",
      candidateCommit: "d".repeat(40),
      evalRunId: "eval-secret",
      lineage: TEST_LINEAGE,
      files: [{ path: "reports/target-a/report.md", root, source }]
    };

    fs.writeFileSync(source, "leaked sk-public-bundle-secret-123456\n");
    expect(() => createPublicBenchmarkBundle(bundleInput)).toThrow(/secret-like content/u);

    const injectedSecret = "opaque-provider-credential-value";
    fs.writeFileSync(source, `leaked ${injectedSecret}\n`);
    expect(() => createPublicBenchmarkBundle({ ...bundleInput, forbiddenSecretValues: [injectedSecret] })).toThrow(
      /injected secret value/u
    );
  });

  it("reapplies generic and exact secret checks to a self-consistent remote bundle", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ultrafuzz-public-bundle-remote-secret-"));
    const bundle = createPublicBenchmarkBundle({
      benchmark: "evmbench",
      lane: "smoke",
      modelSlug: "gpt-5-6-luna",
      model: "gpt-5.6-luna",
      reasoning: "high",
      candidateCommit: "5".repeat(40),
      evalRunId: "eval-remote-secret",
      lineage: TEST_LINEAGE,
      files: completePublicSources(root, ["target-a-runner-trial-1"])
    });
    const reportPath = "reports/target-a-runner-trial-1/report.md";

    expect(() =>
      parsePublicBenchmarkBundle(replaceBundleContents(bundle, reportPath, "leaked sk-proj-remote-123456\n"))
    ).toThrow(/secret-like content/u);
    const opaque = "opaque-remote-provider-credential";
    expect(() =>
      parsePublicBenchmarkBundle(replaceBundleContents(bundle, reportPath, `leaked ${opaque}\n`), [opaque])
    ).toThrow(/injected secret value/u);
  });
});

function replaceBundleContents(
  bundle: ReturnType<typeof createPublicBenchmarkBundle>,
  bundlePath: string,
  contents: string
): ReturnType<typeof createPublicBenchmarkBundle> {
  const encoded = Buffer.from(contents, "utf8");
  return {
    ...bundle,
    files: bundle.files.map((file) =>
      file.path === bundlePath
        ? {
            ...file,
            size_bytes: encoded.byteLength,
            sha256: crypto.createHash("sha256").update(encoded).digest("hex"),
            contents_base64: encoded.toString("base64")
          }
        : file
    )
  };
}

function completePublicSources(root: string, rowIds: string[]): Array<{ path: string; root: string; source: string }> {
  const evalRoot = path.join(root, "eval-source");
  const evalContents = new Map<string, string>([
    ["eval.json", `${JSON.stringify({ eval_run_id: "fixture-eval" }, null, 2)}\n`],
    ["matrix.json", `${JSON.stringify(realisticMatrix(rowIds), null, 2)}\n`],
    [
      "runs.jsonl",
      `${rowIds.map((rowId) => JSON.stringify({ row_id: rowId, final_status: "succeeded" })).join("\n")}\n`
    ],
    ["run-summary.json", `${JSON.stringify({ succeeded: rowIds.length }, null, 2)}\n`],
    ["scores.jsonl", `${rowIds.map((rowId) => JSON.stringify({ row_id: rowId, score: 1 })).join("\n")}\n`],
    ["summary.json", `${JSON.stringify({ rows: rowIds.map((rowId) => ({ row_id: rowId })) }, null, 2)}\n`],
    ["summary.md", "# Eval summary\n"]
  ]);
  const sources = [...evalContents].map(([name, contents]) => {
    const source = path.join(evalRoot, name);
    fs.mkdirSync(path.dirname(source), { recursive: true });
    fs.writeFileSync(source, contents);
    return { path: `eval/${name}`, root, source };
  });
  for (const rowId of rowIds) {
    for (const [name, contents] of [
      ["report.md", `# Report for ${rowId}\n`],
      ["report.json", `${JSON.stringify({ schema_version: "1.0", issues: [] }, null, 2)}\n`],
      ["findings.normalized.json", "[]\n"]
    ] as const) {
      const source = path.join(root, "report-source", rowId, name);
      fs.mkdirSync(path.dirname(source), { recursive: true });
      fs.writeFileSync(source, contents);
      sources.push({ path: `reports/${rowId}/${name}`, root, source });
    }
  }
  return sources;
}

function realisticMatrix(rowIds: string[]): unknown[] {
  return rowIds.map((id, index) => {
    const targetId = `target-${index + 1}`;
    return {
      id,
      target_id: targetId,
      variant_id: "runner",
      trial_id: "trial-1",
      run_id: `fixture-${id}`,
      target: {
        id: targetId,
        repo: "https://github.com/example/benchmark-target",
        ref: "1".repeat(40),
        ground_truth: `${targetId}.yml`,
        ground_truth_path: `/ground-truth/${targetId}.yml`
      },
      variant: { id: "runner", prompt_overlay_paths: [] },
      runner_model_profile: "gpt-5-6-luna",
      judge_model_profile: "gpt-5-6-sol"
    };
  });
}
