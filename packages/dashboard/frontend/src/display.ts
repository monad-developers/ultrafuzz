export type NodeCardDisplayData = {
  label: string;
  kind: string;
  strategy?: {
    display_name: string;
    category: string;
  };
};

export type LoopBadgeDisplayData = {
  loopBadgeCount?: number;
  loopCount?: number;
  strategy?: {
    loops?: number;
  };
};

export type PropertySummaryDisplayData = {
  count: number;
  kind: "candidates" | "properties";
};

const setupKindLabels: Record<string, string> = {
  "project-discovery": "Project setup",
  "prepare-foundry-harness": "Harness setup",
  "discover-base-test": "Base test discovery",
  "property-specification": "Property specification",
  "property-specification-fanin": "Property specification",
  setup: "Setup step"
};

const reviewKindLabels: Record<string, string> = {
  "dedupe-findings": "Finding review",
  triage: "Finding review",
  "severity-classification": "Finding review",
  "aggregate-test-files": "Test aggregation"
};

export function nodeCardEyebrow(data: NodeCardDisplayData): string | null {
  const eyebrow = nodeCardEyebrowLabel(data);
  return displayValueKey(eyebrow) === displayValueKey(data.label) ? null : eyebrow;
}

function nodeCardEyebrowLabel(data: NodeCardDisplayData): string {
  if (data.strategy) {
    return "Strategy";
  }

  const normalized = data.kind.toLowerCase();
  if (setupKindLabels[normalized]) {
    return setupKindLabels[normalized];
  }
  if (isPropertyLensKind(normalized)) {
    return "Property lens";
  }
  if (reviewKindLabels[normalized]) {
    return reviewKindLabels[normalized];
  }
  if (normalized === "generate-report") {
    return "Report";
  }
  return titleCaseWords(normalized);
}

export function nodePanelSubtitle(data: NodeCardDisplayData): string | null {
  return nodeCardEyebrow(data);
}

export function strategyCategoryLabel(category: string): string {
  return titleCaseWords(category);
}

export function propertySummaryFactLabel(summary: PropertySummaryDisplayData | null | undefined): string | null {
  if (!summary) {
    return null;
  }
  const noun = propertySummaryNoun(summary.kind, summary.count);
  return `${formatNumber(summary.count)} ${noun}`;
}

export function loopBadgeLabel(data: LoopBadgeDisplayData): string | null {
  const loopCount = data.loopBadgeCount ?? data.loopCount ?? data.strategy?.loops ?? 1;
  return loopCount > 1 ? `${formatNumber(loopCount)}x loop` : null;
}

export function phaseGroupDetailLabel(memberCount: number, propertyCount?: number | null): string {
  const details = [taskCountLabel(memberCount)];
  if (propertyCount !== undefined && propertyCount !== null) {
    details.push(propertyCountLabel(propertyCount));
  }
  return details.join(" · ");
}

function taskCountLabel(value: number): string {
  return `${formatNumber(value)} ${value === 1 ? "task" : "tasks"}`;
}

function propertyCountLabel(value: number): string {
  return `${formatNumber(value)} ${value === 1 ? "property" : "properties"}`;
}

function propertySummaryNoun(kind: PropertySummaryDisplayData["kind"], count: number): string {
  if (kind === "candidates") {
    return count === 1 ? "candidate" : "candidates";
  }
  return count === 1 ? "property" : "properties";
}

function formatNumber(value: number): string {
  return new Intl.NumberFormat().format(value);
}

function titleCaseWords(value: string): string {
  return value
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function displayValueKey(value: string): string {
  return value.toLowerCase().replace(/[_-]+/g, " ").replace(/\s+/g, " ").trim();
}

function isPropertyLensKind(value: string): boolean {
  return (
    value.startsWith("property-specification lens") ||
    (value.startsWith("property-specification-") && value !== "property-specification-fanin")
  );
}
