import path from "node:path";

import { readSinglyLinkedRegularFileSnapshotInside } from "@ultrafuzz/artifacts";
import * as ts from "typescript";
import { errorMessage } from "@ultrafuzz/artifacts";

export const AGENT_REGISTRY_RELATIVE_PATH = ".smithers/agents/index.ts";
const MAX_AGENT_REGISTRY_BYTES = 256 * 1024;
const MAX_ANALYSIS_DEPTH = 64;
const MAX_ANALYSIS_STEPS = 10_000;

export interface AgentRegistryInspection {
  exists: boolean;
  registeredFactories: ReadonlySet<string>;
  error?: string;
}

/** Reads and analyzes the one supported inline-static agent registry grammar. */
export function inspectAgentRegistry(projectRoot: string): AgentRegistryInspection {
  const root = path.resolve(projectRoot);
  const registryPath = path.join(root, ...AGENT_REGISTRY_RELATIVE_PATH.split("/"));
  let bytes: Buffer;
  try {
    bytes = readSinglyLinkedRegularFileSnapshotInside(
      root,
      registryPath,
      MAX_AGENT_REGISTRY_BYTES,
      "project agent registry"
    );
  } catch (error) {
    if (
      isNodeErrorWithCode(error, "ENOENT") ||
      /does not exist|cannot open regular file.*ENOENT/u.test(errorMessage(error))
    ) {
      return { exists: false, registeredFactories: new Set() };
    }
    return { exists: true, registeredFactories: new Set(), error: errorMessage(error) };
  }
  try {
    return { exists: true, registeredFactories: analyzeAgentRegistry(bytes.toString("utf8")) };
  } catch (error) {
    return { exists: true, registeredFactories: new Set(), error: errorMessage(error) };
  }
}

export function agentRegistryRegisters(inspection: AgentRegistryInspection, agentRef: string): boolean {
  return SAFE_AGENT_REF_PATTERN.test(agentRef) && inspection.registeredFactories.has(agentRef);
}

const SAFE_AGENT_REF_PATTERN = /^(?!.*\.\.)[A-Za-z_][A-Za-z0-9_.:-]{0,127}$/u;

function analyzeAgentRegistry(sourceText: string): ReadonlySet<string> {
  const source = ts.createSourceFile(
    AGENT_REGISTRY_RELATIVE_PATH,
    sourceText,
    ts.ScriptTarget.Latest,
    false,
    ts.ScriptKind.TS
  );
  const parseDiagnostics = (source as ts.SourceFile & { parseDiagnostics: readonly ts.Diagnostic[] }).parseDiagnostics;
  if (parseDiagnostics.length > 0) throw new Error("agent registry contains invalid TypeScript syntax");
  const exported = exportedAgentFactoriesLocalNames(source);
  if (exported.size !== 1) {
    throw new Error("agent registry must export exactly one local const as agentFactories");
  }
  const bindings = topLevelConstBindings(source);
  const objectIsShadowed = topLevelNameIsBound(source, "Object");
  const memo = new Map<ts.Expression, ReadonlyMap<string, boolean> | null>();
  let steps = 0;

  const evaluate = (expression: ts.Expression, depth: number): ReadonlyMap<string, boolean> | undefined => {
    steps += 1;
    if (steps > MAX_ANALYSIS_STEPS) throw new Error("agent registry static analysis exceeded its step budget");
    if (depth > MAX_ANALYSIS_DEPTH) throw new Error("agent registry static analysis exceeded its depth budget");
    const current = unwrapTypeExpressions(expression);
    const cached = memo.get(current);
    if (cached === null) return undefined;
    if (cached !== undefined) return cached;
    memo.set(current, null);
    let result: ReadonlyMap<string, boolean> | undefined;
    if (ts.isIdentifier(current)) {
      const initializer = bindings.get(current.text);
      result = initializer === undefined ? undefined : evaluate(initializer, depth + 1);
    } else if (isUnshadowedObjectFreeze(current, objectIsShadowed)) {
      result = evaluate(current.arguments[0]!, depth + 1);
    } else if (ts.isObjectLiteralExpression(current)) {
      const entries = new Map<string, boolean>();
      for (const property of current.properties) {
        steps += 1;
        if (steps > MAX_ANALYSIS_STEPS) throw new Error("agent registry static analysis exceeded its step budget");
        if (ts.isSpreadAssignment(property)) {
          const spread = evaluate(property.expression, depth + 1);
          if (spread === undefined) {
            // An unknown later spread can overwrite every earlier entry. Clear
            // them; explicit properties after it can establish certainty again.
            entries.clear();
          } else {
            for (const [name, usable] of spread) entries.set(name, usable);
          }
          continue;
        }
        const name = objectMemberName(property);
        if (name === undefined) {
          // An unknown computed name may overwrite any earlier member.
          entries.clear();
          continue;
        }
        entries.set(name, objectMemberIsUsableFactory(property, bindings, new Set(), depth + 1));
      }
      result = entries;
    }
    if (result === undefined) memo.delete(current);
    else memo.set(current, result);
    return result;
  };

  const localName = [...exported][0]!;
  const initializer = bindings.get(localName);
  if (initializer === undefined) throw new Error("exported agentFactories must be initialized by a top-level const");
  const members = evaluate(initializer, 0);
  if (members === undefined) {
    throw new Error(
      "agentFactories must use the documented inline-static object grammar; imported or re-exported registries are not supported"
    );
  }
  return new Set([...members].filter(([, usable]) => usable).map(([name]) => name));
}

function objectMemberIsUsableFactory(
  property: ts.ObjectLiteralElementLike,
  bindings: ReadonlyMap<string, ts.Expression>,
  visiting: ReadonlySet<string>,
  depth: number
): boolean {
  if (depth > MAX_ANALYSIS_DEPTH) throw new Error("agent registry factory analysis exceeded its depth budget");
  if (ts.isMethodDeclaration(property)) return true;
  let expression: ts.Expression | undefined;
  if (ts.isPropertyAssignment(property)) expression = property.initializer;
  else if (ts.isShorthandPropertyAssignment(property))
    expression = property.objectAssignmentInitializer ?? property.name;
  if (expression === undefined) return false;
  const current = unwrapTypeExpressions(expression);
  if (current.kind === ts.SyntaxKind.NullKeyword || ts.isVoidExpression(current)) return false;
  if (!ts.isIdentifier(current)) return true;
  if (visiting.has(current.text)) return false;
  const initializer = bindings.get(current.text);
  if (initializer === undefined) return current.text !== "undefined";
  return factoryExpressionIsNonNullish(initializer, bindings, new Set([...visiting, current.text]), depth + 1);
}

function factoryExpressionIsNonNullish(
  expression: ts.Expression,
  bindings: ReadonlyMap<string, ts.Expression>,
  visiting: ReadonlySet<string>,
  depth: number
): boolean {
  if (depth > MAX_ANALYSIS_DEPTH) throw new Error("agent registry factory analysis exceeded its depth budget");
  const current = unwrapTypeExpressions(expression);
  if (current.kind === ts.SyntaxKind.NullKeyword || ts.isVoidExpression(current)) return false;
  if (!ts.isIdentifier(current)) return true;
  if (visiting.has(current.text)) return false;
  const initializer = bindings.get(current.text);
  if (initializer === undefined) return current.text !== "undefined";
  return factoryExpressionIsNonNullish(initializer, bindings, new Set([...visiting, current.text]), depth + 1);
}

function exportedAgentFactoriesLocalNames(source: ts.SourceFile): ReadonlySet<string> {
  const localNames = new Set<string>();
  for (const statement of source.statements) {
    if (ts.isVariableStatement(statement) && hasExportModifier(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        if (ts.isIdentifier(declaration.name) && declaration.name.text === "agentFactories")
          localNames.add(declaration.name.text);
      }
      continue;
    }
    if (
      !ts.isExportDeclaration(statement) ||
      statement.isTypeOnly ||
      statement.moduleSpecifier !== undefined ||
      statement.exportClause === undefined ||
      !ts.isNamedExports(statement.exportClause)
    )
      continue;
    for (const element of statement.exportClause.elements) {
      if (!element.isTypeOnly && element.name.text === "agentFactories") {
        localNames.add(element.propertyName === undefined ? "agentFactories" : element.propertyName.text);
      }
    }
  }
  return localNames;
}

function topLevelConstBindings(source: ts.SourceFile): ReadonlyMap<string, ts.Expression> {
  const bindings = new Map<string, ts.Expression>();
  for (const statement of source.statements) {
    if (!ts.isVariableStatement(statement) || (statement.declarationList.flags & ts.NodeFlags.Const) === 0) continue;
    for (const declaration of statement.declarationList.declarations) {
      if (ts.isIdentifier(declaration.name) && declaration.initializer !== undefined)
        bindings.set(declaration.name.text, declaration.initializer);
    }
  }
  return bindings;
}

function topLevelNameIsBound(source: ts.SourceFile, name: string): boolean {
  for (const statement of source.statements) {
    if (ts.isImportEqualsDeclaration(statement) && statement.name.text === name) return true;
    if (ts.isImportDeclaration(statement)) {
      const clause = statement.importClause;
      if (clause?.name?.text === name) return true;
      if (
        clause?.namedBindings &&
        ts.isNamespaceImport(clause.namedBindings) &&
        clause.namedBindings.name.text === name
      )
        return true;
      if (
        clause?.namedBindings &&
        ts.isNamedImports(clause.namedBindings) &&
        clause.namedBindings.elements.some((entry) => entry.name.text === name)
      )
        return true;
    }
    if (
      ts.isVariableStatement(statement) &&
      statement.declarationList.declarations.some((declaration) => bindingNameContains(declaration.name, name))
    )
      return true;
    if ((ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement)) && statement.name?.text === name)
      return true;
    if ((ts.isEnumDeclaration(statement) || ts.isModuleDeclaration(statement)) && statement.name.text === name)
      return true;
  }
  return false;
}

function bindingNameContains(binding: ts.BindingName, name: string): boolean {
  if (ts.isIdentifier(binding)) return binding.text === name;
  return binding.elements.some(
    (element) => !ts.isOmittedExpression(element) && bindingNameContains(element.name, name)
  );
}

function isUnshadowedObjectFreeze(
  expression: ts.Expression,
  objectIsShadowed: boolean
): expression is ts.CallExpression {
  return (
    !objectIsShadowed &&
    ts.isCallExpression(expression) &&
    expression.arguments.length === 1 &&
    ts.isPropertyAccessExpression(expression.expression) &&
    ts.isIdentifier(expression.expression.expression) &&
    expression.expression.expression.text === "Object" &&
    expression.expression.name.text === "freeze"
  );
}

function hasExportModifier(node: ts.VariableStatement): boolean {
  return ts.getModifiers(node)?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword) ?? false;
}

function unwrapTypeExpressions(expression: ts.Expression): ts.Expression {
  let current = expression;
  while (ts.isAsExpression(current) || ts.isSatisfiesExpression(current) || ts.isParenthesizedExpression(current))
    current = current.expression;
  return current;
}

function objectMemberName(property: ts.ObjectLiteralElementLike): string | undefined {
  if (
    !ts.isPropertyAssignment(property) &&
    !ts.isShorthandPropertyAssignment(property) &&
    !ts.isMethodDeclaration(property) &&
    !ts.isGetAccessorDeclaration(property) &&
    !ts.isSetAccessorDeclaration(property)
  )
    return undefined;
  const name = property.name;
  if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNoSubstitutionTemplateLiteral(name)) return name.text;
  if (ts.isComputedPropertyName(name)) {
    const expression = unwrapTypeExpressions(name.expression);
    if (ts.isStringLiteral(expression) || ts.isNoSubstitutionTemplateLiteral(expression)) return expression.text;
  }
  return undefined;
}

function isNodeErrorWithCode(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === code;
}
