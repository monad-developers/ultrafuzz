import { createCodexAgent } from "./codex";

export { createCodexAgent } from "./codex";

// Agents are constructed per task from the selected model profile, never at
// import time: an agent's auth is only read when that agent is actually used,
// so a project running one backend does not need another's credentials.
export const agentFactories = { CodexAgent: createCodexAgent };
