import path from "node:path";

import type { ArtifactValidationWarning } from "./artifact-validation.js";

/**
 * The gate that names a generated invariant check that may not be able to
 * fail under Recon (#687).
 * Recon runs in assertion mode: only a failed `assert` is a finding, and a
 * call that reverts for any other reason is discarded. These warnings never
 * fail a node; they mark checks for review in the report.
 */
export const INVARIANT_ORACLE_GATE = "invariant-oracle-falsifiability" as const;

const SUITE_PREFIX = "invariant-suite/";
const TEST_ROOTS = ["test/", "tests/"] as const;
const PRODUCTION_ROOTS = ["src/", "contracts/"] as const;
// A source, not a shared RegExp: a global matcher keeps `lastIndex` between
// uses, and `matchAll` starts from it, which would skip earlier assertions.
const ASSERTION_CALL_SOURCE = String.raw`\b(assert|assertTrue|assertEq|assertLe|assertLt|assertGe|assertGt|t|eq|gt|gte|lt|lte)\s*\(`;
// Receivers whose calls are cheatcodes, encoding or logging rather than the target.
const NON_TARGET_RECEIVERS = new Set(["abi", "vm", "hevm", "console", "console2", "string", "bytes", "type", "super"]);

interface SoliditySource {
  path: string;
  /** Comments and string contents blanked, for reading code. */
  text: string;
  /** Comments blanked and strings kept, for reading import paths. */
  withStrings: string;
}

/**
 * Warnings for the generated Solidity test sources in an invariant-suite
 * publication. Only `invariant-suite/test/` and `invariant-suite/tests/` are
 * read; production sources are never judged.
 */
export function invariantOracleWarnings(publications: ReadonlyMap<string, Uint8Array>): ArtifactValidationWarning[] {
  const warnings: ArtifactValidationWarning[] = [];
  for (const [artifactPath, bytes] of [...publications].sort(([left], [right]) => left.localeCompare(right))) {
    if (!artifactPath.startsWith(SUITE_PREFIX) || !artifactPath.endsWith(".sol")) continue;
    const suitePath = artifactPath.slice(SUITE_PREFIX.length);
    if (!TEST_ROOTS.some((root) => suitePath.startsWith(root))) continue;
    const withStrings = withoutComments(Buffer.from(bytes).toString("utf8"));
    const source = { path: suitePath, text: withoutStrings(withStrings), withStrings };
    for (const finding of [
      ...constantTrueAssertions(source),
      ...discardedRequires(source),
      ...blanketCatches(source),
      ...implementationCallsInAssertions(source)
    ]) {
      warnings.push({
        code: finding.code,
        artifact_path: artifactPath,
        field_path: `line ${String(lineOf(source.text, finding.offset))}`,
        message: finding.message,
        gate: INVARIANT_ORACLE_GATE
      });
    }
  }
  return warnings;
}

interface Finding {
  code: string;
  offset: number;
  message: string;
}

function constantTrueAssertions(source: SoliditySource): Finding[] {
  const findings: Finding[] = [];
  for (const call of assertionCalls(source.text)) {
    const args = splitTopLevel(call.args);
    const first = args[0]?.replace(/\s+/gu, "") ?? "";
    const literalTrue = ["assert", "assertTrue", "t"].includes(call.name) && /^(true|!false|\(true\))$/u.test(first);
    const sameOperands =
      ["assertEq", "eq", "assertLe", "assertGe", "lte", "gte"].includes(call.name) &&
      args.length >= 2 &&
      first !== "" &&
      first === args[1]?.replace(/\s+/gu, "");
    const selfComparison = call.name === "assert" && /^(.+)(==|<=|>=)\1$/u.test(first);
    if (literalTrue || sameOperands || selfComparison) {
      findings.push({
        code: "INVARIANT_ORACLE_CONSTANT_TRUE",
        offset: call.offset,
        message: `${call.name}(...) is true whatever the target does, so it can never report a violation`
      });
    }
  }
  return findings;
}

function discardedRequires(source: SoliditySource): Finding[] {
  const findings: Finding[] = [];
  for (const body of functionBodies(source.text)) {
    const firstCall = firstTargetCall(body.text);
    if (firstCall === undefined) continue;
    for (const match of body.text.matchAll(/\brequire\s*\(/gu)) {
      if (match.index <= firstCall) continue;
      findings.push({
        code: "INVARIANT_ORACLE_REQUIRE_DISCARDED",
        offset: body.offset + match.index,
        message:
          "require after a target call is a post-condition that Recon discards in assertion mode; check an outcome with assert"
      });
    }
  }
  return findings;
}

function blanketCatches(source: SoliditySource): Finding[] {
  const findings: Finding[] = [];
  for (const match of source.text.matchAll(/\bcatch\b[^{]*\{/gu)) {
    const open = match.index + match[0].length - 1;
    const close = matchingBrace(source.text, open);
    if (close === undefined) continue;
    const body = source.text.slice(open + 1, close);
    // Rethrowing is no exception: Recon discards an ordinary revert, so only an
    // assertion in the catch can report the failure.
    if (new RegExp(ASSERTION_CALL_SOURCE, "u").test(body)) continue;
    findings.push({
      code: "INVARIANT_ORACLE_BLANKET_CATCH",
      offset: match.index,
      message:
        "catch accepts every failure without an assertion; a liveness check must assert(false) for any selector the catalog does not document"
    });
  }
  return findings;
}

function implementationCallsInAssertions(source: SoliditySource): Finding[] {
  const aliases = productionImportAliases(source);
  if (aliases.size === 0) return [];
  const findings: Finding[] = [];
  for (const call of assertionCalls(source.text)) {
    for (const match of call.args.matchAll(/\b([A-Za-z_]\w*)\s*\.\s*([A-Za-z_]\w*)\s*\(/gu)) {
      const alias = match[1] ?? "";
      if (!aliases.has(alias)) continue;
      findings.push({
        code: "INVARIANT_ORACLE_IMPLEMENTATION_CALL",
        offset: call.offset,
        message: `${call.name}(...) computes its expected value with ${alias}.${match[2] ?? ""} from the code under test, so it may agree with the implementation by construction; check that the expected value is independent`
      });
      break;
    }
  }
  return findings;
}

/** Names a test file imports from production sources (`src/`, `contracts/`). */
function productionImportAliases(source: SoliditySource): Set<string> {
  const aliases = new Set<string>();
  const directory = path.posix.dirname(source.path);
  for (const match of source.withStrings.matchAll(/\bimport\s+([^;]*?)\s+from\s+"([^"]+)"\s*;/gu)) {
    const target = match[2] ?? "";
    const resolved = target.startsWith(".") ? path.posix.normalize(path.posix.join(directory, target)) : target;
    if (!PRODUCTION_ROOTS.some((root) => resolved.startsWith(root))) continue;
    const clause = match[1] ?? "";
    const named = /^\{([^}]*)\}$/u.exec(clause.trim());
    if (named !== null) {
      for (const entry of (named[1] ?? "").split(",")) {
        const parts = entry.trim().split(/\s+as\s+/u);
        const name = (parts[1] ?? parts[0] ?? "").trim();
        if (name !== "") aliases.add(name);
      }
    } else {
      const star = /^\*\s+as\s+([A-Za-z_]\w*)$/u.exec(clause.trim());
      if (star?.[1] !== undefined) aliases.add(star[1]);
    }
  }
  return aliases;
}

function assertionCalls(text: string): Array<{ name: string; args: string; offset: number }> {
  const calls: Array<{ name: string; args: string; offset: number }> = [];
  for (const match of text.matchAll(new RegExp(ASSERTION_CALL_SOURCE, "gu"))) {
    // `x.assert(` or `function t(` is not an assertion call.
    const before = text.slice(Math.max(0, match.index - 9), match.index);
    if (/\.\s*$/u.test(before) || /\bfunction\s+$/u.test(before)) continue;
    const open = match.index + match[0].length - 1;
    const close = matchingParen(text, open);
    if (close === undefined) continue;
    calls.push({ name: match[1] ?? "", args: text.slice(open + 1, close), offset: match.index });
  }
  return calls;
}

function functionBodies(text: string): Array<{ text: string; offset: number }> {
  const bodies: Array<{ text: string; offset: number }> = [];
  for (const match of text.matchAll(/\bfunction\b[^{;]*\{/gu)) {
    const open = match.index + match[0].length - 1;
    const close = matchingBrace(text, open);
    if (close !== undefined) bodies.push({ text: text.slice(open + 1, close), offset: open + 1 });
  }
  return bodies;
}

/**
 * The offset of the first statement that calls a possible target for its effect:
 * a member call whose result is not assigned, or a `try`. A read such as
 * `uint256 shares = vault.balanceOf(actor);` followed by a guarding `require`
 * is a precondition, not a post-condition, so it does not count.
 */
function firstTargetCall(body: string): number | undefined {
  for (const match of body.matchAll(
    /(?:^|[;{}])\s*(?:try\s+)?([A-Za-z_]\w*)\s*\.\s*[A-Za-z_]\w*\s*(?:\{[^}]*\}\s*)?\(/gu
  )) {
    if (!NON_TARGET_RECEIVERS.has(match[1] ?? "")) return match.index;
  }
  return undefined;
}

function splitTopLevel(args: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  for (let index = 0; index < args.length; index += 1) {
    const char = args[index];
    if (char === "(" || char === "[" || char === "{") depth += 1;
    else if (char === ")" || char === "]" || char === "}") depth -= 1;
    else if (char === "," && depth === 0) {
      parts.push(args.slice(start, index));
      start = index + 1;
    }
  }
  parts.push(args.slice(start));
  return parts;
}

function matchingBrace(text: string, open: number): number | undefined {
  return matchingDelimiter(text, open, "{", "}");
}

function matchingParen(text: string, open: number): number | undefined {
  return matchingDelimiter(text, open, "(", ")");
}

function matchingDelimiter(text: string, open: number, opening: string, closing: string): number | undefined {
  let depth = 0;
  for (let index = open; index < text.length; index += 1) {
    if (text[index] === opening) depth += 1;
    else if (text[index] === closing) {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  return undefined;
}

// Comments and string contents become spaces, so offsets and line numbers still match the file.
// A string is matched before a comment so `//` inside a string literal is not read as a comment.
const STRING_OR_COMMENT = /"(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])*'|\/\*[\s\S]*?\*\/|\/\/[^\n]*/gu;

function withoutComments(text: string): string {
  return text.replace(STRING_OR_COMMENT, (match) =>
    match.startsWith('"') || match.startsWith("'") ? match : match.replace(/[^\n]/gu, " ")
  );
}

function withoutStrings(text: string): string {
  return text.replace(STRING_OR_COMMENT, (match) =>
    match.startsWith('"') || match.startsWith("'") ? `"${" ".repeat(Math.max(0, match.length - 2))}"` : match
  );
}

function lineOf(text: string, offset: number): number {
  let line = 1;
  for (let index = 0; index < offset && index < text.length; index += 1) if (text[index] === "\n") line += 1;
  return line;
}
