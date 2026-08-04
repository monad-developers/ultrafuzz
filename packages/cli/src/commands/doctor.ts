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
      (entry) => `- ${entry.name}: ${entry.available ? (entry.path ?? "available") : "missing from PATH"}`
    ),
    "Workflow engine:",
    `- bundled: ${engine.bundled_version}`,
    `- required by generated project: ${engine.required_version}`,
    `- installed: ${engine.installed_version ?? "not installed"}`,
    `- installed bin target: ${engine.installed_bin_target ?? "unknown"}`,
    `- local binary: ${engine.bin_path ?? "not present"}`,
    `- latest published stable: ${engine.latest_published_version}`,
    `- dependency layout: ${engine.layout_status}${engine.layout_detail === null ? "" : ` - ${engine.layout_detail}`}`,
    `- compatibility patches: detached admission ${engine.compatibility_patches.detached_admission}, fork/replay preparation ${engine.compatibility_patches.replay_prepare_only}, supervisor descriptor ${engine.compatibility_patches.supervisor_descriptor}, workflow path persistence ${engine.compatibility_patches.workflow_path_persistence}`
  ];
  return `${lines.join("\n")}\n`;
}
