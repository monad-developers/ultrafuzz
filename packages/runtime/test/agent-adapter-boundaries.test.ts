import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import test from "node:test";

type OrchestratorResponsibility =
  "argv-construction" | "filesystem-walking" | "output-interpretation" | "session-handling" | "token-accounting";

type AdapterPolicy = {
  maxLines: number;
  responsibilities: readonly OrchestratorResponsibility[];
  upstreamIssues: readonly string[];
};

const adapterPolicies: Record<string, AdapterPolicy> = {
  claude: {
    maxLines: 100,
    responsibilities: [],
    upstreamIssues: []
  },
  codex: {
    maxLines: 175,
    responsibilities: ["argv-construction", "session-handling"],
    upstreamIssues: ["https://github.com/smithersai/smithers/issues/1622"]
  },
  deepseek: {
    maxLines: 350,
    responsibilities: ["output-interpretation", "token-accounting"],
    upstreamIssues: ["https://github.com/smithersai/smithers/issues/1624"]
  },
  kimi: {
    maxLines: 1_525,
    responsibilities: [
      "argv-construction",
      "filesystem-walking",
      "output-interpretation",
      "session-handling",
      "token-accounting"
    ],
    upstreamIssues: ["https://github.com/smithersai/smithers/issues/1623"]
  },
  openrouter: {
    maxLines: 1_250,
    responsibilities: ["output-interpretation", "session-handling"],
    upstreamIssues: [
      "https://github.com/smithersai/smithers/issues/1622",
      "https://github.com/smithersai/smithers/issues/1625"
    ]
  }
};

const responsibilityPatterns: Record<OrchestratorResponsibility, readonly RegExp[]> = {
  "argv-construction": [/\bcommand\.args\b/u, /\bkimiCode029Args\b/u],
  "filesystem-walking": [/\breaddirSync\b/u, /\bopendirSync\b/u],
  "output-interpretation": [/\bcreateOutputInterpreter\b/u, /\bBufferedAttemptRelay\b/u],
  "session-handling": [/\bissuedSessionId\b/u, /\bresumeSession\b/u],
  "token-accounting": [/\binputTokens\b/u, /\boutputTokens\b/u, /\busage\.record\b/u]
};

function lineCount(source: string): number {
  return source.replace(/\n$/u, "").split("\n").length;
}

function detectedResponsibilities(source: string): OrchestratorResponsibility[] {
  return (Object.entries(responsibilityPatterns) as Array<[OrchestratorResponsibility, readonly RegExp[]]>)
    .filter(([, patterns]) => patterns.some((pattern) => pattern.test(source)))
    .map(([responsibility]) => responsibility)
    .sort();
}

test("shipped agent adapters stay inside their measured responsibility boundaries", (context) => {
  const packageRoot = [process.cwd(), path.resolve("packages/runtime")].find((candidate) =>
    existsSync(path.join(candidate, "src/templates/smithers/agents/index.tsx"))
  );
  assert.ok(packageRoot, "could not resolve the runtime package root");
  const agentsDir = path.join(packageRoot, "src/templates/smithers/agents");
  const indexSource = readFileSync(path.join(agentsDir, "index.tsx"), "utf8");
  const shippedAdapters = [
    ...new Set(
      [...indexSource.matchAll(/export \{ create[A-Za-z]+Agent \} from "\.\/([a-z0-9-]+)";/gu)].map(
        (match) => match[1]!
      )
    )
  ].sort();

  assert.deepEqual(
    Object.keys(adapterPolicies).sort(),
    shippedAdapters,
    "every shipped adapter must have an explicit measured policy"
  );

  for (const entry of readdirSync(agentsDir, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith(".tsx")) continue;
    const moduleName = entry.name.slice(0, -".tsx".length);
    if (adapterPolicies[moduleName] !== undefined) continue;
    const source = readFileSync(path.join(agentsDir, entry.name), "utf8");
    assert.deepEqual(
      detectedResponsibilities(source),
      [],
      `${entry.name} assumed an orchestrator responsibility outside a classified adapter`
    );
  }

  for (const adapter of shippedAdapters) {
    const policy = adapterPolicies[adapter]!;
    const source = readFileSync(path.join(agentsDir, `${adapter}.tsx`), "utf8");
    const lines = lineCount(source);
    const detected = detectedResponsibilities(source);
    context.diagnostic(
      `${adapter}.tsx: ${lines} lines; orchestrator responsibilities: ${detected.join(", ") || "none"}`
    );
    assert.ok(lines <= policy.maxLines, `${adapter}.tsx grew past its ${policy.maxLines}-line review ceiling`);
    assert.deepEqual(
      detected,
      [...policy.responsibilities].sort(),
      `${adapter}.tsx changed its orchestrator responsibilities; classify the change before accepting it`
    );
    if (detected.length > 0) {
      assert.ok(policy.upstreamIssues.length > 0, `${adapter}.tsx debt must link an upstream issue`);
    }
  }
});
