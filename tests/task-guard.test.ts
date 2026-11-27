import { expect, test } from "bun:test";
import { readdir } from "node:fs/promises";

type Message = { info: { role: "user" | "assistant"; finish?: string; error?: unknown; agent?: string; model?: { providerID: string; modelID: string; variant?: string } }; parts?: Array<{ type: string; text?: string; synthetic?: boolean }> };
type Hook = (input: { tool: string; args?: { subagent_type?: string } }, output: { output?: string; metadata?: Record<string, any> }) => Promise<void>;
interface Guard { default: (context: { client: unknown }) => Promise<{ "tool.execute.after": Hook }> }

/**
 * The plugin is plain JavaScript that OpenCode loads at the start of each run. Nothing else parses it: the type
 * checker and the build do not include plugins/. A typed dynamic import keeps the file out of the type check.
 */
const load = async () => await import(new URL("../plugins/ultrafuzz-task-guard.js", import.meta.url).href) as Guard;

const user: Message = { info: { role: "user", agent: "hunter", model: { providerID: "openrouter", modelID: "vendor/model", variant: "max" } }, parts: [{ type: "text", text: "Hunt." }] };
const answer = (text: string, finish = "stop"): Message => ({ info: { role: "assistant", finish }, parts: text ? [{ type: "text", text }] : [] });
const completed = '<task id="ses_child" state="completed">\n<task_result>\n\n</task_result>\n</task>';

/** A session whose assistant gives `answers` one after the other: the first is there at the start, each prompt adds the next. */
async function guarded(answers: Message[]) {
  const messages: Message[] = [user, answers[0]!], prompts: Array<{ path: { id: string }; body: Record<string, any> }> = [], reads: string[] = [];
  const client = { session: {
    messages: async ({ path }: { path: { id: string } }) => { reads.push(path.id); return { data: [...messages] }; },
    prompt: async (request: { path: { id: string }; body: Record<string, any> }) => { prompts.push(request); messages.push({ info: { role: "user", agent: "hunter" } }, answers[prompts.length] ?? answers.at(-1)!); return { data: {} }; },
  } };
  const hook = (await (await load()).default({ client }))["tool.execute.after"];
  return { hook, prompts, reads };
}

test("the task guard has one export, so OpenCode registers it once", async () => {
  expect(Object.keys(await load())).toEqual(["default"]);
  // Every file of plugins/ is copied into the image and into each run, so the test helpers stay out of it.
  expect(await readdir(new URL("../plugins/", import.meta.url))).toEqual(["ultrafuzz-task-guard.js"]);
});

test("a normal subagent result, another tool and a task that did not complete are left alone", async () => {
  const { hook, prompts, reads } = await guarded([answer("Findings: none.")]);
  const output = { output: completed.replace("\n\n", "\nFindings: none.\n"), metadata: { sessionId: "ses_child" } };
  await hook({ tool: "task" }, output);
  expect(prompts).toEqual([]);
  expect(output.output).toContain("Findings: none.");
  expect(output.metadata).toMatchObject({ ultrafuzz_guard: { continuations: [], final_finish: "stop" } });
  // No client call at all for another tool, for a task without a session, or for a task that is not completed.
  reads.length = 0;
  await hook({ tool: "bash" }, { output: completed, metadata: { sessionId: "ses_child" } });
  await hook({ tool: "task" }, { output: completed, metadata: {} });
  await hook({ tool: "task" }, { output: '<task id="ses_child" state="running">', metadata: { sessionId: "ses_child" } });
  expect([reads, prompts]).toEqual([[], []]);
  // A model error is reported by OpenCode itself.
  const failed = await guarded([{ info: { role: "assistant", error: { name: "APIError" } }, parts: [] }]);
  await failed.hook({ tool: "task" }, { output: completed, metadata: { sessionId: "ses_child" } });
  expect(failed.prompts).toEqual([]);
});

test("a result that stopped at the output limit is continued once, and the new text replaces the task result", async () => {
  const { hook, prompts } = await guarded([answer("Partial", "length"), answer("Complete findings.")]);
  const output = { output: completed, metadata: { sessionId: "ses_child" } as Record<string, any> };
  await hook({ tool: "task", args: { subagent_type: "hunter" } }, output);
  expect(prompts).toHaveLength(1);
  // The same child, agent, model and variant get the continuation.
  expect(prompts[0]!.path).toEqual({ id: "ses_child" });
  expect(prompts[0]!.body).toMatchObject({ agent: "hunter", model: { providerID: "openrouter", modelID: "vendor/model" }, variant: "max" });
  expect(prompts[0]!.body.parts[0].text).toContain("ended at the output token limit");
  expect(output.output).toBe('<task id="ses_child" state="completed">\n<task_result>\nComplete findings.\n</task_result>\n</task>');
  expect(output.metadata.ultrafuzz_guard).toEqual({ continuations: ["length"], final_finish: "stop" });
});

test("an empty result is continued two times at most, and then the task fails with the reason", async () => {
  const { hook, prompts } = await guarded([answer(""), answer(""), answer("")]);
  const output = { output: completed, metadata: { sessionId: "ses_child" } as Record<string, any> };
  await expect(hook({ tool: "task" }, output)).rejects.toThrow("Subagent hunter (session ses_child) returned no result text after 2 continuation(s). This task failed; it produced no usable result.");
  expect(prompts).toHaveLength(2);
  expect(prompts.map(prompt => prompt.body.parts[0].text)).toEqual(Array(2).fill("Your previous response contained no result text. Return your complete findings as text now."));
  expect(output.metadata.ultrafuzz_guard.continuations).toEqual(["empty", "empty"]);
  // The second continuation can still give the result.
  const late = await guarded([answer(""), answer("", "length"), answer("Late findings.")]);
  const recovered = { output: completed, metadata: { sessionId: "ses_child" } as Record<string, any> };
  await late.hook({ tool: "task" }, recovered);
  expect(late.prompts).toHaveLength(2);
  expect(recovered.output).toContain("<task_result>\nLate findings.\n</task_result>");
  // An answer of the client that is an error is not taken for an empty session.
  const broken = (await (await load()).default({ client: { session: { messages: async () => ({ error: { name: "NotFound" } }) } } }))["tool.execute.after"];
  await expect(broken({ tool: "task" }, { output: completed, metadata: { sessionId: "ses_child" } })).rejects.toThrow("Ultrafuzz task guard could not read messages for session ses_child");
});
