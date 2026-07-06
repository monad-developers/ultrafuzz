import { normalizeRelativePath, splitPathComponents, validateSafeId, validateSafeRelativePath } from "./path-policy.js";
import { type PolicyDiagnostic, type PolicyResult, policyError, policyResult } from "./types.js";

export interface MaterializeCopySelection {
  source: string;
  destination: string;
}

export interface MaterializePolicyInput {
  patches?: readonly string[];
  copies?: readonly MaterializeCopySelection[];
  confirmed?: boolean;
  dryRun?: boolean;
  mode?: "dry-run" | "unstaged-working-tree" | "staged" | "commit" | "push";
  allowOverwrite?: boolean;
}

export interface MaterializePolicyValue {
  patches: string[];
  copies: MaterializeCopySelection[];
  mode: "dry-run" | "unstaged-working-tree";
}

export interface CleanPolicyInput {
  selections: readonly string[];
  confirmed?: boolean;
  dryRun?: boolean;
}

export function validateMaterializePolicy(input: MaterializePolicyInput): PolicyResult<MaterializePolicyValue> {
  const diagnostics: PolicyDiagnostic[] = [];
  const patches = [...(input.patches ?? [])];
  const copies = [...(input.copies ?? [])];

  if (patches.length === 0 && copies.length === 0) {
    diagnostics.push(policyError("MATERIALIZE_NO_SELECTION", "materialization requires explicit selected outputs"));
  }
  if (patches.length > 0) {
    diagnostics.push(
      policyError(
        "MATERIALIZE_PATCHES_UNSUPPORTED",
        "patch materialization is not implemented; copy explicit output files instead"
      )
    );
  }
  if (!input.dryRun && input.confirmed !== true) {
    diagnostics.push(
      policyError("MATERIALIZE_CONFIRMATION_REQUIRED", "materialization requires explicit confirmation")
    );
  }
  if (input.mode && input.mode !== "dry-run" && input.mode !== "unstaged-working-tree") {
    diagnostics.push(
      policyError("MATERIALIZE_UNSAFE_MODE", `materialization mode \`${input.mode}\` would publish or stage changes`)
    );
  }

  for (const patch of patches) {
    diagnostics.push(...validateSelectedRunOutput("patch", patch).diagnostics);
    if (!/\.(?:diff|patch)$/i.test(patch)) {
      diagnostics.push(
        policyError("MATERIALIZE_PATCH_EXTENSION", `patch selection \`${patch}\` must be a .diff or .patch file`)
      );
    }
  }

  const destinations = new Set<string>();
  for (const copy of copies) {
    diagnostics.push(...validateSelectedRunOutput("copy source", copy.source).diagnostics);
    diagnostics.push(...validateRepoDestination(copy.destination).diagnostics);
    const destinationKey = normalizeRelativePath(copy.destination);
    if (destinations.has(destinationKey)) {
      diagnostics.push(
        policyError(
          "MATERIALIZE_DUPLICATE_DESTINATION",
          `copy destination \`${copy.destination}\` is selected more than once`
        )
      );
    }
    destinations.add(destinationKey);
  }

  return policyResult(diagnostics, {
    patches,
    copies,
    mode: input.dryRun ? "dry-run" : "unstaged-working-tree"
  });
}

export function validateCleanPolicy(input: CleanPolicyInput): PolicyResult<string[]> {
  const diagnostics: PolicyDiagnostic[] = [];
  if (input.selections.length === 0) {
    diagnostics.push(policyError("CLEAN_NO_SELECTION", "clean requires selected generated paths"));
  }
  if (!input.dryRun && input.confirmed !== true) {
    diagnostics.push(policyError("CLEAN_CONFIRMATION_REQUIRED", "clean requires explicit confirmation"));
  }
  for (const selection of input.selections) {
    diagnostics.push(...validateSafeRelativePath(selection).diagnostics);
    diagnostics.push(...validateExplicitRelativeSelection("clean selection", selection).diagnostics);
    diagnostics.push(...validateCleanSelectionShape(selection).diagnostics);
    const normalized = normalizeRelativePath(selection);
    if (!isGeneratedCleanPath(normalized)) {
      diagnostics.push(
        policyError(
          "CLEAN_NON_GENERATED_PATH",
          `clean selection \`${selection}\` is not under a generated run, artifact, or workspace root`
        )
      );
    }
    if (normalized.startsWith(".git/") || normalized === ".git") {
      diagnostics.push(policyError("CLEAN_GIT_PATH", "clean must never remove git metadata"));
    }
  }
  return policyResult(diagnostics, [...input.selections]);
}

function validateSelectedRunOutput(label: string, selectedPath: string): PolicyResult<string> {
  const diagnostics = [
    ...validateSafeRelativePath(selectedPath).diagnostics,
    ...validateExplicitRelativeSelection(label, selectedPath).diagnostics,
    ...validateMaterializePathSegments(label, selectedPath).diagnostics
  ];
  const normalized = normalizeRelativePath(selectedPath);
  if (!isRunOutputPath(normalized)) {
    diagnostics.push(
      policyError(
        "MATERIALIZE_SOURCE_NOT_OUTPUT",
        `${label} \`${selectedPath}\` is not under an allowed run output root`
      )
    );
  }
  if (normalized.startsWith(".git/") || normalized === ".git") {
    diagnostics.push(policyError("MATERIALIZE_GIT_SOURCE", "materialization source must not read git metadata"));
  }
  return policyResult(diagnostics, normalized);
}

function validateRepoDestination(destination: string): PolicyResult<string> {
  const normalized = normalizeRelativePath(destination);
  const diagnostics = [
    ...validateSafeRelativePath(destination).diagnostics,
    ...validateExplicitRelativeSelection("copy destination", destination).diagnostics
  ];
  if (normalized.startsWith(".git/") || normalized === ".git") {
    diagnostics.push(policyError("MATERIALIZE_GIT_DESTINATION", "materialization must not write git metadata"));
  }
  if (normalized.startsWith(".ultrafuzz/") || normalized === ".ultrafuzz") {
    diagnostics.push(
      policyError("MATERIALIZE_PRODUCT_SURFACE_DESTINATION", "materialization must not write product run surfaces")
    );
  }
  if (isSensitiveMaterializeDestination(normalized)) {
    diagnostics.push(policyError("MATERIALIZE_SENSITIVE_DESTINATION", `destination \`${destination}\` is sensitive`));
  }
  diagnostics.push(...validateMaterializePathSegments("copy destination", destination).diagnostics);
  return policyResult(diagnostics, normalized);
}

function isSensitiveMaterializeDestination(normalized: string): boolean {
  const components = splitPathComponents(normalized);
  const [root] = components;
  const basename = components.at(-1) ?? normalized;
  if (basename === ".env" || basename.startsWith(".env.")) {
    return true;
  }
  if (/^secrets?\.[A-Za-z0-9._-]+$/i.test(basename)) {
    return true;
  }
  if (basename.endsWith(".pem") || basename.endsWith(".key")) {
    return true;
  }
  return root !== undefined && SENSITIVE_MATERIALIZE_ROOTS.has(root);
}

const SENSITIVE_MATERIALIZE_ROOTS = new Set(["secrets", ".secrets", ".ssh", ".aws", ".gcloud", ".azure"]);

function isRunOutputPath(value: string): boolean {
  const components = splitPathComponents(value);
  const root = components[0];
  if (root === "artifacts") {
    return components.length >= 3;
  }
  return (root === "review" || root === "reports" || root === "outputs") && components.length >= 2;
}

function isGeneratedCleanPath(value: string): boolean {
  const components = splitPathComponents(value);
  const root = components[0];
  if (root === "runs") {
    if (components.length === 2) {
      return true;
    }
    return components.length >= 4 && (components[2] === "artifacts" || components[2] === "workspaces");
  }
  return (root === "artifacts" || root === "workspaces") && components.length >= 2;
}

function validateExplicitRelativeSelection(label: string, selection: string): PolicyResult<string> {
  const normalized = normalizeRelativePath(selection);
  const diagnostics: PolicyDiagnostic[] = [];
  if (selection.trim() !== selection || selection.trim().length === 0) {
    diagnostics.push(policyError("PATH_UNSAFE_WHITESPACE", `${label} \`${selection}\` must not be empty or padded`));
  }
  if (/[?*[\]{}]/u.test(selection)) {
    diagnostics.push(policyError("PATH_IMPLICIT_BULK_SELECTION", `${label} \`${selection}\` must not use glob syntax`));
  }
  if (selection.endsWith("/") || selection.endsWith("\\")) {
    diagnostics.push(
      policyError(
        "PATH_IMPLICIT_DIRECTORY_SELECTION",
        `${label} \`${selection}\` must name an explicit file or generated root`
      )
    );
  }
  if (normalized === "*" || normalized === "**") {
    diagnostics.push(
      policyError("PATH_IMPLICIT_BULK_SELECTION", `${label} \`${selection}\` is an implicit bulk selection`)
    );
  }
  return policyResult(diagnostics, normalized);
}

function validateMaterializePathSegments(label: string, selectedPath: string): PolicyResult<string> {
  const normalized = normalizeRelativePath(selectedPath);
  const diagnostics: PolicyDiagnostic[] = [];
  for (const component of splitPathComponents(normalized)) {
    diagnostics.push(...validateSafeId(`${label} path segment`, component).diagnostics);
  }
  return policyResult(diagnostics, normalized);
}

function validateCleanSelectionShape(selection: string): PolicyResult<string> {
  const normalized = normalizeRelativePath(selection);
  const diagnostics: PolicyDiagnostic[] = [];
  const components = splitPathComponents(normalized);
  const [root, firstId, scope, scopedId] = components;
  if (root === "runs") {
    if (firstId !== undefined) {
      diagnostics.push(...validateSafeId("clean run ID", firstId).diagnostics);
    }
    if (scope !== undefined && scope !== "artifacts" && scope !== "workspaces") {
      diagnostics.push(
        policyError(
          "CLEAN_UNSUPPORTED_RUN_SUBPATH",
          `clean selection \`${selection}\` may only target a run root, run artifacts, or run workspaces`
        )
      );
    }
    if (scopedId !== undefined) {
      diagnostics.push(...validateSafeId("clean generated selection ID", scopedId).diagnostics);
    }
  } else if (root === "artifacts" || root === "workspaces") {
    if (firstId !== undefined) {
      diagnostics.push(...validateSafeId("clean generated selection ID", firstId).diagnostics);
    }
  }
  return policyResult(diagnostics, normalized);
}
