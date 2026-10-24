/**
 * One real request through the bridge, in the single protocol it serves.
 *
 * `smoke` exists to prove the wire path end to end: the payload and the
 * response reader both speak OpenAI Responses, which is what ZCode registers as
 * `openai-responses` and what Codex CLI sends.
 */

export const SMOKE_PROMPT = 'Reply exactly WORKBUDDY_OK.'

/** Bridge route path below `<region>/v1/`. */
export const SMOKE_ROUTE = 'responses'

/** Non-streaming request body so the answer arrives as one document. */
export function smokeBody(model: string, prompt = SMOKE_PROMPT): Record<string, unknown> {
  return { model, input: prompt, max_output_tokens: 64 }
}

/** Pull the answer text, stop reason and usage out of a Responses body. */
export function smokeSummary(body: any): { text: string | undefined, finish_reason: unknown, usage: unknown } {
  const chunks: string[] = []
  for (const item of Array.isArray(body?.output) ? body.output : []) {
    if (item?.type !== 'message' || !Array.isArray(item.content)) continue
    for (const part of item.content) {
      if (part?.type === 'output_text' && typeof part.text === 'string') chunks.push(part.text)
    }
  }
  return { text: chunks.join(''), finish_reason: body?.status, usage: body?.usage }
}
