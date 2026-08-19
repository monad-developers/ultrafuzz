import { Command } from "@oclif/core";
import { diagnoseProject, type DoctorValue } from "@ultrafuzz/runtime";

import { cliIo, commandFromRuntime, emitCommandResult, globalFlags, projectRoot } from "../command-shared.js";

export default class Doctor extends Command {
  static override summary = "Report configuration, toolchain, and workflow engine install posture";
  static override flags = globalFlags;

  async run(): Promise<void> {
    const { flags } = await this.parse(Doctor);
    const result = await diagnoseProject({ projectRoot: projectRoot(flags), env: cliIo().env });
    emitCommandResult(this, "doctor", commandFromRuntime("doctor", result, renderDoctor), flags.json === true);
  }
}

function renderDoctor(value: DoctorValue): string {
  const engine = value.workflow_engine;
  const lines = [
    `Project: ${value.project_root}`,
    `Verdict: ${value.ok ? "healthy" : "needs attention"}`,
    "Checks:",
    ...value.checks.map((check) => `- ${check.name}: ${check.status} - ${check.summary}`),
    "Toolchain:",
    ...value.toolchain.map(
      (entry) =>
        `- ${entry.name}: ${
          entry.available
            ? `${entry.path ?? "available"}${entry.version == null ? "" : ` (${entry.version})`}`
            : "missing from execution environment"
        }`
    ),
    "Resolved bindings:",
    ...(value.validation.bindings.length === 0
      ? ["- none configured"]
      : value.validation.bindings.map(
          (binding) =>
            `- ${binding.profile}: harness=${binding.harness}, provider=${binding.provider}, model=${binding.model}${binding.protocol === undefined ? "" : `, protocol=${binding.protocol}`}`
        )),
    "Workflow engine:",
    `- bundled: ${engine.bundled_version}`,
    `- required by generated project: ${engine.required_version}`,
    `- installed: ${engine.installed_version ?? "not installed"}`,
    `- installed bin target: ${engine.installed_bin_target ?? "unknown"}`,
    `- local binary: ${engine.bin_path ?? "not present"}`,
    `- latest published stable: ${engine.latest_published_version}${
      engine.latest_published_is_renamed_package ? " (renamed upstream package)" : ""
    }`,
    `- dependency layout: ${engine.layout_status}${engine.layout_detail === null ? "" : ` - ${engine.layout_detail}`}`,
    `- compatibility patches: ${renderCompatibilityPatches(engine.compatibility_patches)}`
  ];
  return `${lines.join("\n")}\n`;
}

// Rendered from whatever the runtime reports rather than a fixed pair of keys, so
// a newly tracked workaround shows up here without a second edit.
function renderCompatibilityPatches(patches: Record<string, string>): string {
  const entries = Object.entries(patches);
  if (entries.length === 0) {
    return "none tracked";
  }
  return entries.map(([name, posture]) => `${name.replaceAll("_", " ")} ${posture}`).join(", ");
}
