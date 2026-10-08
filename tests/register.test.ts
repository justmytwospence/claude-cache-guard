import { expect, mock, test } from 'claude-code/testing'

import { parseTail, transcriptPath } from '../hooks/transcript'

const T0 = Date.parse('2026-10-07T12:00:00Z')
const MIN = 60_000

function row(at: number, usage: Record<string, unknown>, extra: Record<string, unknown> = {}) {
  return JSON.stringify({ type: 'assistant', timestamp: new Date(at).toISOString(), isSidechain: false, message: { model: 'claude-opus-5-5', usage }, ...extra })
}
const usage1h = (read: number, write = 2_000) => ({
  input_tokens: 2, cache_read_input_tokens: read, cache_creation_input_tokens: write, output_tokens: 500,
  cache_creation: { ephemeral_1h_input_tokens: write, ephemeral_5m_input_tokens: 0 },
})

interface World {
  asks: string[]
  answers: (string | undefined)[]
  filled: string[]
  logs: string[]
  forks: number
  forkRead: number
  transcript: string
  subscriber: boolean
  herdr: string[]
  menus: string[][]
  submitted: string[]
  commands: string[]
  compactions: (string | undefined)[]
}

function stubs(on: any, world: World, env: Record<string, string> = { HOME: '/home/u' }) {
  const clock = mock.clock(on, { now: T0 })
  mock.env(on, env)
  on('session.root', () => ({ value: '/work' }))
  on('session.id', () => ({ value: 'sid' }))
  on('fs.read', () => ({ deny: 'ENOENT' }))
  on('command.register', () => ({ value: undefined }))
  on('ui.log', ($: any, e: any) => { world.logs.push(e.text); return { value: undefined } })
  on('process.run', ($: any, e: any) => {
    if (e.argv[0] === 'herdr') {
      world.herdr.push(e.argv.slice(4).join(' '))
      return { value: { exitCode: 0, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
    }
    expect(e.argv.slice(4)).toEqual(['/home/u/.claude/projects/-work/sid.jsonl', '/home/u/.claude/projects', 'sid.jsonl', '400000'])
    return { value: { exitCode: world.transcript ? 0 : 1, stdout: world.transcript, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('session.usage', () => ({
    value: { startedAt: 0, context: { tokens: 0, window: 1_000_000, percent: 0 }, rateLimits: world.subscriber ? [{ kind: 'five_hour', percentUsed: 5 }] : [] },
  }))
  on('model.fork', () => {
    world.forks++
    return { value: { isAnswered: true, text: 'ok', usage: { input_tokens: 30, output_tokens: 3, cache_read_input_tokens: world.forkRead, cache_creation_input_tokens: 0 } } }
  })
  // $.ui.ask is a tool.call of AskUserQuestion beneath the plugins.
  on('tool.call', { tool: 'AskUserQuestion' }, ($: any, e: any) => {
    const questions = e.questions ?? e.input?.questions
    world.asks.push(questions[0].question)
    world.menus.push(questions[0].options.map((o: any) => o.label))
    const answer = world.answers.shift()
    const label = questions[0].options.find((o: any) => o.label.startsWith(answer ?? '\u0000'))?.label ?? answer
    return answer === undefined
      ? { deny: 'dismissed' }
      : { result: { questions, answers: { [questions[0].question]: label } } }
  })
  on('prompt.fill', ($: any, e: any) => { world.filled.push(e.text); return { isFilled: true } })
  on('prompt.submit', ($: any, e: any) => {
    if (e.origin?.kind === 'plugin') world.submitted.push(e.text)
    return { text: e.text }
  })
  on('command.run', { command: 'clear' }, ($: any, e: any) => {
    world.commands.push(e.command)
    return { text: '' }
  })
  on('session.compact', ($: any, e: any) => {
    world.compactions.push(e.instructions)
    return { messages: [] }
  })
  on('turn.start', ($: any, e: any) => ({ turnId: e.turnId }))
  on('turn.complete', ($: any, e: any) => ({ text: e.answer }))
  on('session.start', ($: any, e: any) => ({ cwd: e.cwd }))
  return clock
}

function world(partial: Partial<World> = {}): World {
  return { asks: [], answers: [], filled: [], logs: [], forks: 0, forkRead: 0, transcript: '', subscriber: true, herdr: [], menus: [], submitted: [], commands: [], compactions: [], ...partial }
}

/** One main-loop turn whose single request reads `read` cached tokens. */
async function turn($: any, on: any, read: number, turnId = 't') {
  await $.turn.start({ text: 'go', turnId })
  const stream = $.turn.step({ turnId, index: 0, model: 'claude-opus-5-5', messageCount: 3 })
  let next = await stream.next()
  while (next.done !== true) next = await stream.next()
  await $.turn.complete({ turnId, reason: 'answer', answer: 'ok', durationMs: 1000, isAborted: false })
}

function stepUsage(on: any, read: number) {
  on('turn.step', async function* ($: any, e: any) {
    return {
      turnId: e.turnId, index: e.index, answer: 'ok', toolUses: [], stopReason: 'end_turn',
      usage: { model: 'claude-opus-5-5', input_tokens: 2, cache_read_input_tokens: read, cache_creation_input_tokens: 1_000, output_tokens: 400 },
    }
  })
}

test('transcript tail: last main response, its TTL tier, and compaction', () => {
  const text = [
    'cut line}',
    row(T0 - 10 * MIN, usage1h(500_000)),
    row(T0 - 5 * MIN, { input_tokens: 1, cache_read_input_tokens: 600_000, cache_creation_input_tokens: 0, output_tokens: 10 }),
    row(T0 - 4 * MIN, usage1h(9), { isSidechain: true }),
    row(T0 - 3 * MIN, { input_tokens: 0, output_tokens: 0 }, { message: { model: '<synthetic>', usage: {} } }),
  ].join('\n')
  const tail = parseTail(text)
  expect(tail.at).toBe(T0 - 5 * MIN)
  expect(tail.tokens).toBe(600_011)
  expect(tail.ttlMs).toBe(3_600_000)
  expect(parseTail(`${text}\n{"type":"system","subtype":"compact_boundary"}`).compacted).toBe(true)
  expect(transcriptPath('/h/.claude', '/Users/me/my.repo', 'abc')).toBe('/h/.claude/projects/-Users-me-my-repo/abc.jsonl')
})

test('keeps a 1h cache warm with fork refreshes, then stops at the idle limit', async ($, on) => {
  const w = world({ transcript: row(T0, usage1h(600_000)), forkRead: 600_000 })
  const clock = stubs(on, w)
  stepUsage(on, 600_000)
  await $.session.start({ cwd: '/work', surface: 'terminal', isInteractive: true })
  await turn($, on, 600_000)
  await clock.advance(53 * MIN)
  expect(w.forks).toBe(0)
  await clock.advance(2 * MIN) // 54 min: first refresh
  expect(w.forks).toBe(1)
  expect(w.logs[0]).toMatch(/^kept the prompt cache warm \(600k tokens read/)
  await clock.advance(54 * MIN) // 108 min: second, inside the 2h limit
  expect(w.forks).toBe(2)
  await clock.advance(120 * MIN) // the third would be at 162 min, past 120: none
  expect(w.forks).toBe(2)
  const status = await $.command.run({ command: 'cache-guard', args: '' } as any)
  expect(status.text).toMatch(/TTL: 1h \(transcript\)/)
  expect(status.text).toMatch(/idle limit reached/)
})

test('a refresh that misses the cache stops keeping it warm', async ($, on) => {
  const w = world({ transcript: row(T0, usage1h(600_000)), forkRead: 1_000 })
  const clock = stubs(on, w)
  stepUsage(on, 600_000)
  await $.session.start({ cwd: '/work', surface: 'terminal', isInteractive: true })
  await turn($, on, 600_000)
  await clock.advance(55 * MIN)
  await clock.advance(60 * MIN)
  expect(w.forks).toBe(1)
  expect(w.logs[0]).toMatch(/stopped keeping the prompt cache warm: the refresh read only 1k of 601k/)
})

test('small contexts are not worth a refresh', async ($, on) => {
  const w = world({ transcript: row(T0, usage1h(20_000)), forkRead: 20_000 })
  const clock = stubs(on, w)
  stepUsage(on, 20_000)
  await $.session.start({ cwd: '/work', surface: 'terminal', isInteractive: true })
  await turn($, on, 20_000)
  await clock.advance(60 * MIN)
  expect(w.forks).toBe(0)
})

test('asks before a prompt onto an expired cache, and keeps it on dismissal', async ($, on) => {
  const w = world({ transcript: row(T0, usage1h(600_000)), answers: [undefined, 'Send anyway'] })
  const clock = stubs(on, w)
  stepUsage(on, 600_000)
  await $.session.start({ cwd: '/work', surface: 'terminal', isInteractive: false }) // no keep-warm
  await turn($, on, 600_000)
  await clock.advance(30 * MIN)
  const warm = await $.prompt.submit({ text: 'next', wait: false, origin: { kind: 'composer' } })
  expect(warm.text).toBe('next')
  expect(w.asks).toEqual([])
  await clock.advance(40 * MIN)
  const kept = await $.prompt.submit({ text: 'next', wait: false, origin: { kind: 'composer' } })
  expect(kept.drop).toMatch(/^Kept in the prompt box\. The prompt cache expired 10m ago: this prompt re-caches 601k tokens \(~\$4\.69/)
  expect(w.filled).toEqual(['next'])
  const sent = await $.prompt.submit({ text: 'next', wait: false, origin: { kind: 'composer' } })
  expect(sent.text).toBe('next')
  // Not the user's own Enter, or a command: never held.
  const scheduled = await $.prompt.submit({ text: 'loop', wait: false, origin: { kind: 'scheduled-trigger' } })
  expect(scheduled.text).toBe('loop')
  expect(w.asks.length).toBe(2)
})

test('a resumed session is judged from its transcript', async ($, on) => {
  const w = world({ transcript: row(T0 - 3 * 3_600_000, usage1h(600_000)), answers: ['Keep the prompt'] })
  stubs(on, w)
  await $.session.start({ cwd: '/work', surface: 'terminal', isInteractive: true })
  const kept = await $.prompt.submit({ text: 'where were we', wait: false, origin: { kind: 'composer' } })
  expect(kept.drop).toMatch(/expired 2h ago/)
})

test('/cache-guard off stops warming and asking', async ($, on) => {
  const w = world({ transcript: row(T0, usage1h(600_000)), forkRead: 600_000 })
  const clock = stubs(on, w)
  stepUsage(on, 600_000)
  await $.session.start({ cwd: '/work', surface: 'terminal', isInteractive: true })
  await turn($, on, 600_000)
  expect((await $.command.run({ command: 'cache-guard', args: 'off' } as any)).text).toBe('cache-guard off for this session')
  await clock.advance(3 * 3_600_000)
  expect(w.forks).toBe(0)
  const sent = await $.prompt.submit({ text: 'hi', wait: false, origin: { kind: 'composer' } })
  expect(sent.text).toBe('hi')
})

test('a forked session, whose transcript is not written yet, is judged from the SessionStart hook input', async ($, on) => {
  const w = world({ transcript: '', subscriber: false, answers: [undefined] })
  stubs(on, w)
  on('classic.SessionStart', ($: any, e: any) => ({}))
  await $.session.start({ cwd: '/work', surface: 'terminal', isInteractive: true })
  await ($ as any).classic.SessionStart({
    hook_event_name: 'SessionStart', session_id: 'sid', transcript_path: '/home/u/.claude/projects/-work/sid.jsonl', cwd: '/work',
    source: 'resume', model: 'claude-opus-5-5', seconds_since_last_response: 7_200, context_tokens: 300_000, prompt_cache_likely_expired: true,
  })
  const kept = await $.prompt.submit({ text: 'continue', wait: false, origin: { kind: 'composer' } })
  // No API key in the environment: a Claude login, whose writes are 1h (2x input).
  expect(kept.drop).toMatch(/expired 1h ago: this prompt re-caches 300k tokens \(~\$2\.34/)
})

test('inside herdr, the cache token shows a doomed session and clears when it is warm again', async ($, on) => {
  const w = world({ transcript: row(T0, usage1h(600_000)), forkRead: 600_000 })
  const clock = stubs(on, w, { HOME: '/home/u', HERDR_ENV: '1', HERDR_PANE_ID: 'w1:p1' })
  stepUsage(on, 600_000)
  await $.session.start({ cwd: '/work', surface: 'terminal', isInteractive: false })
  expect(w.herdr).toEqual(['--source cache-guard --agent claude --clear-token cache']) // warm: clear any stale token
  await turn($, on, 600_000)
  await clock.advance(59 * MIN)
  expect(w.herdr.length).toBe(1)
  await clock.advance(2 * MIN + 1_000)
  expect(w.herdr.at(-1)).toBe('--source cache-guard --agent claude --token cache=cold 601k --ttl-ms 86400000')
  await turn($, on, 600_000, 't2')
  expect(w.herdr.at(-1)).toBe('--source cache-guard --agent claude --clear-token cache')
  expect(w.herdr.length).toBe(3)
})

test('the menu offers a new conversation, compaction and sending, priced', async ($, on) => {
  const w = world({ transcript: row(T0 - 2 * 3_600_000, usage1h(600_000)), answers: [undefined] })
  stubs(on, w)
  await $.session.start({ cwd: '/work', surface: 'terminal', isInteractive: false })
  await $.prompt.submit({ text: 'x', wait: false, origin: { kind: 'composer' } })
  expect(w.menus[0]).toEqual(['Keep the prompt', 'New conversation (~$0)', 'Compact first (~$2.41)', 'Send anyway (~$4.82)'])
})

test('new conversation: /clear, then the prompt as its first', async ($, on) => {
  const w = world({ transcript: row(T0 - 2 * 3_600_000, usage1h(600_000)), answers: ['New conversation'] })
  const clock = stubs(on, w)
  await $.session.start({ cwd: '/work', surface: 'terminal', isInteractive: false })
  const held = await $.prompt.submit({ text: 'fresh start', wait: false, origin: { kind: 'composer' } })
  expect(held.drop).toBe('Starting a new conversation with your prompt.')
  await clock.settle()
  expect(w.commands).toEqual(['clear'])
  expect(w.submitted).toEqual(['fresh start'])
})

test('compact asks what the summary keeps; a failed compaction puts the prompt back', async ($, on) => {
  // The test kit cannot run a compaction (no engine fills the messages), so this covers the
  // failure path; compaction itself is checked live.
  const w = world({ transcript: row(T0 - 2 * 3_600_000, usage1h(600_000)), answers: ['Compact first', 'Focus'] })
  const clock = stubs(on, w)
  await $.session.start({ cwd: '/work', surface: 'terminal', isInteractive: false })
  const held = await $.prompt.submit({ text: 'fix the parser', wait: false, origin: { kind: 'composer' } })
  expect(held.drop).toBe('Compacting, then sending your prompt.')
  expect(w.menus[1]).toEqual(['Default summary', 'Focus on this prompt'])
  await clock.settle()
  expect(w.submitted).toEqual([])
  expect(w.filled).toEqual(['fix the parser'])
  expect(w.logs.at(-1)).toMatch(/your prompt is back in the box/)
})
