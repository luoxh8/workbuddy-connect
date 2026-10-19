/**
 * One real request through the bridge, spoken in each supported protocol.
 *
 * `smoke` exists to prove the wire path end to end, which means the payload and
 * the response reader have to match the protocol the bridge is asked to serve —
 * a chat-completions body on the `/messages` route would answer a different
 * question.
 */

import type { ZCodeProtocol } from './zcode.ts'

export const SMOKE_PROMPT = 'Reply exactly WORKBUDDY_OK.'

/** Bridge route path (below `<region>/v1/`) for one protocol. */
export function smokeRequest(protocol: ZCodeProtocol): string {
  if (protocol === 'anthropic') return 'messages'
  if (protocol === 'responses') return 'responses'
  return 'chat/completions'
}

/** Request body for one protocol; always non-streaming so the answer is one document. */
export function smokeBody(protocol: ZCodeProtocol, model: string, prompt = SMOKE_PROMPT): Record<string, unknown> {
  if (protocol === 'anthropic') {
    return { model, max_tokens: 64, messages: [{ role: 'user', content: prompt }] }
  }
  if (protocol === 'responses') {
    return { model, input: prompt, max_output_tokens: 64 }
  }
  return { model, messages: [{ role: 'user', content: prompt }], stream: false, max_tokens: 64 }
}

/** Pull the answer text and stop reason out of a protocol-specific response. */
export function smokeSummary(protocol: ZCodeProtocol, body: any): { text: string | undefined, finish_reason: unknown, usage: unknown } {
  if (protocol === 'anthropic') {
    const text = Array.isArray(body?.content)
      ? body.content.filter((block: any) => block?.type === 'text').map((block: any) => block.text).join('')
      : undefined
    return { text, finish_reason: body?.stop_reason, usage: body?.usage }
  }
  if (protocol === 'responses') {
    const chunks: string[] = []
    for (const item of Array.isArray(body?.output) ? body.output : []) {
      if (item?.type !== 'message' || !Array.isArray(item.content)) continue
      for (const part of item.content) {
        if (part?.type === 'output_text' && typeof part.text === 'string') chunks.push(part.text)
      }
    }
    return { text: chunks.join(''), finish_reason: body?.status, usage: body?.usage }
  }
  return {
    text: body?.choices?.[0]?.message?.content,
    finish_reason: body?.choices?.[0]?.finish_reason,
    usage: body?.usage,
  }
}
