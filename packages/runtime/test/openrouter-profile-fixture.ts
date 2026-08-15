import fs from "node:fs";
import path from "node:path";

export function addOpenRouterProfile(project: string): void {
  fs.appendFileSync(
    path.join(project, "ultrafuzz.toml"),
    '\n[models.openrouter]\nagent = "OpenRouterAgent"\nmodel = "~anthropic/claude-sonnet-latest:free"\nreasoning = "high"\n',
    "utf8"
  );
}
