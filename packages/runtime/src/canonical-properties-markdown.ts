import { isDeepStrictEqual } from "node:util";

import { parseStrictJsonBytes, type InvariantLedgerArtifact, type PropertiesArtifact } from "@ultrafuzz/artifacts";

export type CanonicalPropertiesMarkdownParityIssueCode =
  | "PROPERTY_MARKDOWN_CANONICAL_DUPLICATE"
  | "PROPERTY_MARKDOWN_CANONICAL_UNKNOWN"
  | "PROPERTY_MARKDOWN_PARITY_MISSING"
  | "PROPERTY_MARKDOWN_PARITY_EXTRA"
  | "INVARIANT_LEDGER_MARKDOWN_MAPPING_MISSING"
  | "INVARIANT_LEDGER_MARKDOWN_MAPPING_EXTRA"
  | "INVARIANT_LEDGER_MARKDOWN_EVIDENCE_MISSING"
  | "INVARIANT_LEDGER_MARKDOWN_EVIDENCE_EXTRA"
  | "INVARIANT_LEDGER_MARKDOWN_INVENTORY_MISSING"
  | "INVARIANT_LEDGER_MARKDOWN_INVENTORY_EXTRA";

export interface CanonicalPropertiesMarkdownParityIssue {
  code: CanonicalPropertiesMarkdownParityIssueCode;
  message: string;
  path: string;
  source: "property-fanin" | "invariant-ledger";
}

interface MarkdownBlock {
  id: string;
  lineIndex: number;
  lines: readonly string[];
  closed: boolean;
}

interface ParsedMarkdownBlocks {
  blocks: readonly MarkdownBlock[];
  anomalyLines: readonly number[];
}

interface ParsedFields {
  values: ReadonlyMap<string, readonly unknown[]>;
  fieldNames: readonly string[];
  invalidLineIndexes: readonly number[];
}

const FIELD_LINE = /^([a-z][a-z0-9_]*): (.+)$/u;

/** One reversible grammar: JSON-string headings and strict JSON field values. */
export function canonicalPropertiesMarkdownParityIssues(
  catalog: PropertiesArtifact,
  markdown: string,
  markdownPath: string
): CanonicalPropertiesMarkdownParityIssue[] {
  const issues: CanonicalPropertiesMarkdownParityIssue[] = [];
  const parsedBlocks = markdownDelimitedBlocks(markdown, "Canonical property", "End canonical property");
  const blocksById = groupBlocksById(parsedBlocks.blocks);
  const catalogIds = new Set(catalog.properties.map((property) => property.id));

  for (const lineIndex of parsedBlocks.anomalyLines) {
    issues.push({
      code: "PROPERTY_MARKDOWN_PARITY_EXTRA",
      message: "Properties Markdown contains a malformed canonical-property delimiter",
      source: "property-fanin",
      path: `${markdownPath}#line-${lineIndex + 1}`
    });
  }
  for (const [id, blocks] of blocksById) {
    if (blocks.length > 1) {
      for (const duplicate of blocks.slice(1)) {
        issues.push({
          code: "PROPERTY_MARKDOWN_CANONICAL_DUPLICATE",
          message: `Properties Markdown contains duplicate canonical property ${JSON.stringify(id)}`,
          source: "property-fanin",
          path: `${markdownPath}#line-${duplicate.lineIndex + 1}`
        });
      }
    }
    if (!catalogIds.has(id)) {
      issues.push({
        code: "PROPERTY_MARKDOWN_CANONICAL_UNKNOWN",
        message: `Properties Markdown contains canonical property ${JSON.stringify(id)} absent from the typed property catalog`,
        source: "property-fanin",
        path: `${markdownPath}#line-${blocks[0]!.lineIndex + 1}`
      });
    }
  }

  const requiredFields = new Set(["description", "category", "priority", "sources"]);
  const allowedFields = new Set([...requiredFields, "ledger_ids", "reference_expectations"]);
  for (const [propertyIndex, property] of catalog.properties.entries()) {
    const blocks = blocksById.get(property.id) ?? [];
    const block = blocks.length === 1 ? blocks[0] : undefined;
    if (block === undefined || !block.closed) {
      issues.push(propertyMissingIssue(markdownPath, propertyIndex, property.id, "canonical block"));
      continue;
    }
    const fields = parseJsonFields(block);
    const expected = new Map<string, unknown>([
      ["description", property.description],
      ["category", property.category],
      ["priority", property.priority],
      ["sources", property.sources]
    ]);
    if (property.ledger_ids !== undefined) expected.set("ledger_ids", property.ledger_ids);
    if (property.reference_expectations !== undefined) {
      expected.set("reference_expectations", property.reference_expectations);
    }

    const mismatched = [...expected].find(([field, value]) => !exactSingleField(fields.values.get(field), value));
    const orderedFieldNames = [...expected.keys()];
    if (
      mismatched !== undefined ||
      fields.invalidLineIndexes.length > 0 ||
      !isDeepStrictEqual(fields.fieldNames, orderedFieldNames)
    ) {
      issues.push(
        propertyMissingIssue(markdownPath, propertyIndex, property.id, mismatched?.[0] ?? "canonical field order")
      );
    }
    for (const [field, values] of fields.values) {
      if (!allowedFields.has(field) || !expected.has(field) || values.length !== 1) {
        const code =
          field === "ledger_ids" ? "INVARIANT_LEDGER_MARKDOWN_MAPPING_EXTRA" : "PROPERTY_MARKDOWN_PARITY_EXTRA";
        issues.push({
          code,
          message: `Properties Markdown contains unexpected or duplicate field ${JSON.stringify(field)} for canonical property ${JSON.stringify(property.id)}`,
          source: field === "ledger_ids" ? "invariant-ledger" : "property-fanin",
          path: `${markdownPath}#$.properties[${propertyIndex}].${field}`
        });
      }
    }
    for (const field of requiredFields) {
      if (!fields.values.has(field)) continue;
      if (!expected.has(field)) {
        issues.push({
          code: "PROPERTY_MARKDOWN_PARITY_EXTRA",
          message: `Properties Markdown contains unexpected field ${JSON.stringify(field)}`,
          source: "property-fanin",
          path: `${markdownPath}#$.properties[${propertyIndex}].${field}`
        });
      }
    }
    if (property.ledger_ids !== undefined && !exactSingleField(fields.values.get("ledger_ids"), property.ledger_ids)) {
      issues.push({
        code: "INVARIANT_LEDGER_MARKDOWN_MAPPING_MISSING",
        message: `Properties Markdown must preserve the exact ledger_ids list for canonical property ${JSON.stringify(property.id)}`,
        source: "invariant-ledger",
        path: `${markdownPath}#$.properties[${propertyIndex}].ledger_ids`
      });
    }
  }
  return issues;
}

/** Exact one-to-one discovery ledger JSON/Markdown parity over authenticated bytes. */
export function invariantLedgerMarkdownParityIssues(
  ledger: InvariantLedgerArtifact,
  markdown: string,
  markdownPath: string
): CanonicalPropertiesMarkdownParityIssue[] {
  const issues: CanonicalPropertiesMarkdownParityIssue[] = [];
  const parsedEntries = markdownDelimitedBlocks(markdown, "Ledger entry", "End ledger entry");
  const parsedInventory = markdownDelimitedBlocks(markdown, "Inventory row", "End inventory row");
  const entriesById = groupBlocksById(parsedEntries.blocks);
  const inventoryById = groupBlocksById(parsedInventory.blocks);
  const expectedEntryIds = new Set(ledger.entries.map((entry) => entry.id));
  const expectedInventoryRows = ledger.inventory_rows ?? [];
  const expectedInventoryIds = new Set(expectedInventoryRows.map((row) => row.id));

  for (const lineIndex of parsedEntries.anomalyLines) {
    issues.push(invariantExtraIssue("entry", markdownPath, lineIndex));
  }
  for (const lineIndex of parsedInventory.anomalyLines) {
    issues.push(invariantExtraIssue("inventory", markdownPath, lineIndex));
  }
  for (const [id, blocks] of entriesById) {
    if (!expectedEntryIds.has(id) || blocks.length !== 1) {
      issues.push({
        code: "INVARIANT_LEDGER_MARKDOWN_EVIDENCE_EXTRA",
        message: `Discovery Markdown contains an unknown or duplicate ledger-entry block ${JSON.stringify(id)}`,
        source: "invariant-ledger",
        path: `${markdownPath}#line-${blocks[0]!.lineIndex + 1}`
      });
    }
  }
  for (const [id, blocks] of inventoryById) {
    if (!expectedInventoryIds.has(id) || blocks.length !== 1) {
      issues.push({
        code: "INVARIANT_LEDGER_MARKDOWN_INVENTORY_EXTRA",
        message: `Discovery Markdown contains an unknown or duplicate inventory-row block ${JSON.stringify(id)}`,
        source: "invariant-ledger",
        path: `${markdownPath}#line-${blocks[0]!.lineIndex + 1}`
      });
    }
  }

  for (const [entryIndex, entry] of ledger.entries.entries()) {
    const block = exactBlock(entriesById.get(entry.id));
    const expected = {
      source_path: entry.source_path,
      source_location: entry.source_location,
      kind: entry.kind,
      verbatim: entry.verbatim,
      inventory_ids: entry.inventory_ids
    };
    if (block === undefined || !exactTypedBlock(block, expected)) {
      issues.push({
        code: "INVARIANT_LEDGER_MARKDOWN_EVIDENCE_MISSING",
        message: `Discovery Markdown must preserve one exact typed block for ledger entry ${JSON.stringify(entry.id)}`,
        source: "invariant-ledger",
        path: `${markdownPath}#$.entries[${entryIndex}]`
      });
    }
  }
  for (const [rowIndex, row] of expectedInventoryRows.entries()) {
    const block = exactBlock(inventoryById.get(row.id));
    const expected = { description: row.description, ledger_ids: row.ledger_ids };
    if (block === undefined || !exactTypedBlock(block, expected)) {
      issues.push({
        code: "INVARIANT_LEDGER_MARKDOWN_INVENTORY_MISSING",
        message: `Discovery Markdown must preserve one exact typed block for inventory row ${JSON.stringify(row.id)}`,
        source: "invariant-ledger",
        path: `${markdownPath}#$.inventory_rows[${rowIndex}]`
      });
    }
  }
  return issues;
}

function propertyMissingIssue(
  markdownPath: string,
  propertyIndex: number,
  propertyId: string,
  field: string
): CanonicalPropertiesMarkdownParityIssue {
  return {
    code: "PROPERTY_MARKDOWN_PARITY_MISSING",
    message: `Properties Markdown must preserve canonical property ${JSON.stringify(propertyId)} exactly (missing or mismatched ${JSON.stringify(field)})`,
    source: "property-fanin",
    path: `${markdownPath}#$.properties[${propertyIndex}]`
  };
}

function invariantExtraIssue(
  kind: "entry" | "inventory",
  markdownPath: string,
  lineIndex: number
): CanonicalPropertiesMarkdownParityIssue {
  return {
    code: kind === "entry" ? "INVARIANT_LEDGER_MARKDOWN_EVIDENCE_EXTRA" : "INVARIANT_LEDGER_MARKDOWN_INVENTORY_EXTRA",
    message: `Discovery Markdown contains a malformed ${kind} block delimiter`,
    source: "invariant-ledger",
    path: `${markdownPath}#line-${lineIndex + 1}`
  };
}

function exactTypedBlock(block: MarkdownBlock, expected: Readonly<Record<string, unknown>>): boolean {
  if (!block.closed) return false;
  const fields = parseJsonFields(block);
  const expectedFieldNames = Object.keys(expected);
  if (
    fields.invalidLineIndexes.length > 0 ||
    fields.values.size !== expectedFieldNames.length ||
    !isDeepStrictEqual(fields.fieldNames, expectedFieldNames)
  )
    return false;
  for (const [field, value] of Object.entries(expected)) {
    if (!exactSingleField(fields.values.get(field), value)) return false;
  }
  return true;
}

function exactSingleField(values: readonly unknown[] | undefined, expected: unknown): boolean {
  return values?.length === 1 && isDeepStrictEqual(values[0], expected);
}

function exactBlock(blocks: readonly MarkdownBlock[] | undefined): MarkdownBlock | undefined {
  return blocks?.length === 1 ? blocks[0] : undefined;
}

function markdownDelimitedBlocks(markdown: string, startLabel: string, endLabel: string): ParsedMarkdownBlocks {
  const lines = markdown.replace(/\r\n?/gu, "\n").split("\n");
  const startPrefix = `### ${startLabel}: `;
  const endPrefix = `### ${endLabel}: `;
  const blocks: MarkdownBlock[] = [];
  const anomalyLines: number[] = [];
  let open: { id: string; lineIndex: number; lines: string[] } | undefined;

  const closeUnterminated = (): void => {
    if (open === undefined) return;
    blocks.push({ id: open.id, lineIndex: open.lineIndex, lines: open.lines, closed: false });
    anomalyLines.push(open.lineIndex);
    open = undefined;
  };
  for (const [lineIndex, line] of lines.entries()) {
    if (line.startsWith(startPrefix)) {
      closeUnterminated();
      const id = decodeJsonString(line.slice(startPrefix.length));
      if (id === undefined) {
        anomalyLines.push(lineIndex);
      } else {
        open = { id, lineIndex, lines: [] };
      }
      continue;
    }
    if (line.startsWith(endPrefix)) {
      const id = decodeJsonString(line.slice(endPrefix.length));
      if (open === undefined || id === undefined || id !== open.id) {
        anomalyLines.push(lineIndex);
        continue;
      }
      blocks.push({ id: open.id, lineIndex: open.lineIndex, lines: open.lines, closed: true });
      open = undefined;
      continue;
    }
    if (open !== undefined) open.lines.push(line);
  }
  closeUnterminated();
  return { blocks, anomalyLines };
}

function groupBlocksById(blocks: readonly MarkdownBlock[]): Map<string, MarkdownBlock[]> {
  const grouped = new Map<string, MarkdownBlock[]>();
  for (const block of blocks) {
    const current = grouped.get(block.id);
    if (current === undefined) grouped.set(block.id, [block]);
    else current.push(block);
  }
  return grouped;
}

function parseJsonFields(block: MarkdownBlock): ParsedFields {
  const values = new Map<string, unknown[]>();
  const fieldNames: string[] = [];
  const invalidLineIndexes: number[] = [];
  for (const [offset, line] of block.lines.entries()) {
    // Blank and whitespace-only lines carry no field content, so they are
    // skipped rather than rejected. A blank line after a Markdown heading is
    // conventional -- several renderers need one -- and the companion grammar
    // documented in the discovery prompt forbids bullets, tables, bare tokens,
    // indented multiline values, aliases, and extra, duplicate, or unknown
    // fields without ever forbidding blank lines. Treating them as invalid
    // rejected agent output that was otherwise exactly correct, and did so for
    // every block at once, since that spacing is uniform across a document.
    if (line.trim() === "") continue;
    const match = FIELD_LINE.exec(line);
    if (match?.[1] === undefined || match[2] === undefined) {
      invalidLineIndexes.push(block.lineIndex + offset + 1);
      continue;
    }
    fieldNames.push(match[1]);
    let value: unknown;
    try {
      value = parseStrictJsonBytes(new TextEncoder().encode(match[2]));
    } catch {
      invalidLineIndexes.push(block.lineIndex + offset + 1);
      continue;
    }
    const current = values.get(match[1]);
    if (current === undefined) values.set(match[1], [value]);
    else current.push(value);
  }
  return { values, fieldNames, invalidLineIndexes };
}

function decodeJsonString(rendered: string): string | undefined {
  try {
    const parsed = parseStrictJsonBytes(new TextEncoder().encode(rendered));
    return typeof parsed === "string" ? parsed : undefined;
  } catch {
    return undefined;
  }
}
