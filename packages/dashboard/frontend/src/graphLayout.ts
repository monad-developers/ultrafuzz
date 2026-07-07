export type WorkflowPhaseId =
  | "setup"
  | "references"
  | "properties"
  | "strategies"
  | "invariants"
  | "differential-tests"
  | "deduplication"
  | "triaging"
  | "report"
  | "ungrouped";

export type GraphPosition = {
  x: number;
  y: number;
};

export type PhaseLayoutMember = {
  dependencies: string[];
  id: string;
  position: GraphPosition;
  sortValue: number;
};

export type PhaseDimensions = {
  height: number;
  positions: Map<string, GraphPosition>;
  width: number;
};

export const dashboardNodeWidth = 268;
export const dashboardNodeHeight = 132;
export const metaNodeWidth = 138;
export const metaNodeHeight = 56;
export const metaNodeGap = 76;
export const phaseNodeGap = 52;
export const phaseGroupGap = 108;
export const phaseBranchGap = 72;
export const phasePadding = {
  left: 36,
  right: 36,
  top: 62,
  bottom: 34
};

const parallelGridPhases: ReadonlySet<WorkflowPhaseId> = new Set(["references", "properties", "strategies"]);
const parallelGridMinUsefulRows = 3;
const parallelGridMaxUsefulRows = 5;
const parallelGridMaxExactColumns = 3;

type PhaseLayer = {
  columnCount: number;
  members: PhaseLayoutMember[];
  rows: number;
  startColumn: number;
};

export function phaseDimensions(phase: WorkflowPhaseId, members: PhaseLayoutMember[]): PhaseDimensions {
  const orderedMembers = orderedPhaseLayoutMembers(members);
  const memberById = new Map(orderedMembers.map((node) => [node.id, node]));
  const dependencyColumnByNodeId = new Map<string, number>();
  const columnForNode = (node: PhaseLayoutMember, visiting = new Set<string>()): number => {
    const existing = dependencyColumnByNodeId.get(node.id);
    if (existing !== undefined) {
      return existing;
    }
    if (visiting.has(node.id)) {
      return 0;
    }
    visiting.add(node.id);
    const dependencyColumns = node.dependencies
      .map((dependency) => memberById.get(dependency))
      .filter((dependency): dependency is PhaseLayoutMember => Boolean(dependency))
      .map((dependency) => columnForNode(dependency, visiting));
    visiting.delete(node.id);
    const column = dependencyColumns.length ? Math.max(...dependencyColumns) + 1 : 0;
    dependencyColumnByNodeId.set(node.id, column);
    return column;
  };

  orderedMembers.forEach((node) => columnForNode(node));

  const membersByDependencyColumn = new Map<number, PhaseLayoutMember[]>();
  orderedMembers.forEach((node) => {
    const dependencyColumn = dependencyColumnByNodeId.get(node.id) ?? 0;
    const columnNodes = membersByDependencyColumn.get(dependencyColumn) ?? [];
    columnNodes.push(node);
    membersByDependencyColumn.set(dependencyColumn, columnNodes);
  });

  const layers = phaseLayers(phase, membersByDependencyColumn);
  const columns = layers.reduce((total, layer) => total + layer.columnCount, 0);
  const rows = Math.max(1, ...layers.map((layer) => layer.rows));
  const positions = new Map<string, GraphPosition>();

  layers.forEach((layer) => {
    const rowOffset = Math.max(0, (rows - layer.rows) / 2);
    layer.members.forEach((node, index) => {
      const column = layer.startColumn + (index % layer.columnCount);
      const row = Math.floor(index / layer.columnCount);
      positions.set(node.id, {
        x: phasePadding.left + column * (dashboardNodeWidth + phaseNodeGap),
        y: phasePadding.top + (rowOffset + row) * (dashboardNodeHeight + phaseNodeGap)
      });
    });
  });

  return {
    height: phasePadding.top + rows * dashboardNodeHeight + Math.max(0, rows - 1) * phaseNodeGap + phasePadding.bottom,
    positions,
    width:
      phasePadding.left + columns * dashboardNodeWidth + Math.max(0, columns - 1) * phaseNodeGap + phasePadding.right
  };
}

export function phaseGroupPositions(
  dimensionsByPhase: Map<WorkflowPhaseId, PhaseDimensions>
): Map<WorkflowPhaseId, GraphPosition> {
  const positions = new Map<WorkflowPhaseId, GraphPosition>();
  const setupDimensions = dimensionsByPhase.get("setup");
  const propertiesDimensions = dimensionsByPhase.get("properties");
  const strategiesDimensions = dimensionsByPhase.get("strategies");
  const invariantsDimensions = dimensionsByPhase.get("invariants");
  const differentialTestsDimensions = dimensionsByPhase.get("differential-tests");
  const deduplicationDimensions = dimensionsByPhase.get("deduplication");
  const triagingDimensions = dimensionsByPhase.get("triaging");
  const reportDimensions = dimensionsByPhase.get("report");
  const branchDimensions = [strategiesDimensions, invariantsDimensions, differentialTestsDimensions].filter(
    (dimensions): dimensions is PhaseDimensions => Boolean(dimensions)
  );
  const branchHeight =
    branchDimensions.reduce((total, dimensions) => total + dimensions.height, 0) +
    Math.max(0, branchDimensions.length - 1) * phaseBranchGap;
  const pipelineHeight = Math.max(
    setupDimensions?.height ?? 0,
    propertiesDimensions?.height ?? 0,
    branchHeight,
    deduplicationDimensions?.height ?? 0,
    triagingDimensions?.height ?? 0,
    reportDimensions?.height ?? 0
  );
  const pipelineCenterY = pipelineHeight / 2;
  let x = 0;

  (["setup", "properties"] as WorkflowPhaseId[]).forEach((phase) => {
    const dimensions = dimensionsByPhase.get(phase);
    if (!dimensions) {
      return;
    }
    positions.set(phase, { x, y: centeredPhaseY(dimensions, pipelineCenterY) });
    x += dimensions.width + phaseGroupGap;
  });

  const branchX = x;
  let branchY = centeredBlockY(branchHeight, pipelineCenterY);
  (["strategies", "invariants", "differential-tests"] as WorkflowPhaseId[]).forEach((phase) => {
    const dimensions = dimensionsByPhase.get(phase);
    if (!dimensions) {
      return;
    }
    positions.set(phase, { x: branchX, y: branchY });
    branchY += dimensions.height + phaseBranchGap;
  });
  x += Math.max(0, ...branchDimensions.map((dimensions) => dimensions.width)) + phaseGroupGap;

  (["deduplication", "triaging", "report"] as WorkflowPhaseId[]).forEach((phase) => {
    const dimensions = dimensionsByPhase.get(phase);
    if (!dimensions) {
      return;
    }
    positions.set(phase, { x, y: centeredPhaseY(dimensions, pipelineCenterY) });
    x += dimensions.width + phaseGroupGap;
  });

  const ungroupedDimensions = dimensionsByPhase.get("ungrouped");
  if (ungroupedDimensions) {
    positions.set("ungrouped", {
      x: 0,
      y: pipelineHeight + phaseGroupGap
    });
  }

  return positions;
}

function phaseLayers(
  phase: WorkflowPhaseId,
  membersByDependencyColumn: Map<number, PhaseLayoutMember[]>
): PhaseLayer[] {
  let startColumn = 0;
  const layers = [...membersByDependencyColumn.entries()].sort(([left], [right]) => left - right);
  return layers.map(([, members]) => {
    const columnCount = gridColumnCount(phase, members.length);
    const layer = {
      columnCount,
      members,
      rows: Math.ceil(members.length / columnCount),
      startColumn
    };
    startColumn += columnCount;
    return layer;
  });
}

function gridColumnCount(phase: WorkflowPhaseId, memberCount: number): number {
  if (!parallelGridPhases.has(phase) || memberCount <= parallelGridMaxUsefulRows) {
    return 1;
  }
  const minimumColumnsForMaxRows = Math.ceil(memberCount / parallelGridMaxUsefulRows);
  const maximumColumnsForMinRows = Math.ceil(memberCount / parallelGridMinUsefulRows);
  return (
    exactParallelGridColumnCount(memberCount, minimumColumnsForMaxRows, maximumColumnsForMinRows) ??
    minimumColumnsForMaxRows
  );
}

function exactParallelGridColumnCount(
  memberCount: number,
  minimumColumnsForMaxRows: number,
  maximumColumnsForMinRows: number
): number | null {
  const maximumExactColumns = Math.min(maximumColumnsForMinRows, parallelGridMaxExactColumns);
  for (let columns = minimumColumnsForMaxRows; columns <= maximumExactColumns; columns += 1) {
    const rows = Math.ceil(memberCount / columns);
    if (rows >= parallelGridMinUsefulRows && rows <= parallelGridMaxUsefulRows && memberCount % columns === 0) {
      return columns;
    }
  }
  return null;
}

function orderedPhaseLayoutMembers(members: PhaseLayoutMember[]): PhaseLayoutMember[] {
  return [...members].sort(
    (left, right) => left.sortValue - right.sortValue || compareGraphPosition(left.position, right.position)
  );
}

function centeredPhaseY(dimensions: PhaseDimensions, centerY: number): number {
  return centeredBlockY(dimensions.height, centerY);
}

function centeredBlockY(height: number, centerY: number): number {
  return Math.max(0, centerY - height / 2);
}

function compareGraphPosition(left: GraphPosition | undefined, right: GraphPosition | undefined): number {
  if (!left || !right) {
    return left ? -1 : right ? 1 : 0;
  }
  if (left.y !== right.y) {
    return left.y - right.y;
  }
  return left.x - right.x;
}
