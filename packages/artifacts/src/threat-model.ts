import fs from "node:fs";
import path from "node:path";

import { z } from "zod/v4";

import { assertRegularFileInside, prepareSafeFilePath, safeResolveInside, writeFileDurable } from "./safe-paths.js";
import { schemaErrorMessage, validateWithZod, type SchemaValidationResult } from "./schema-validation.js";

export const THREAT_MODEL_SCHEMA_VERSION = "ultrafuzz.threat-model.v1" as const;
export const THREAT_MODEL_JSON_SCHEMA_ID = "urn:ultrafuzz:schema:artifacts:threat-model:1" as const;
export const CAPABILITY_STATUSES = ["present", "absent", "unknown"] as const;
export const INVARIANT_KINDS = ["economic", "accounting", "state", "authorization", "integration"] as const;

const nonEmptyString = z.string().trim().min(1);
const uniqueStrings = z
  .array(nonEmptyString)
  .refine((values) => new Set(values).size === values.length, { message: "Values must be unique" });
const oneOrMoreStrings = uniqueStrings.min(1);
const hierarchicalId = z.string().regex(/^[a-z0-9]+(?:[.-][a-z0-9]+)*(?::[a-z0-9]+(?:[.-][a-z0-9]+)*)*$/u, {
  message: "ID must be a lowercase, slug-safe hierarchy separated by colons"
});
const threatId = z.string().regex(/^[a-z0-9]+(?:[.-][a-z0-9]+)*:[a-z0-9]+(?:[.:-][a-z0-9]+)*$/u, {
  message: "Threat ID must be a lowercase colon-separated hierarchy"
});
const capabilityId = z.string().regex(/^[a-z0-9]+(?:[.-][a-z0-9]+)*$/u, {
  message: "Capability ID must be a lowercase dotted slug"
});
export const repositoryRelativePathSchema = z
  .string()
  .min(1)
  .max(512)
  .refine(
    (value) =>
      !path.posix.isAbsolute(value) &&
      !path.win32.isAbsolute(value) &&
      !/^[A-Za-z]:/u.test(value) &&
      !value.includes("\\") &&
      !containsAsciiControl(value) &&
      !value.split("/").some((segment) => segment.includes(":")) &&
      path.posix.normalize(value) === value &&
      !value.split("/").some((segment) => segment === "" || segment === "." || segment === ".."),
    "must be a canonical relative POSIX repository path"
  );

function containsAsciiControl(value: string): boolean {
  return [...value].some((character) => {
    const codePoint = character.codePointAt(0)!;
    return codePoint <= 0x1f || codePoint === 0x7f;
  });
}

const evidenceReferenceSchema = z
  .strictObject({
    path: repositoryRelativePathSchema,
    line: z.number().int().positive().optional(),
    end_line: z.number().int().positive().optional(),
    symbol: nonEmptyString.optional(),
    note: nonEmptyString.optional()
  })
  .superRefine((value, context) => {
    if (value.line !== undefined && value.end_line !== undefined && value.end_line < value.line) {
      context.addIssue({ code: "custom", path: ["end_line"], message: "end_line cannot precede line" });
    }
  });

const capabilitySchema = z
  .strictObject({
    id: capabilityId,
    status: z.enum(CAPABILITY_STATUSES),
    rationale: nonEmptyString.optional(),
    evidence: z.array(evidenceReferenceSchema)
  })
  .superRefine((value, context) => {
    if (value.status !== "unknown" && value.evidence.length === 0) {
      context.addIssue({
        code: "custom",
        path: ["evidence"],
        message: value.status + " capabilities require repository evidence"
      });
    }
  });

const assetSchema = z.strictObject({
  id: hierarchicalId,
  name: nonEmptyString,
  description: nonEmptyString.optional(),
  value_at_risk: nonEmptyString.optional(),
  evidence: z.array(evidenceReferenceSchema)
});
const actorSchema = z.strictObject({
  id: hierarchicalId,
  name: nonEmptyString,
  role: nonEmptyString,
  trust: z.enum(["untrusted", "partially-trusted", "trusted", "privileged"]),
  privileges: uniqueStrings,
  evidence: z.array(evidenceReferenceSchema)
});
const trustBoundarySchema = z.strictObject({
  id: hierarchicalId,
  name: nonEmptyString,
  description: nonEmptyString.optional(),
  actor_ids: uniqueStrings,
  evidence: z.array(evidenceReferenceSchema)
});
const attackSurfaceSchema = z.strictObject({
  id: hierarchicalId,
  name: nonEmptyString,
  description: nonEmptyString.optional(),
  entry_points: oneOrMoreStrings,
  asset_ids: uniqueStrings,
  actor_ids: uniqueStrings,
  capability_ids: uniqueStrings,
  trust_boundary_ids: uniqueStrings,
  evidence: z.array(evidenceReferenceSchema)
});
const valueFlowSchema = z.strictObject({
  id: hierarchicalId,
  name: nonEmptyString,
  description: nonEmptyString.optional(),
  steps: oneOrMoreStrings,
  asset_ids: oneOrMoreStrings,
  actor_ids: uniqueStrings,
  evidence: z.array(evidenceReferenceSchema)
});
const lifecycleTransitionSchema = z.strictObject({
  id: hierarchicalId,
  name: nonEmptyString,
  from: nonEmptyString,
  to: nonEmptyString,
  trigger: nonEmptyString,
  guards: uniqueStrings,
  effects: uniqueStrings,
  evidence: z.array(evidenceReferenceSchema)
});
const invariantSchema = z.strictObject({
  id: hierarchicalId,
  name: nonEmptyString,
  kind: z.enum(INVARIANT_KINDS),
  statement: nonEmptyString,
  asset_ids: uniqueStrings,
  capability_ids: uniqueStrings,
  evidence: z.array(evidenceReferenceSchema)
});
const assumptionSchema = z.strictObject({
  id: hierarchicalId,
  name: nonEmptyString,
  statement: nonEmptyString,
  evidence: z.array(evidenceReferenceSchema)
});
const unknownSchema = z.strictObject({
  id: hierarchicalId,
  name: nonEmptyString,
  description: nonEmptyString.optional(),
  security_impact: nonEmptyString.optional(),
  evidence_needed: nonEmptyString
});
const coverageGapSchema = z.strictObject({
  id: hierarchicalId,
  name: nonEmptyString,
  description: nonEmptyString.optional(),
  reason: nonEmptyString
});
const threatSchema = z.strictObject({
  id: threatId,
  title: nonEmptyString,
  description: nonEmptyString.optional(),
  preconditions: oneOrMoreStrings,
  impact: nonEmptyString,
  asset_ids: uniqueStrings,
  actor_ids: uniqueStrings,
  attack_surface_ids: oneOrMoreStrings,
  capability_ids: uniqueStrings,
  trust_boundary_ids: uniqueStrings,
  invariant_ids: uniqueStrings,
  assumption_ids: uniqueStrings,
  unknown_ids: uniqueStrings,
  evidence: z.array(evidenceReferenceSchema)
});

export const threatModelSchema = z
  .strictObject({
    schema_version: z.literal(THREAT_MODEL_SCHEMA_VERSION),
    title: nonEmptyString,
    scope: z.strictObject({
      summary: nonEmptyString.optional(),
      repository_evidence: z.array(evidenceReferenceSchema),
      exclusions: uniqueStrings
    }),
    protocol: z.strictObject({
      summary: nonEmptyString.optional(),
      archetypes: oneOrMoreStrings
    }),
    capabilities: z.array(capabilitySchema).min(1),
    assets: z.array(assetSchema).min(1),
    actors: z.array(actorSchema).min(1),
    trust_boundaries: z.array(trustBoundarySchema),
    attack_surfaces: z.array(attackSurfaceSchema).min(1),
    value_flows: z.array(valueFlowSchema),
    lifecycle_transitions: z.array(lifecycleTransitionSchema),
    invariants: z.array(invariantSchema).min(1),
    threats: z.array(threatSchema).min(1),
    assumptions: z.array(assumptionSchema),
    unknowns: z.array(unknownSchema),
    coverage_gaps: z.array(coverageGapSchema)
  })
  .superRefine((value, context) => {
    const collections = [
      ["capabilities", value.capabilities],
      ["assets", value.assets],
      ["actors", value.actors],
      ["trust_boundaries", value.trust_boundaries],
      ["attack_surfaces", value.attack_surfaces],
      ["value_flows", value.value_flows],
      ["lifecycle_transitions", value.lifecycle_transitions],
      ["invariants", value.invariants],
      ["threats", value.threats],
      ["assumptions", value.assumptions],
      ["unknowns", value.unknowns],
      ["coverage_gaps", value.coverage_gaps]
    ] as const;
    for (const [field, entries] of collections) {
      addDuplicateIdIssues(entries, field, context);
    }

    const references = {
      asset_ids: new Set(value.assets.map((entry) => entry.id)),
      actor_ids: new Set(value.actors.map((entry) => entry.id)),
      capability_ids: new Set(value.capabilities.map((entry) => entry.id)),
      trust_boundary_ids: new Set(value.trust_boundaries.map((entry) => entry.id)),
      attack_surface_ids: new Set(value.attack_surfaces.map((entry) => entry.id)),
      invariant_ids: new Set(value.invariants.map((entry) => entry.id)),
      assumption_ids: new Set(value.assumptions.map((entry) => entry.id)),
      unknown_ids: new Set(value.unknowns.map((entry) => entry.id))
    };
    validateReferences(value.trust_boundaries, "trust_boundaries", { actor_ids: references.actor_ids }, context);
    validateReferences(
      value.attack_surfaces,
      "attack_surfaces",
      {
        asset_ids: references.asset_ids,
        actor_ids: references.actor_ids,
        capability_ids: references.capability_ids,
        trust_boundary_ids: references.trust_boundary_ids
      },
      context
    );
    validateReferences(
      value.value_flows,
      "value_flows",
      { asset_ids: references.asset_ids, actor_ids: references.actor_ids },
      context
    );
    validateReferences(
      value.invariants,
      "invariants",
      { asset_ids: references.asset_ids, capability_ids: references.capability_ids },
      context
    );
    validateReferences(value.threats, "threats", references, context);
  });

/**
 * The canonical JSON Schema for `ultrafuzz/threat-model@1`, generated from the single runtime
 * contract above and snapshotted to `schema/threat-model.schema.json` so prompts and external
 * consumers can reference one authoritative document instead of a hand-maintained shape summary.
 */
export const threatModelJsonSchema = {
  ...z.toJSONSchema(threatModelSchema, { io: "input", unrepresentable: "any" }),
  $id: THREAT_MODEL_JSON_SCHEMA_ID,
  title: "Ultrafuzz threat model"
} as Record<string, unknown>;

export type ThreatModel = z.infer<typeof threatModelSchema>;
export type ThreatModelEvidenceReference = z.infer<typeof evidenceReferenceSchema>;
export type CapabilityStatus = (typeof CAPABILITY_STATUSES)[number];

export function validateThreatModel(value: unknown, path = "$"): SchemaValidationResult<ThreatModel> {
  return validateWithZod(threatModelSchema, value, { path, code: "THREAT_MODEL_SCHEMA_INVALID" });
}

export function assertThreatModel(value: unknown): ThreatModel {
  const result = validateThreatModel(value);
  if (!result.ok || result.value === undefined) {
    throw new Error(schemaErrorMessage("threat model", result.issues));
  }
  return result.value;
}

export function renderThreatModelMarkdown(input: ThreatModel): string {
  const model = assertThreatModel(input);
  const lines = [
    "# " + model.title,
    "",
    "## Scope",
    "",
    model.scope.summary ?? "Not recorded.",
    "",
    "Protocol archetypes: " + inlineList(model.protocol.archetypes) + ".",
    "",
    model.protocol.summary ?? "Not recorded.",
    "",
    "### Repository evidence",
    ""
  ];
  appendEvidenceList(lines, model.scope.repository_evidence);
  lines.push("", "### Exclusions", "");
  appendStringList(lines, model.scope.exclusions, "None recorded.");

  lines.push("", "## Capabilities", "", "| Capability | Status | Rationale | Evidence |", "| --- | --- | --- | --- |");
  for (const capability of model.capabilities) {
    lines.push(
      "| " +
        code(capability.id) +
        " | " +
        capability.status +
        " | " +
        escapeTable(capability.rationale ?? "Not recorded.") +
        " | " +
        escapeTable(evidenceSummary(capability.evidence)) +
        " |"
    );
  }

  appendNamedEntries(lines, "Assets and value stores", model.assets, (entry) => [
    entry.description ?? "Not recorded.",
    "Value at risk: " + (entry.value_at_risk ?? "Not recorded."),
    "Evidence: " + evidenceSummary(entry.evidence)
  ]);
  appendNamedEntries(lines, "Actors and roles", model.actors, (entry) => [
    entry.role,
    "Trust: " + entry.trust,
    "Privileges: " + inlineList(entry.privileges),
    "Evidence: " + evidenceSummary(entry.evidence)
  ]);
  appendNamedEntries(lines, "Trust boundaries", model.trust_boundaries, (entry) => [
    entry.description ?? "Not recorded.",
    "Actors: " + inlineCodeList(entry.actor_ids),
    "Evidence: " + evidenceSummary(entry.evidence)
  ]);
  appendNamedEntries(lines, "Attack surfaces", model.attack_surfaces, (entry) => [
    entry.description ?? "Not recorded.",
    "Entry points: " + inlineList(entry.entry_points),
    "Assets: " + inlineCodeList(entry.asset_ids),
    "Actors: " + inlineCodeList(entry.actor_ids),
    "Capabilities: " + inlineCodeList(entry.capability_ids),
    "Trust boundaries: " + inlineCodeList(entry.trust_boundary_ids),
    "Evidence: " + evidenceSummary(entry.evidence)
  ]);
  appendNamedEntries(lines, "Value and accounting flows", model.value_flows, (entry) => [
    entry.description ?? "Not recorded.",
    "Assets: " + inlineCodeList(entry.asset_ids),
    "Actors: " + inlineCodeList(entry.actor_ids),
    ...entry.steps.map((step, index) => "Step " + String(index + 1) + ": " + step),
    "Evidence: " + evidenceSummary(entry.evidence)
  ]);
  appendNamedEntries(lines, "Lifecycle transitions", model.lifecycle_transitions, (entry) => [
    entry.from + " -> " + entry.to,
    "Trigger: " + entry.trigger,
    "Guards: " + inlineList(entry.guards),
    "Effects: " + inlineList(entry.effects),
    "Evidence: " + evidenceSummary(entry.evidence)
  ]);
  appendNamedEntries(lines, "Economic and security invariants", model.invariants, (entry) => [
    entry.kind + ": " + entry.statement,
    "Assets: " + inlineCodeList(entry.asset_ids),
    "Capabilities: " + inlineCodeList(entry.capability_ids),
    "Evidence: " + evidenceSummary(entry.evidence)
  ]);

  lines.push("", "## Threats", "");
  for (const threat of model.threats) {
    lines.push(
      "### " + threat.title + " (" + code(threat.id) + ")",
      "",
      threat.description ?? "Not recorded.",
      "",
      "- Preconditions: " + inlineList(threat.preconditions),
      "- Impact: " + threat.impact,
      "- Assets: " + inlineCodeList(threat.asset_ids),
      "- Actors: " + inlineCodeList(threat.actor_ids),
      "- Attack surfaces: " + inlineCodeList(threat.attack_surface_ids),
      "- Capabilities: " + inlineCodeList(threat.capability_ids),
      "- Trust boundaries: " + inlineCodeList(threat.trust_boundary_ids),
      "- Invariants: " + inlineCodeList(threat.invariant_ids),
      "- Assumptions: " + inlineCodeList(threat.assumption_ids),
      "- Unknowns: " + inlineCodeList(threat.unknown_ids),
      "- Evidence: " + evidenceSummary(threat.evidence),
      ""
    );
  }
  appendNamedEntries(lines, "Assumptions", model.assumptions, (entry) => [
    entry.statement,
    "Evidence: " + evidenceSummary(entry.evidence)
  ]);
  appendNamedEntries(lines, "Unknowns", model.unknowns, (entry) => [
    entry.description ?? "Not recorded.",
    "Security impact: " + (entry.security_impact ?? "Not recorded."),
    "Evidence needed: " + entry.evidence_needed
  ]);
  appendNamedEntries(lines, "Coverage gaps", model.coverage_gaps, (entry) => [
    entry.description ?? "Not recorded.",
    "Reason: " + entry.reason
  ]);
  return trimTrailingBlankLines(lines).join("\n") + "\n";
}

export function materializeCanonicalThreatModelMarkdown(artifactDir: string): {
  jsonPath: string;
  markdownPath: string;
  markdown: string;
} {
  const jsonPath = safeResolveInside(artifactDir, "threat-model.json", "threat model JSON");
  assertRegularFileInside(artifactDir, jsonPath, "threat model JSON");
  const parsed = JSON.parse(fs.readFileSync(jsonPath, "utf8")) as unknown;
  const markdown = renderThreatModelMarkdown(assertThreatModel(parsed));
  const markdownPath = prepareSafeFilePath(artifactDir, "THREAT_MODEL.md");
  if (fs.existsSync(markdownPath) && fs.lstatSync(markdownPath).isSymbolicLink()) {
    throw new Error("canonical threat model Markdown cannot replace a symlink");
  }
  writeFileDurable(markdownPath, markdown);
  return { jsonPath, markdownPath, markdown };
}

/**
 * Verifies that every evidence path names a current regular file inside the
 * task's exact repository workspace. Optional line and symbol metadata remains
 * descriptive: publication deliberately does not bind evidence to file bytes.
 */
export function verifyThreatModelEvidenceFiles(model: ThreatModel, workspaceRoot: string): string[] {
  const validated = assertThreatModel(model);
  const anchoredWorkspaceRoot = fs.realpathSync(workspaceRoot);
  if (!fs.statSync(anchoredWorkspaceRoot).isDirectory()) {
    throw new Error(`threat model evidence workspace must be a directory: ${anchoredWorkspaceRoot}`);
  }
  const paths = [
    ...validated.scope.repository_evidence,
    ...validated.capabilities.flatMap((entry) => entry.evidence),
    ...validated.assets.flatMap((entry) => entry.evidence),
    ...validated.actors.flatMap((entry) => entry.evidence),
    ...validated.trust_boundaries.flatMap((entry) => entry.evidence),
    ...validated.attack_surfaces.flatMap((entry) => entry.evidence),
    ...validated.value_flows.flatMap((entry) => entry.evidence),
    ...validated.lifecycle_transitions.flatMap((entry) => entry.evidence),
    ...validated.invariants.flatMap((entry) => entry.evidence),
    ...validated.threats.flatMap((entry) => entry.evidence),
    ...validated.assumptions.flatMap((entry) => entry.evidence)
  ].map((evidence) => evidence.path);
  const uniquePaths = [...new Set(paths)].sort();
  for (const relativePath of uniquePaths) {
    const candidate = path.resolve(anchoredWorkspaceRoot, ...relativePath.split("/"));
    assertRegularFileInside(anchoredWorkspaceRoot, candidate, `threat model evidence ${relativePath}`);
  }
  return uniquePaths;
}

function addDuplicateIdIssues(entries: ReadonlyArray<{ id: string }>, field: string, context: z.RefinementCtx): void {
  const seen = new Set<string>();
  entries.forEach((entry, index) => {
    if (seen.has(entry.id)) {
      context.addIssue({ code: "custom", path: [field, index, "id"], message: "Duplicate ID " + entry.id });
    }
    seen.add(entry.id);
  });
}

function validateReferences(
  entries: ReadonlyArray<Record<string, unknown>>,
  field: string,
  references: Record<string, Set<string>>,
  context: z.RefinementCtx
): void {
  entries.forEach((entry, entryIndex) => {
    for (const [referenceField, known] of Object.entries(references)) {
      const values = entry[referenceField];
      if (!Array.isArray(values)) continue;
      values.forEach((value, valueIndex) => {
        if (typeof value === "string" && !known.has(value)) {
          context.addIssue({
            code: "custom",
            path: [field, entryIndex, referenceField, valueIndex],
            message: "Unknown reference " + value
          });
        }
      });
    }
  });
}

function appendNamedEntries<T extends { id: string; name: string }>(
  lines: string[],
  heading: string,
  entries: readonly T[],
  details: (entry: T) => string[]
): void {
  lines.push("", "## " + heading, "");
  if (entries.length === 0) {
    lines.push("None recorded.");
    return;
  }
  for (const entry of entries) {
    lines.push("### " + entry.name + " (" + code(entry.id) + ")", "");
    for (const detail of details(entry)) lines.push("- " + detail);
    lines.push("");
  }
}

function appendEvidenceList(lines: string[], evidence: readonly ThreatModelEvidenceReference[]): void {
  if (evidence.length === 0) {
    lines.push("No repository evidence recorded.");
    return;
  }
  for (const item of evidence) lines.push("- " + formatEvidence(item));
}

function appendStringList(lines: string[], values: readonly string[], empty: string): void {
  if (values.length === 0) {
    lines.push(empty);
    return;
  }
  for (const value of values) lines.push("- " + value);
}

function evidenceSummary(evidence: readonly ThreatModelEvidenceReference[]): string {
  return evidence.length === 0 ? "none recorded" : evidence.map(formatEvidence).join("; ");
}

function formatEvidence(evidence: ThreatModelEvidenceReference): string {
  let location = evidence.path;
  if (evidence.line !== undefined) {
    location += ":" + String(evidence.line);
    if (evidence.end_line !== undefined) location += "-" + String(evidence.end_line);
  }
  const suffix = [evidence.symbol, evidence.note].filter((value): value is string => value !== undefined).join(" - ");
  return code(location) + (suffix === "" ? "" : " (" + suffix + ")");
}

function inlineList(values: readonly string[]): string {
  return values.length === 0 ? "none" : values.join("; ");
}

function inlineCodeList(values: readonly string[]): string {
  return values.length === 0 ? "none" : values.map(code).join(", ");
}

function code(value: string): string {
  const tick = String.fromCharCode(96);
  return tick + value + tick;
}

function escapeTable(value: string): string {
  return value.replaceAll("|", "\\|").replaceAll("\n", " ");
}

function trimTrailingBlankLines(lines: string[]): string[] {
  while (lines.at(-1) === "") lines.pop();
  return lines;
}
