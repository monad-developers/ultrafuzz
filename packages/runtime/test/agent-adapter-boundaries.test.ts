import assert from "node:assert/strict";
import crypto from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import * as ts from "typescript";

type OrchestratorResponsibility =
  "argv-construction" | "filesystem-walking" | "output-interpretation" | "session-handling" | "token-accounting";

type ResponsibilityPolicy = {
  classifiedSourceSha256: string;
  responsibilities: readonly OrchestratorResponsibility[];
  upstreamIssues: readonly string[];
};

type SourcePolicy = {
  maxLines: number;
  maxSyntaxNodes: number;
  purpose: "adapter" | "data-governance" | "provider-home" | "registry" | "strict-input" | "toml";
  sourceSha256: string;
};

type SourceUnit = {
  ast: ts.SourceFile;
  source: string;
};

type ImportBinding = {
  moduleSpecifier: string;
  namespace: boolean;
};

const FILESYSTEM_MODULES = new Set(["fs", "fs/promises", "node:fs", "node:fs/promises"]);
const FILESYSTEM_WALKING_APIS = new Set(["glob", "globSync", "opendir", "opendirSync", "readdir", "readdirSync"]);
const OUTPUT_INTERPRETATION_SIGNALS = new Set(["createOutputInterpreter", "onStderrLine", "onStdoutLine"]);
const OUTPUT_TEXT_SIGNALS = new Set([
  "line",
  "outputLine",
  "resultLine",
  "stderr",
  "stderrLine",
  "stdout",
  "stdoutLine"
]);
const SESSION_HANDLING_SIGNALS = new Set([
  "continuationId",
  "continuation_id",
  "resumeId",
  "resumeSession",
  "resume_id",
  "sessionId",
  "session_id"
]);
const TOKEN_ACCOUNTING_SIGNALS = new Set([
  "cacheHitTokens",
  "cacheMissTokens",
  "cacheReadTokens",
  "cacheWriteTokens",
  "cache_creation_input_tokens",
  "cache_read_input_tokens",
  "cachedInputTokens",
  "cached_input_tokens",
  "completionTokens",
  "completion_tokens",
  "inputTokens",
  "input_tokens",
  "outputTokens",
  "output_tokens",
  "promptCacheHitTokens",
  "promptCacheMissTokens",
  "promptTokens",
  "prompt_cache_hit_tokens",
  "prompt_cache_miss_tokens",
  "prompt_tokens",
  "reasoningTokens",
  "reasoning_tokens",
  "textTokens",
  "totalTokens",
  "total_tokens"
]);

// This deliberately duplicates each exact source fingerprint in a separate,
// classification-owned policy. A source edit must update both the structural
// policy below and this responsibility review, even when the reviewer decides
// that the declared responsibility set remains unchanged.
const responsibilityPolicies: Record<string, ResponsibilityPolicy> = {
  "claude.tsx": {
    classifiedSourceSha256: "04c785868e9a6955d1f048fb1377b61dca6f3da0e4de6a305536a8b0979f73d9",
    responsibilities: [],
    upstreamIssues: []
  },
  "codex.tsx": {
    classifiedSourceSha256: "a44eb5c47e6374457476a86420eca0c5ff23616fc8201637f0139d37e13b92f5",
    responsibilities: ["argv-construction", "session-handling"],
    upstreamIssues: ["https://github.com/smithersai/smithers/issues/1622"]
  },
  "deepseek.tsx": {
    classifiedSourceSha256: "19cda147d4cf9f0cb00056c76c875087deb00d1f5c6a63116e64cb526459c396",
    responsibilities: ["output-interpretation", "token-accounting"],
    upstreamIssues: ["https://github.com/smithersai/smithers/issues/1624"]
  },
  "environment.tsx": {
    classifiedSourceSha256: "067fbb00ac6418af8f52e8e48f8d30d69549611a6815f98cb9dbcb9bbee4ca71",
    responsibilities: [],
    upstreamIssues: []
  },
  "index.tsx": {
    classifiedSourceSha256: "ce5f94b3bf12ae40c5b59ebd587a77d1e80e532d92c785f3353d272e627d79e4",
    responsibilities: [],
    upstreamIssues: []
  },
  "kimi.tsx": {
    classifiedSourceSha256: "104e72c4fe049514a20112897c2740764629fa54e7115dfffcfd4c28e7077b07",
    responsibilities: [
      "argv-construction",
      "filesystem-walking",
      "output-interpretation",
      "session-handling",
      "token-accounting"
    ],
    upstreamIssues: [
      "https://github.com/smithersai/smithers/issues/1623",
      "https://github.com/smithersai/smithers/issues/1626"
    ]
  },
  "opencode.tsx": {
    classifiedSourceSha256: "7d4e22b674e06b00cd537c531c0e7e95d800ffc07b50d02b566a5fd029d0b489",
    responsibilities: [],
    upstreamIssues: []
  },
  "openrouter.tsx": {
    classifiedSourceSha256: "1a09dfba7abe15299ace0193b20a8686dce2db8a3c633cddb950e2f0fc55e15f",
    responsibilities: ["argv-construction", "output-interpretation", "session-handling"],
    upstreamIssues: [
      "https://github.com/smithersai/smithers/issues/1622",
      "https://github.com/smithersai/smithers/issues/1625"
    ]
  },
  "pi.tsx": {
    classifiedSourceSha256: "f60204f6f4dc1019accd3dfbe22eb03227d86c6b4e30b4848342a68939bf44fc",
    responsibilities: ["argv-construction", "output-interpretation"],
    upstreamIssues: [
      "https://github.com/monad-developers/ultrafuzz/issues/895",
      "https://github.com/smithersai/smithers/issues/1629"
    ]
  },
  "provider-home.tsx": {
    classifiedSourceSha256: "31085a2bad1d6d82b3709946464df332fe1d22e13236708dfb840c8fbd7d5744",
    responsibilities: [],
    upstreamIssues: []
  },
  "strict-json.tsx": {
    classifiedSourceSha256: "16c909eb1f01c82e1174db61877a30028b58a49466714865f1243293f10b186b",
    responsibilities: [],
    upstreamIssues: []
  },
  "toml.tsx": {
    classifiedSourceSha256: "51b15d0f75a09b49a53a33709cf9127c74b2a35814ad8770ce529f0638a4f6ae",
    responsibilities: [],
    upstreamIssues: []
  }
};

// Syntax-node ceilings and exact source fingerprints are the reviewed PR shape
// rooted at main@fe0922ea. The fingerprint makes every replacement visible
// even when it preserves or reduces aggregate structure; line ceilings retain
// a small formatting/documentation margin.
const sourcePolicies: Record<string, SourcePolicy> = {
  "claude.tsx": {
    maxLines: 100,
    maxSyntaxNodes: 452,
    purpose: "adapter",
    sourceSha256: "04c785868e9a6955d1f048fb1377b61dca6f3da0e4de6a305536a8b0979f73d9"
  },
  "codex.tsx": {
    maxLines: 250,
    maxSyntaxNodes: 1_300,
    purpose: "adapter",
    sourceSha256: "a44eb5c47e6374457476a86420eca0c5ff23616fc8201637f0139d37e13b92f5"
  },
  "deepseek.tsx": {
    maxLines: 350,
    maxSyntaxNodes: 1_609,
    purpose: "adapter",
    sourceSha256: "19cda147d4cf9f0cb00056c76c875087deb00d1f5c6a63116e64cb526459c396"
  },
  "environment.tsx": {
    maxLines: 425,
    maxSyntaxNodes: 2_209,
    purpose: "data-governance",
    sourceSha256: "067fbb00ac6418af8f52e8e48f8d30d69549611a6815f98cb9dbcb9bbee4ca71"
  },
  "index.tsx": {
    maxLines: 30,
    maxSyntaxNodes: 125,
    purpose: "registry",
    sourceSha256: "ce5f94b3bf12ae40c5b59ebd587a77d1e80e532d92c785f3353d272e627d79e4"
  },
  "kimi.tsx": {
    maxLines: 1_525,
    maxSyntaxNodes: 8_919,
    purpose: "adapter",
    sourceSha256: "104e72c4fe049514a20112897c2740764629fa54e7115dfffcfd4c28e7077b07"
  },
  "opencode.tsx": {
    maxLines: 150,
    maxSyntaxNodes: 650,
    purpose: "adapter",
    sourceSha256: "7d4e22b674e06b00cd537c531c0e7e95d800ffc07b50d02b566a5fd029d0b489"
  },
  "openrouter.tsx": {
    maxLines: 1_250,
    maxSyntaxNodes: 6_719,
    purpose: "adapter",
    sourceSha256: "1a09dfba7abe15299ace0193b20a8686dce2db8a3c633cddb950e2f0fc55e15f"
  },
  "pi.tsx": {
    maxLines: 200,
    maxSyntaxNodes: 1_100,
    purpose: "adapter",
    sourceSha256: "f60204f6f4dc1019accd3dfbe22eb03227d86c6b4e30b4848342a68939bf44fc"
  },
  "provider-home.tsx": {
    maxLines: 75,
    maxSyntaxNodes: 556,
    purpose: "provider-home",
    sourceSha256: "31085a2bad1d6d82b3709946464df332fe1d22e13236708dfb840c8fbd7d5744"
  },
  "strict-json.tsx": {
    maxLines: 350,
    maxSyntaxNodes: 1_965,
    purpose: "strict-input",
    sourceSha256: "16c909eb1f01c82e1174db61877a30028b58a49466714865f1243293f10b186b"
  },
  "toml.tsx": {
    maxLines: 120,
    maxSyntaxNodes: 526,
    purpose: "toml",
    sourceSha256: "51b15d0f75a09b49a53a33709cf9127c74b2a35814ad8770ce529f0638a4f6ae"
  }
};

function lineCount(source: string): number {
  return source.replace(/\n$/u, "").split("\n").length;
}

function syntaxNodeCount(sourceFile: ts.SourceFile): number {
  let count = 0;
  const visit = (node: ts.Node): void => {
    if (node !== sourceFile) count += 1;
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return count;
}

function sourceFingerprint(source: string): string {
  return crypto.createHash("sha256").update(source, "utf8").digest("hex");
}

function assertSourceMatchesPolicy(relativePath: string, source: SourceUnit, policy: SourcePolicy): void {
  const lines = lineCount(source.source);
  const syntaxNodes = syntaxNodeCount(source.ast);
  assert.ok(lines <= policy.maxLines, `${relativePath} grew past its ${policy.maxLines}-line review ceiling`);
  assert.ok(
    syntaxNodes <= policy.maxSyntaxNodes,
    `${relativePath} grew past its ${policy.maxSyntaxNodes}-node structural ceiling; classify the change before accepting it`
  );
  assert.equal(
    sourceFingerprint(source.source),
    policy.sourceSha256,
    `${relativePath} changed from its reviewed source fingerprint; audit responsibilities and update the policy explicitly`
  );
}

function assertResponsibilityReviewMatchesSource(
  relativePath: string,
  source: SourceUnit,
  policy: ResponsibilityPolicy
): void {
  assert.equal(
    sourceFingerprint(source.source),
    policy.classifiedSourceSha256,
    `${relativePath} changed from its responsibility-reviewed source fingerprint; audit its responsibility declaration and refresh the independent classification policy`
  );
}

function detectedOrchestratorResponsibilities(source: SourceUnit): ReadonlySet<OrchestratorResponsibility> {
  const detected = new Set<OrchestratorResponsibility>();
  const filesystemWalkingBindings = new Set<string>();
  const filesystemNamespaces = new Set<string>();
  for (const statement of source.ast.statements) {
    if (
      !ts.isImportDeclaration(statement) ||
      !ts.isStringLiteral(statement.moduleSpecifier) ||
      !FILESYSTEM_MODULES.has(statement.moduleSpecifier.text)
    ) {
      continue;
    }
    const importClause = statement.importClause;
    if (importClause?.name !== undefined) filesystemNamespaces.add(importClause.name.text);
    const bindings = importClause?.namedBindings;
    if (bindings === undefined) continue;
    if (ts.isNamespaceImport(bindings)) {
      filesystemNamespaces.add(bindings.name.text);
      continue;
    }
    for (const element of bindings.elements) {
      const importedName = element.propertyName?.text ?? element.name.text;
      if (FILESYSTEM_WALKING_APIS.has(importedName)) filesystemWalkingBindings.add(element.name.text);
    }
  }

  const collectDynamicFilesystemBindings = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node) && node.initializer !== undefined) {
      const moduleSpecifier = dynamicImportModuleSpecifier(node.initializer);
      if (moduleSpecifier !== undefined && FILESYSTEM_MODULES.has(moduleSpecifier)) {
        if (ts.isIdentifier(node.name)) {
          filesystemNamespaces.add(node.name.text);
        } else if (ts.isObjectBindingPattern(node.name)) {
          for (const element of node.name.elements) {
            if (!ts.isIdentifier(element.name)) continue;
            const importedName = propertyNameText(element.propertyName) ?? element.name.text;
            if (FILESYSTEM_WALKING_APIS.has(importedName)) filesystemWalkingBindings.add(element.name.text);
          }
        }
      }
    }
    ts.forEachChild(node, collectDynamicFilesystemBindings);
  };
  collectDynamicFilesystemBindings(source.ast);

  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const expression = unwrapExpression(node.expression);
      if (
        (ts.isIdentifier(expression) && filesystemWalkingBindings.has(expression.text)) ||
        (ts.isPropertyAccessExpression(expression) &&
          ts.isIdentifier(expression.expression) &&
          filesystemNamespaces.has(expression.expression.text) &&
          FILESYSTEM_WALKING_APIS.has(expression.name.text)) ||
        (ts.isPropertyAccessExpression(expression) &&
          FILESYSTEM_MODULES.has(dynamicImportModuleSpecifier(expression.expression) ?? "") &&
          FILESYSTEM_WALKING_APIS.has(expression.name.text)) ||
        (ts.isElementAccessExpression(expression) &&
          ts.isIdentifier(expression.expression) &&
          filesystemNamespaces.has(expression.expression.text) &&
          FILESYSTEM_WALKING_APIS.has(elementAccessName(expression) ?? "")) ||
        (ts.isElementAccessExpression(expression) &&
          FILESYSTEM_MODULES.has(dynamicImportModuleSpecifier(expression.expression) ?? "") &&
          FILESYSTEM_WALKING_APIS.has(elementAccessName(expression) ?? ""))
      ) {
        detected.add("filesystem-walking");
      }
      if (isOutputParsingCall(node)) detected.add("output-interpretation");
    }
    const accessedName = ts.isPropertyAccessExpression(node)
      ? node.name.text
      : ts.isElementAccessExpression(node)
        ? elementAccessName(node)
        : undefined;
    if (accessedName === "args" && !isDirectConstructorOptionForwarding(node)) {
      detected.add("argv-construction");
    }
    if (
      ts.isPropertyAssignment(node) &&
      propertyNameText(node.name) === "args" &&
      !isEmptyArrayLiteral(node.initializer) &&
      !isDirectConstructorOptionForwarding(node)
    ) {
      detected.add("argv-construction");
    }
    if (
      ts.isArrayLiteralExpression(node) &&
      isCliArgumentArray(node) &&
      reviewedAdapterFactoryConstructorOption(node) === undefined
    ) {
      detected.add("argv-construction");
    }
    if (
      ((ts.isMethodDeclaration(node) || ts.isPropertyAssignment(node) || ts.isPropertyDeclaration(node)) &&
        OUTPUT_INTERPRETATION_SIGNALS.has(propertyNameText(node.name) ?? "")) ||
      (accessedName !== undefined &&
        OUTPUT_INTERPRETATION_SIGNALS.has(accessedName) &&
        !isDirectConstructorOptionForwarding(node))
    ) {
      detected.add("output-interpretation");
    }
    if (ts.isIdentifier(node) && !isInsideNonExecutableSyntax(node) && !isDirectConstructorOptionForwarding(node)) {
      if (SESSION_HANDLING_SIGNALS.has(node.text)) detected.add("session-handling");
      if (TOKEN_ACCOUNTING_SIGNALS.has(node.text)) detected.add("token-accounting");
    }
    if (
      accessedName !== undefined &&
      !isDirectConstructorOptionForwarding(node) &&
      SESSION_HANDLING_SIGNALS.has(accessedName)
    ) {
      detected.add("session-handling");
    }
    if (
      accessedName !== undefined &&
      !isDirectConstructorOptionForwarding(node) &&
      TOKEN_ACCOUNTING_SIGNALS.has(accessedName)
    ) {
      detected.add("token-accounting");
    }
    if (
      (ts.isPropertyAssignment(node) || ts.isShorthandPropertyAssignment(node) || ts.isBindingElement(node)) &&
      !isDirectConstructorOptionForwarding(node)
    ) {
      const declaredName = ts.isBindingElement(node)
        ? node.propertyName !== undefined
          ? propertyNameText(node.propertyName)
          : ts.isIdentifier(node.name)
            ? node.name.text
            : undefined
        : propertyNameText(node.name);
      if (declaredName !== undefined && SESSION_HANDLING_SIGNALS.has(declaredName)) detected.add("session-handling");
      if (declaredName !== undefined && TOKEN_ACCOUNTING_SIGNALS.has(declaredName)) detected.add("token-accounting");
    }
    ts.forEachChild(node, visit);
  };
  visit(source.ast);
  return detected;
}

function assertDetectedResponsibilitiesDeclared(
  relativePath: string,
  source: SourceUnit,
  policy: ResponsibilityPolicy
): readonly OrchestratorResponsibility[] {
  const detected = [...detectedOrchestratorResponsibilities(source)].sort();
  const undeclared = detected.filter((responsibility) => !policy.responsibilities.includes(responsibility));
  assert.deepEqual(
    undeclared,
    [],
    `${relativePath} has static signals for undeclared orchestrator responsibilities; update its central classification`
  );
  return detected;
}

function assertNonAdapterSourceHasNoOrchestrationSignals(relativePath: string, source: SourceUnit): void {
  assert.deepEqual(
    [...detectedOrchestratorResponsibilities(source)].sort(),
    [],
    `${relativePath} is a non-adapter helper with orchestrator-responsibility signals; keep the logic in an owned adapter or add explicit helper ownership`
  );
}

function propertyNameText(name: ts.PropertyName | undefined): string | undefined {
  if (name === undefined) return undefined;
  if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNoSubstitutionTemplateLiteral(name)) return name.text;
  if (ts.isComputedPropertyName(name)) {
    const expression = unwrapExpression(name.expression);
    if (ts.isStringLiteral(expression) || ts.isNoSubstitutionTemplateLiteral(expression)) return expression.text;
  }
  return undefined;
}

function elementAccessName(node: ts.ElementAccessExpression): string | undefined {
  const argument = node.argumentExpression === undefined ? undefined : unwrapExpression(node.argumentExpression);
  return argument !== undefined && (ts.isStringLiteral(argument) || ts.isNoSubstitutionTemplateLiteral(argument))
    ? argument.text
    : undefined;
}

function isEmptyArrayLiteral(expression: ts.Expression): boolean {
  const current = unwrapExpression(expression);
  return ts.isArrayLiteralExpression(current) && current.elements.length === 0;
}

function isInsideNonExecutableSyntax(node: ts.Node): boolean {
  for (let current: ts.Node | undefined = node; current !== undefined; current = current.parent) {
    if (
      ts.isTypeNode(current) ||
      ts.isInterfaceDeclaration(current) ||
      ts.isTypeAliasDeclaration(current) ||
      ts.isImportDeclaration(current) ||
      ts.isExportDeclaration(current)
    ) {
      return true;
    }
    if (ts.isSourceFile(current)) return false;
  }
  return false;
}

function isDirectConstructorOptionForwarding(node: ts.Node): boolean {
  const element = reviewedAdapterFactoryConstructorOption(node);
  if (element === undefined) return false;
  if (ts.isShorthandPropertyAssignment(element)) return true;
  if (ts.isSpreadAssignment(element)) return isSimpleForwardedValue(element.expression);
  return ts.isPropertyAssignment(element) && isSimpleForwardedValue(element.initializer);
}

function reviewedAdapterFactoryConstructorOption(node: ts.Node): ts.ObjectLiteralElementLike | undefined {
  for (let current: ts.Node | undefined = node; current !== undefined; current = current.parent) {
    if (
      (ts.isPropertyAssignment(current) ||
        ts.isShorthandPropertyAssignment(current) ||
        ts.isSpreadAssignment(current)) &&
      ts.isObjectLiteralExpression(current.parent)
    ) {
      const objectLiteral = current.parent;
      if (
        ts.isNewExpression(objectLiteral.parent) &&
        objectLiteral.parent.arguments?.includes(objectLiteral) &&
        isReviewedAdapterFactoryConstruction(objectLiteral.parent)
      ) {
        return current;
      }
    }
    if (ts.isStatement(current) || ts.isSourceFile(current)) return undefined;
  }
  return undefined;
}

function isSimpleForwardedValue(expression: ts.Expression): boolean {
  const current = unwrapExpression(expression);
  if (ts.isIdentifier(current)) return true;
  if (ts.isPropertyAccessExpression(current)) return isSimpleForwardedValue(current.expression);
  if (ts.isElementAccessExpression(current)) return isSimpleForwardedValue(current.expression);
  return false;
}

function isReviewedAdapterFactoryConstruction(expression: ts.NewExpression): boolean {
  const constructor = unwrapExpression(expression.expression);
  const constructorName = ts.isIdentifier(constructor)
    ? constructor.text
    : ts.isPropertyAccessExpression(constructor)
      ? constructor.name.text
      : undefined;
  if (constructorName === undefined || !constructorName.endsWith("Agent")) return false;

  let current: ts.Node = expression;
  while (
    ts.isParenthesizedExpression(current.parent) ||
    ts.isAsExpression(current.parent) ||
    ts.isSatisfiesExpression(current.parent) ||
    ts.isNonNullExpression(current.parent)
  ) {
    current = current.parent;
  }
  if (!ts.isReturnStatement(current.parent)) return false;
  for (let owner: ts.Node | undefined = current.parent.parent; owner !== undefined; owner = owner.parent) {
    if (ts.isFunctionDeclaration(owner)) {
      return owner.name !== undefined && /^create[A-Za-z0-9]*Agent$/u.test(owner.name.text);
    }
    if (
      ts.isFunctionExpression(owner) ||
      ts.isArrowFunction(owner) ||
      ts.isMethodDeclaration(owner) ||
      ts.isConstructorDeclaration(owner)
    ) {
      return false;
    }
  }
  return false;
}

function dynamicImportModuleSpecifier(expression: ts.Expression): string | undefined {
  let current = unwrapExpression(expression);
  while (ts.isAwaitExpression(current)) current = unwrapExpression(current.expression);
  if (
    !ts.isCallExpression(current) ||
    current.expression.kind !== ts.SyntaxKind.ImportKeyword ||
    current.arguments.length !== 1
  ) {
    return undefined;
  }
  const argument = unwrapExpression(current.arguments[0]!);
  return ts.isStringLiteral(argument) || ts.isNoSubstitutionTemplateLiteral(argument) ? argument.text : undefined;
}

function isCliArgumentArray(node: ts.ArrayLiteralExpression): boolean {
  return node.elements.some((element) => {
    const current = unwrapExpression(element);
    return (ts.isStringLiteral(current) || ts.isNoSubstitutionTemplateLiteral(current)) && current.text.startsWith("-");
  });
}

function isOutputParsingCall(node: ts.CallExpression): boolean {
  const expression = unwrapExpression(node.expression);
  const isJsonParse =
    ts.isPropertyAccessExpression(expression) &&
    ts.isIdentifier(expression.expression) &&
    expression.expression.text === "JSON" &&
    expression.name.text === "parse";
  const isStrictJsonParse = ts.isIdentifier(expression) && /^parseStrictJson(?:Bytes)?$/u.test(expression.text);
  const argument = node.arguments[0];
  if ((!isJsonParse && !isStrictJsonParse) || argument === undefined) return false;
  let readsOutputText = false;
  const visit = (current: ts.Node): void => {
    if (ts.isIdentifier(current) && OUTPUT_TEXT_SIGNALS.has(current.text)) readsOutputText = true;
    if (!readsOutputText) ts.forEachChild(current, visit);
  };
  visit(argument);
  return readsOutputText;
}

function parseSource(relativePath: string, source: string): SourceUnit {
  const ast = ts.createSourceFile(
    relativePath,
    source,
    ts.ScriptTarget.Latest,
    true,
    relativePath.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS
  );
  const diagnostics = (ast as ts.SourceFile & { parseDiagnostics: readonly ts.Diagnostic[] }).parseDiagnostics;
  assert.equal(diagnostics.length, 0, `${relativePath} must contain valid TypeScript`);
  return { ast, source };
}

function readSourceTree(root: string): ReadonlyMap<string, SourceUnit> {
  const sources = new Map<string, SourceUnit>();
  const visit = (directory: string, relativeDirectory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((left, right) =>
      left.name.localeCompare(right.name)
    )) {
      const relativePath = path.posix.join(relativeDirectory, entry.name);
      const absolutePath = path.join(directory, entry.name);
      assert.equal(entry.isSymbolicLink(), false, `${relativePath} must not be a symbolic link`);
      if (entry.isDirectory()) {
        visit(absolutePath, relativePath);
      } else if (entry.isFile() && /\.tsx?$/u.test(entry.name)) {
        sources.set(relativePath, parseSource(relativePath, readFileSync(absolutePath, "utf8")));
      }
    }
  };
  visit(root, "");
  return sources;
}

function topLevelConstBindings(sourceFile: ts.SourceFile): ReadonlyMap<string, ts.Expression> {
  const bindings = new Map<string, ts.Expression>();
  for (const statement of sourceFile.statements) {
    if (!ts.isVariableStatement(statement) || (statement.declarationList.flags & ts.NodeFlags.Const) === 0) continue;
    for (const declaration of statement.declarationList.declarations) {
      if (ts.isIdentifier(declaration.name) && declaration.initializer !== undefined) {
        bindings.set(declaration.name.text, declaration.initializer);
      }
    }
  }
  return bindings;
}

function exportedAgentFactoriesName(sourceFile: ts.SourceFile): string {
  const localNames = new Set<string>();
  for (const statement of sourceFile.statements) {
    if (ts.isVariableStatement(statement) && hasExportModifier(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        if (ts.isIdentifier(declaration.name) && declaration.name.text === "agentFactories") {
          localNames.add(declaration.name.text);
        }
      }
    } else if (
      ts.isExportDeclaration(statement) &&
      !statement.isTypeOnly &&
      statement.moduleSpecifier === undefined &&
      statement.exportClause !== undefined &&
      ts.isNamedExports(statement.exportClause)
    ) {
      for (const element of statement.exportClause.elements) {
        if (!element.isTypeOnly && element.name.text === "agentFactories") {
          localNames.add(element.propertyName?.text ?? element.name.text);
        }
      }
    }
  }
  assert.equal(localNames.size, 1, "the registry must export exactly one local const as agentFactories");
  return [...localNames][0]!;
}

function hasExportModifier(statement: ts.VariableStatement): boolean {
  return ts.getModifiers(statement)?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword) ?? false;
}

function unwrapExpression(expression: ts.Expression): ts.Expression {
  let current = expression;
  while (
    ts.isAsExpression(current) ||
    ts.isSatisfiesExpression(current) ||
    ts.isParenthesizedExpression(current) ||
    ts.isNonNullExpression(current)
  ) {
    current = current.expression;
  }
  return current;
}

function registryMembers(
  expression: ts.Expression,
  bindings: ReadonlyMap<string, ts.Expression>,
  visiting: ReadonlySet<string> = new Set()
): ReadonlyMap<string, ts.Expression> {
  const current = unwrapExpression(expression);
  if (ts.isIdentifier(current)) {
    assert.equal(visiting.has(current.text), false, `cyclic registry binding: ${current.text}`);
    const initializer = bindings.get(current.text);
    assert.ok(initializer, `registry binding is not a top-level const: ${current.text}`);
    return registryMembers(initializer, bindings, new Set([...visiting, current.text]));
  }
  if (
    ts.isCallExpression(current) &&
    current.arguments.length === 1 &&
    ts.isPropertyAccessExpression(current.expression) &&
    ts.isIdentifier(current.expression.expression) &&
    current.expression.expression.text === "Object" &&
    current.expression.name.text === "freeze"
  ) {
    return registryMembers(current.arguments[0]!, bindings, visiting);
  }
  assert.ok(ts.isObjectLiteralExpression(current), "agentFactories must be a bounded static object literal");
  const members = new Map<string, ts.Expression>();
  for (const property of current.properties) {
    if (ts.isSpreadAssignment(property)) {
      for (const [name, factory] of registryMembers(property.expression, bindings, visiting)) {
        members.set(name, factory);
      }
      continue;
    }
    const name = objectMemberName(property);
    assert.ok(name, "agentFactories keys must be static identifiers or strings");
    if (ts.isPropertyAssignment(property)) members.set(name, property.initializer);
    else if (ts.isShorthandPropertyAssignment(property)) members.set(name, property.name);
    else assert.fail(`agentFactories entry must reference an imported adapter factory: ${name}`);
  }
  return members;
}

function objectMemberName(property: ts.ObjectLiteralElementLike): string | undefined {
  if (!ts.isPropertyAssignment(property) && !ts.isShorthandPropertyAssignment(property)) return undefined;
  const name = property.name;
  if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNoSubstitutionTemplateLiteral(name)) return name.text;
  if (ts.isComputedPropertyName(name)) {
    const expression = unwrapExpression(name.expression);
    if (ts.isStringLiteral(expression) || ts.isNoSubstitutionTemplateLiteral(expression)) return expression.text;
  }
  return undefined;
}

function importBindings(sourceFile: ts.SourceFile): ReadonlyMap<string, ImportBinding> {
  const imports = new Map<string, ImportBinding>();
  for (const statement of sourceFile.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) continue;
    const clause = statement.importClause;
    if (clause?.name !== undefined) {
      imports.set(clause.name.text, { moduleSpecifier: statement.moduleSpecifier.text, namespace: false });
    }
    if (clause?.namedBindings !== undefined && ts.isNamespaceImport(clause.namedBindings)) {
      imports.set(clause.namedBindings.name.text, {
        moduleSpecifier: statement.moduleSpecifier.text,
        namespace: true
      });
    } else if (clause?.namedBindings !== undefined) {
      for (const element of clause.namedBindings.elements) {
        imports.set(element.name.text, { moduleSpecifier: statement.moduleSpecifier.text, namespace: false });
      }
    }
  }
  return imports;
}

function resolveFactoryModule(
  expression: ts.Expression,
  imports: ReadonlyMap<string, ImportBinding>,
  bindings: ReadonlyMap<string, ts.Expression>,
  sources: ReadonlyMap<string, SourceUnit>,
  visiting: ReadonlySet<string> = new Set()
): string {
  const current = unwrapExpression(expression);
  if (ts.isIdentifier(current)) {
    const imported = imports.get(current.text);
    if (imported !== undefined && !imported.namespace) {
      return resolveLocalModule("index.tsx", imported.moduleSpecifier, sources);
    }
    assert.equal(visiting.has(current.text), false, `cyclic factory alias: ${current.text}`);
    const initializer = bindings.get(current.text);
    assert.ok(initializer, `registered factory is not imported from adapter source: ${current.text}`);
    return resolveFactoryModule(initializer, imports, bindings, sources, new Set([...visiting, current.text]));
  }
  if (ts.isPropertyAccessExpression(current) && ts.isIdentifier(current.expression)) {
    const imported = imports.get(current.expression.text);
    if (imported?.namespace === true) {
      return resolveLocalModule("index.tsx", imported.moduleSpecifier, sources);
    }
  }
  assert.fail("registered factory must resolve to a local imported adapter module");
}

function resolveLocalModule(
  fromPath: string,
  moduleSpecifier: string,
  sources: ReadonlyMap<string, SourceUnit>
): string {
  assert.match(moduleSpecifier, /^\./u, `adapter factory import must be local: ${moduleSpecifier}`);
  const unresolved = path.posix.normalize(path.posix.join(path.posix.dirname(fromPath), moduleSpecifier));
  assert.doesNotMatch(
    unresolved,
    /^\.\.(?:\/|$)/u,
    `adapter factory import escapes the source tree: ${moduleSpecifier}`
  );
  const base = unresolved.replace(/\.[cm]?jsx?$/u, "");
  const candidates = [unresolved, `${base}.ts`, `${base}.tsx`, `${base}/index.ts`, `${base}/index.tsx`];
  const matches = [...new Set(candidates)].filter((candidate) => sources.has(candidate));
  assert.equal(matches.length, 1, `adapter factory import must resolve once: ${moduleSpecifier}`);
  return matches[0]!;
}

function registeredAdapterSources(sources: ReadonlyMap<string, SourceUnit>): ReadonlyMap<string, string> {
  const index = sources.get("index.tsx") ?? sources.get("index.ts");
  assert.ok(index, "adapter source tree must contain index.ts or index.tsx");
  const bindings = topLevelConstBindings(index.ast);
  const registryName = exportedAgentFactoriesName(index.ast);
  const initializer = bindings.get(registryName);
  assert.ok(initializer, "agentFactories must be initialized by a top-level const");
  const imports = importBindings(index.ast);
  return new Map(
    [...registryMembers(initializer, bindings)].map(([agentRef, factory]) => [
      agentRef,
      resolveFactoryModule(factory, imports, bindings, sources)
    ])
  );
}

test("registry discovery follows factory imports, aliases, and registered-only adapters", () => {
  const sources = new Map<string, SourceUnit>([
    [
      "index.tsx",
      parseSource(
        "index.tsx",
        'import { createOne as renamed } from "./nested/one";\n' +
          'import { createTwo } from "./two";\n' +
          "const first = renamed;\n" +
          "const core = { PrimaryAgent: first };\n" +
          "const registry = Object.freeze({ ...core, AliasAgent: renamed, RegisteredOnlyAgent: createTwo });\n" +
          "export { registry as agentFactories };\n"
      )
    ],
    ["nested/one.ts", parseSource("nested/one.ts", "export const createOne = () => null;\n")],
    ["two.tsx", parseSource("two.tsx", "export const createTwo = () => null;\n")]
  ]);

  assert.deepEqual(
    [...registeredAdapterSources(sources)],
    [
      ["PrimaryAgent", "nested/one.ts"],
      ["AliasAgent", "nested/one.ts"],
      ["RegisteredOnlyAgent", "two.tsx"]
    ]
  );
});

test("source inventory recurses through both TypeScript source extensions", () => {
  const fixture = mkdtempSync(path.join(os.tmpdir(), "ultrafuzz-adapter-boundaries-"));
  try {
    mkdirSync(path.join(fixture, "nested", "deeper"), { recursive: true });
    writeFileSync(path.join(fixture, "index.tsx"), "export const index = true;\n");
    writeFileSync(path.join(fixture, "nested", "helper.ts"), "export const helper = true;\n");
    writeFileSync(path.join(fixture, "nested", "deeper", "view.tsx"), "export const view = true;\n");
    writeFileSync(path.join(fixture, "nested", "ignored.js"), "export const ignored = true;\n");
    assert.deepEqual([...readSourceTree(fixture).keys()], ["index.tsx", "nested/deeper/view.tsx", "nested/helper.ts"]);
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});

test("syntax budgets ignore names and comments but catch structural orchestration additions", () => {
  const baseline = syntaxNodeCount(
    parseSource("fixture.ts", "export async function run(task: string) { return task; }\n").ast
  );
  const renamed = syntaxNodeCount(
    parseSource(
      "fixture.ts",
      "// resumeSession and prompt_tokens are documentation, not classification markers.\n" +
        "export async function invoke(prompt: string) { return prompt; }\n"
    ).ast
  );
  assert.equal(renamed, baseline);
  assert.notEqual(
    sourceFingerprint("export async function run(task: string) { return task; }\n"),
    sourceFingerprint(
      "// resumeSession and prompt_tokens are documentation, not classification markers.\n" +
        "export async function invoke(prompt: string) { return prompt; }\n"
    ),
    "an equal-size replacement must still require an explicit source-policy review"
  );

  for (const addition of [
    'import { readdir } from "node:fs/promises"; export async function run() { return readdir("."); }\n',
    'export function run(prompt: string) { const launchArguments = ["--resume", prompt]; return launchArguments; }\n',
    "export function run(usage: { prompt_tokens: number; completion_tokens: number }) { return usage.prompt_tokens + usage.completion_tokens; }\n"
  ]) {
    assert.ok(syntaxNodeCount(parseSource("fixture.ts", addition).ast) > baseline);
  }
});

test("source-policy acknowledgment cannot reuse a stale responsibility review for opaque behavior", () => {
  const baselineSource = "export function passThrough(payload: Uint8Array) { return payload; }\n";
  const changedSource =
    'import { decodeProviderEvent } from "./provider-parser";\n' +
    "export function passThrough(payload: Uint8Array) { return decodeProviderEvent(payload); }\n";
  const changed = parseSource("fixture.tsx", changedSource);
  const acknowledgedSourcePolicy: SourcePolicy = {
    maxLines: lineCount(changedSource),
    maxSyntaxNodes: syntaxNodeCount(changed.ast),
    purpose: "adapter",
    sourceSha256: sourceFingerprint(changedSource)
  };
  const staleResponsibilityPolicy: ResponsibilityPolicy = {
    classifiedSourceSha256: sourceFingerprint(baselineSource),
    responsibilities: [],
    upstreamIssues: []
  };

  assert.deepEqual(
    [...detectedOrchestratorResponsibilities(changed)],
    [],
    "the fixture must exercise a semantic form outside the conservative static lower bound"
  );
  assert.doesNotThrow(() => assertSourceMatchesPolicy("fixture.tsx", changed, acknowledgedSourcePolicy));
  assert.throws(
    () => assertResponsibilityReviewMatchesSource("fixture.tsx", changed, staleResponsibilityPolicy),
    /responsibility-reviewed source fingerprint/u
  );

  const refreshedResponsibilityPolicy: ResponsibilityPolicy = {
    classifiedSourceSha256: sourceFingerprint(changedSource),
    responsibilities: ["output-interpretation"],
    upstreamIssues: ["https://example.invalid/upstream"]
  };
  assert.doesNotThrow(() =>
    assertResponsibilityReviewMatchesSource("fixture.tsx", changed, refreshedResponsibilityPolicy)
  );
  assert.doesNotThrow(() =>
    assertDetectedResponsibilitiesDeclared("fixture.tsx", changed, refreshedResponsibilityPolicy)
  );
});

test("fingerprint and ceiling acknowledgment cannot retain stale responsibility classifications", () => {
  const changedSources: Array<[OrchestratorResponsibility, string]> = [
    [
      "filesystem-walking",
      'export async function discover() { const fs = await import("node:fs/promises"); return fs.readdir(process.cwd()); }\n'
    ],
    [
      "argv-construction",
      'export function launch(prompt: string) { const launchArguments = ["--resume", prompt]; return launchArguments; }\n'
    ],
    [
      "output-interpretation",
      "export function decode(line: string) { const event = JSON.parse(line); return event.result; }\n"
    ],
    [
      "session-handling",
      "export function continueAttempt(state: { continuationId: string }) { return state.continuationId; }\n"
    ],
    [
      "token-accounting",
      "class UsageBox { constructor(_value: unknown) {} }\n" +
        "export function normalize(usage: { prompt_tokens: number }) { return new UsageBox({ inputTokens: usage.prompt_tokens }); }\n"
    ]
  ];

  for (const [responsibility, changedSource] of changedSources) {
    const parsed = parseSource("fixture.tsx", changedSource);
    const acknowledgedSourcePolicy: SourcePolicy = {
      maxLines: lineCount(changedSource),
      maxSyntaxNodes: syntaxNodeCount(parsed.ast),
      purpose: "adapter",
      sourceSha256: sourceFingerprint(changedSource)
    };
    assert.doesNotThrow(
      () => assertSourceMatchesPolicy("fixture.tsx", parsed, acknowledgedSourcePolicy),
      `${responsibility} fixture must model an independently acknowledged fingerprint and ceiling`
    );
    const staleCentralPolicy: ResponsibilityPolicy = {
      classifiedSourceSha256: sourceFingerprint(changedSource),
      responsibilities: [],
      upstreamIssues: []
    };
    assert.doesNotThrow(() => assertResponsibilityReviewMatchesSource("fixture.tsx", parsed, staleCentralPolicy));
    assert.throws(
      () => assertDetectedResponsibilitiesDeclared("fixture.tsx", parsed, staleCentralPolicy),
      /static signals for undeclared orchestrator responsibilities/u,
      responsibility
    );
    assert.doesNotThrow(() =>
      assertDetectedResponsibilitiesDeclared("fixture.tsx", parsed, {
        classifiedSourceSha256: sourceFingerprint(changedSource),
        responsibilities: [responsibility],
        upstreamIssues: ["https://example.invalid/upstream"]
      })
    );
  }
});

test("static lower-bound signals catch newly implemented orchestrator responsibilities", () => {
  const fixtures: Array<[OrchestratorResponsibility, string]> = [
    [
      "argv-construction",
      'export function rewrite(command: { args: string[] }) { return { ...command, args: ["--resume", ...command["args"]] }; }\n'
    ],
    [
      "filesystem-walking",
      'import { readdirSync } from "node:fs"; export function walk() { return readdirSync(process.cwd()); }\n'
    ],
    [
      "filesystem-walking",
      'import { readdir as list } from "fs/promises"; export async function walk() { return list(process.cwd()); }\n'
    ],
    [
      "filesystem-walking",
      'import * as fs from "node:fs"; export function walk() { return fs["readdirSync"](process.cwd()); }\n'
    ],
    [
      "filesystem-walking",
      'export async function walk() { const fs = await import("node:fs/promises"); return fs.readdir(process.cwd()); }\n'
    ],
    [
      "output-interpretation",
      "export class Adapter { createOutputInterpreter() { return { onStdoutLine: () => [] }; } }\n"
    ],
    ["output-interpretation", "export class Adapter { onStderrLine = (line: string) => JSON.parse(line); }\n"],
    [
      "session-handling",
      'export function resume(options: { resumeSession?: string }) { return options["resumeSession"]; }\n'
    ],
    [
      "token-accounting",
      "export function usage(value: { prompt_tokens: number; completion_tokens: number }) { return value.prompt_tokens + value.completion_tokens; }\n"
    ],
    [
      "token-accounting",
      "class UsageBox { constructor(_value: unknown) {} } export function usage(value: { prompt_tokens: number }) { return new UsageBox({ inputTokens: value.prompt_tokens }); }\n"
    ]
  ];
  for (const [responsibility, fixture] of fixtures) {
    assert.equal(
      detectedOrchestratorResponsibilities(parseSource("fixture.ts", fixture)).has(responsibility),
      true,
      responsibility
    );
  }
});

test("static lower-bound signals ignore types, prose, thin constructor mappings, and empty error argv", () => {
  const fixtures = [
    "// resumeSession, session_id, and total_tokens are prose only.\n" +
      "type Contract = { resumeSession?: string; sessionId?: string; inputTokens: number };\n" +
      'export const labels = ["session_id", "total_tokens"];\n',
    'import { readFileSync } from "node:fs";\n' +
      "type Options = { resumeSession?: string; sessionId?: string; inputTokens: number };\n" +
      "export function createFixtureAgent(Agent: new (options: unknown) => unknown, options: Options) {\n" +
      "  return new Agent({\n" +
      "    resume: options.resumeSession,\n" +
      "    sessionId: options.sessionId,\n" +
      "    tokenBudget: options.inputTokens,\n" +
      '    extraArgs: ["--flag"],\n' +
      '    env: { CONFIG: readFileSync("config", "utf8") }\n' +
      "  });\n" +
      "}\n",
    'export const diagnostic = { command: "codex", args: [], cwd: process.cwd() };\n'
  ];
  for (const fixture of fixtures) {
    assert.deepEqual([...detectedOrchestratorResponsibilities(parseSource("fixture.ts", fixture))], []);
  }
});

test("non-adapter helpers cannot hide orchestrator responsibilities", () => {
  const helper = parseSource(
    "helper.ts",
    'import { readdirSync } from "node:fs"; export function discover() { return readdirSync(process.cwd()); }\n'
  );
  assert.throws(
    () => assertNonAdapterSourceHasNoOrchestrationSignals("helper.ts", helper),
    /non-adapter helper with orchestrator-responsibility signals/u
  );
});

test("OpenRouter retains the manually reviewed argv responsibility inherited from Codex", () => {
  assert.equal(responsibilityPolicies["openrouter.tsx"]!.responsibilities.includes("argv-construction"), true);
});

test("main agent registry and recursive sources stay inside reviewed adapter boundaries", (context) => {
  const packageRoot = [process.cwd(), path.resolve("packages/runtime")].find((candidate) =>
    existsSync(path.join(candidate, "src/templates/smithers/agents/index.tsx"))
  );
  assert.ok(packageRoot, "could not resolve the runtime package root");
  const sources = readSourceTree(path.join(packageRoot, "src/templates/smithers/agents"));

  assert.deepEqual(
    Object.keys(sourcePolicies).sort(),
    [...sources.keys()].sort(),
    "every recursive .ts/.tsx adapter source must have an explicit structural policy"
  );
  assert.deepEqual(
    Object.keys(responsibilityPolicies).sort(),
    [...sources.keys()].sort(),
    "every recursive .ts/.tsx source must have an independent responsibility-review policy"
  );

  const registered = registeredAdapterSources(sources);
  const registeredSourcePaths = [...new Set(registered.values())].sort();
  assert.deepEqual(
    Object.entries(sourcePolicies)
      .filter(([, policy]) => policy.purpose === "adapter")
      .map(([relativePath]) => relativePath)
      .sort(),
    registeredSourcePaths,
    "only adapter sources registered in agentFactories may carry the adapter purpose"
  );
  for (const [relativePath, source] of sources) {
    const policy = sourcePolicies[relativePath]!;
    const responsibilityPolicy = responsibilityPolicies[relativePath]!;
    const lines = lineCount(source.source);
    const syntaxNodes = syntaxNodeCount(source.ast);
    context.diagnostic(
      `${relativePath}: ${lines} lines; ${syntaxNodes} syntax nodes; reviewed purpose: ${policy.purpose}`
    );
    assertSourceMatchesPolicy(relativePath, source, policy);
    assertResponsibilityReviewMatchesSource(relativePath, source, responsibilityPolicy);
    if (policy.purpose !== "adapter") {
      assert.deepEqual(
        responsibilityPolicy.responsibilities,
        [],
        `${relativePath} is not a registered adapter and cannot own orchestrator responsibilities`
      );
      assert.deepEqual(
        responsibilityPolicy.upstreamIssues,
        [],
        `${relativePath} is not a registered adapter and cannot own adapter debt`
      );
      assertNonAdapterSourceHasNoOrchestrationSignals(relativePath, source);
    }
  }

  for (const adapterSource of registeredSourcePaths) {
    const policy = responsibilityPolicies[adapterSource]!;
    const detectedResponsibilities = assertDetectedResponsibilitiesDeclared(
      adapterSource,
      sources.get(adapterSource)!,
      policy
    );
    const registrations = [...registered]
      .filter(([, sourcePath]) => sourcePath === adapterSource)
      .map(([agentRef]) => agentRef)
      .sort();
    context.diagnostic(
      `${adapterSource}: registered as ${registrations.join(", ")}; declared orchestrator responsibilities: ${
        policy.responsibilities.join(", ") || "none"
      }; statically detected lower bound: ${detectedResponsibilities.join(", ") || "none"}`
    );
    assert.equal(sourcePolicies[adapterSource]?.purpose, "adapter");
    if (policy.responsibilities.length > 0) {
      assert.ok(policy.upstreamIssues.length > 0, `${adapterSource} debt must link an upstream issue`);
    }
  }
});
