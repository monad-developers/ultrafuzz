import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import YAML from "yaml";

const root = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const promptRoot = path.join(root, ".ultrafuzz", "prompts");
const metadataPath = path.join(root, "docs", "reference", "prompt-catalog-data.yml");
const outputPath = path.join(root, "docs", "reference", "prompt-catalog.md");

const topologySources = [
  { id: "default", path: path.join(root, ".ultrafuzz", "topology.yml") },
  { id: "exhaustive", path: path.join(root, "packages", "config", "topologies", "exhaustive.yml") },
  {
    id: "invariant-only",
    path: path.join(root, "packages", "config", "topologies", "invariant-only.yml")
  },
  { id: "smoke", path: path.join(root, "packages", "config", "topologies", "smoke.yml") }
];

const metadata = readMetadata();
const promptPaths = discoverPromptPaths(promptRoot);
const metadataPaths = metadata.map((entry) => entry.path).sort();
assertSamePaths(promptPaths, metadataPaths);

const metadataByPath = new Map(metadata.map((entry) => [entry.path, entry]));
const topologyBindings = topologySources.map((source) => ({
  ...source,
  prompts: readTopologyPromptBindings(source.path)
}));
const promptPathSet = new Set(promptPaths);
for (const topology of topologyBindings) {
  for (const promptPath of topology.prompts) {
    if (!promptPathSet.has(promptPath)) {
      throw new Error(`${relative(topology.path)} binds missing prompt ${promptPath}`);
    }
    if (isRuntimeTemplate(promptPath)) {
      throw new Error(`${relative(topology.path)} must not bind runtime composition template ${promptPath}`);
    }
  }
}

const usageByPath = new Map();
for (const topology of topologyBindings) {
  for (const promptPath of new Set(topology.prompts)) {
    const usages = usageByPath.get(promptPath) ?? [];
    usages.push(topology.id);
    usageByPath.set(promptPath, usages);
  }
}

const defaultBindings = topologyBindings[0].prompts;
const defaultPromptPaths = unique(defaultBindings);
const defaultPromptPathSet = new Set(defaultPromptPaths);
const editablePromptPaths = promptPaths.filter((promptPath) => !isRuntimeTemplate(promptPath));
const additionalProfilePromptPaths = editablePromptPaths.filter(
  (promptPath) => !defaultPromptPathSet.has(promptPath) && usageByPath.has(promptPath)
);
const unwiredPromptPaths = editablePromptPaths.filter((promptPath) => !usageByPath.has(promptPath));
const runtimeTemplatePaths = promptPaths.filter(isRuntimeTemplate);

const output = renderCatalog({
  additionalProfilePromptPaths,
  defaultBindings,
  defaultPromptPaths,
  editablePromptPaths,
  metadataByPath,
  runtimeTemplatePaths,
  topologyBindings,
  unwiredPromptPaths
});

if (process.argv.includes("--check")) {
  if (!existsSync(outputPath) || readFileSync(outputPath, "utf8") !== output) {
    process.stderr.write("docs/reference/prompt-catalog.md is stale; run pnpm docs:prompt-catalog\n");
    process.exit(1);
  }
} else {
  writeFileSync(outputPath, output, "utf8");
  process.stdout.write(`${relative(outputPath)}\n`);
}

function readMetadata() {
  const document = YAML.parse(readFileSync(metadataPath, "utf8"));
  if (!isRecord(document) || document.schema_version !== 1 || !Array.isArray(document.prompts)) {
    throw new Error(`${relative(metadataPath)} must contain schema_version: 1 and a prompts array`);
  }

  const seen = new Set();
  return document.prompts.map((value, index) => {
    if (!isRecord(value)) {
      throw new Error(`${relative(metadataPath)} prompts[${index}] must be a mapping`);
    }
    const keys = Object.keys(value).sort();
    if (keys.join(",") !== "category,description,path") {
      throw new Error(
        `${relative(metadataPath)} prompts[${index}] must contain exactly path, category, and description`
      );
    }

    const promptPath = normalizePromptPath(value.path, `prompts[${index}].path`);
    if (seen.has(promptPath)) {
      throw new Error(`${relative(metadataPath)} repeats prompt path ${promptPath}`);
    }
    seen.add(promptPath);

    const category = oneLine(value.category, `prompts[${index}].category`);
    const description = oneLine(value.description, `prompts[${index}].description`);
    if (!/[.!?]$/u.test(description)) {
      throw new Error(`${relative(metadataPath)} prompts[${index}].description must end as a sentence`);
    }
    return { path: promptPath, category, description };
  });
}

function discoverPromptPaths(directory) {
  const walk = (current) =>
    readdirSync(current, { withFileTypes: true }).flatMap((entry) => {
      const absolutePath = path.join(current, entry.name);
      if (entry.isDirectory()) return walk(absolutePath);
      if (!entry.isFile() || !/\.mdx?$/iu.test(entry.name)) return [];
      return [path.relative(directory, absolutePath).split(path.sep).join("/")];
    });
  return walk(directory).sort();
}

function readTopologyPromptBindings(topologyPath) {
  const document = YAML.parse(readFileSync(topologyPath, "utf8"));
  if (!isRecord(document) || !Array.isArray(document.nodes)) {
    throw new Error(`${relative(topologyPath)} must contain a nodes array`);
  }

  return document.nodes.flatMap((value, index) => {
    if (!isRecord(value) || value.kind !== "agentic") return [];
    if (typeof value.prompt === "string") {
      return [normalizePromptPath(value.prompt, `${relative(topologyPath)} nodes[${index}].prompt`)];
    }
    if (typeof value.id !== "string") {
      throw new Error(`${relative(topologyPath)} agentic nodes[${index}] must have an id`);
    }
    const inferred = typeof value.group === "string" ? `${value.group}/${value.id}.md` : `${value.id}.md`;
    return [normalizePromptPath(inferred, `${relative(topologyPath)} nodes[${index}] inferred prompt`)];
  });
}

function renderCatalog(input) {
  const defaultPromptPathSet = new Set(input.defaultPromptPaths);
  const duplicateBindings = input.defaultPromptPaths
    .map((promptPath) => [promptPath, input.defaultBindings.filter((candidate) => candidate === promptPath).length])
    .filter(([, count]) => count > 1);
  const duplicateSentence =
    duplicateBindings.length === 0
      ? ""
      : ` ${duplicateBindings
          .map(([promptPath, count]) => `${sourceLink(promptPath)} is reused by ${count} nodes`)
          .join("; ")}.`;
  const profileCounts = input.topologyBindings
    .slice(1)
    .map((topology) => [
      topology.id,
      new Set(topology.prompts.filter((promptPath) => !defaultPromptPathSet.has(promptPath))).size
    ])
    .filter(([, count]) => count > 0)
    .map(([id, count]) => `\`${id}\` (${count})`)
    .join(", ");

  const sections = [
    "<!-- Generated by scripts/prompt-catalog-docs.mjs from prompt-catalog-data.yml and shipped topologies. -->",
    "# Prompt Catalog",
    "",
    `Ultrafuzz ships ${input.editablePromptPaths.length} project-editable workflow prompts and ${input.runtimeTemplatePaths.length} package-owned composition templates. The descriptions are maintained in [\`prompt-catalog-data.yml\`](prompt-catalog-data.yml); file membership and workflow grouping are derived from the checked-in prompt tree and shipped topologies.`,
    "",
    "The **Category** column is documentation only. It is not prompt frontmatter or topology configuration.",
    "",
    "## Default Campaign Prompts",
    "",
    `The default topology binds ${input.defaultBindings.length} agentic nodes to ${input.defaultPromptPaths.length} distinct prompt files.${duplicateSentence}`,
    "",
    renderTable(input.defaultPromptPaths, input.metadataByPath),
    "",
    "## Additional Shipped-Profile Prompts",
    "",
    `These ${input.additionalProfilePromptPaths.length} project-editable prompts are not bound by the default topology, but are used by other shipped topologies. Additional-file counts by topology are ${profileCounts}; a prompt can appear in more than one topology.`,
    "",
    renderTable(input.additionalProfilePromptPaths, input.metadataByPath)
  ];

  if (input.unwiredPromptPaths.length > 0) {
    sections.push(
      "",
      "## Unwired Project Prompts",
      "",
      "These project-editable prompts are shipped but are not currently referenced by a shipped topology.",
      "",
      renderTable(input.unwiredPromptPaths, input.metadataByPath)
    );
  }

  sections.push(
    "",
    "## Runtime Composition Templates",
    "",
    `These ${input.runtimeTemplatePaths.length} underscore-prefixed files are package-owned renderer fragments. They are packaged with Ultrafuzz, but \`ultrafuzz init\` does not scaffold them into target projects and topology nodes cannot bind them directly as workflow prompts.`,
    "",
    renderTable(input.runtimeTemplatePaths, input.metadataByPath),
    ""
  );

  return sections.join("\n");
}

function renderTable(promptPaths, metadataByPath) {
  const rows = promptPaths.map((promptPath) => {
    const metadata = metadataByPath.get(promptPath);
    if (metadata === undefined) throw new Error(`missing metadata for ${promptPath}`);
    return `| ${sourceLink(promptPath)} | ${escapeCell(metadata.category)} | ${escapeCell(metadata.description)} |`;
  });
  return ["| Filename | Category | Description |", "| --- | --- | --- |", ...rows].join("\n");
}

function sourceLink(promptPath) {
  return `[\`${promptPath}\`](../../.ultrafuzz/prompts/${promptPath})`;
}

function assertSamePaths(actual, documented) {
  const actualSet = new Set(actual);
  const documentedSet = new Set(documented);
  const missing = actual.filter((promptPath) => !documentedSet.has(promptPath));
  const stale = documented.filter((promptPath) => !actualSet.has(promptPath));
  if (missing.length > 0 || stale.length > 0) {
    throw new Error(
      [
        "prompt catalog metadata does not match .ultrafuzz/prompts",
        ...(missing.length > 0 ? [`missing metadata: ${missing.join(", ")}`] : []),
        ...(stale.length > 0 ? [`stale metadata: ${stale.join(", ")}`] : [])
      ].join("; ")
    );
  }
}

function normalizePromptPath(value, field) {
  if (typeof value !== "string") throw new Error(`${field} must be a string`);
  const normalized = value.replaceAll("\\", "/");
  if (
    normalized !== value ||
    normalized === "" ||
    normalized.startsWith("/") ||
    normalized.split("/").some((part) => part === "" || part === "." || part === "..") ||
    !/\.mdx?$/iu.test(normalized)
  ) {
    throw new Error(`${field} is not a safe prompt path: ${value}`);
  }
  return normalized;
}

function oneLine(value, field) {
  if (typeof value !== "string" || value.trim() === "" || value.trim() !== value || /[\r\n]/u.test(value)) {
    throw new Error(`${relative(metadataPath)} ${field} must be one non-empty line`);
  }
  return value;
}

function isRuntimeTemplate(promptPath) {
  return promptPath.split("/").some((part) => part.startsWith("_"));
}

function unique(values) {
  return [...new Set(values)];
}

function escapeCell(value) {
  return value.replaceAll("|", "\\|");
}

function relative(absolutePath) {
  return path.relative(root, absolutePath).split(path.sep).join("/");
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
