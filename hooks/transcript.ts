// Reads the tail of a Claude Code transcript (~/.claude/projects/<slug>/<session>.jsonl): the last
// main-conversation response, and which TTL the session's cache writes use. The usage rows carry
// `cache_creation.ephemeral_1h_input_tokens` / `ephemeral_5m_input_tokens`, which nothing in the
// mod API reports.

export interface TranscriptTail {
  /** When the last main-thread response was written (its end, so later than the request's start). */
  at?: number;
  /** Its prompt: input + cache reads + cache writes. */
  promptTokens?: number;
  /** Prompt plus the reply: what the next request re-sends. */
  tokens?: number;
  model?: string;
  /** The tier of the most recent main-thread cache write in the tail. */
  ttlMs?: number;
  /** A compaction after the last response: the next request carries a fresh context. */
  compacted?: boolean;
}

interface Usage {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_creation?: { ephemeral_1h_input_tokens?: number; ephemeral_5m_input_tokens?: number };
}

/** The transcript file Claude Code writes for `sessionId` started in `root`. */
export function transcriptPath(configDir: string, root: string, sessionId: string): string {
  return `${configDir}/projects/${root.replace(/[^a-zA-Z0-9]/g, '-')}/${sessionId}.jsonl`
}

/** Parses JSONL text (possibly starting mid-line) from the end back. */
export function parseTail(text: string): TranscriptTail {
  const out: TranscriptTail = {}
  const lines = text.split('\n')
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]
    if (!line || line[0] !== '{') continue
    let row: Record<string, any>
    try {
      row = JSON.parse(line)
    } catch {
      continue // the first, cut line
    }
    if (out.at === undefined && row.type === 'system' && row.subtype === 'compact_boundary') {
      out.compacted = true
      continue
    }
    if (row.type !== 'assistant' || row.isSidechain === true) continue
    const message = row.message ?? {}
    if (message.model === '<synthetic>' || row.isApiErrorMessage === true) continue
    const usage: Usage | undefined = message.usage
    if (!usage) continue
    const prompt = (usage.input_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0)
    if (prompt <= 0) continue
    if (out.at === undefined) {
      const at = Date.parse(row.timestamp)
      if (!Number.isFinite(at)) continue
      out.at = at
      out.promptTokens = prompt
      out.tokens = prompt + (usage.output_tokens ?? 0)
      out.model = String(message.model ?? '')
    }
    const oneHour = usage.cache_creation?.ephemeral_1h_input_tokens ?? 0
    const fiveMinutes = usage.cache_creation?.ephemeral_5m_input_tokens ?? 0
    if (oneHour > 0 || fiveMinutes > 0) {
      out.ttlMs = oneHour >= fiveMinutes ? 3_600_000 : 300_000
      break
    }
  }
  return out
}
