import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createOpenRouterAgent } from "../../packages/runtime/dist/templates/smithers/agents/openrouter.js";

const root = mkdtempSync(path.join(tmpdir(), "ultrafuzz-openrouter-agent-probe-"));
try {
  writeFileSync(
    path.join(root, "ultrafuzz.toml"),
    [
      "version = 1",
      "",
      "[agents.OpenRouterAgent]",
      'auth = "api-key"',
      'api_key_env = "OPENROUTER_API_KEY"',
      ""
    ].join("\n"),
    { mode: 0o600 }
  );
  process.chdir(root);
  const events = [];
  const agent = createOpenRouterAgent({ model: "openai/gpt-5.6-luna", reasoningEffort: "xhigh" });
  const result = await agent.generate({
    prompt: "Use the shell tool to run 'printf ready'. Then report only the exact command output.",
    rootDir: root,
    onEvent: (event) => {
      events.push({ type: event.type, ok: event.ok, entryType: event.entryType });
    }
  });
  console.log(JSON.stringify({ text: result.text, events }));
} finally {
  rmSync(root, { recursive: true, force: true });
}
