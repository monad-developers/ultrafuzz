/** @jsxImportSource smthrs */
import { mkdirSync } from "node:fs";
import path from "node:path";
import { createSmithers } from "smthrs";
import { z } from "zod/v4";
import { createOpenRouterAgent } from "./dist/templates/smithers/agents/openrouter.tsx";

const artifactDir = process.env.ULTRAFUZZ_PROBE_ARTIFACT_DIR;
if (artifactDir === undefined || artifactDir.trim() === "") {
  throw new Error("ULTRAFUZZ_PROBE_ARTIFACT_DIR is required");
}
mkdirSync(artifactDir, { recursive: true });
const outputPath = path.join(artifactDir, "smoke-context.md");
const agent = createOpenRouterAgent({
  model: "openai/gpt-5.6-luna",
  reasoningEffort: "xhigh",
  addDir: [artifactDir]
});
const { Workflow, Task, smithers, outputs } = createSmithers({
  input: z.object({}),
  result: z.strictObject({ summary: z.string().min(1) })
});

export default smithers(() => (
  <Workflow name="openrouter-probe">
    <Task id="smoke-context" output={outputs.result} agent={agent} retries={0}>
      {`Use the shell tool to write exactly "# Ready\\n" to ${outputPath}. Then return a concise completion summary.`}
    </Task>
  </Workflow>
));
