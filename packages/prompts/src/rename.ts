import path from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { isSafePromptId, parsePromptFrontmatter, PromptError, serializePromptDocument } from "./frontmatter.js";
import { renamePromptArtifactReferences } from "./render.js";

export interface PromptFileSnapshot {
  path: string;
  contents: string;
}

export interface PromptTopologyNode {
  id: string;
  prompt?: string;
  dependsOn?: string[];
  depends_on?: string[];
  outputs?: Array<{ path: string; contract: string; primary?: boolean }>;
  [key: string]: unknown;
}

export interface PromptTopologyDocument {
  version?: number;
  nodes: PromptTopologyNode[];
  [key: string]: unknown;
}

export interface PromptConcreteNodeSnapshot {
  id: string;
  logicalId?: string;
  logical_id?: string;
  dependsOn?: string[];
  depends_on?: string[];
  artifactDir?: string;
  artifact_dir?: string;
  [key: string]: unknown;
}

export interface RenamePromptIdInput {
  oldId: string;
  newId: string;
  topology: PromptTopologyDocument | string;
  promptFiles: PromptFileSnapshot[];
  concreteNodes?: PromptConcreteNodeSnapshot[];
}

export interface RenamePromptIdResult {
  topology: PromptTopologyDocument;
  topologyYaml?: string;
  promptFiles: PromptFileSnapshot[];
  concreteNodes: PromptConcreteNodeSnapshot[];
  concreteIdMap: Record<string, string>;
  renamedPromptPaths: Record<string, string>;
}

export function renamePromptId(input: RenamePromptIdInput): RenamePromptIdResult {
  validateRename(input.oldId, input.newId);

  const parsedTopology =
    typeof input.topology === "string" ? (parseYaml(input.topology) as PromptTopologyDocument) : clone(input.topology);
  if (!parsedTopology || !Array.isArray(parsedTopology.nodes)) {
    throw new PromptError("invalid-rename", "topology must contain a nodes array");
  }
  if (parsedTopology.nodes.some((node) => node.id === input.newId && node.id !== input.oldId)) {
    throw new PromptError("invalid-rename", `topology already contains node id \`${input.newId}\``);
  }
  validatePromptFileRenameConflicts(input.promptFiles, input.oldId, input.newId);

  const renamedPromptPaths: Record<string, string> = {};
  const promptFiles = input.promptFiles.map((file) =>
    renamePromptFile(file, input.oldId, input.newId, renamedPromptPaths)
  );
  const topology = renameTopology(parsedTopology, input.oldId, input.newId, renamedPromptPaths);
  const { concreteNodes, concreteIdMap } = renameConcreteNodes(input.concreteNodes ?? [], input.oldId, input.newId);

  return {
    topology,
    ...(typeof input.topology === "string" ? { topologyYaml: stringifyYaml(topology, { sortMapEntries: false }) } : {}),
    promptFiles,
    concreteNodes,
    concreteIdMap,
    renamedPromptPaths
  };
}

export function renameConcreteNodeId(concreteId: string, oldId: string, newId: string): string {
  if (concreteId === oldId) {
    return newId;
  }
  if (concreteId.startsWith(`${oldId}-`)) {
    return `${newId}${concreteId.slice(oldId.length)}`;
  }
  return concreteId;
}

export function rewriteArtifactPathForPromptId(value: string, oldId: string, newId: string): string {
  return value
    .split(/[\\/]/g)
    .map((segment) => rewriteArtifactSegment(segment, oldId, newId))
    .join(value.includes("\\") ? "\\" : "/");
}

function renamePromptFile(
  file: PromptFileSnapshot,
  oldId: string,
  newId: string,
  renamedPromptPaths: Record<string, string>
): PromptFileSnapshot {
  const parsed = parsePromptFrontmatter(file.contents);
  const fallbackId = path.basename(file.path).replace(/\.(md|mdx)$/i, "");
  const ownsRenamedId = parsed.frontmatter.id === oldId || fallbackId === oldId;
  const nextFrontmatter = { ...parsed.frontmatter };
  if (ownsRenamedId) {
    nextFrontmatter.id = newId;
  }

  const nextBody = renamePromptArtifactReferences(parsed.body, oldId, newId);
  const contents = serializePromptDocument(nextFrontmatter, nextBody, parsed.unknownFrontmatter);
  const nextPath = ownsRenamedId ? renamePromptPath(file.path, oldId, newId) : file.path;
  if (nextPath !== file.path) {
    renamedPromptPaths[file.path] = nextPath;
  }
  return {
    path: nextPath,
    contents
  };
}

function renamePromptPath(promptPath: string, oldId: string, newId: string): string {
  const extension = path.extname(promptPath);
  const dirname = path.dirname(promptPath);
  const basename = path.basename(promptPath, extension);
  if (basename !== oldId) {
    return promptPath;
  }
  return path.posix.join(dirname.split(path.sep).join("/"), `${newId}${extension}`);
}

function renameTopology(
  topology: PromptTopologyDocument,
  oldId: string,
  newId: string,
  renamedPromptPaths: Record<string, string>
): PromptTopologyDocument {
  return {
    ...topology,
    nodes: topology.nodes.map((node) => {
      const renamed: PromptTopologyNode = {
        ...node,
        id: node.id === oldId ? newId : node.id
      };
      if (node.prompt) {
        renamed.prompt = renamedPromptPaths[node.prompt] ?? renamePromptPath(node.prompt, oldId, newId);
      }
      if (node.dependsOn) {
        renamed.dependsOn = node.dependsOn.map((dependency) => (dependency === oldId ? newId : dependency));
      }
      if (node.depends_on) {
        renamed.depends_on = node.depends_on.map((dependency) => (dependency === oldId ? newId : dependency));
      }
      if (node.outputs) {
        renamed.outputs = node.outputs.map((output) => ({
          ...output,
          path: rewriteArtifactPathForPromptId(output.path, oldId, newId)
        }));
      }
      return renamed;
    })
  };
}

function renameConcreteNodes(
  concreteNodes: PromptConcreteNodeSnapshot[],
  oldId: string,
  newId: string
): { concreteNodes: PromptConcreteNodeSnapshot[]; concreteIdMap: Record<string, string> } {
  const concreteIdMap: Record<string, string> = {};
  const renamed = concreteNodes.map((node) => {
    const nextId = renameConcreteNodeId(node.id, oldId, newId);
    if (nextId !== node.id) {
      concreteIdMap[node.id] = nextId;
    }
    const next: PromptConcreteNodeSnapshot = {
      ...node,
      id: nextId
    };
    if (node.logicalId === oldId) {
      next.logicalId = newId;
    }
    if (node.logical_id === oldId) {
      next.logical_id = newId;
    }
    if (node.dependsOn) {
      next.dependsOn = node.dependsOn.map((dependency) => renameConcreteNodeId(dependency, oldId, newId));
    }
    if (node.depends_on) {
      next.depends_on = node.depends_on.map((dependency) => renameConcreteNodeId(dependency, oldId, newId));
    }
    if (node.artifactDir) {
      next.artifactDir = rewriteArtifactPathForPromptId(node.artifactDir, oldId, newId);
    }
    if (node.artifact_dir) {
      next.artifact_dir = rewriteArtifactPathForPromptId(node.artifact_dir, oldId, newId);
    }
    return next;
  });

  return {
    concreteNodes: renamed,
    concreteIdMap
  };
}

function validateRename(oldId: string, newId: string): void {
  if (!isSafePromptId(oldId) || !isSafePromptId(newId)) {
    throw new PromptError("invalid-rename", "prompt rename IDs must be safe IDs");
  }
  if (oldId === newId) {
    throw new PromptError("invalid-rename", "prompt rename requires different old and new IDs");
  }
}

function validatePromptFileRenameConflicts(promptFiles: PromptFileSnapshot[], oldId: string, newId: string): void {
  for (const file of promptFiles) {
    const parsed = parsePromptFrontmatter(file.contents);
    const fallbackId = path.basename(file.path).replace(/\.(md|mdx)$/i, "");
    if (parsed.frontmatter.id === newId || (fallbackId === newId && parsed.frontmatter.id !== oldId)) {
      throw new PromptError("invalid-rename", `prompt file already contains id \`${newId}\`: ${file.path}`);
    }
  }
}

function rewriteArtifactSegment(segment: string, oldId: string, newId: string): string {
  if (segment === oldId) {
    return newId;
  }
  if (segment.startsWith(`${oldId}-`)) {
    return `${newId}${segment.slice(oldId.length)}`;
  }
  const extensionIndex = segment.lastIndexOf(".");
  if (extensionIndex > 0 && segment.slice(0, extensionIndex) === oldId) {
    return `${newId}${segment.slice(extensionIndex)}`;
  }
  return segment;
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}
