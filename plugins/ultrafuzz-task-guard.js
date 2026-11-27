// Temporary workaround for OpenCode 1.19.x task completion on empty/truncated output.
// Continue the same child at most twice, then fail explicitly. No tool-use policing.
// Retire after upstream fixes are qualified with the shipped profile.
// https://github.com/anomalyco/opencode/issues/52378
// https://github.com/anomalyco/opencode/issues/59051
const MAX_CONTINUATIONS = 2

const CONTINUE_PROMPT =
  "Your previous response ended at the output token limit before you returned a result. " +
  "Continue the same task from where you stopped. Keep reasoning brief and return your complete findings as text now."
const EMPTY_PROMPT =
  "Your previous response contained no result text. Return your complete findings as text now."
function assistants(messages) {
  return messages.filter((message) => message?.info?.role === "assistant")
}

function lastUser(messages) {
  return messages.filter((message) => message?.info?.role === "user").at(-1)
}

function resultText(message) {
  return (message?.parts ?? [])
    .filter((part) => part.type === "text" && !part.synthetic)
    .map((part) => part.text ?? "")
    .join("")
    .trim()
}

function problem(messages) {
  const message = assistants(messages).at(-1)
  if (!message) return "missing"
  if (message.info.error) return null // OpenCode already reports model errors.
  if (message.info.finish === "length") return "length"
  if (!resultText(message)) return "empty"
  return null
}

const PROMPTS = { length: CONTINUE_PROMPT, empty: EMPTY_PROMPT, missing: EMPTY_PROMPT }
const DETAILS = {
  length: "stopped at the output token limit (finish=length) without returning a result",
  empty: "returned no result text",
  missing: "has no assistant response",
}

// Single export: OpenCode registers every exported function, so a named export
// beside `default` would run the guard twice.
export default async function UltrafuzzTaskGuard({ client }) {
  return {
    "tool.execute.after": async (input, output) => {
      if (input.tool !== "task") return
      const sessionID = output?.metadata?.sessionId
      if (!sessionID) return
      const current = String(output.output ?? "")
      if (!/<task [^>]*state="completed">/.test(current)) return

      // The 1.19.x plugin client uses path/body argument objects.
      const unwrap = (response, what) => {
        if (response?.error || !("data" in (response ?? {}))) {
          throw new Error(`Ultrafuzz task guard could not ${what} for session ${sessionID}: ${JSON.stringify(response?.error ?? response)}`)
        }
        return response.data
      }
      const read = async () => unwrap(await client.session.messages({ path: { id: sessionID } }), "read messages") ?? []
      let messages = await read()
      let last = assistants(messages).at(-1)
      const continuations = []
      let reason = problem(messages)
      while (reason && continuations.length < MAX_CONTINUATIONS) {
        const user = lastUser(messages)?.info ?? {}
        const model = user.model ?? output.metadata.model
        continuations.push(reason)
        const agent = user.agent ?? input.args?.subagent_type
        unwrap(await client.session.prompt({
          path: { id: sessionID },
          body: {
            ...(agent ? { agent } : {}),
            ...(model?.providerID && model?.modelID ? { model: { providerID: model.providerID, modelID: model.modelID } } : {}),
            ...(user.model?.variant ? { variant: user.model.variant } : {}),
            parts: [{ type: "text", text: PROMPTS[reason] }],
          },
        }), "continue the subagent")
        messages = await read()
        last = assistants(messages).at(-1)
        reason = problem(messages)
      }
      output.metadata = { ...output.metadata, ultrafuzz_guard: { continuations, final_finish: last?.info?.finish ?? null } }
      if (reason) {
        const agent = lastUser(messages)?.info?.agent ?? input.args?.subagent_type ?? "subagent"
        throw new Error(
          `Subagent ${agent} (session ${sessionID}) ${DETAILS[reason]} after ${continuations.length} continuation(s). ` +
          "This task failed; it produced no usable result.",
        )
      }
      if (continuations.length) {
        output.output = current.replace(/<task_result>[\s\S]*<\/task_result>/, () => `<task_result>\n${resultText(last)}\n</task_result>`)
      }
    },
  }
}
