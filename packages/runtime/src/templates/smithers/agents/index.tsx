import { createClaudeAgent } from "./claude";
import { createCodexAgent } from "./codex";
import { createDeepSeekAgent } from "./deepseek";
import { createKimiAgent } from "./kimi";
import { createOpenCodeAgent } from "./opencode";
import { createOpenRouterAgent } from "./openrouter";
import { createPiAgent } from "./pi";

export { createClaudeAgent } from "./claude";
export { createCodexAgent } from "./codex";
export { createDeepSeekAgent } from "./deepseek";
export { createKimiAgent } from "./kimi";
export { createOpenCodeAgent } from "./opencode";
export { createOpenRouterAgent } from "./openrouter";
export { createPiAgent } from "./pi";

// Agents are constructed per task from the selected model profile, never at
// import time: an agent's auth is only read when that agent is actually used,
// so a project running one backend does not need the other's credentials.
export const agentFactories = {
  ClaudeAgent: createClaudeAgent,
  CodexAgent: createCodexAgent,
  DeepSeekAgent: createDeepSeekAgent,
  KimiAgent: createKimiAgent,
  OpenCodeAgent: createOpenCodeAgent,
  OpenRouterAgent: createOpenRouterAgent,
  PiAgent: createPiAgent
};
