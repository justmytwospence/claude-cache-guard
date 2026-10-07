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
// The status line shows the cache itself (Claude Code's prompt_cache input), so this mod draws none.
//
// The host reads on(...) and $.noun.method(...) from source, so calls are spelled in full and
// helpers that take $ are top-level functions in this file.
import type { EngineInterface, On } from 'claude-code'

import {
  DEFAULT_SETTINGS,
  NAME,
  ONE_HOUR,
  FIVE_MINUTES,
  type Settings,
  claudePrice,
  decideWarm,
  describeMiss,
  formatClock,
  formatCost,
  formatDuration,
  formatTokens,
  mergeSettings,
  missCost,
  warmDeadline,
  warmDelayMs,
  worthWarning,
} from './core'
import { settingsFiles } from './settings'
import { parseTail, transcriptPath } from './transcript'

const COMMAND = NAME
const KEEP = 'Keep the prompt'
const SEND = 'Send anyway'
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
}

export function register(on: On): void {
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
  }

  on('session.start', async ($, e, next) => {
    const result = await next(e)
    s.interactive = e.isInteractive
    s.settings = await loadSettings($)
    await $.command.register({
      name: COMMAND,
      description: 'cache-guard: prompt cache status, warm (refresh now), on, or off (this session)',
      argumentHint: '[status|warm|on|off]',
      immediate: true,
    })
    // A resumed session: its last response and TTL come from the transcript.
    await readTranscript($, s, true)
    return result
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
    return result
  })

  on('turn.start', async ($, e, next) => {
    s.busy = true
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
      return result
    } finally {
      s.stepsInFlight--
      // A long tool run between steps can outlast a 5-minute TTL: keep warming then too.
      if (s.stepsInFlight === 0) await schedule($, s)
    }
  })

  on('prompt.submit', async ($, e, next) => {
    if (!s.sessionOn || e.origin.kind !== 'composer' || e.turnId !== undefined) return next(e)
    const text = e.text.trim()
    if (!text || text.startsWith('/')) return next(e)
    const miss = await assess($, s)
    if (!miss) return next(e)
    let answer: string | undefined
    try {
      answer = await $.ui.ask(`Prompt cache miss. ${miss.line} Send it anyway?`, { options: [KEEP, SEND], header: 'Cache' })
    } catch {
      answer = undefined // dismissed: keep it
    }
    if (answer === SEND) return next(e)
    await $.prompt.fill({ text: e.text })
    return { drop: `Kept in the prompt box. ${miss.line} /compact or /clear first is cheaper.` }
  })

  on('command.run', { command: COMMAND }, async ($, e) => {
    const arg = e.args.trim()
    if (arg === 'on' || arg === 'off') {
      s.sessionOn = arg === 'on'
      if (s.sessionOn) await schedule($, s)
      else cancel(s, 'turned off for this session')
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

/** Arms the next refresh at 90% of the TTL after the last cache use, inside the idle limit. */
async function schedule($: EngineInterface, s: State): Promise<void> {
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
async function assess($: EngineInterface, s: State): Promise<{ line: string } | undefined> {
  if (!s.settings.enabled || !s.settings.warn.enabled) return undefined
  if (!s.clock) await readTranscript($, s, true)
  const clock = s.clock
  if (!clock) return undefined
  const now = await $.clock.now()
  const left = clock.lastAt + s.ttl.ms - now
  if (left > 0) return undefined
  const cost = missCost(clock.tokens, claudePrice(clock.model), s.ttl.ms)
  if (!worthWarning(clock.tokens, cost, s.settings)) return undefined
  return { line: describeMiss({ kind: 'expired', idleMs: -left }, clock.tokens, cost) }
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
  return lines.join('\n')
}
