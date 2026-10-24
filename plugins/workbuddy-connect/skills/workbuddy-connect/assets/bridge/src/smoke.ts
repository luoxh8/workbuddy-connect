/**
 * One real request through the bridge, in the single protocol it serves.
 *
 * `smoke` exists to prove the wire path end to end: the payload and the
 * response reader both speak OpenAI Chat Completions, the format every client
 * understands and the shape WorkBuddy upstream answers in.
 */

export const SMOKE_PROMPT = 'Reply exactly WORKBUDDY_OK.'

/** Bridge route path below `<region>/v1/`. */
export const SMOKE_ROUTE = 'chat/completions'

/** Non-streaming request body so the answer arrives as one document. */
export function smokeBody(model: string, prompt = SMOKE_PROMPT): Record<string, unknown> {
  return { model, messages: [{ role: 'user', content: prompt }], stream: false, max_tokens: 64 }
}

/** Pull the answer text, stop reason and usage out of a chat-completions body. */
export function smokeSummary(body: any): { text: string | undefined, finish_reason: unknown, usage: unknown } {
  return {
    text: body?.choices?.[0]?.message?.content,
    finish_reason: body?.choices?.[0]?.finish_reason,
    usage: body?.usage,
  }
}
