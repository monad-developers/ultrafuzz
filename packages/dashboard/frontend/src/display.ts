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
  kind: "candidates" | "properties" | string;
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

const internalDashboardTokens = [
  "project-discovery",
  "prepare-foundry-harness",
  "discover-base-test",
  "agent-attempt",
  "consolidate",
  "0kn0t-lens",
  "certora-thinking-lens",
  "aviggiano-lens",
  "josselin-feist-lens",
  "property-specification-fanin",
  "encode-decode",
  "expand-coverage",
  "stateful-invariant-setup",
  "stateful-invariant-handlers",
  "stateful-invariant-coverage",
  "kind:"
];

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

export function visibleNodeCardText(data: NodeCardDisplayData): string {
  return uniqueDisplayValues([
    nodeCardEyebrow(data),
    data.label,
    data.strategy?.display_name,
    data.strategy ? strategyCategoryLabel(data.strategy.category) : undefined
  ]).join(" ");
}

export function hasInternalDashboardToken(value: string): boolean {
  const normalized = value.toLowerCase();
  return internalDashboardTokens.some((token) => normalized.includes(token));
}

function taskCountLabel(value: number): string {
  return `${formatNumber(value)} ${value === 1 ? "task" : "tasks"}`;
}

function propertyCountLabel(value: number): string {
  return `${formatNumber(value)} ${value === 1 ? "property" : "properties"}`;
}

function propertySummaryNoun(kind: string, count: number): string {
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

function uniqueDisplayValues(values: Array<string | null | undefined>): string[] {
  const seen = new Set<string>();
  return values.filter((value): value is string => {
    if (!value) {
      return false;
    }
    const key = value.toLowerCase();
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}
