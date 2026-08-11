import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

import { artifactContractDefinition, artifactContractSchemaBinding } from "@ultrafuzz/artifacts";
import { loadReferenceCatalog, type ReferenceCatalog, type ReferenceEntry } from "@ultrafuzz/references";

import { topologyError } from "./errors.js";
import { concreteIdsFor, resolvedPromptPath, validateTopology } from "./validate.js";
import { GRAPH_VERSION, TOPOLOGY_VERSION } from "./types.js";
import type {
  ExpandTopologyOptions,
  ExpandedGraph,
  ExpandedNode,
  ModelFanoutProvenance,
  ModelProfileSelection,
  NormalizedProjectTopology,
  NormalizedTopologyNode,
  ReferenceRevision
} from "./types.js";
import { titleFromId } from "./path-utils.js";
import { assertExpandedGraphSchema } from "./expanded-graph-schema.js";

export function expandTopology(topologyInput: unknown, options: ExpandTopologyOptions = {}): ExpandedGraph {
  const { topology, effectiveLoopCounts } = validateTopology(topologyInput, options);
  const referenceCatalog = referenceCatalogFor(topology, options);
  const expansion = new Map<string, string[]>();
  const nodeById = new Map(topology.nodes.map((node) => [node.id, node]));
  for (const node of topology.nodes) {
    expansion.set(node.id, concreteIdsFor(node.id, effectiveLoopCounts[node.id] ?? node.loops));
  }

  const nodes: ExpandedNode[] = [];
  for (const node of topology.nodes) {
    const concreteIds = expansion.get(node.id)!;
    concreteIds.forEach((concreteId, loopIndex) => {
      nodes.push(expandNode(node, concreteId, loopIndex, topology, expansion, nodeById, options, referenceCatalog));
    });
  }

  return assertExpandedGraphSchema({
    graphVersion: GRAPH_VERSION,
    ...(options.runId ? { runId: options.runId } : {}),
    topologyVersion: TOPOLOGY_VERSION,
    groups: topology.groups,
    nodes,
    fingerprintInputs: buildFingerprintInputs(topology, options)
  });
}

function expandNode(
  node: NormalizedTopologyNode,
  concreteId: string,
  loopIndex: number,
  topology: NormalizedProjectTopology,
  expansion: Map<string, string[]>,
  nodeById: Map<string, NormalizedTopologyNode>,
  options: ExpandTopologyOptions,
  referenceCatalog: ReferenceCatalog | undefined
): ExpandedNode {
  const loopCount = expansion.get(node.id)!.length;
  const dependsOn =
    node.kind === "agentic" && node.loop_mode === "series" && loopCount > 1 && loopIndex > 0
      ? [expansion.get(node.id)![loopIndex - 1]!]
      : lowerDependencies(node, expansion, nodeById);
  const promptPath = node.kind === "agentic" ? resolvedPromptPath(node) : undefined;
  const referenceRevision =
    node.kind === "reference" && node.reference !== undefined
      ? referenceRevisionFor(node, referenceCatalog)
      : undefined;
  return {
    id: concreteId,
    logicalId: node.id,
    label: node.kind === "meta" ? (node.role === "start" ? "START" : "FINISH") : labelFor(node, loopIndex, loopCount),
    kind: node.kind,
    ...(node.role ? { role: node.role } : {}),
    ...(promptPath ? { promptPath } : {}),
    ...(node.reference ? { reference: node.reference } : {}),
    ...(referenceRevision ? { referenceRevision } : {}),
    ...(node.group ? { group: node.group } : {}),
    dependsOn,
    ...(node.required_commands.length === 0 ? {} : { requiredCommands: [...node.required_commands] }),
    artifactDir: deterministicArtifactDir(concreteId),
    ...timeoutSecondsFor(node, topology),
    retryPolicy: { maxAttempts: maxAttemptsFor(node, topology) },
    loop: {
      index: loopIndex,
      count: loopCount,
      mode: node.loop_mode,
      attemptIndex: loopIndex
    },
    outputs: node.outputs.map((output) => {
      const binding = artifactContractSchemaBinding(output.contract);
      return {
        ...output,
        contractDigest: artifactContractDefinition(output.contract).digest,
        ...(binding === undefined
          ? {}
          : {
              schemaFile: binding.schema_file,
              schemaId: binding.schema_id,
              schemaSha256: binding.schema_sha256,
              schemaBundleSha256: binding.schema_bundle_sha256,
              validatorBuild: binding.validator_build
            })
      };
    }),
    modelFanout: modelFanoutFor(node, topology, loopIndex, options)
  };
}

function referenceCatalogFor(
  topology: NormalizedProjectTopology,
  options: ExpandTopologyOptions
): ReferenceCatalog | undefined {
  if (!topology.nodes.some((node) => node.kind === "reference")) {
    return undefined;
  }
  if (options.referenceCatalog) {
    return options.referenceCatalog as ReferenceCatalog;
  }
  if (!options.projectRoot) {
    throw topologyError("REFERENCE_CATALOG", "Reference topology nodes require a project references catalog");
  }
  try {
    return loadReferenceCatalog(options.projectRoot);
  } catch (error) {
    throw topologyError("REFERENCE_CATALOG", error instanceof Error ? error.message : String(error), {
      reason: error instanceof Error ? error.name : "ReferenceError"
    });
  }
}

function referenceRevisionFor(
  node: NormalizedTopologyNode,
  catalog: ReferenceCatalog | undefined
): ReferenceRevision | undefined {
  if (!node.reference) {
    return undefined;
  }
  const entry = catalog?.references[node.reference];
  if (!entry) {
    throw topologyError(
      "INVALID_REFERENCE_NODE",
      `Reference node \`${node.id}\` points to unknown reference \`${node.reference}\``,
      { nodeId: node.id, reference: node.reference }
    );
  }
  return referenceRevision(entry);
}

function referenceRevision(entry: ReferenceEntry): ReferenceRevision {
  return {
    provider: entry.provider,
    repo: entry.repo,
    commit: entry.commit,
    paths: [...entry.paths]
  };
}

export function deterministicArtifactDir(concreteId: string): string {
  return `artifacts/${concreteId}`;
}

function lowerDependencies(
  node: NormalizedTopologyNode,
  expansion: Map<string, string[]>,
  nodeById: Map<string, NormalizedTopologyNode>
): string[] {
  return node.depends_on.flatMap((dependency) => {
    const concreteIds = expansion.get(dependency) ?? [];
    const dependencyNode = nodeById.get(dependency);
    if (dependencyNode?.loop_mode === "series" && concreteIds.length > 1) {
      return [concreteIds[concreteIds.length - 1]!];
    }
    return concreteIds;
  });
}

function labelFor(node: NormalizedTopologyNode, loopIndex: number, loopCount: number): string {
  const base = titleFromId(node.id);
  return loopCount > 1 ? `${base} attempt ${loopIndex + 1}` : base;
}

function timeoutSecondsFor(
  node: NormalizedTopologyNode,
  topology: NormalizedProjectTopology
): Pick<ExpandedNode, "timeoutSeconds"> {
  const timeoutSeconds =
    node.timeout_seconds ?? (node.group ? topology.groups[node.group]?.defaults?.timeout_seconds : undefined);
  return timeoutSeconds === undefined ? {} : { timeoutSeconds };
}

function maxAttemptsFor(node: NormalizedTopologyNode, topology: NormalizedProjectTopology): number {
  if (node.kind !== "agentic") {
    return 1;
  }
  return node.max_attempts ?? (node.group ? topology.groups[node.group]?.defaults?.max_attempts : undefined) ?? 1;
}

function modelFanoutFor(
  node: NormalizedTopologyNode,
  topology: NormalizedProjectTopology,
  loopIndex: number,
  options: ExpandTopologyOptions
): ModelFanoutProvenance[] {
  if (node.kind !== "agentic") {
    return [];
  }
  const profiles = options.modelProfilesByNode?.[node.id] ?? selectedModelProfiles(node, topology, options);
  return profiles.map((profile, modelIndex) => ({
    modelProfileId: profile.profileId,
    agentRef: profile.agentRef,
    ...(profile.modelName ? { modelName: profile.modelName } : {}),
    ...(profile.reasoningEffort ? { reasoningEffort: profile.reasoningEffort } : {}),
    modelIndex,
    loopIndex,
    attemptIndex: loopIndex * Math.max(profiles.length, 1) + modelIndex
  }));
}

function selectedModelProfiles(
  node: NormalizedTopologyNode,
  topology: NormalizedProjectTopology,
  options: ExpandTopologyOptions
): ModelProfileSelection[] {
  const explicitProfileIds = node.model_profiles.length > 0 ? node.model_profiles : undefined;
  const groupProfileIds =
    explicitProfileIds === undefined && node.group !== undefined
      ? topology.groups[node.group]?.defaults?.model_profiles
      : undefined;
  const selectedProfileIds =
    explicitProfileIds ?? (groupProfileIds && groupProfileIds.length > 0 ? groupProfileIds : undefined);
  if (selectedProfileIds !== undefined && options.modelProfiles && !Array.isArray(options.modelProfiles)) {
    return selectedProfileIds.map((profileId) =>
      modelProfileSelection(
        profileId,
        options.modelProfiles as Record<string, Omit<ModelProfileSelection, "profileId">>
      )
    );
  }
  if (selectedProfileIds !== undefined && Array.isArray(options.modelProfiles)) {
    const profiles = new Map(options.modelProfiles.map((profile) => [profile.profileId, profile]));
    return selectedProfileIds.map((profileId) => {
      const selected = profiles.get(profileId);
      if (!selected) {
        throw topologyError("UNKNOWN_MODEL_PROFILE", `Topology references unknown model profile \`${profileId}\``, {
          nodeId: node.id,
          modelProfile: profileId
        });
      }
      return selected;
    });
  }
  if (Array.isArray(options.modelProfiles)) {
    if (options.defaultModelProfileId === undefined) {
      return [];
    }
    const selected = options.modelProfiles.find((profile) => profile.profileId === options.defaultModelProfileId);
    return selected ? [selected] : [];
  }
  if (options.modelProfiles && !Array.isArray(options.modelProfiles)) {
    if (options.defaultModelProfileId !== undefined) {
      return [modelProfileSelection(options.defaultModelProfileId, options.modelProfiles)];
    }
    return [];
  }
  return [];
}

function modelProfileSelection(
  profileId: string,
  profiles: Record<string, Omit<ModelProfileSelection, "profileId">>
): ModelProfileSelection {
  const selected = profiles[profileId];
  if (!selected) {
    throw topologyError("UNKNOWN_MODEL_PROFILE", `Topology references unknown model profile \`${profileId}\``, {
      modelProfile: profileId
    });
  }
  return { profileId, ...selected };
}

function buildFingerprintInputs(
  topology: NormalizedProjectTopology,
  options: ExpandTopologyOptions
): ExpandedGraph["fingerprintInputs"] {
  const promptDigests: Record<string, string> = {};
  for (const node of topology.nodes) {
    if (node.kind !== "agentic") {
      continue;
    }
    const promptPath = resolvedPromptPath(node);
    const text = promptTextFor(node.id, promptPath, options);
    if (text !== undefined) {
      promptDigests[promptPath] = sha256(text);
    }
  }
  return {
    ...(options.configFingerprint !== undefined ? { config: options.configFingerprint } : {}),
    ...(Object.keys(promptDigests).length > 0 ? { promptDigests } : {})
  };
}

function promptTextFor(nodeId: string, promptPath: string, options: ExpandTopologyOptions): string | undefined {
  if (options.promptTexts?.[promptPath] !== undefined) {
    return options.promptTexts[promptPath];
  }
  if (options.promptTexts?.[nodeId] !== undefined) {
    return options.promptTexts[nodeId];
  }
  if (!options.projectRoot) {
    return undefined;
  }
  const fullPath = path.join(options.projectRoot, ".ultrafuzz", "prompts", promptPath);
  if (existsSync(fullPath) && statSync(fullPath).isFile()) {
    return readFileSync(fullPath, "utf8");
  }
  return undefined;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
