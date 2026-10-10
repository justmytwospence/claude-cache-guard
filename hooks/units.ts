// Claude Code's transcript (SessionMessage rows) in and out of lean.ts: the units Jev judges for
// a compaction, the filtered conversation Claude Code's summarizer reads, the earlier summary, the
// files the conversation touched, and the last requests. Pure: no `$`.
import { type FileOps, type Keep, type Unit, clip, finishUnits } from './lean'

/** The part of a SessionMessage this reads; what it writes back is the same shape. */
export interface MessageLike {
  role: 'user' | 'assistant'
  text: string
  toolUses: readonly ToolUseLike[]
  toolResults?: readonly ToolResultLike[]
  handle?: string
}

export interface ToolUseLike {
  tool_use_id: string
  tool: string
  input: Record<string, unknown>
  text?: string
  isError?: true
  result?: unknown
  [extra: string]: unknown
}

export interface ToolResultLike {
  tool_use_id: string
  text: string
  isError: boolean
  result?: unknown
}

/** How Claude Code's own summary opens, and how a Jev summary does. */
const SUMMARY_PREFIXES = ['This session is being continued from a previous conversation', '# Compacted with Jev']

export function isSummary(message: MessageLike): boolean {
  if (message.role !== 'user' || message.toolResults?.length || message.toolUses.length) return false
  const text = message.text.trimStart()
  return SUMMARY_PREFIXES.some((prefix) => text.startsWith(prefix))
}

/**
 * Split the transcript into units, each tool call with its outcome (from the assistant row's
 * `toolUses`, which carry the result once answered). A leading summary of an earlier compaction
 * is returned apart, as the previous summary.
 */
export function extractUnits(messages: readonly MessageLike[]): { units: Unit[]; previousSummary?: string } {
  const units: Unit[] = []
  let previousSummary: string | undefined
  const id = () => `U${String(units.length + 1).padStart(3, '0')}`
  messages.forEach((message, index) => {
    if (index === 0 && isSummary(message)) {
      previousSummary = message.text
      return
    }
    if (message.role === 'user') {
      // A row carrying tool results is the engine's; its text, if any, is a reminder.
      if (message.toolResults?.length) return
      const text = message.text.trim()
      if (text) units.push({ id: id(), kind: 'user', text, message: index })
      return
    }
    const text = message.text.trim()
    if (text) units.push({ id: id(), kind: 'assistant', text, message: index })
    for (const use of message.toolUses) {
      units.push({
        id: id(),
        kind: 'tool',
        text: '',
        tool: { name: use.tool, args: JSON.stringify(use.input ?? {}), result: use.text ?? '', isError: use.isError === true, callId: use.tool_use_id },
        message: index,
      })
    }
  })
  return { units: finishUnits(units), ...(previousSummary !== undefined ? { previousSummary } : {}) }
}

/**
 * The transcript Claude Code's summarizer reads: dropped units removed, summarized ones clipped
 * (user text to 1.5k, assistant text to 1k, tool results to 600 characters), verbatim ones as they
 * are (they are also appended to the summary). A changed row loses its `handle`, so the engine
 * builds it from the text and tool blocks; an unchanged row keeps it.
 */
export function filterMessages(messages: readonly MessageLike[], units: readonly Unit[], keep: ReadonlyMap<string, Keep>): MessageLike[] {
  const byMessage = new Map<number, Unit[]>()
  for (const unit of units) byMessage.set(unit.message, [...(byMessage.get(unit.message) ?? []), unit])
  const callKeep = new Map<string, Keep>()
  for (const unit of units) if (unit.tool) callKeep.set(unit.tool.callId, keep.get(unit.id) ?? 'summarize')
  const out: MessageLike[] = []
  messages.forEach((message, index) => {
    const own = byMessage.get(index) ?? []
    if (message.role === 'user') {
      if (message.toolResults?.length) {
        // Each result follows its call: dropped with it, clipped with it.
        const results = message.toolResults.filter((r) => callKeep.get(r.tool_use_id) !== 'drop')
        if (!results.length && !message.text.trim()) return
        const clipped = results.map((r) => (callKeep.get(r.tool_use_id) === 'summarize' && r.text.length > 600 ? { ...r, text: clip(r.text, 600) } : r))
        const changed = clipped.length !== message.toolResults.length || clipped.some((r, i) => r !== results[i])
        out.push(changed ? withoutHandle({ ...message, toolResults: clipped }) : message)
        return
      }
      const unit = own[0]
      const k = unit ? (keep.get(unit.id) ?? 'summarize') : 'verbatim'
      if (k === 'drop') return
      if (k === 'summarize' && message.text.length > 1_500) out.push(withoutHandle({ ...message, text: clip(message.text, 1_500) }))
      else out.push(message)
      return
    }
    const textUnit = own.find((u) => u.kind === 'assistant')
    const k = textUnit ? (keep.get(textUnit.id) ?? 'summarize') : 'drop'
    const text = k === 'drop' ? '' : k === 'summarize' ? clip(message.text, 1_000) : message.text
    const uses = message.toolUses.filter((u) => callKeep.get(u.tool_use_id) !== 'drop')
    const clippedUses = uses.map((u) => (callKeep.get(u.tool_use_id) === 'summarize' && (u.text?.length ?? 0) > 600 ? { ...u, text: clip(u.text ?? '', 600) } : u))
    if (!text.trim() && !clippedUses.length) return
    const changed = text !== message.text || clippedUses.length !== message.toolUses.length || clippedUses.some((u, i) => u !== message.toolUses[i])
    out.push(changed ? withoutHandle({ ...message, text, toolUses: clippedUses }) : message)
  })
  return out
}

function withoutHandle(message: MessageLike): MessageLike {
  const { handle: _handle, ...rest } = message
  return rest
}

/** The last `count` prompts, oldest first: the goal when none is given. */
export function lastUserMessages(messages: readonly MessageLike[], count: number): string {
  const texts: string[] = []
  for (let i = messages.length - 1; i >= 0 && texts.length < count; i--) {
    const message = messages[i] as MessageLike
    if (message.role !== 'user' || message.toolResults?.length || isSummary(message)) continue
    const text = message.text.trim()
    if (text) texts.unshift(clip(text, 1_500))
  }
  return texts.join('\n---\n')
}

const READ_TOOLS = new Set(['Read'])
const WRITE_TOOLS = new Set(['Write'])
const EDIT_TOOLS = new Set(['Edit', 'MultiEdit', 'NotebookEdit'])

/** The files the conversation read, wrote and edited, from the file tools' arguments. */
export function fileOps(messages: readonly MessageLike[]): FileOps {
  const read = new Set<string>()
  const written = new Set<string>()
  const edited = new Set<string>()
  for (const message of messages) {
    if (message.role !== 'assistant') continue
    for (const use of message.toolUses) {
      if (use.isError) continue
      const path = use.input?.file_path ?? use.input?.notebook_path
      if (typeof path !== 'string' || !path) continue
      if (READ_TOOLS.has(use.tool)) read.add(path)
      else if (WRITE_TOOLS.has(use.tool)) written.add(path)
      else if (EDIT_TOOLS.has(use.tool)) edited.add(path)
    }
  }
  return { read, written, edited }
}

/** Which tools' output may be trimmed, and from what size; undefined for the rest. */
export function trimFloor(tool: string, limits: { minChars: number; readMinChars: number }): number | undefined {
  if (tool === 'Read') return limits.readMinChars
  if (['Bash', 'Grep', 'Glob', 'LS', 'WebFetch', 'WebSearch'].includes(tool) || tool.startsWith('mcp__')) return limits.minChars
  return undefined
}

/** The text of a tool_result block's `content`: a string, or its text blocks joined. */
export function resultText(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .flatMap((block) => (block && typeof block === 'object' && (block as { type?: unknown }).type === 'text' ? [String((block as { text?: unknown }).text ?? '')] : []))
    .join('\n')
}

/** The same `content` with its text replaced: a string stays a string; blocks keep their non-text blocks. */
export function withResultText(content: unknown, text: string): unknown {
  if (typeof content === 'string' || !Array.isArray(content)) return text
  const out: unknown[] = []
  let placed = false
  for (const block of content) {
    if (block && typeof block === 'object' && (block as { type?: unknown }).type === 'text') {
      if (!placed) out.push({ type: 'text', text })
      placed = true
    } else out.push(block)
  }
  if (!placed) out.push({ type: 'text', text })
  return out
}
