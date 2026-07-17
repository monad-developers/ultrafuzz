import { createClaudeAgent } from "./claude";
import { createCodexAgent } from "./codex";

export { createClaudeAgent } from "./claude";
export { createCodexAgent } from "./codex";

// Agents are constructed per task from the selected model profile, never at
// import time: an agent's auth is only read when that agent is actually used,
// so a project running one backend does not need the other's credentials.
export const agentFactories = { ClaudeAgent: createClaudeAgent, CodexAgent: createCodexAgent };
