import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

/** Sets `run.refresh_prompts_on_resume` in the project's `ultrafuzz.toml`, which `resume` reads. */
export function setRefreshPromptsOnResume(project: string, enabled: boolean): void {
  const configPath = path.join(project, "ultrafuzz.toml");
  const config = fs.readFileSync(configPath, "utf8").replace(/^refresh_prompts_on_resume = \S+\n/mu, "");
  assert.match(config, /^\[run\]$/mu);
  fs.writeFileSync(
    configPath,
    config.replace(/^\[run\]$/mu, `[run]\nrefresh_prompts_on_resume = ${String(enabled)}`),
    "utf8"
  );
}
