// Jev, TypeSafe's judgment model, over its HTTP API (https://docs.typesafe.ai/api.md): the request
// and response shapes, translated to and from lean.ts's Pi-style questions and answers. lean.ts
// asks `bool` questions; the API's type is `noul`, answered as `{ type: "noul", noul }`. Pure: the
// `$.http.fetch` call itself is in register.ts, where `$` is.
import type { Answer, Question } from './lean'

export const ENDPOINT = 'https://api.typesafe.ai/v1/systemone'
export const DEFAULT_MODEL = 'jev-latest'

/** The API's question shapes. */
type ApiQuestion =
  | { type: 'noul'; instructions: string; criteria?: { true: string; false: string } }
  | { type: 'choice'; instructions: string; criteria: Record<string, string> }
  | { type: 'score'; instructions: string; criteria: readonly string[] }

type ApiAnswer =
  | { type: 'noul'; noul: number }
  | { type: 'choice'; choice: string; probabilities: Record<string, number>; confidence: number }
  | { type: 'score'; score: number; confidence: number }

export interface JevTarget {
  model: string
  /** Where the key came from, for /cache-guard jev. */
  keySource: 'plugin config' | 'TYPESAFE_API_KEY'
  apiKey: string
}

export type JevState =
  | { kind: 'ready'; target: JevTarget }
  | { kind: 'missing'; reason: string }
  | { kind: 'off' }

/**
 * Which Jev to use, from the settings and the credentials found: the plugin's `typesafe_api_key`
 * option first, then `TYPESAFE_API_KEY`. Only TypeSafe's own API is reachable from here, so any
 * other `jev.provider` is "missing" with that reason. Never throws.
 */
export function resolveJev(
  settings: { enabled: boolean; jev: { enabled: boolean; provider: string; model: string } },
  configKey: unknown,
  envKey: string | undefined,
): JevState {
  if (!settings.enabled || !settings.jev.enabled) return { kind: 'off' }
  const provider = settings.jev.provider.trim()
  if (provider && provider !== 'typesafe') {
    return { kind: 'missing', reason: `jev.provider "${provider}" is not supported here; Claude Code reaches Jev through TypeSafe's API only (leave it empty or "typesafe")` }
  }
  const model = settings.jev.model.trim() || DEFAULT_MODEL
  const fromConfig = typeof configKey === 'string' ? configKey.trim() : ''
  if (fromConfig) return { kind: 'ready', target: { model, keySource: 'plugin config', apiKey: fromConfig } }
  const fromEnv = envKey?.trim() ?? ''
  if (fromEnv) return { kind: 'ready', target: { model, keySource: 'TYPESAFE_API_KEY', apiKey: fromEnv } }
  return { kind: 'missing', reason: 'no TypeSafe API key (the plugin option typesafe_api_key, or TYPESAFE_API_KEY in the environment)' }
}

export function label(target: JevTarget): string {
  return `typesafe/${target.model}`
}

/** lean.ts questions as the API takes them: `bool` becomes `noul`. */
export function toApiQuestions(questions: Record<string, Question>): Record<string, ApiQuestion> {
  const out: Record<string, ApiQuestion> = {}
  for (const [id, question] of Object.entries(questions)) {
    out[id] = question.type === 'bool' ? { type: 'noul', instructions: question.instructions, criteria: question.criteria } : question
  }
  return out
}

/** The request body for one Jev call. */
export function requestBody(model: string, state: Record<string, unknown>, questions: Record<string, Question>): string {
  return JSON.stringify({ model, state, questions: toApiQuestions(questions) })
}

export interface JevReply {
  answers: Record<string, Answer>
  model: string
  inputTokens?: number
}

/** The API's answers as lean.ts reads them: `noul` becomes `bool`. Undefined when the body has no answers. */
export function readReply(text: string): JevReply | undefined {
  let body: { model?: unknown; answers?: unknown; usage?: { input_tokens?: unknown } }
  try {
    body = JSON.parse(text) as typeof body
  } catch {
    return undefined
  }
  if (!body || typeof body !== 'object' || !body.answers || typeof body.answers !== 'object') return undefined
  const answers: Record<string, Answer> = {}
  for (const [id, raw] of Object.entries(body.answers as Record<string, ApiAnswer | undefined>)) {
    const answer = fromApiAnswer(raw)
    if (answer) answers[id] = answer
  }
  const inputTokens = body.usage?.input_tokens
  return {
    answers,
    model: typeof body.model === 'string' ? body.model : '',
    ...(typeof inputTokens === 'number' && Number.isFinite(inputTokens) ? { inputTokens } : {}),
  }
}

function fromApiAnswer(raw: ApiAnswer | undefined): Answer | undefined {
  if (!raw || typeof raw !== 'object') return undefined
  switch (raw.type) {
    case 'noul':
      return Number.isFinite(raw.noul) ? { type: 'bool', probability: raw.noul } : undefined
    case 'choice':
      return typeof raw.choice === 'string'
        ? { type: 'choice', choice: raw.choice, probabilities: raw.probabilities ?? {}, confidence: Number(raw.confidence) || 0 }
        : undefined
    case 'score':
      return Number.isFinite(raw.score) ? { type: 'score', score: raw.score, confidence: Number(raw.confidence) || 0 } : undefined
    default:
      return undefined
  }
}

/** One line for an HTTP status or a transport error. */
export function describeFailure(status: number | undefined, message?: string): string {
  if (status !== undefined) {
    if (status === 401 || status === 403) return 'invalid API key'
    if (status === 429) return 'rate limited (HTTP 429)'
    return `HTTP ${status}`
  }
  const text = (message ?? '').replace(/\s+/gu, ' ').trim()
  if (/timed out|timeout|ETIMEDOUT/iu.test(text)) return 'timed out'
  if (/CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC|nonessential/iu.test(text)) return 'network calls are off (CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC)'
  return text.slice(0, 160) || 'unknown error'
}

/** A one-question request, to check that Jev answers with the key found. */
export const PROBE: { state: Record<string, unknown>; questions: Record<string, Question> } = {
  state: { message: 'The tests pass now, thanks.' },
  questions: { approved: { type: 'bool', instructions: 'Is the user satisfied?', criteria: { true: 'Satisfied', false: 'Not satisfied' } } },
}
