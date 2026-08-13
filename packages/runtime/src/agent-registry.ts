import * as ts from "typescript";

/**
 * Returns the statically declared keys of the canonical named agentFactories
 * export without executing project-owned registry code.
 */
export function registeredAgentFactoryNames(registryText: string): ReadonlySet<string> {
  const source = ts.createSourceFile(
    ".smithers/agents/index.ts",
    registryText,
    ts.ScriptTarget.Latest,
    false,
    ts.ScriptKind.TS
  );
  const parseDiagnostics = (source as ts.SourceFile & { parseDiagnostics: readonly ts.Diagnostic[] }).parseDiagnostics;
  if (parseDiagnostics.length > 0) return new Set();

  const names = new Set<string>();
  const exportedLocalNames = exportedAgentFactoriesLocalNames(source);
  for (const statement of source.statements) {
    if (!ts.isVariableStatement(statement) || (statement.declarationList.flags & ts.NodeFlags.Const) === 0) {
      continue;
    }
    for (const declaration of statement.declarationList.declarations) {
      if (
        ts.isIdentifier(declaration.name) &&
        exportedLocalNames.has(declaration.name.text) &&
        declaration.initializer !== undefined
      ) {
        collectObjectMemberNames(source, declaration.initializer, names, new Set());
      }
    }
  }
  return names;
}

function exportedAgentFactoriesLocalNames(source: ts.SourceFile): ReadonlySet<string> {
  const localNames = new Set<string>();
  for (const statement of source.statements) {
    if (ts.isVariableStatement(statement) && hasExportModifier(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        if (ts.isIdentifier(declaration.name) && declaration.name.text === "agentFactories") {
          localNames.add(declaration.name.text);
        }
      }
      continue;
    }
    if (
      !ts.isExportDeclaration(statement) ||
      statement.isTypeOnly ||
      statement.moduleSpecifier !== undefined ||
      statement.exportClause === undefined ||
      !ts.isNamedExports(statement.exportClause)
    ) {
      continue;
    }
    for (const element of statement.exportClause.elements) {
      if (!element.isTypeOnly && moduleExportNameText(element.name) === "agentFactories") {
        localNames.add(
          element.propertyName === undefined ? "agentFactories" : moduleExportNameText(element.propertyName)
        );
      }
    }
  }
  return localNames;
}

function collectObjectMemberNames(
  source: ts.SourceFile,
  expression: ts.Expression,
  names: Set<string>,
  visitingLocalNames: Set<string>
): void {
  const current = unwrapTypeExpressions(expression);
  if (ts.isObjectLiteralExpression(current)) {
    for (const property of current.properties) {
      if (ts.isSpreadAssignment(property)) {
        collectObjectMemberNames(source, property.expression, names, visitingLocalNames);
        continue;
      }
      const name = objectMemberName(property);
      if (name !== undefined) names.add(name);
    }
    return;
  }
  if (
    ts.isCallExpression(current) &&
    current.arguments.length === 1 &&
    ts.isPropertyAccessExpression(current.expression) &&
    ts.isIdentifier(current.expression.expression) &&
    current.expression.expression.text === "Object" &&
    current.expression.name.text === "freeze"
  ) {
    collectObjectMemberNames(source, current.arguments[0]!, names, visitingLocalNames);
    return;
  }
  if (!ts.isIdentifier(current) || visitingLocalNames.has(current.text)) return;

  visitingLocalNames.add(current.text);
  try {
    for (const statement of source.statements) {
      if (!ts.isVariableStatement(statement) || (statement.declarationList.flags & ts.NodeFlags.Const) === 0) {
        continue;
      }
      for (const declaration of statement.declarationList.declarations) {
        if (
          ts.isIdentifier(declaration.name) &&
          declaration.name.text === current.text &&
          declaration.initializer !== undefined
        ) {
          collectObjectMemberNames(source, declaration.initializer, names, visitingLocalNames);
        }
      }
    }
  } finally {
    visitingLocalNames.delete(current.text);
  }
}

function hasExportModifier(node: ts.VariableStatement): boolean {
  return ts.getModifiers(node)?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword) ?? false;
}

function moduleExportNameText(name: ts.ModuleExportName): string {
  return name.text;
}

function unwrapTypeExpressions(expression: ts.Expression): ts.Expression {
  let current = expression;
  while (ts.isAsExpression(current) || ts.isSatisfiesExpression(current) || ts.isParenthesizedExpression(current)) {
    current = current.expression;
  }
  return current;
}

function objectMemberName(property: ts.ObjectLiteralElementLike): string | undefined {
  if (
    !ts.isPropertyAssignment(property) &&
    !ts.isShorthandPropertyAssignment(property) &&
    !ts.isMethodDeclaration(property)
  ) {
    return undefined;
  }
  const name = property.name;
  if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNoSubstitutionTemplateLiteral(name)) return name.text;
  if (ts.isComputedPropertyName(name)) {
    const expression = unwrapTypeExpressions(name.expression);
    if (ts.isStringLiteral(expression) || ts.isNoSubstitutionTemplateLiteral(expression)) return expression.text;
  }
  return undefined;
}
