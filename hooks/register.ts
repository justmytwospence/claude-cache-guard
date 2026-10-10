// cache-guard: keeps Claude Code's prompt cache warm while you are away, and asks before a prompt
// that would re-cache a large conversation.
//
// The clock: every main-loop model request (turn.step) reads or writes the cache, and the entry
// lives for its TTL from that request's start. The TTL is the tier the session's own cache writes
// use, read off the transcript (1h on a subscription within plan usage, 5m otherwise).
//
// Keep-warm: at 90% of the TTL with no request since, `$.model.fork` re-sends the main thread's
// last request (same model, system prompt, tools and messages) with one short question after it,
// tools denied and its own tail never cached, so the API serves the prefix from the cache and
// restarts its clock. Pi's rule decides each refresh (expected saving at least $0.05, with a 15%
// chance you come back before it lapses while idle), and refreshing stops 30 minutes (5m tier) or
// 2 hours (1h tier) after the last real request. A refresh that misses stops it.
//
// Warning: a prompt typed while idle onto an expired cache, when the rewrite would cost at least
// warn.minCost at API prices, asks first; keeping it puts the text back in the prompt box.
//
// Lean context (with Jev, TypeSafe's judgment model, over its HTTP API): large tool output is
// trimmed to the blocks the agent needs as its row is stored (`session.append`), so the model
// never reads the rest and the prompt cache is never disturbed; and `session.compact` either
// answers a summary written in code from Jev's verbatim/summarize/drop choices (the cold-cache
// menu, /cache-guard compact) or filters what Claude Code's own summarizer reads (/compact and
// automatic compaction). Without Jev none of that runs.
//
// The status line shows the cache itself (Claude Code's prompt_cache input), so this mod draws none.
//
// The host reads on(...) and $.noun.method(...) from source, so calls are spelled in full and
// helpers that take $ are top-level functions in this file (jev.ts and units.ts are pure).
import type { EngineInterface, On, PluginOptions, SessionCompactResult, SessionMessage } from 'claude-code'

import {
  DEFAULT_SETTINGS,
  NAME,
  ONE_HOUR,
  FIVE_MINUTES,
  HERDR_SOURCE,
  HERDR_TOKEN,
  type Settings,
  claudePrice,
  decideWarm,
  describeMiss,
  formatClock,
  formatCost,
  formatDuration,
  formatTokens,
  choiceCosts,
  compactionFocus,
  herdrCacheValue,
  mergeSettings,
  missCost,
  warmDeadline,
  warmDelayMs,
  worthWarning,
} from './core'
import { ENDPOINT, type JevState, type JevTarget, PROBE, describeFailure, label, readReply, requestBody, resolveJev } from './jev'
import {
  type Answer,
  JEV_KEY_URL,
  JEV_PITCH,
  type Keep,
  type Question,
  type Unit,
  batches,
  blocksFor,
  codeSummary,
  keepAnswers,
  keepCounts,
  keepQuestions,
  keepState,
  trimQuestions,
  trimState,
  trimVerdict,
  verbatimSection,
} from './lean'
import { settingsFiles } from './settings'
import { parseTail, transcriptPath } from './transcript'
import { extractUnits, fileOps, filterMessages, lastUserMessages, resultText, trimFloor, withResultText } from './units'

const COMMAND = NAME
const KEEP = 'Keep the prompt'
const FRESH = 'New conversation'
const COMPACT = 'Compact first'
const SEND = 'Send anyway'
const SUMMARY_DEFAULT = 'Default summary'
const SUMMARY_FOCUS = 'Focus on this prompt'
/** The compaction choices with Jev: its own, or Claude Code's summary (which Jev filters first). */
const COMPACT_JEV = 'Compact with Jev'
const SUMMARY_JEV_DEFAULT = 'Compact with a summary'
const SUMMARY_JEV_FOCUS = 'Compact with a summary focused on this prompt'
/** Under the cold-cache question while Jev is not set up (and not turned off). */
export const JEV_TIP = 'Tip: /cache-guard jev sets up Jev, which compacts in about a second for ~$0 (or turns this tip off).'
/** The /cache-guard jev and /cache-guard compact choices. */
const JEV_DONE = 'Done'
const JEV_ON = 'Turn Jev on'
const JEV_LEAVE_OFF = 'Leave it off'
const JEV_OFF = 'Turn Jev off'
const JEV_OFF_TIPS = 'Turn Jev off (no more tips)'
const JEV_SHOW_SETUP = 'Show the setup'
const COMPACT_SUMMARY = "Compact with Claude Code's summary"
const JEV_SETUP = 'Set up Jev'
/** How many tool calls' inputs are remembered for their results (the rest trim without arguments). */
const CALLS_REMEMBERED = 200
/** How much of a transcript's end to read: enough for the last few responses. */
const TAIL_BYTES = 400_000
const TAIL_SCRIPT = 'f=$1; [ -f "$f" ] || f=$(ls "$2"/*/"$3" 2>/dev/null | head -n 1); [ -n "$f" ] && tail -c "$4" "$f"'

interface Clock {
  /** Start of the last request that read or wrote the cache (a real one or a refresh). */
  lastAt: number
  /** Start of the last real request. */
  lastRealAt: number
  /** The last request's prompt: what a refresh should read from the cache. */
  promptTokens: number
  /** Prompt plus reply: what the next real request re-sends. */
  tokens: number
  model: string
}

interface State {
  settings: Settings
  sessionOn: boolean
  interactive: boolean
  clock?: Clock
  /** The transcript file, from the settings-hook SessionStart input. */
  transcript?: string
  ttl: { ms: number; source: string }
  timer?: { cancel: () => void }
  stepsInFlight: number
  busy: boolean
  warming: boolean
  warms: number
  /** Why no refresh is scheduled, for /cache-guard. */
  stopped: string
  /** Fires when the cache expires, to tell herdr. */
  expiry?: { cancel: () => void }
  /** The `cache` token last reported to herdr; null before the first report. */
  herdrLast: string | undefined | null
  /** The plugin's userConfig values (`typesafe_api_key`). */
  options: PluginOptions
  lean: Lean
}

/** The Jev parts: which Jev, what is armed, what was trimmed. */
interface Lean {
  jev: JevState
  /** The settings the Jev state was resolved from, to resolve again when they change. */
  jevKey: string
  /** The next compaction is Jev's, written in code; strict: nothing is spent if Jev fails. */
  armed?: { goal?: string }
  /** Why the last Jev compaction did not run, if it did not. */
  failure?: string
  /** The last compaction this plugin's hook saw. */
  last?: { mode: 'jev' | 'filtered' | 'plain'; counts?: Record<Keep, number>; latencyMs?: number }
  /** How many compactions this plugin's hook has seen. */
  compactions: number
  /** Characters trimmed from tool output this session. */
  saved: number
  /** Tool+input keys trimmed this turn: asked again, the output comes whole. */
  trimmedThisTurn: Set<string>
  /** The main loop's tool calls in flight, by id: the name and input their result row is judged with. */
  calls: Map<string, { tool: string; input: Record<string, unknown> }>
  /** The current turn's request and the assistant's latest text: Jev's `intent` for a trim. */
  turnText: { user: string; assistant: string }
  /** A strict (armed) compaction is being judged: a failure must skip, not summarize. */
  strictInFlight?: boolean
}

export function register(on: On, options: PluginOptions = {}): void {
  const s: State = {
    settings: DEFAULT_SETTINGS,
    sessionOn: true,
    interactive: false,
    ttl: { ms: FIVE_MINUTES, source: 'default' },
    stepsInFlight: 0,
    busy: false,
    warming: false,
    warms: 0,
    stopped: 'waiting for the first response',
    herdrLast: null,
    options,
    lean: {
      jev: { kind: 'missing', reason: 'not checked yet' },
      jevKey: '',
      compactions: 0,
      saved: 0,
      trimmedThisTurn: new Set(),
      calls: new Map(),
      turnText: { user: '', assistant: '' },
    },
  }

  on('session.start', async ($, e, next) => {
    const result = await next(e)
    s.interactive = e.isInteractive
    s.settings = await loadSettings($)
    await refreshJev($, s)
    await $.command.register({
      name: COMMAND,
      description: 'cache-guard: prompt cache status, warm (refresh now), on/off (this session), compact [focus] (with Jev), jev (set up or check Jev)',
      argumentHint: '[status|warm|on|off|compact [focus]|jev]',
      immediate: true,
    })
    // A resumed session: its last response and TTL come from the transcript.
    await readTranscript($, s, true)
    await syncHerdr($, s)
    return result
  })

  on('session.end', async ($, e, next) => {
    s.expiry?.cancel()
    await reportHerdr($, s, undefined)
    return next(e)
  })

  // The settings-hook SessionStart: its transcript_path, and on a resume or fork how long ago the
  // last response was and how big it was. A forked session's transcript is only written with its
  // first message, so this is the one record of the conversation's cache until then.
  on('classic.SessionStart', async ($, e, next) => {
    const result = await next(e)
    s.transcript = e.transcript_path
    const seconds = e.seconds_since_last_response
    if (seconds !== undefined && e.context_tokens !== undefined && e.context_tokens > 0) {
      const at = (await $.clock.now()) - seconds * 1000
      if (!s.clock || s.clock.lastAt < at) {
        s.clock = { lastAt: at, lastRealAt: at, promptTokens: e.context_tokens, tokens: e.context_tokens, model: e.model ?? (await $.session.model()) }
      }
    }
    await syncHerdr($, s)
    return result
  })

  on('turn.start', async ($, e, next) => {
    s.busy = true
    s.lean.turnText = { user: e.text, assistant: '' }
    s.lean.trimmedThisTurn.clear()
    s.lean.calls.clear()
    // Settings edited since (a key added, trimming turned off) apply from the next turn.
    s.settings = await loadSettings($)
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    if (e.agentId === undefined) {
      s.busy = false
      await readTranscript($, s, false)
      await schedule($, s)
    }
    return result
  })

  on('turn.step', async function* ($, e, next) {
    if (e.agentId !== undefined) return yield* next(e)
    const startedAt = await $.clock.now()
    s.stepsInFlight++
    s.timer?.cancel()
    s.timer = undefined
    try {
      const result = yield* next(e)
      const usage = result.usage
      const prompt = usage ? usage.input_tokens + usage.cache_read_input_tokens + usage.cache_creation_input_tokens : 0
      if (usage && prompt > 0) {
        s.clock = { lastAt: startedAt, lastRealAt: startedAt, promptTokens: prompt, tokens: prompt + usage.output_tokens, model: usage.model }
      }
      if (result.answer.trim()) s.lean.turnText.assistant = result.answer
      return result
    } finally {
      s.stepsInFlight--
      // A long tool run between steps can outlast a 5-minute TTL: keep warming then too.
      if (s.stepsInFlight === 0) await schedule($, s)
    }
  })

  // Every main-loop tool call: its name and input, for the trim of its result row.
  on('tool.call', async ($, e, next) => {
    if (e.agentId === undefined && typeof e.tool_use_id === 'string') {
      const { tool, tool_use_id, agentId: _agentId, consent: _consent, ...input } = e as Record<string, unknown> & { tool: string; tool_use_id: string }
      if (s.lean.calls.size >= CALLS_REMEMBERED) s.lean.calls.delete(s.lean.calls.keys().next().value as string)
      s.lean.calls.set(tool_use_id, { tool, input })
    }
    return next(e)
  }).catch(($, e, next) => (next.called ? undefined : next(e)))

  // A tool result about to be stored: trimmed to the blocks the agent needs, before the model reads
  // it. Main loop only: a subagent's transcript is its own and is dropped when it finishes.
  on('session.append', { door: 'tool-result' }, async ($, e, next) => {
    if (e.agentId !== undefined || !s.settings.enabled || !s.settings.trim.enabled) return next(e)
    const index = e.message.content.findIndex((block) => block.type === 'tool_result')
    const block = e.message.content[index]
    if (!block) return next(e)
    const id = String(block.tool_use_id ?? '')
    const call = s.lean.calls.get(id)
    const tool = call?.tool ?? (e.origin.kind === 'tool' ? e.origin.tool : '')
    const floor = trimFloor(tool, s.settings.trim)
    if (floor === undefined || block.is_error === true) return next(e)
    const text = resultText(block.content)
    if (text.length <= floor) return next(e)
    // The agent asked again for something already trimmed this turn: give it everything.
    const key = call ? `${tool}:${JSON.stringify(call.input)}` : undefined
    if (key !== undefined && s.lean.trimmedThisTurn.has(key)) return next(e)
    const jev = await currentJev($, s)
    if (jev.kind !== 'ready') return next(e)

    const { lines, blocks } = blocksFor(text, s.settings.trim)
    const state = trimState({ user_request: s.lean.turnText.user, agent_said: s.lean.turnText.assistant, tool, arguments: JSON.stringify(call?.input ?? {}) }, blocks)
    const outcome = await askJev($, jev.target, s.settings.jev.timeoutMs, state, trimQuestions(blocks))
    if (!outcome.ok) {
      $.ui.log(`${tool} output not trimmed: Jev ${outcome.reason}`, { to: 'debug' })
      return next(e)
    }
    const fullPath = await outputPath($, s, id)
    const verdict = trimVerdict(lines, blocks, outcome.answers, s.settings.trim, fullPath)
    if (!verdict.trim) {
      $.ui.log(`${tool} output kept whole (${verdict.totalLines} lines; needs all: ${verdict.needsAll.toFixed(2)}, would keep ${verdict.keptLines}; Jev ${outcome.latencyMs} ms)`, { to: 'debug' })
      return next(e)
    }
    try {
      await $.fs.write(fullPath, text)
    } catch (error) {
      $.ui.log(`${tool} output not trimmed: could not save it to ${fullPath} (${error instanceof Error ? error.message : String(error)})`, { to: 'debug' })
      return next(e)
    }
    if (key !== undefined) s.lean.trimmedThisTurn.add(key)
    s.lean.saved += text.length - verdict.text.length
    $.ui.log(`trimmed ${tool} output to ${verdict.keptLines} of ${verdict.totalLines} lines (Jev, ${outcome.latencyMs} ms); full output: ${fullPath}`)
    const content = e.message.content.map((b, i) => (i === index ? { ...b, content: withResultText(b.content, verdict.text) } : b))
    return next({ ...e, message: { ...e.message, content } })
  }).catch(($, e, next) => (next.called ? undefined : next(e)))

  // Compaction: Jev's own when armed (strict: a Jev failure skips it, so nothing is spent), else
  // Claude Code's summarizer over what Jev did not drop, plus the verbatim items.
  on('session.compact', async ($, e, next) => {
    if (e.agentId !== undefined || e.trigger === 'precompute') return next(e)
    const request = s.lean.armed
    s.lean.armed = undefined
    s.lean.failure = undefined
    s.lean.compactions++
    const jevOnly = request !== undefined
    s.lean.strictInFlight = jevOnly
    s.lean.last = { mode: 'plain' }
    // A Jev problem: an armed compaction is skipped (strict), any other runs as it would have.
    const fail = (reason: string): SessionCompactResult | Promise<SessionCompactResult> => {
      s.lean.failure = reason
      s.lean.strictInFlight = false
      return jevOnly ? { skip: `Jev compaction: ${reason}` } : next(e)
    }
    if (!s.settings.enabled) return fail('cache-guard is off')
    if (!jevOnly && !s.settings.compact.filter) return next(e)
    const jev = await currentJev($, s)
    if (jev.kind !== 'ready') return fail(jev.kind === 'off' ? 'Jev is off' : `Jev is not set up (${jev.reason})`)
    const { units, previousSummary } = extractUnits(e.messages)
    if (!units.length) return fail('nothing for Jev to judge')
    const goal = request?.goal?.trim() || e.instructions?.trim() || lastUserMessages(e.messages, 2)
    const judged = await judgeUnits($, s, jev.target, units, goal)
    if (!judged.ok) return fail(judged.reason)
    const { keep } = judged
    const counts = keepCounts(keep)

    if (jevOnly) {
      const summary = codeSummary({ units, keep, previousSummary, fileOps: fileOps(e.messages), instructions: request?.goal ?? e.instructions })
      s.lean.last = { mode: 'jev', counts, latencyMs: judged.latencyMs }
      s.lean.strictInFlight = false
      return { messages: [{ role: 'user', text: summary, toolUses: [] }] }
    }

    let filtered: SessionMessage[]
    try {
      filtered = filterMessages(e.messages, units, keep) as SessionMessage[]
    } catch (error) {
      return fail(`filtering failed (${error instanceof Error ? error.message : String(error)})`)
    }
    s.lean.last = { mode: 'filtered', counts, latencyMs: judged.latencyMs }
    const result = await next({ ...e, messages: filtered })
    if (result.skip !== undefined) return result
    const verbatim = verbatimSection(units, keep)
    if (!verbatim) return result
    // One more user message after the summary (the summary's own row is the engine's).
    return { ...result, messages: [...result.messages, { role: 'user', text: verbatim, toolUses: [] }] }
  }).catch(($, e, next) => {
    if (next.called) return undefined
    if (!s.lean.strictInFlight) return next(e)
    // Armed and failed before answering: strict, so nothing is spent.
    s.lean.strictInFlight = false
    s.lean.failure = `Jev compaction failed (${next.error.message})`
    return { skip: s.lean.failure }
  })

  on('prompt.submit', async ($, e, next) => {
    if (!s.sessionOn || e.origin.kind !== 'composer' || e.turnId !== undefined) return next(e)
    const text = e.text.trim()
    if (!text || text.startsWith('/')) return next(e)
    const miss = await assess($, s)
    if (!miss) return next(e)
    const jev = await currentJev($, s)
    const ready = jev.kind === 'ready'
    // Keep first, so a reflexive Enter (or Esc) spends nothing; then cheapest to dearest. The dialog
    // takes four options, so with Jev the two compactions are the next question's.
    const compactCost = `${s.settings.compact.filter && ready ? 'up to ' : ''}~${formatCost(miss.costs.compact)}`
    const labels = {
      keep: KEEP,
      fresh: `${FRESH} (~$0)`,
      compact: ready ? `${COMPACT} (~$0 with Jev)` : `${COMPACT} (~${formatCost(miss.costs.compact)})`,
      send: `${SEND} (~${formatCost(miss.costs.send)})`,
    }
    const tip = jev.kind === 'missing' ? `\n${JEV_TIP}` : ''
    let answer: string | undefined
    try {
      answer = await $.ui.ask(`Prompt cache miss. ${miss.line} What now?${tip}`, { header: 'Cache', options: [labels.keep, labels.fresh, labels.compact, labels.send] })
    } catch {
      answer = undefined // dismissed: keep it
    }
    if (answer === labels.send) return next(e)
    if (answer === labels.fresh) {
      $.clock.after(0, () => {
        void startFresh($, s, e.text)
      })
      return { drop: 'Starting a new conversation with your prompt.' }
    }
    if (answer === labels.compact) {
      const jevLabel = `${COMPACT_JEV} (~1s, ~$0)`
      const plainLabel = ready ? `${SUMMARY_JEV_DEFAULT} (${compactCost})` : SUMMARY_DEFAULT
      const focusLabel = ready ? `${SUMMARY_JEV_FOCUS} (${compactCost})` : SUMMARY_FOCUS
      const choices = ready ? [jevLabel, plainLabel, focusLabel] : [plainLabel, focusLabel]
      const question = ready
        ? 'Compact how? Jev judges the history against your prompt and writes the summary in code, in about a second. (Type your own guidance for a summary under Other.)'
        : 'What should the summary keep? (Type your own guidance under Other.)'
      let how: string | undefined
      try {
        how = await $.ui.ask(question, { header: 'Compact', options: choices })
      } catch {
        how = undefined
      }
      if (how === jevLabel) {
        $.clock.after(0, () => {
          void compactWithJevThenSend($, s, e.text)
        })
        return { drop: 'Compacting with Jev, then sending your prompt.' }
      }
      if (how !== undefined) {
        const instructions = how === plainLabel ? undefined : how === focusLabel ? compactionFocus(e.text) : how
        $.clock.after(0, () => {
          void compactThenSend($, s, e.text, instructions)
        })
        return { drop: 'Compacting, then sending your prompt.' }
      }
    }
    await $.prompt.fill({ text: e.text })
    return { drop: `Kept in the prompt box. ${miss.line} /cache-guard off stops asking in this session.` }
  })

  on('command.run', { command: COMMAND }, async ($, e) => {
    const arg = e.args.trim()
    const word = arg.split(/\s+/u)[0] ?? ''
    if (word === 'jev') return { text: await jevCommand($, s) }
    if (word === 'compact') return { text: await compactCommand($, s, arg.slice(word.length).trim()) }
    if (arg === 'on' || arg === 'off') {
      s.sessionOn = arg === 'on'
      if (s.sessionOn) await schedule($, s)
      else {
        cancel(s, 'turned off for this session')
        await syncHerdr($, s)
      }
      return { text: `cache-guard ${arg} for this session` }
    }
    if (arg === 'warm') {
      // A refresh now, whatever the schedule and the expected saving say (to bridge a break, or to check one works).
      if (!s.clock) return { text: 'Nothing to keep warm yet.' }
      await refresh($, s, true)
      return { text: await status($, s) }
    }
    s.settings = await loadSettings($)
    return { text: await status($, s) }
  })
}

/** The shared settings files merged over the defaults; a missing file is skipped. */
async function loadSettings($: EngineInterface): Promise<Settings> {
  const home = (await $.env.get('HOME')) ?? ''
  const xdg = await $.env.get('XDG_CONFIG_HOME')
  const root = await $.session.root()
  const texts: (string | undefined)[] = []
  for (const file of settingsFiles(home, xdg, root)) {
    texts.push(await $.fs.read(file).catch(() => undefined))
  }
  return mergeSettings(DEFAULT_SETTINGS, texts)
}

/** `~/.claude/cache-guard.json`: the Claude Code user file, which `/cache-guard jev` writes. */
async function userSettingsFile($: EngineInterface): Promise<string> {
  const home = (await $.env.get('HOME')) ?? ''
  return `${home}/.claude/${NAME}.json`
}

/**
 * Merges `patch` into the user settings file (objects merge, other values replace). Refuses, with
 * the reason, when the file exists but is not a JSON object, rather than overwrite it.
 */
async function saveUserSettings($: EngineInterface, patch: Record<string, unknown>): Promise<string | undefined> {
  const file = await userSettingsFile($)
  let current: Record<string, unknown> = {}
  const text = await $.fs.read(file).catch(() => undefined)
  if (text !== undefined && text.trim()) {
    let value: unknown
    try {
      value = JSON.parse(text)
    } catch {
      return `${file} is not valid JSON; fix it by hand`
    }
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return `${file} is not a JSON object; fix it by hand`
    current = value as Record<string, unknown>
  }
  try {
    await $.fs.write(file, `${JSON.stringify(mergeObjects(current, patch), null, 2)}\n`)
  } catch (error) {
    return `could not write ${file} (${error instanceof Error ? error.message : String(error)})`
  }
  return undefined
}

function mergeObjects(base: Record<string, unknown>, over: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...base }
  for (const [key, value] of Object.entries(over)) {
    const current = out[key]
    out[key] = isRecord(current) && isRecord(value) ? mergeObjects(current, value) : value
  }
  return out
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

// ---------------------------------------------------------------------------------------------
// Jev

/** Resolves which Jev to use from the settings and the key found; the state is kept on `s`. */
async function refreshJev($: EngineInterface, s: State): Promise<JevState> {
  s.lean.jevKey = JSON.stringify([s.settings.enabled, s.settings.jev])
  s.lean.jev = resolveJev(s.settings, s.options.typesafe_api_key, await $.env.get('TYPESAFE_API_KEY'))
  return s.lean.jev
}

/** Jev as last resolved, resolved again when the settings changed since. */
async function currentJev($: EngineInterface, s: State): Promise<JevState> {
  if (s.lean.jevKey !== JSON.stringify([s.settings.enabled, s.settings.jev])) await refreshJev($, s)
  return s.lean.jev
}

type JevOutcome =
  | { ok: true; answers: Record<string, Answer>; latencyMs: number; inputTokens?: number }
  | { ok: false; reason: string }

/** One Jev request over TypeSafe's API. Never throws: every failure is `{ ok: false, reason }`. */
async function askJev($: EngineInterface, target: JevTarget, timeoutMs: number, state: Record<string, unknown>, questions: Record<string, Question>): Promise<JevOutcome> {
  const started = await $.clock.now()
  let timer: { cancel: () => void } | undefined
  const timeout = new Promise<string>((resolve) => {
    timer = $.clock.after(timeoutMs, () => resolve('timed out'))
  })
  const request = $.http
    .fetch(ENDPOINT, {
      method: 'POST',
      headers: { authorization: `Bearer ${target.apiKey}`, 'content-type': 'application/json' },
      body: requestBody(target.model, state, questions),
    })
    .then(
      (response) => response,
      (error: unknown) => describeFailure(undefined, error instanceof Error ? error.message : String(error)),
    )
  const response = await Promise.race([request, timeout])
  timer?.cancel()
  if (typeof response === 'string') return { ok: false, reason: response }
  if (!response.ok) return { ok: false, reason: describeFailure(response.status) }
  const reply = readReply(response.text)
  if (!reply) return { ok: false, reason: 'unreadable response' }
  return { ok: true, answers: reply.answers, latencyMs: (await $.clock.now()) - started, ...(reply.inputTokens !== undefined ? { inputTokens: reply.inputTokens } : {}) }
}

/** Jev's verdict on every unit, in batches, `compact.concurrency` requests at a time. */
async function judgeUnits($: EngineInterface, s: State, target: JevTarget, units: Unit[], goal: string): Promise<{ ok: true; keep: Map<string, Keep>; latencyMs: number } | { ok: false; reason: string }> {
  const started = await $.clock.now()
  const keep = new Map<string, Keep>()
  const queue = batches(units)
  let reason: string | undefined
  const worker = async () => {
    for (let batch = queue.shift(); batch && !reason; batch = queue.shift()) {
      const outcome = await askJev($, target, s.settings.compact.timeoutMs, keepState(goal, batch), keepQuestions(batch))
      if (!outcome.ok) {
        reason = outcome.reason
        return
      }
      keepAnswers(batch, outcome.answers, keep)
    }
  }
  await Promise.all(Array.from({ length: Math.max(1, Math.floor(s.settings.compact.concurrency)) }, worker))
  if (reason) return { ok: false, reason: `Jev failed (${reason})` }
  return { ok: true, keep, latencyMs: (await $.clock.now()) - started }
}

/** Where a trimmed tool result's full output is saved. */
async function outputPath($: EngineInterface, s: State, toolUseId: string): Promise<string> {
  const home = (await $.env.get('HOME')) ?? ''
  const configDir = (await $.env.get('CLAUDE_CONFIG_DIR')) || `${home}/.claude`
  const session = (await $.session.id().catch(() => 'session')) || 'session'
  const safe = (text: string) => text.replace(/[^\w.-]/gu, '_')
  return `${configDir}/${NAME}/tool-output/${safe(session)}/${safe(toolUseId)}.txt`
}

/** The Jev line of /cache-guard status. */
function jevLine(s: State): string {
  const jev = s.lean.jev
  if (jev.kind === 'off') return 'Jev: off (/cache-guard jev turns it on).'
  if (jev.kind === 'missing') return `Jev: not set up (${jev.reason}); /cache-guard jev.`
  const saved = s.lean.saved > 0 ? ` (−${Math.round(s.lean.saved / 4_000)}k tokens so far)` : ''
  const trim = s.settings.trim.enabled ? `trimming on${saved}` : 'trimming off'
  const compaction = `Jev compaction from the cold-cache menu and /cache-guard compact${s.settings.compact.filter ? '; it filters /compact too' : ''}`
  return `Jev: ${label(jev.target)} (key from ${jev.target.keySource}); ${trim}; ${compaction}.`
}

/** How to set Jev up, for /cache-guard jev and the tip. */
function jevSetupText(): string {
  return [
    JEV_PITCH,
    `It needs a TypeSafe API key from ${JEV_KEY_URL}. Either set the plugin option (kept in secure storage, not settings.json):`,
    `  /plugin configure ${NAME}@inline  (${NAME}@<marketplace> when installed from one), or in a shell`,
    `  echo '{"typesafe_api_key": "<key>"}' | claude plugin configure ${NAME}@inline --values-stdin`,
    'then restart Claude Code; or export TYPESAFE_API_KEY before starting it. /cache-guard jev checks it.',
  ].join('\n')
}

/** `/cache-guard jev`: whether Jev is set up and answers; or how to set it up; on or off. */
async function jevCommand($: EngineInterface, s: State): Promise<string> {
  s.settings = await loadSettings($)
  if (!s.settings.enabled) return 'cache-guard is off in its settings ("enabled": false), Jev included.'
  const ask = async (question: string, options: string[]): Promise<string | undefined> => {
    try {
      return await $.ui.ask(question, { header: 'Jev', options })
    } catch {
      return undefined
    }
  }
  const turnOff = async (): Promise<string> => {
    const problem = await saveUserSettings($, { jev: { enabled: false } })
    if (problem) return `Could not save the setting: ${problem}`
    s.settings = await loadSettings($)
    await refreshJev($, s)
    return 'Jev is off: no trimming, no Jev compaction, no tips. /cache-guard jev turns it back on.'
  }
  if (!s.settings.jev.enabled) {
    const pick = await ask(`Jev is off: no trimming, no Jev compaction, no tips. Turn it on?\n${JEV_PITCH}`, [JEV_ON, JEV_LEAVE_OFF])
    if (pick !== JEV_ON) return 'Jev stays off.'
    const problem = await saveUserSettings($, { jev: { enabled: true } })
    if (problem) return `Could not save the setting: ${problem}`
    s.settings = await loadSettings($)
  }
  const state = await refreshJev($, s)
  if (state.kind === 'ready') {
    const answer = await askJev($, state.target, 10_000, PROBE.state, PROBE.questions)
    const head = answer.ok
      ? `Jev: ${label(state.target)} (key from ${state.target.keySource}), answered in ${answer.latencyMs} ms.`
      : `Jev: ${label(state.target)} (key from ${state.target.keySource}) did not answer (${answer.reason}).`
    const pick = await ask(`${head} It trims large tool output and compacts in about a second (the cold-cache menu, /cache-guard compact).`, [JEV_DONE, JEV_OFF, JEV_SHOW_SETUP])
    if (pick === JEV_OFF) return turnOff()
    if (pick === JEV_SHOW_SETUP) return `${head}\n${jevSetupText()}`
    return head
  }
  if (state.kind === 'off') return 'Jev is off.'
  const text = `Jev is not set up: ${state.reason}.\n${jevSetupText()}`
  const pick = await ask(`${text}\nWhat now?`, [JEV_DONE, JEV_OFF_TIPS])
  if (pick === JEV_OFF_TIPS) return turnOff()
  return text
}

/** `/cache-guard compact [focus]`: Jev's compaction, written in code; nothing is spent if Jev fails. */
async function compactCommand($: EngineInterface, s: State, focus: string): Promise<string> {
  const jev = await currentJev($, s)
  if (jev.kind !== 'ready') {
    const why = jev.kind === 'off' ? 'Jev is off' : `Jev is not set up (${jev.reason})`
    let pick: string | undefined
    try {
      pick = await $.ui.ask(`${why}. Compact with Claude Code's summary instead?`, { header: 'Compact', options: [COMPACT_SUMMARY, JEV_SETUP] })
    } catch {
      pick = undefined
    }
    if (pick === JEV_SETUP) return jevCommand($, s)
    if (pick !== COMPACT_SUMMARY) return `${why}; nothing compacted.`
    $.clock.after(0, () => {
      void runCompaction($, s, focus || undefined).then((outcome) => {
        $.ui.log(outcome.ok ? 'compacted' : `compaction did not run (${outcome.reason})`)
      })
    })
    return 'Compacting with a summary.'
  }
  $.clock.after(0, () => {
    void runJevCompaction($, s, focus || undefined).then((outcome) => {
      $.ui.log(outcome.ok ? `compacted with Jev in ${(outcome.latencyMs / 1000).toFixed(1)} s (${describeCounts(outcome.counts)})` : `compaction with Jev did not run: ${outcome.reason}`)
    })
  })
  return 'Compacting with Jev.'
}

function describeCounts(counts: Record<Keep, number> | undefined): string {
  if (!counts) return 'no counts'
  return `${counts.verbatim} kept verbatim, ${counts.summarize} noted, ${counts.drop} dropped`
}

type CompactionOutcome = { ok: true; latencyMs: number; counts?: Record<Keep, number> } | { ok: false; reason: string }

/**
 * A Jev compaction of the main conversation: armed, then `/compact` run as the person would, which
 * reaches this plugin's own `session.compact` hook (a plugin's `$.session.compact` skips its own
 * hooks). Strict: if the hook skipped, or never ran, nothing was spent.
 */
async function runJevCompaction($: EngineInterface, s: State, goal: string | undefined): Promise<CompactionOutcome> {
  s.lean.armed = { goal }
  s.lean.failure = undefined
  const started = await $.clock.now()
  try {
    await $.command.run({ command: 'compact' })
  } catch (error) {
    s.lean.armed = undefined
    return { ok: false, reason: s.lean.failure ?? (error instanceof Error ? error.message : String(error)) }
  }
  if (s.lean.armed) {
    s.lean.armed = undefined
    return { ok: false, reason: 'the compaction did not reach cache-guard (another plugin answered session.compact first?)' }
  }
  if (s.lean.failure) return { ok: false, reason: s.lean.failure }
  if (s.lean.last?.mode !== 'jev') return { ok: false, reason: 'the compaction was not Jev\'s' }
  s.clock = undefined
  return { ok: true, latencyMs: (await $.clock.now()) - started, counts: s.lean.last.counts }
}

/**
 * Claude Code's own compaction (with the guidance), run as `/compact` so that this plugin's hook
 * filters it with Jev. It counted as done when the transcript got shorter.
 */
async function runCompaction($: EngineInterface, s: State, instructions: string | undefined): Promise<CompactionOutcome> {
  s.lean.armed = undefined
  const before = await $.session.messages().then((m) => m.length, () => undefined)
  const seen = s.lean.compactions
  const started = await $.clock.now()
  try {
    await $.command.run({ command: 'compact', ...(instructions ? { args: instructions } : {}) })
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) }
  }
  const after = await $.session.messages().then((m) => m.length, () => undefined)
  if (before !== undefined && after !== undefined && after >= before) {
    return { ok: false, reason: s.lean.compactions > seen ? 'the conversation is unchanged (skipped, or too small)' : 'nothing compacted' }
  }
  s.clock = undefined
  return { ok: true, latencyMs: (await $.clock.now()) - started, counts: s.lean.last?.counts }
}

/**
 * Reads the transcript's tail for the TTL the session's cache writes use and, when `seed` (a new or
 * resumed session) or nothing was tracked yet, the last response as the clock.
 */
async function readTranscript($: EngineInterface, s: State, seed: boolean): Promise<void> {
  try {
    const home = (await $.env.get('HOME')) ?? ''
    const configDir = (await $.env.get('CLAUDE_CONFIG_DIR')) || `${home}/.claude`
    const id = await $.session.id()
    // The project directory is the session root with every non-alphanumeric turned into '-', but
    // of the path as Claude Code saw it (/private/tmp, not /tmp): try that, then look the id up.
    const run = await $.process.run(
      ['sh', '-c', TAIL_SCRIPT, 'cache-guard', s.transcript ?? transcriptPath(configDir, await $.session.root(), id), `${configDir}/projects`, `${id}.jsonl`, String(TAIL_BYTES)],
      { timeoutMs: 5_000 },
    )
    if (run.exitCode !== 0) {
      s.ttl = await configuredTtl($, s.ttl)
      return
    }
    const tail = parseTail(run.stdout)
    s.ttl = tail.ttlMs !== undefined ? { ms: tail.ttlMs, source: 'transcript' } : await configuredTtl($, s.ttl)
    if (tail.compacted) {
      s.clock = undefined
      return
    }
    if ((seed || !s.clock) && tail.at !== undefined && tail.tokens !== undefined && tail.promptTokens !== undefined) {
      s.clock = { lastAt: tail.at, lastRealAt: tail.at, promptTokens: tail.promptTokens, tokens: tail.tokens, model: tail.model ?? '' }
    }
  } catch {
    // No transcript (a -p run with --no-session-persistence, a host without tail): keep what we have.
  }
}

/** The TTL Claude Code is configured to request, when the transcript shows no write yet. */
async function configuredTtl($: EngineInterface, current: { ms: number; source: string }): Promise<{ ms: number; source: string }> {
  if (current.source === 'transcript') return current
  if ((await $.env.get('FORCE_PROMPT_CACHING_5M')) === '1') return { ms: FIVE_MINUTES, source: 'FORCE_PROMPT_CACHING_5M' }
  const env = (await $.env.get('CLAUDE_CODE_PROMPT_CACHE_TTL'))?.trim()
  if (env === '5m' || env === '1h') return { ms: env === '1h' ? ONE_HOUR : FIVE_MINUTES, source: 'CLAUDE_CODE_PROMPT_CACHE_TTL' }
  const usage = await $.session.usage().catch(() => undefined)
  // Rate-limit windows are reported to subscribers only; within plan usage the main conversation gets 1h.
  if (usage?.rateLimits.some((r) => r.kind === 'five_hour' || r.kind === 'seven_day')) return { ms: ONE_HOUR, source: 'subscription' }
  if ((await $.env.get('ENABLE_PROMPT_CACHING_1H')) === '1') return { ms: ONE_HOUR, source: 'ENABLE_PROMPT_CACHING_1H' }
  // Before the first response reports rate limits: no API key or cloud provider means a Claude login.
  const keyed = [
    await $.env.get('ANTHROPIC_API_KEY'),
    await $.env.get('ANTHROPIC_AUTH_TOKEN'),
    await $.env.get('CLAUDE_CODE_USE_BEDROCK'),
    await $.env.get('CLAUDE_CODE_USE_VERTEX'),
    await $.env.get('CLAUDE_CODE_USE_FOUNDRY'),
  ].some((value) => !!value)
  return keyed ? { ms: FIVE_MINUTES, source: 'API key or cloud provider' } : { ms: ONE_HOUR, source: 'Claude login' }
}

function cancel(s: State, why: string): void {
  s.timer?.cancel()
  s.timer = undefined
  s.stopped = why
}

/** Arms the next refresh (and the expiry report to herdr) after the cache was used. */
async function schedule($: EngineInterface, s: State): Promise<void> {
  await arm($, s)
  await syncHerdr($, s)
}

/** Arms the next refresh at 90% of the TTL after the last cache use, inside the idle limit. */
async function arm($: EngineInterface, s: State): Promise<void> {
  s.timer?.cancel()
  s.timer = undefined
  const clock = s.clock
  if (!clock) return cancel(s, 'no cached request yet')
  if (!s.interactive) return cancel(s, 'not an interactive session')
  if (!s.sessionOn || !s.settings.enabled || !s.settings.warm.enabled) return cancel(s, 'keep-warm is off')
  const delay = warmDelayMs(s.ttl.ms)
  if (delay === undefined) return cancel(s, 'TTL too short')
  const due = clock.lastAt + delay
  if (due > warmDeadline(clock.lastRealAt, s.ttl.ms, s.settings)) {
    return cancel(s, `idle limit reached (${s.settings.warm.idleMinutes[s.ttl.ms >= ONE_HOUR ? '1h' : '5m']}m after the last request)`)
  }
  const now = await $.clock.now()
  s.stopped = ''
  s.timer = $.clock.after(Math.max(0, due - now), () => {
    void refresh($, s)
  })
}

/** One keep-warm request, when Pi's rule says it pays; reschedules after a hit, stops otherwise. */
async function refresh($: EngineInterface, s: State, forced = false): Promise<void> {
  if (!forced) s.timer = undefined
  const clock = s.clock
  if (!clock || s.stepsInFlight > 0 || s.warming) return
  const now = await $.clock.now()
  // A timer that fired late (sleep, a blocked loop) would pay a full write, not a refresh.
  if (!forced && now >= clock.lastAt + s.ttl.ms - 1_000) return cancel(s, 'missed the refresh window (the cache expired first)')
  const price = claudePrice(clock.model)
  const decision = decideWarm(clock.promptTokens, price, s.ttl.ms, !s.busy, s.settings)
  if (!forced && decision.action === 'stop') {
    return cancel(s, `expected saving ${formatCost(decision.expectedSavings)} is under ${formatCost(s.settings.warm.minSavings)}`)
  }
  s.warming = true
  try {
    const result = await $.model.fork({ prompt: s.settings.warm.prompt })
    const usage = 'usage' in result ? result.usage : undefined
    const read = usage?.cache_read_input_tokens ?? 0
    if (s.clock !== clock) return // a real request went out meanwhile and took over the clock
    const cost = usage
      ? (read * price.cacheRead + (usage.input_tokens + usage.cache_creation_input_tokens * 1.25) * price.input + usage.output_tokens * price.input * 5) / 1e6
      : 0
    if (read >= 0.8 * clock.promptTokens) {
      s.clock = { ...clock, lastAt: now }
      s.warms++
      $.ui.log(`kept the prompt cache warm (${forced ? 'on request, ' : ''}${formatTokens(read)} tokens read, ~${formatCost(cost)} at API prices)`)
      await schedule($, s)
    } else {
      const why = result.isAnswered || result.reason === 'empty-reply'
        ? `the refresh read only ${formatTokens(read)} of ${formatTokens(clock.promptTokens)} tokens from the cache`
        : `the refresh failed (${result.reason})`
      $.ui.log(`stopped keeping the prompt cache warm: ${why}`)
      cancel(s, why)
    }
  } catch (error) {
    cancel(s, `the refresh failed (${error instanceof Error ? error.message : String(error)})`)
  } finally {
    s.warming = false
  }
}

/** Why the next prompt misses the cache and what that costs, when it is worth asking about. */
async function assess($: EngineInterface, s: State): Promise<{ line: string; costs: { send: number; compact: number } } | undefined> {
  if (!s.settings.enabled || !s.settings.warn.enabled) return undefined
  if (!s.clock) await readTranscript($, s, true)
  const clock = s.clock
  if (!clock) return undefined
  const now = await $.clock.now()
  const left = clock.lastAt + s.ttl.ms - now
  if (left > 0) return undefined
  const cost = missCost(clock.tokens, claudePrice(clock.model), s.ttl.ms)
  if (!worthWarning(clock.tokens, cost, s.settings)) return undefined
  return { line: describeMiss({ kind: 'expired', idleMs: -left }, clock.tokens, cost), costs: choiceCosts(clock.tokens, claudePrice(clock.model), s.ttl.ms) }
}

async function status($: EngineInterface, s: State): Promise<string> {
  const now = await $.clock.now()
  const clock = s.clock
  const lines: string[] = []
  if (!clock) {
    lines.push('No cached request in this session yet (or it was just compacted).')
  } else {
    const left = clock.lastAt + s.ttl.ms - now
    lines.push(`Last request: ${clock.model}, ${formatTokens(clock.tokens)} tokens, ${formatDuration(now - clock.lastRealAt)} ago` +
      (clock.lastAt > clock.lastRealAt ? `; kept warm ${s.warms}x, last ${formatDuration(now - clock.lastAt)} ago.` : '.'))
    lines.push(`TTL: ${s.ttl.ms >= ONE_HOUR ? '1h' : '5m'} (${s.ttl.source}). ${left > 0 ? `Warm, ${formatClock(left)} left.` : describeMiss({ kind: 'expired', idleMs: -left }, clock.tokens, missCost(clock.tokens, claudePrice(clock.model), s.ttl.ms))}`)
  }
  const on = s.sessionOn && s.settings.enabled
  lines.push(`Keep-warm: ${on && s.settings.warm.enabled ? (s.timer ? 'next refresh scheduled' : `idle (${s.stopped || 'nothing to keep'})`) : 'off'}.`)
  lines.push(`Warning: ${on && s.settings.warn.enabled ? `on, from ${formatCost(s.settings.warn.minCost)} at API prices` : 'off'}.`)
  await currentJev($, s)
  lines.push(jevLine(s))
  return lines.join('\n')
}

/**
 * herdr's `cache` pane token: "cold 664k" once the cache has expired with a re-cache worth a
 * warning, nothing while it is warm (an expiry timer re-checks then) or small. Inside herdr only.
 */
async function syncHerdr($: EngineInterface, s: State): Promise<void> {
  s.expiry?.cancel()
  s.expiry = undefined
  const clock = s.clock
  let value: string | undefined
  if (clock && s.sessionOn && s.stepsInFlight === 0) {
    const now = await $.clock.now()
    const left = clock.lastAt + s.ttl.ms - now
    if (left > 0) {
      s.expiry = $.clock.after(left + 1_000, () => {
        void syncHerdr($, s)
      })
    } else {
      value = herdrCacheValue({ kind: 'expired', idleMs: -left }, clock.tokens, missCost(clock.tokens, claudePrice(clock.model), s.ttl.ms), s.settings)
    }
  }
  await reportHerdr($, s, value)
}

/** One `herdr pane report-metadata` call when the token changes; any failure is ignored. */
async function reportHerdr($: EngineInterface, s: State, value: string | undefined): Promise<void> {
  if (value === s.herdrLast) return
  if ((await $.env.get('HERDR_ENV')) !== '1') return
  const pane = await $.env.get('HERDR_PANE_ID')
  if (!pane) return
  s.herdrLast = value
  const change = value === undefined ? ['--clear-token', HERDR_TOKEN] : ['--token', `${HERDR_TOKEN}=${value}`, '--ttl-ms', '86400000']
  await $.process.run(['herdr', 'pane', 'report-metadata', pane, '--source', HERDR_SOURCE, '--agent', 'claude', ...change], { timeoutMs: 3_000 }).catch(() => undefined)
}

/** /clear, then the held prompt as the new conversation's first. */
async function startFresh($: EngineInterface, s: State, text: string): Promise<void> {
  try {
    await $.command.run({ command: 'clear' })
    s.clock = undefined
    s.timer?.cancel()
    s.timer = undefined
    await $.prompt.submit({ text, asUser: true })
  } catch (error) {
    $.ui.log(`could not start a new conversation (${error instanceof Error ? error.message : String(error)}); your prompt is back in the box`)
    await $.prompt.fill({ text })
  }
}

/** Compaction (with the chosen guidance), then the held prompt onto the summary. */
async function compactThenSend($: EngineInterface, s: State, text: string, instructions: string | undefined): Promise<void> {
  const outcome = await runCompaction($, s, instructions)
  if (!outcome.ok) {
    $.ui.log(`compaction did not run (${outcome.reason}); your prompt is back in the box`)
    await $.prompt.fill({ text })
    return
  }
  await $.prompt.submit({ text, asUser: true }).catch(async (error: unknown) => {
    $.ui.log(`could not send your prompt (${error instanceof Error ? error.message : String(error)}); it is back in the box`)
    await $.prompt.fill({ text })
  })
}

/** A Jev compaction judged against the held prompt, then the prompt onto the summary; on failure the prompt goes back. */
async function compactWithJevThenSend($: EngineInterface, s: State, text: string): Promise<void> {
  const outcome = await runJevCompaction($, s, text)
  if (!outcome.ok) {
    $.ui.log(`compaction with Jev did not run: ${outcome.reason}; your prompt is back in the box`)
    await $.prompt.fill({ text })
    return
  }
  $.ui.log(`compacted with Jev in ${(outcome.latencyMs / 1000).toFixed(1)} s (${describeCounts(outcome.counts)})`)
  await $.prompt.submit({ text, asUser: true }).catch(async (error: unknown) => {
    $.ui.log(`could not send your prompt (${error instanceof Error ? error.message : String(error)}); it is back in the box`)
    await $.prompt.fill({ text })
  })
}
