import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createOpenRouterAgent } from "../../packages/runtime/dist/templates/smithers/agents/openrouter.tsx";

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
  const invoke = async (index) => {
    const events = [];
    const agent = createOpenRouterAgent({ model: "openai/gpt-5.6-luna", reasoningEffort: "xhigh" });
    const result = await agent.generate({
      prompt: `Use the shell tool to run 'printf ready-${index}'. Then report only the exact command output.`,
      rootDir: root,
      onEvent: (event) => {
        events.push({ type: event.type, ok: event.ok, entryType: event.entryType });
      }
    });
    return { text: result.text, events };
  };
  const single = await invoke(0);
  console.log(JSON.stringify({ phase: "single", ...single }));
  const concurrent = await Promise.allSettled(Array.from({ length: 6 }, (_, index) => invoke(index + 1)));
  console.log(
    JSON.stringify({
      phase: "concurrent",
      results: concurrent.map((entry) =>
        entry.status === "fulfilled"
          ? { status: entry.status, text: entry.value.text }
          : { status: entry.status, error: entry.reason instanceof Error ? entry.reason.message : String(entry.reason) }
      )
    })
  );
  if (concurrent.some((entry) => entry.status === "rejected")) process.exitCode = 1;
} finally {
  rmSync(root, { recursive: true, force: true });
}
