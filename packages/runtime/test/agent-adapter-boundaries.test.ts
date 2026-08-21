import assert from "node:assert/strict";
import crypto from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import * as ts from "typescript";

type OrchestratorResponsibility =
  "argv-construction" | "filesystem-walking" | "output-interpretation" | "session-handling" | "token-accounting";

type AdapterPolicy = {
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

const adapterPolicies: Record<string, AdapterPolicy> = {
  "claude.tsx": {
    responsibilities: [],
    upstreamIssues: []
  },
  "codex.tsx": {
    responsibilities: ["argv-construction", "session-handling"],
    upstreamIssues: ["https://github.com/smithersai/smithers/issues/1622"]
  },
  "deepseek.tsx": {
    responsibilities: ["output-interpretation", "token-accounting"],
    upstreamIssues: ["https://github.com/smithersai/smithers/issues/1624"]
  },
  "kimi.tsx": {
    responsibilities: [
      "argv-construction",
      "filesystem-walking",
      "output-interpretation",
      "session-handling",
      "token-accounting"
    ],
    upstreamIssues: ["https://github.com/smithersai/smithers/issues/1623"]
  },
  "openrouter.tsx": {
    responsibilities: ["output-interpretation", "session-handling"],
    upstreamIssues: [
      "https://github.com/smithersai/smithers/issues/1622",
      "https://github.com/smithersai/smithers/issues/1625"
    ]
  }
};

// Syntax-node ceilings and exact source fingerprints are the reviewed
// main@fe0922ea shape. The fingerprint makes every replacement visible even
// when it preserves or reduces aggregate structure; line ceilings retain a
// small formatting/documentation margin.
const sourcePolicies: Record<string, SourcePolicy> = {
  "claude.tsx": {
    maxLines: 100,
    maxSyntaxNodes: 452,
    purpose: "adapter",
    sourceSha256: "04c785868e9a6955d1f048fb1377b61dca6f3da0e4de6a305536a8b0979f73d9"
  },
  "codex.tsx": {
    maxLines: 175,
    maxSyntaxNodes: 851,
    purpose: "adapter",
    sourceSha256: "614e45e4ecba581ca8e32f1ae0f69be223da25fb4d8ecdcc964b9d820265feda"
  },
  "deepseek.tsx": {
    maxLines: 350,
    maxSyntaxNodes: 1_596,
    purpose: "adapter",
    sourceSha256: "c0c8cacff536100b8fb8af2fdec51e382c79e54c5700059f7ff1d3f9cb947818"
  },
  "environment.tsx": {
    maxLines: 425,
    maxSyntaxNodes: 2_209,
    purpose: "data-governance",
    sourceSha256: "067fbb00ac6418af8f52e8e48f8d30d69549611a6815f98cb9dbcb9bbee4ca71"
  },
  "index.tsx": {
    maxLines: 30,
    maxSyntaxNodes: 77,
    purpose: "registry",
    sourceSha256: "89dff9ebf9e542adac8465a6f1b13dfdf79e204cdfab0f0f320da1afc86aaf23"
  },
  "kimi.tsx": {
    maxLines: 1_525,
    maxSyntaxNodes: 8_919,
    purpose: "adapter",
    sourceSha256: "104e72c4fe049514a20112897c2740764629fa54e7115dfffcfd4c28e7077b07"
  },
  "openrouter.tsx": {
    maxLines: 1_250,
    maxSyntaxNodes: 6_719,
    purpose: "adapter",
    sourceSha256: "1a09dfba7abe15299ace0193b20a8686dce2db8a3c633cddb950e2f0fc55e15f"
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
  assert.deepEqual(
    Object.keys(adapterPolicies).sort(),
    registeredSourcePaths,
    "every adapter registered in agentFactories must have an explicit responsibility policy"
  );

  for (const [relativePath, source] of sources) {
    const policy = sourcePolicies[relativePath]!;
    const lines = lineCount(source.source);
    const syntaxNodes = syntaxNodeCount(source.ast);
    context.diagnostic(
      `${relativePath}: ${lines} lines; ${syntaxNodes} syntax nodes; reviewed purpose: ${policy.purpose}`
    );
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

  for (const adapterSource of registeredSourcePaths) {
    const policy = adapterPolicies[adapterSource]!;
    const registrations = [...registered]
      .filter(([, sourcePath]) => sourcePath === adapterSource)
      .map(([agentRef]) => agentRef)
      .sort();
    context.diagnostic(
      `${adapterSource}: registered as ${registrations.join(", ")}; declared orchestrator responsibilities: ${
        policy.responsibilities.join(", ") || "none"
      }`
    );
    assert.equal(sourcePolicies[adapterSource]?.purpose, "adapter");
    if (policy.responsibilities.length > 0) {
      assert.ok(policy.upstreamIssues.length > 0, `${adapterSource} debt must link an upstream issue`);
    }
  }
});
