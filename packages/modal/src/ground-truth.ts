import type { GroundTruthSubject } from "@ultrafuzz/evals";

export interface ModalGroundTruthBug {
  id: string;
  title: string;
  severity?: string;
}

export interface ModalPublicGroundTruthDocument {
  schema_version: "ultrafuzz.eval-ground-truth.v1";
  bugs: ModalGroundTruthBug[];
}

export interface ModalPrivateGroundTruthDocument extends ModalPublicGroundTruthDocument {
  subject: GroundTruthSubject;
}

const ISSUE_HEADING = /\[([A-Za-z][A-Za-z0-9_-]*-\d{1,4})\](?:\s*[-–—:]\s*|\s+)(.+)$/u;

export function convertAuditMarkdownGroundTruth(
  markdown: string,
  expectedFindings?: number
): ModalPublicGroundTruthDocument;
export function convertAuditMarkdownGroundTruth(
  markdown: string,
  expectedFindings: number | undefined,
  subject: GroundTruthSubject
): ModalPrivateGroundTruthDocument;
export function convertAuditMarkdownGroundTruth(
  markdown: string,
  expectedFindings?: number,
  subject?: GroundTruthSubject
): ModalPublicGroundTruthDocument | ModalPrivateGroundTruthDocument {
  const bugs = new Map<string, ModalGroundTruthBug>();
  for (const line of markdown.split(/\r?\n/u)) {
    const match = ISSUE_HEADING.exec(line);
    if (match === null) continue;
    const id = match[1]!;
    const title = cleanMarkdownTitle(match[2]!);
    if (title === "") continue;
    const existing = bugs.get(id);
    if (existing !== undefined && existing.title !== title) {
      throw new Error(`ground-truth issue ${id} has conflicting titles`);
    }
    bugs.set(id, { id, title, ...severityFromIssueId(id) });
  }
  if (expectedFindings !== undefined && bugs.size !== expectedFindings) {
    throw new Error(`expected ${expectedFindings} ground-truth findings, found ${bugs.size}`);
  }
  if (bugs.size === 0) throw new Error("audit Markdown did not contain any issue headings");
  const convertedBugs = [...bugs.values()];
  if (subject === undefined) {
    return { schema_version: "ultrafuzz.eval-ground-truth.v1", bugs: convertedBugs };
  }
  return { schema_version: "ultrafuzz.eval-ground-truth.v1", subject, bugs: convertedBugs };
}

function cleanMarkdownTitle(value: string): string {
  return value
    .replace(/\]\(#[^)]+\)\s*\|?\s*$/u, "")
    .replace(/\s*\|\s*$/u, "")
    .replace(/[*_`]/gu, "")
    .replace(/\s+/gu, " ")
    .trim();
}

function severityFromIssueId(id: string): { severity?: string } {
  const prefix = id.split("-", 1)[0]?.toUpperCase();
  const severity =
    prefix === "C"
      ? "critical"
      : prefix === "H"
        ? "high"
        : prefix === "M"
          ? "medium"
          : prefix === "L"
            ? "low"
            : prefix === "I"
              ? "informational"
              : undefined;
  return severity === undefined ? {} : { severity };
}
