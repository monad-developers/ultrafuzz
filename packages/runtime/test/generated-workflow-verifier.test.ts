import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { assertRegularFileInside, writeFileDurable } from "@ultrafuzz/artifacts";

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
  assert.match(source, /artifactContractDefinition,[\s\S]*assertRegularFileInside,[\s\S]*validateArtifactContract/u);
  assert.match(source, /validateArtifactContract,[\s\S]*writeFileDurable[\s\S]*= await import/u);
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
  assert.match(
    preparation,
    /output\.contract === "ultrafuzz\/invariant-ledger@1" \|\| output\.contract === "ultrafuzz\/properties@1"/u
  );
  assert.match(preparation, /source-completeness and provenance joins/u);
  assert.match(preparation, /artifactContractDefinition\(output\.contract\)\.validEmptyExample/u);
  assert.match(source, /id=\{task\.preparationId\}/u);
  assert.match(source, /dependsOn=\{\[task\.preparationId\]\}/u);
});

test("generated Smithers workflow prefers its relocatable task prompt path", () => {
  const source = fs.readFileSync(workflowTemplatePath, "utf8");
  assert.match(source, /const promptPath = task\.promptPath \?\? inputTask\?\.prompt_path/u);
});

test("generated Smithers verifier explains byte-preserving invariant evidence", () => {
  const source = fs.readFileSync(workflowTemplatePath, "utf8");
  assert.match(source, /Derive verbatim from the cited source with a JSON serializer/u);
  assert.match(source, /repeated backslashes and other literals remain intact/u);
  const helperStart = source.indexOf("function normalizeInvariantSourceLines");
  const workflowStart = source.indexOf("export default smithers");
  assert.ok(helperStart >= 0, source);
  assert.ok(workflowStart > helperStart, source);
  assert.match(source.slice(helperStart, workflowStart), /\.join\("\\n"\)/u);
  assert.match(source, /invariantSymbolDeclaration\([^)]*\)\.split\(\/\\r\?\\n\/u\)/u);
});

test("generated Smithers worktrees fail closed on any source other than the pinned benchmark ref", () => {
  const source = fs.readFileSync(workflowTemplatePath, "utf8");
  const proofStart = source.indexOf("function preservePinnedSourceProof");
  const preparationStart = source.indexOf("function prepareArtifactMirror");
  const workflowStart = source.indexOf("export default smithers");

  assert.ok(proofStart > preparationStart, source);
  assert.ok(workflowStart > proofStart, source);
  assert.match(source, /const pinnedSourceBranch = "ultrafuzz-pinned"/u);
  assert.match(source, /\.\.\.\(usesPinnedSource \? \{ baseBranch: pinnedSourceBranch \} : \{\}\)/u);
  assert.match(source, /if \(!usesPinnedSource\) return/u);
  assert.match(source, /preservePinnedSourceProof\(task\)/u);
  assert.match(source, /git\(\["rev-parse", "HEAD"\]\)/u);
  assert.match(source, /git\(\["rev-parse", pinnedSourceRef\]\)/u);
  assert.match(source, /git\(\["rev-list", "--all"\]\)/u);
  assert.match(source, /git\(\["cat-file", "--batch-all-objects", "--batch-check=%\(objecttype\)"\]\)/u);
  assert.match(source, /git\(\["remote"\]\)/u);
  assert.match(source, /source-isolation failure/u);
  assert.match(source, /"source-proofs"/u);
  assert.match(source, /path\.resolve\(process\.cwd\(\), task\.metadata\.artifacts\.dir, "\.\.", "\.\."\)/u);
  assert.doesNotMatch(source.slice(proofStart, workflowStart), /task\.runRoot/u);
  assert.match(source, /ultrafuzz\.agent-source-proof\.v1/u);
});

test("generated Smithers retries reset exact task-owned artifact contents after the first attempt", () => {
  const source = fs.readFileSync(workflowTemplatePath, "utf8");
  const agentStart = source.indexOf("function artifactAwareAgent");
  const rootsStart = source.indexOf("function resetTaskArtifactsForRetry");
  const preparationStart = source.indexOf("function prepareArtifactMirror");

  assert.ok(agentStart >= 0, source);
  assert.ok(rootsStart > agentStart, source);
  assert.ok(preparationStart > rootsStart, source);

  const agent = source.slice(agentStart, rootsStart);
  assert.match(agent, /if \(\(args\?\.taskContext\?\.attempt \?\? 1\) > 1\)/u);
  assert.ok(agent.indexOf("resetTaskArtifactsForRetry(task)") < agent.indexOf("await agent.generate(args)"), agent);

  const reset = source.slice(rootsStart, preparationStart);
  assert.match(
    reset,
    /resetTaskArtifactContents\(task\.metadata\.artifacts\.dir, task\.attemptId, "canonical", task\.promptPath\)/u
  );
  assert.match(
    reset,
    /resetTaskArtifactContents\(path\.join\(artifactsParent, task\.attemptId\), task\.attemptId, "mirror"\)/u
  );
  assert.match(reset, /output\.contract === "ultrafuzz\/generated-tests@1"/u);
  assert.match(reset, /path\.resolve\(workspaceRoot, "test", "foundry"\)/u);
  assert.match(
    reset,
    /path\.join\(foundryParent, task\.metadata\.node\.logicalNodeId\),\s*task\.metadata\.node\.logicalNodeId,\s*"generated-test"/u
  );
  assert.match(reset, /path\.basename\(candidate\) !== attemptId/u);
  assert.match(reset, /const parent = realpathSync\(path\.dirname\(candidate\)\)/u);
  assert.match(reset, /const anchoredRoot = realpathSync\(candidate\)/u);
  assert.match(reset, /anchoredRoot !== path\.join\(parent, attemptId\)/u);
  assert.match(reset, /const preservedInput =/u);
  assert.match(reset, /candidate === preservedInput/u);
  assert.match(reset, /for \(const entry of readdirSync\(anchoredRoot\)\)/u);
  assert.match(reset, /rmSync\(candidate, \{ recursive: true, force: true \}\)/u);
  assert.match(reset, /prepareArtifactMirror\(task\)/u);
});

test("generated Smithers agent preserves its final response as missing non-report Markdown", () => {
  const source = fs.readFileSync(workflowTemplatePath, "utf8");
  const agentStart = source.indexOf("function artifactAwareAgent");
  const preparationStart = source.indexOf("function prepareArtifactMirror");

  assert.ok(agentStart >= 0, source);
  assert.ok(preparationStart > agentStart, source);

  const agent = source.slice(agentStart, preparationStart);
  assert.match(agent, /const result = await agent\.generate\(args\)/u);
  assert.match(agent, /prepareArtifactMirror\(task\)/u);
  assert.match(agent, /materializeMissingMarkdownArtifacts\(task, result\)/u);
  assert.match(agent, /materializeMissingFinalReportArtifacts\(task\)/u);
  assert.match(agent, /normalizeLegacyReportProvenance\(task\)/u);
  assert.match(agent, /normalizeLegacyGeneratedTestManifests\(task\)/u);
  assert.match(agent, /materializeGeneratedTestCompanions\(task\)/u);
  assert.match(agent, /verifyArtifacts\(task\)/u);
  assert.match(source, /output\.contract !== "ultrafuzz\/nonempty-markdown@1"/u);
  assert.match(source, /const fallback = `# \$\{title\}\\n\\n\$\{summary\}\\n`/u);
});

test("generated Smithers agent retains validated strategy findings when dedupe output is missing", () => {
  const source = fs.readFileSync(workflowTemplatePath, "utf8");
  const fallbackStart = source.indexOf("function materializeMissingDedupeArtifact");
  const finalReportStart = source.indexOf("function materializeMissingFinalReportArtifacts");

  assert.ok(fallbackStart >= 0, source);
  assert.ok(finalReportStart > fallbackStart, source);

  const fallback = source.slice(fallbackStart, finalReportStart);
  assert.match(fallback, /logicalNodeId !== "dedupe-findings"/u);
  assert.match(fallback, /candidate\.primary && candidate\.path === "deduped-findings\.json"/u);
  assert.match(fallback, /output\.contract !== "ultrafuzz\/findings@1"/u);
  assert.match(fallback, /validation\.value\.length > 0/u);
  assert.match(fallback, /task\.metadata\.dependencies\.attemptIds/u);
  assert.match(fallback, /validateArtifactContract\(\s*"ultrafuzz\/findings@1"/u);
  assert.match(fallback, /normalizeLegacyFindingArray\(contents\)/u);
  assert.match(fallback, /writeFileDurable\(candidatePath, normalized\)/u);
  assert.match(fallback, /retained\.push\(\.\.\.validation\.value\)/u);
  assert.match(fallback, /JSON\.stringify\(retained, null, 2\)/u);
  assert.match(fallback, /writeFileDurable\(outputPath, serialized\)/u);
  assert.doesNotMatch(fallback, /writeFileSync\(/u);
});

test("durable dedupe recovery replaces a symlink without overwriting its target", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ultrafuzz-dedupe-recovery-"));
  try {
    const symlinkTarget = path.join(root, "target.json");
    const recoveredOutput = path.join(root, "deduped-findings.json");
    fs.writeFileSync(symlinkTarget, "target remains unchanged\n");
    fs.symlinkSync(symlinkTarget, recoveredOutput);

    writeFileDurable(recoveredOutput, "[]\n");

    assert.equal(fs.readFileSync(symlinkTarget, "utf8"), "target remains unchanged\n");
    assert.equal(fs.lstatSync(recoveredOutput).isSymbolicLink(), false);
    assert.equal(fs.readFileSync(recoveredOutput, "utf8"), "[]\n");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("generated Smithers agent fails closed instead of promoting dedupe findings into a final report", () => {
  const source = fs.readFileSync(workflowTemplatePath, "utf8");
  const fallbackStart = source.indexOf("function materializeMissingFinalReportArtifacts");
  const reportReaderStart = source.indexOf("function meaningfulFinalReport");

  assert.ok(fallbackStart >= 0, source);
  assert.ok(reportReaderStart > fallbackStart, source);

  const fallback = source.slice(fallbackStart, reportReaderStart);
  assert.match(fallback, /logicalNodeId !== "final-report"/u);
  assert.match(fallback, /candidate\.path === "report\.json" && candidate\.contract === "ultrafuzz\/report@1"/u);
  assert.match(fallback, /candidate\.path === "findings\.normalized\.json"/u);
  assert.match(fallback, /if \(report === undefined\) \{[\s\S]*?return;\s*\}/u);
  assert.match(fallback, /writeValidatedTaskArtifact\(task, reportOutput, report\)/u);
  assert.match(fallback, /let findings = normalizedFindingArray\(report\.issues\)/u);
  assert.doesNotMatch(fallback, /dedupe-findings|retainedDedupeFindings|recoveredReport|artifact_recovery/u);
  assert.doesNotMatch(source, /function normalizedFallbackReportIssue|issue\.impact =|issue\.likelihood =/u);
});

test("generated Smithers agent leaves final-report Markdown to the final-review worker", () => {
  const source = fs.readFileSync(workflowTemplatePath, "utf8");
  const markdownStart = source.indexOf("function materializeMissingMarkdownArtifacts");
  const summaryStart = source.indexOf("function agentResultSummary");
  const finalReportStart = source.indexOf("function materializeMissingFinalReportArtifacts");
  const reportReaderStart = source.indexOf("function meaningfulFinalReport");

  assert.ok(markdownStart >= 0, source);
  assert.ok(summaryStart > markdownStart, source);
  assert.ok(finalReportStart > summaryStart, source);
  assert.ok(reportReaderStart > finalReportStart, source);

  const markdownFallback = source.slice(markdownStart, summaryStart);
  assert.match(
    markdownFallback,
    /task\.metadata\.node\.logicalNodeId === "final-report" && output\.path === "report\.md"/u
  );
  assert.match(markdownFallback, /continue;/u);

  const finalReportFallback = source.slice(finalReportStart, reportReaderStart);
  assert.doesNotMatch(finalReportFallback, /report\.md|markdown|writeValidatedTextArtifact/u);
  assert.doesNotMatch(source, /function writeRecoveredReportMarkdown|function writeValidatedTextArtifact/u);
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

test("generated Smithers agent strips line suffixes from safe finding path fields", () => {
  const source = fs.readFileSync(workflowTemplatePath, "utf8");
  const normalizerStart = source.indexOf("function normalizeLegacyFindingFields");
  const generatedTestNormalizerStart = source.indexOf("function normalizeLegacyGeneratedTestManifests");

  assert.ok(normalizerStart >= 0, source);
  assert.ok(generatedTestNormalizerStart > normalizerStart, source);

  const normalizer = source.slice(normalizerStart, generatedTestNormalizerStart);
  assert.match(normalizer, /\["affected_files", "patch_refs"\] as const/u);
  assert.match(normalizer, /normalizeLegacyPathReferences\(finding\[key\]\)/u);
  assert.match(normalizer, /finding\[key\] = normalizedPaths\.value/u);
  assert.match(normalizer, /function normalizeLegacyPathReference/u);
  assert.ok(normalizer.includes("trimmed.match(/^(.+?)#L\\d+(?:-L?\\d+)?$/u)"));
  assert.ok(normalizer.includes("withoutHashLineSuffix.match(/^(.+?):\\d+(?::\\d+)?$/u)"));
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
  assert.match(normalizer, /"affected_files"/u);
  assert.match(normalizer, /"affected_functions"/u);
  assert.match(normalizer, /"patch_refs"/u);
  assert.match(normalizer, /"property_ids"/u);
  assert.match(normalizer, /"notes"/u);
  assert.match(normalizer, /finding\[key\] = \[value\.trim\(\)\]/u);
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

test("generated Smithers workflow preserves the complete invariant suite across worktree handoffs", () => {
  const source = fs.readFileSync(workflowTemplatePath, "utf8");
  const preparationStart = source.indexOf("function prepareArtifactMirror");
  const resolverStart = source.indexOf("function resolveRegularArtifactFile");
  const verifierStart = source.indexOf("function verifyArtifacts");
  const workflowStart = source.indexOf("export default smithers");

  assert.ok(preparationStart >= 0, source);
  assert.ok(resolverStart > preparationStart, source);
  assert.ok(workflowStart > verifierStart, source);
  assert.match(source, /materializeInvariantSuiteFromDependencies\(task, workspaceRoot\)/u);
  assert.match(source, /materializeInvariantSuiteCompanions\(task\)/u);
  assert.match(source, /validateImplementedPropertiesSchema/u);
  assert.match(source, /invariant-suite/u);
  assert.match(source, /changedTestTreePaths/u);
  assert.match(source, /CryticTester/u);
  assert.match(source, /TargetFunctions/u);
  assert.match(source, /Properties/u);
  assert.match(source, /copyInvariantSuiteIntoWorkspace/u);
  assert.match(source, /rememberInvariantSuitePublications\(publications, artifactRoots\)/u);
  assert.match(source, /artifact handoff is missing invariant-suite sources/u);
  assert.match(source, /invariant suite destination conflicts with source/u);

  const suiteMaterializerStart = source.indexOf("function materializeInvariantSuiteFromDependencies");
  const suitePublicationStart = source.indexOf("function rememberInvariantSuitePublications");
  assert.ok(suiteMaterializerStart > preparationStart, source);
  assert.ok(suitePublicationStart > suiteMaterializerStart, source);
  assert.ok(resolverStart > suitePublicationStart, source);
  assert.ok(workflowStart > resolverStart, source);
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

test("generated Smithers verifier publishes the complete validated set before task success", () => {
  const source = fs.readFileSync(workflowTemplatePath, "utf8");
  const verifierStart = source.indexOf("function verifyArtifacts");
  const workflowStart = source.indexOf("export default smithers");

  assert.ok(verifierStart >= 0, source);
  assert.ok(workflowStart > verifierStart, source);
  assert.match(source, /publishFileDurableExclusive/u);

  const verifier = source.slice(verifierStart, workflowStart);
  assert.match(verifier, /const publications = new Map<string, Buffer>\(\)/u);
  assert.match(verifier, /rememberVerifiedPublication\(publications, output\.path, bytes\)/u);
  assert.match(verifier, /verifyGeneratedTestFiles\(artifactRoot, validation\.value\)/u);
  assert.match(verifier, /rememberVerifiedPublication\(publications, companion\.path, companion\.contents\)/u);
  assert.match(verifier, /publishFileDurableExclusive\(artifactDir, relativePath, contents\)/u);
  assert.ok(
    verifier.indexOf("publishVerifiedArtifacts(artifactDir, publications)") > verifier.indexOf("primary === undefined")
  );
  assert.ok(
    verifier.indexOf("publishVerifiedArtifacts(artifactDir, publications)") <
      verifier.indexOf("return { artifacts, primary_artifact: primary.path }")
  );
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
