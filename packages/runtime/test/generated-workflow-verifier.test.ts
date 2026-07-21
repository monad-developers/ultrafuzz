import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { assertRegularFileInside } from "@ultrafuzz/artifacts";

const runtimePackageRoot = findRuntimePackageRoot(path.dirname(fileURLToPath(import.meta.url)));
const workflowTemplatePath = path.join(runtimePackageRoot, "src", "templates", "smithers", "workflows", "workflow.tsx");

test("generated Smithers verifier rejects zero-byte generated-test companions", () => {
  const source = fs.readFileSync(workflowTemplatePath, "utf8");
  const helperStart = source.indexOf("function resolveNonEmptyRegularArtifactFile");
  const verifierStart = source.indexOf("function verifyGeneratedTestFiles");
  const workflowStart = source.indexOf("export default smithers");

  assert.ok(helperStart >= 0, source);
  assert.ok(verifierStart > helperStart, source);
  assert.ok(workflowStart > verifierStart, source);

  const helper = source.slice(helperStart, verifierStart);
  assert.match(
    source,
    /const \{ artifactContractDefinition, assertRegularFileInside, validateArtifactContract \} = await import/u
  );
  assert.match(source, /assertRegularFileInside\(artifactDir, artifactPath, failureMessage\)/u);
  assert.match(helper, /resolveRegularArtifactFile\(artifactDir, artifactPath, missingFailureMessage\)/u);
  assert.match(helper, /statSync\(resolvedPath\)\.size === 0/u);
  assert.match(helper, /throw new Error\(emptyFailureMessage\)/u);

  const generatedTestVerifier = source.slice(verifierStart, workflowStart);
  assert.match(generatedTestVerifier, /resolveNonEmptyRegularArtifactFile\(/u);
  assert.match(generatedTestVerifier, /generated test file is empty \$\{relativePath\}/u);
});

test("generated Smithers workflow prepares canonical empty sidecars and primary findings", () => {
  const source = fs.readFileSync(workflowTemplatePath, "utf8");
  const preparationStart = source.indexOf("function prepareArtifactMirror");
  const verifierStart = source.indexOf("function resolveRegularArtifactFile");

  assert.ok(preparationStart >= 0, source);
  assert.ok(verifierStart > preparationStart, source);

  const preparation = source.slice(preparationStart, verifierStart);
  assert.match(preparation, /function canonicalEmptyArtifact/u);
  assert.match(preparation, /output\.primary && output\.contract !== "ultrafuzz\/findings@1"/u);
  assert.match(preparation, /artifactContractDefinition\(output\.contract\)\.validEmptyExample/u);
  assert.match(source, /id=\{task\.preparationId\}/u);
  assert.match(source, /dependsOn=\{\[task\.preparationId\]\}/u);
});

test("generated Smithers agent preserves its final response as missing Markdown", () => {
  const source = fs.readFileSync(workflowTemplatePath, "utf8");
  const agentStart = source.indexOf("function artifactAwareAgent");
  const preparationStart = source.indexOf("function prepareArtifactMirror");

  assert.ok(agentStart >= 0, source);
  assert.ok(preparationStart > agentStart, source);

  const agent = source.slice(agentStart, preparationStart);
  assert.match(agent, /const result = await agent\.generate\(args\)/u);
  assert.match(agent, /prepareArtifactMirror\(task\)/u);
  assert.match(agent, /materializeMissingMarkdownArtifacts\(task, result\)/u);
  assert.match(agent, /normalizeLegacyReportProvenance\(task\)/u);
  assert.match(agent, /normalizeLegacyGeneratedTestManifests\(task\)/u);
  assert.match(agent, /materializeGeneratedTestCompanions\(task\)/u);
  assert.match(agent, /verifyArtifacts\(task\)/u);
  assert.match(source, /output\.contract !== "ultrafuzz\/nonempty-markdown@1"/u);
  assert.match(source, /const fallback = `# \$\{title\}\\n\\n\$\{summary\}\\n`/u);
});

test("generated Smithers agent normalizes legacy generated-test string lists", () => {
  const source = fs.readFileSync(workflowTemplatePath, "utf8");
  const normalizerStart = source.indexOf("function normalizeLegacyGeneratedTestManifests");
  const resolverStart = source.indexOf("function resolveRegularArtifactFile");

  assert.ok(normalizerStart >= 0, source);
  assert.ok(resolverStart > normalizerStart, source);

  const normalizer = source.slice(normalizerStart, resolverStart);
  assert.match(normalizer, /output\.contract !== "ultrafuzz\/generated-tests@1"/u);
  assert.match(normalizer, /validateArtifactContract\(output\.contract, contents, output\.path\)\.ok/u);
  assert.match(normalizer, /manifest\.generated_tests\.some\(\(entry\) => typeof entry === "string"\)/u);
  assert.match(normalizer, /typeof entry === "string" \? \{ path: entry \} : entry/u);
  assert.match(normalizer, /validateArtifactContract\(output\.contract, normalized, output\.path\)\.ok/u);
  assert.match(normalizer, /writeFileSync\(resolvedPath, normalized/u);
});

test("generated Smithers agent normalizes legacy finding field shapes", () => {
  const source = fs.readFileSync(workflowTemplatePath, "utf8");
  const normalizerStart = source.indexOf("function normalizeLegacyFindingFields");
  const generatedTestNormalizerStart = source.indexOf("function normalizeLegacyGeneratedTestManifests");

  assert.ok(normalizerStart >= 0, source);
  assert.ok(generatedTestNormalizerStart > normalizerStart, source);

  const normalizer = source.slice(normalizerStart, generatedTestNormalizerStart);
  assert.match(normalizer, /output\.contract !== "ultrafuzz\/findings@1"/u);
  assert.match(normalizer, /validateArtifactContract\(output\.contract, contents, output\.path\)\.ok/u);
  assert.match(normalizer, /typeof finding\.confidence === "number"/u);
  assert.match(normalizer, /Number\.isFinite\(finding\.confidence\)/u);
  assert.match(normalizer, /finding\.confidence = String\(finding\.confidence\)/u);
  assert.match(normalizer, /typeof strategy === "object" && strategy !== null && !Array\.isArray\(strategy\)/u);
  assert.match(normalizer, /\(strategy as Record<string, unknown>\)\.origin/u);
  assert.match(normalizer, /finding\.strategy = legacyStrategy\.trim\(\)/u);
  assert.match(normalizer, /typeof evidence === "string"/u);
  assert.match(normalizer, /finding\.evidence = \[evidence\]/u);
  assert.match(normalizer, /validateArtifactContract\(output\.contract, normalized, output\.path\)\.ok/u);
  assert.match(normalizer, /writeFileSync\(resolvedPath, normalized/u);
});

test("generated Smithers agent normalizes legacy unavailable report provenance fields", () => {
  const source = fs.readFileSync(workflowTemplatePath, "utf8");
  const normalizerStart = source.indexOf("function normalizeLegacyReportProvenance");
  const generatedTestNormalizerStart = source.indexOf("function normalizeLegacyGeneratedTestManifests");

  assert.ok(normalizerStart >= 0, source);
  assert.ok(generatedTestNormalizerStart > normalizerStart, source);

  const normalizer = source.slice(normalizerStart, generatedTestNormalizerStart);
  assert.match(normalizer, /output\.contract !== "ultrafuzz\/report@1"/u);
  assert.match(normalizer, /validateArtifactContract\(output\.contract, contents, output\.path\)\.ok/u);
  assert.match(normalizer, /report\.issues\.map/u);
  assert.match(normalizer, /normalizeLegacyFindingRecord\(entry\)/u);
  assert.match(normalizer, /normalizeFinalReportSeverityRecord\(normalized\.value\)/u);
  assert.match(normalizer, /originalIsValid/u);
  assert.match(normalizer, /\["implementation_paths", "test_paths"\]/u);
  assert.match(normalizer, /provenance\[field\] = \[\]/u);
  assert.match(normalizer, /\["fuzzer_backend", "fuzzer_backends"\]/u);
  assert.match(normalizer, /delete provenance\[field\]/u);
  assert.match(normalizer, /validateArtifactContract\(output\.contract, normalized, output\.path\)\.ok/u);
  assert.match(normalizer, /writeFileSync\(resolvedPath, normalized/u);
});

test("generated Smithers agent mirrors declared workspace tests before strict verification", () => {
  const source = fs.readFileSync(workflowTemplatePath, "utf8");
  const materializerStart = source.indexOf("function materializeGeneratedTestCompanions");
  const resolverStart = source.indexOf("function resolveRegularArtifactFile");

  assert.ok(materializerStart >= 0, source);
  assert.ok(resolverStart > materializerStart, source);

  const materializer = source.slice(materializerStart, resolverStart);
  assert.match(materializer, /const generatedPrefix = "generated-tests\/"/u);
  assert.match(materializer, /const directSourceCandidate = path\.resolve\(workspaceRoot, "test", "foundry"/u);
  assert.match(materializer, /path\.resolve\(workspaceRoot, "test", "foundry", nodeId, workspaceRelativePath\)/u);
  assert.match(materializer, /existsSync\(directSourceCandidate\)/u);
  assert.match(materializer, /existsSync\(nodeScopedSourceCandidate\)/u);
  assert.match(materializer, /resolveNonEmptyRegularArtifactFile\(workspaceRoot, sourceCandidate/u);
  assert.match(materializer, /sourceBefore\.nlink !== 1/u);
  assert.match(materializer, /writeFileSync\(anchoredArtifactPath, contents, \{ flag: "wx", mode: 0o600 \}\)/u);
  assert.match(materializer, /generated test copy mismatch/u);
});

test("generated Smithers verifier rejects in-root leaf and parent symlinks", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ultrafuzz-generated-verifier-"));
  const realDirectory = path.join(root, "real");
  fs.mkdirSync(realDirectory);
  const realFile = path.join(realDirectory, "Test.t.sol");
  fs.writeFileSync(realFile, "contract Test {}\n");

  const leafSymlink = path.join(root, "Leaf.t.sol");
  fs.symlinkSync(realFile, leafSymlink);
  assert.throws(() => assertRegularFileInside(root, leafSymlink), /symlink/u);

  const parentSymlink = path.join(root, "linked-parent");
  fs.symlinkSync(realDirectory, parentSymlink, "dir");
  assert.throws(() => assertRegularFileInside(root, path.join(parentSymlink, "Test.t.sol")), /symlink/u);
});

function findRuntimePackageRoot(start: string): string {
  let current = path.resolve(start);
  while (current !== path.dirname(current)) {
    const packageJsonPath = path.join(current, "package.json");
    if (fs.existsSync(packageJsonPath)) {
      const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, "utf8")) as { name?: string };
      if (packageJson.name === "@ultrafuzz/runtime") {
        return current;
      }
    }
    current = path.dirname(current);
  }
  throw new Error("could not locate @ultrafuzz/runtime package root");
}
