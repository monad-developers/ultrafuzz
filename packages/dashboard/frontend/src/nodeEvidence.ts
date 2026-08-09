export type NodeEvidenceSectionId = "artifacts" | "logs" | "findings";

export type NodeEvidenceAvailability = {
  logs: boolean;
  findings: boolean;
  patch: boolean;
  report: boolean;
  metadata: boolean;
};

export type NodeEvidenceDetail = {
  stdout?: string;
  stderr?: string;
  findings: unknown[];
  artifacts: Array<{ path: string; kind: string; size_bytes: number; sha256: string }>;
  artifactReferences?: {
    outputs: unknown[];
    referencedPrevious: unknown[];
  };
  metadata?: unknown;
};

export type NodeEvidenceInput = {
  availability: NodeEvidenceAvailability;
  detail: NodeEvidenceDetail | null;
  detailLoading: boolean;
  findingCount: number;
};

export function visibleNodeEvidenceSections(input: NodeEvidenceInput): NodeEvidenceSectionId[] {
  const sections: NodeEvidenceSectionId[] = [];
  if (hasArtifactEvidence(input)) {
    sections.push("artifacts");
  }
  if (hasLogEvidence(input)) {
    sections.push("logs");
  }
  if (hasFindingEvidence(input)) {
    sections.push("findings");
  }
  return sections;
}

export function nodeEvidenceCountLabel(section: NodeEvidenceSectionId, input: NodeEvidenceInput): string {
  if (!input.detail) {
    return "Loading";
  }
  if (section === "artifacts") {
    const referenceCount =
      (input.detail.artifactReferences?.outputs.length ?? 0) +
      (input.detail.artifactReferences?.referencedPrevious.length ?? 0);
    return countLabel(input.detail.artifacts.length + referenceCount + (input.detail.metadata ? 1 : 0), "item");
  }
  if (section === "logs") {
    return countLabel([input.detail.stdout, input.detail.stderr].filter(Boolean).length, "source");
  }
  return countLabel(input.detail.findings.length, "finding");
}

function hasArtifactEvidence({ availability, detail, detailLoading }: NodeEvidenceInput): boolean {
  if (detail) {
    return (
      detail.artifacts.length > 0 ||
      Boolean(detail.metadata) ||
      Boolean(detail.artifactReferences?.outputs.length) ||
      Boolean(detail.artifactReferences?.referencedPrevious.length)
    );
  }
  if (!detailLoading) {
    return false;
  }
  return availability.patch || availability.report || availability.metadata;
}

function hasLogEvidence({ availability, detail, detailLoading }: NodeEvidenceInput): boolean {
  if (detail) {
    return Boolean(detail.stdout || detail.stderr);
  }
  if (!detailLoading) {
    return false;
  }
  return availability.logs;
}

function hasFindingEvidence({ availability, detail, detailLoading, findingCount }: NodeEvidenceInput): boolean {
  if (detail) {
    return detail.findings.length > 0;
  }
  if (!detailLoading) {
    return false;
  }
  return availability.findings || findingCount > 0;
}

function countLabel(count: number, singular: string): string {
  return `${count} ${singular}${count === 1 ? "" : "s"}`;
}
