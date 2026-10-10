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
  /** Files `$.fs.read` finds, and what `$.fs.write` wrote. */
  files: Record<string, string>
  /** Every Jev request body, parsed. */
  fetches: any[]
  /** How the Jev stub answers: a reply body, or a status for a failure; `null` never answers (a timeout). */
  jev: (body: any) => { status?: number; text?: string } | null
  /** The transcript `$.session.messages()` and a driven compaction carry. */
  messages: any[]
  /** A `/compact` run by the plugin, held until the test drives the compaction and resolves it. */
  pendingCompact?: { args: string | undefined; resolve: (text: string) => void }
  /** What the bottom `session.compact` saw, and the summary it answers. */
  compacted: any[]
}

/** Jev answers from the questions alone: a block is needed when it mentions a failure; a unit is kept as its text says. */
function jevAnswers(body: any): Record<string, unknown> {
  const answers: Record<string, unknown> = {}
  for (const [id, q] of Object.entries<any>(body.questions)) {
    if (q.type === 'noul') {
      const block = id.startsWith('block::') ? String(body.state.output[id.slice(7)]) : ''
      answers[id] = { type: 'noul', noul: id === 'needs_all' ? 0.1 : /FAIL|error/.test(block) ? 0.9 : 0.1 }
    } else if (q.type === 'choice') {
      const unit = body.state.units[id.slice(6)]
      const text = JSON.stringify(unit)
      const choice = /drop me/.test(text) ? 'drop' : /keep me/.test(text) ? 'verbatim' : 'summarize'
      answers[id] = { type: 'choice', choice, probabilities: { [choice]: 0.9 }, confidence: 0.9 }
    }
  }
  return answers
}

function stubs(on: any, world: World, env: Record<string, string> = { HOME: '/home/u' }) {
  const clock = mock.clock(on, { now: T0 })
  mock.env(on, env)
  on('session.root', () => ({ value: '/work' }))
  on('session.id', () => ({ value: 'sid' }))
  on('fs.read', ($: any, e: any) => (e.path in world.files ? { value: world.files[e.path] } : { deny: 'ENOENT' }))
  on('fs.write', ($: any, e: any) => { world.files[e.path] = e.text; return { value: undefined } })
  on('http.fetch', ($: any, e: any) => {
    expect(e.url).toBe('https://api.typesafe.ai/v1/systemone')
    expect(e.init.headers.authorization).toMatch(/^Bearer /)
    const body = JSON.parse(e.init.body)
    world.fetches.push(body)
    const reply = world.jev(body)
    if (reply === null) return new Promise(() => {})
    if (reply.status !== undefined && reply.status >= 400) return { value: { status: reply.status, ok: false, headers: {}, text: '' } }
    return { value: { status: 200, ok: true, headers: {}, text: reply.text ?? JSON.stringify({ model: body.model, answers: jevAnswers(body), usage: { input_tokens: 10 } }) } }
  })
  on('session.messages', () => ({ value: world.messages }))
  on('session.append', ($: any, e: any, next: any) => next(e))
  on('session.compact', ($: any, e: any) => {
    world.compacted.push(e)
    return { messages: [{ role: 'user', text: `SUMMARY of ${e.messages.length} (${e.instructions ?? 'no guidance'})`, toolUses: [], handle: 'hs' }], tokensBefore: 1000, tokensAfter: 100 }
  })
  on('command.run', { command: 'compact' }, ($: any, e: any) => new Promise((resolve) => {
    world.commands.push('compact')
    world.pendingCompact = { args: e.args, resolve: (text) => resolve({ text }) }
  }))
  on('tool.call', { tool: 'Bash' }, () => ({ result: { stdout: '', stderr: '', interrupted: false } }))
  on('tool.call', { tool: 'Edit' }, () => ({ result: {} }))
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
  on('turn.start', ($: any, e: any) => ({ turnId: e.turnId }))
  on('turn.complete', ($: any, e: any) => ({ text: e.answer }))
  on('session.start', ($: any, e: any) => ({ cwd: e.cwd }))
  return clock
}

function world(partial: Partial<World> = {}): World {
  return {
    asks: [], answers: [], filled: [], logs: [], forks: 0, forkRead: 0, transcript: '', subscriber: true, herdr: [], menus: [], submitted: [], commands: [], compactions: [],
    files: {}, fetches: [], jev: () => ({}), messages: [], compacted: [],
    ...partial,
  }
}

const JEV_ENV = { HOME: '/home/u', TYPESAFE_API_KEY: 'tsk-test' }

/** A tool result row as the engine appends it. */
function toolResultRow(id: string, tool: string, content: unknown, extra: Record<string, unknown> = {}) {
  return {
    message: { type: 'user', role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content, ...extra }] },
    door: 'tool-result',
    origin: { kind: 'tool', tool },
    uuid: `u-${id}`,
  }
}

/** A build log: 400 lines, one failure in the middle. */
function buildLog(): string {
  const lines: string[] = []
  for (let i = 1; i <= 400; i++) lines.push(i === 213 ? 'FAIL src/parser.test.ts > skips blank lines: expected 2, got 3' : `PASS case ${i}: ok (${i} ms) ....................................`)
  return lines.join('\n')
}

/** A conversation to compact: a request, exploration to drop, a decision to keep, the latest request. */
function history(): any[] {
  return [
    { role: 'user', text: 'Fix the parser.', toolUses: [], handle: 'h1' },
    { role: 'assistant', text: 'Looking around (drop me).', toolUses: [{ tool_use_id: 'c1', tool: 'Grep', input: { pattern: 'parse' }, text: 'a.ts:1: parse() (drop me)' }], handle: 'h2' },
    { role: 'user', text: '', toolUses: [], toolResults: [{ tool_use_id: 'c1', text: 'a.ts:1: parse() (drop me)', isError: false }], handle: 'h3' },
    { role: 'assistant', text: 'Decision: blank lines are skipped before parsing (keep me).', toolUses: [{ tool_use_id: 'c2', tool: 'Edit', input: { file_path: '/p/parser.ts', old_string: 'a', new_string: 'b' }, text: 'ok' }], handle: 'h4' },
    { role: 'user', text: '', toolUses: [], toolResults: [{ tool_use_id: 'c2', text: 'ok', isError: false }], handle: 'h5' },
    { role: 'assistant', text: 'Done.', toolUses: [], handle: 'h6' },
  ]
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

test('compact asks what the summary keeps, runs /compact, then sends; an unchanged conversation puts the prompt back', async ($, on) => {
  const w = world({ transcript: row(T0 - 2 * 3_600_000, usage1h(600_000)), answers: ['Compact first', 'Focus', 'Compact first', 'Default'], messages: history() })
  const clock = stubs(on, w)
  await $.session.start({ cwd: '/work', surface: 'terminal', isInteractive: false })
  const held = await $.prompt.submit({ text: 'fix the parser', wait: false, origin: { kind: 'composer' } })
  expect(held.drop).toBe('Compacting, then sending your prompt.')
  expect(w.menus[0]).toEqual(['Keep the prompt', 'New conversation (~$0)', 'Compact first (~$2.41)', 'Send anyway (~$4.82)'])
  expect(w.menus[1]).toEqual(['Default summary', 'Focus on this prompt'])
  await clock.settle()
  expect(w.pendingCompact!.args).toMatch(/^Keep what is needed to continue with the user's next request, quoted below, and drop the rest\.\n\nfix the parser$/)
  // Core compacts (through this plugin's hook, which has no Jev and passes it on) and the transcript shrinks.
  const result = await $.session.compact({ trigger: 'manual', instructions: w.pendingCompact!.args, messages: history() })
  expect(w.compacted.length).toBe(1)
  expect(w.compacted[0].messages.length).toBe(6)
  expect(result.messages!.length).toBe(1)
  w.messages = [...result.messages!]
  w.pendingCompact!.resolve('Compacted.')
  await clock.settle()
  expect(w.submitted).toEqual(['fix the parser'])
  expect(w.filled).toEqual([])
  // Again, but core compacts nothing (skipped): the prompt goes back.
  w.messages = history()
  await $.prompt.submit({ text: 'fix the parser', wait: false, origin: { kind: 'composer' } })
  await clock.settle()
  w.pendingCompact!.resolve('Compaction skipped.')
  await clock.settle()
  expect(w.submitted).toEqual(['fix the parser'])
  expect(w.filled).toEqual(['fix the parser'])
  expect(w.logs.at(-1)).toBe('compaction did not run (nothing compacted); your prompt is back in the box')
})

test('without a key the question carries the Jev tip; jev.enabled false drops it', async ($, on) => {
  const w = world({ transcript: row(T0 - 2 * 3_600_000, usage1h(600_000)), answers: [undefined, undefined] })
  stubs(on, w)
  await $.session.start({ cwd: '/work', surface: 'terminal', isInteractive: false })
  await $.prompt.submit({ text: 'x', wait: false, origin: { kind: 'composer' } })
  expect(w.asks[0]).toMatch(/What now\?\nTip: \/cache-guard jev sets up Jev, which compacts in about a second for ~\$0 \(or turns this tip off\)\.$/)
  w.files['/home/u/.claude/cache-guard.json'] = JSON.stringify({ jev: { enabled: false } })
  await $.command.run({ command: 'cache-guard', args: 'status' } as any) // reloads the settings
  await $.prompt.submit({ text: 'x', wait: false, origin: { kind: 'composer' } })
  expect(w.asks[1]).not.toMatch(/Tip:/)
})

test('trims a large Bash result with Jev, saves the full output, and gives it whole when asked again', async ($, on) => {
  const w = world({ transcript: row(T0, usage1h(600_000)) })
  stubs(on, w, JEV_ENV)
  await $.session.start({ cwd: '/work', surface: 'terminal', isInteractive: false })
  await $.turn.start({ text: 'run the tests and fix what fails', turnId: 't1' })
  await $.tool.call({ tool: 'Bash', command: 'npm test', tool_use_id: 'c1' } as any)
  const log = buildLog()
  const stored = await $.session.append(toolResultRow('c1', 'Bash', log) as any)
  const text = stored.message!.content[0]!.content as string
  expect(text.length).toBeLessThan(log.length / 4)
  expect(text).toMatch(/FAIL src\/parser\.test\.ts > skips blank lines/)
  expect(text).toMatch(/\[… \d+ lines omitted …\]/)
  expect(text).toMatch(/\[Trimmed by Jev: kept \d+ of 400 lines that matter for this step\. Full output: \/home\/u\/\.claude\/cache-guard\/tool-output\/sid\/c1\.txt/)
  expect(w.files['/home/u/.claude/cache-guard/tool-output/sid/c1.txt']).toBe(log)
  expect(w.fetches.length).toBe(1)
  expect(w.fetches[0].model).toBe('jev-latest')
  expect(w.fetches[0].state.intent).toEqual({ user_request: 'run the tests and fix what fails', agent_said: '(nothing; see the tool call)', tool: 'Bash', arguments: '{"command":"npm test"}' })
  expect(w.fetches[0].questions.needs_all.type).toBe('noul')
  expect(w.logs.at(-1)).toMatch(/^trimmed Bash output to \d+ of 400 lines \(Jev, \d+ ms\); full output: /)
  // The same command again this turn: everything.
  await $.tool.call({ tool: 'Bash', command: 'npm test', tool_use_id: 'c2' } as any)
  const again = await $.session.append(toolResultRow('c2', 'Bash', log) as any)
  expect(again.message!.content[0]!.content).toBe(log)
  expect(w.fetches.length).toBe(1)
  // A result as text blocks keeps its other blocks; a small one, an error, and an Edit are never judged.
  await $.tool.call({ tool: 'Bash', command: 'npm run build', tool_use_id: 'c3' } as any)
  const blocks = await $.session.append(toolResultRow('c3', 'Bash', [{ type: 'text', text: log }, { type: 'image', source: {} }]) as any)
  expect(blocks.message!.content[0]!.content).toEqual([{ type: 'text', text: expect.stringContaining('[Trimmed by Jev') }, { type: 'image', source: {} }])
  const small = await $.session.append(toolResultRow('c4', 'Bash', 'ok') as any)
  expect(small.message!.content[0]!.content).toBe('ok')
  const failed = await $.session.append(toolResultRow('c5', 'Bash', log, { is_error: true }) as any)
  expect(failed.message!.content[0]!.content).toBe(log)
  await $.tool.call({ tool: 'Edit', file_path: '/p', old_string: 'a', new_string: 'b', tool_use_id: 'c6' } as any)
  const edit = await $.session.append(toolResultRow('c6', 'Edit', log) as any)
  expect(edit.message!.content[0]!.content).toBe(log)
  expect(w.fetches.length).toBe(2)
  const status = await $.command.run({ command: 'cache-guard', args: '' } as any)
  expect(status.text).toMatch(/Jev: typesafe\/jev-latest \(key from TYPESAFE_API_KEY\); trimming on \(−\d+k tokens so far\); Jev compaction from the cold-cache menu and \/cache-guard compact; it filters \/compact too\./)
})

test('a Jev that times out, errors, or wants the whole output leaves the result alone; a subagent is never trimmed', async ($, on) => {
  const w = world({ transcript: row(T0, usage1h(600_000)), jev: () => null })
  const clock = stubs(on, w, JEV_ENV)
  await $.session.start({ cwd: '/work', surface: 'terminal', isInteractive: false })
  await $.turn.start({ text: 'build it', turnId: 't1' })
  const log = buildLog()
  const slow = $.session.append(toolResultRow('c1', 'Bash', log) as any)
  await clock.advance(2_600)
  expect((await slow).message!.content[0]!.content).toBe(log)
  w.jev = () => ({ status: 401 })
  expect((await $.session.append(toolResultRow('c2', 'Bash', log) as any)).message!.content[0]!.content).toBe(log)
  w.jev = (body) => ({ text: JSON.stringify({ answers: { ...jevAnswers(body), needs_all: { type: 'noul', noul: 0.95 } } }) })
  expect((await $.session.append(toolResultRow('c3', 'Bash', log) as any)).message!.content[0]!.content).toBe(log)
  w.jev = () => ({})
  expect((await $.session.append({ ...toolResultRow('c4', 'Bash', log), agentId: 'agent-1' } as any)).message!.content[0]!.content).toBe(log)
  expect(w.fetches.length).toBe(3)
  expect(Object.keys(w.files)).toEqual([])
})

test('the cold-cache menu with Jev: a Jev compaction judged against the prompt, written in code, then the prompt', async ($, on) => {
  const w = world({ transcript: row(T0 - 2 * 3_600_000, usage1h(600_000)), answers: ['Compact first', 'Compact with Jev'], messages: history() })
  const clock = stubs(on, w, JEV_ENV)
  await $.session.start({ cwd: '/work', surface: 'terminal', isInteractive: false })
  const held = await $.prompt.submit({ text: 'now add the CLI flag', wait: false, origin: { kind: 'composer' } })
  expect(held.drop).toBe('Compacting with Jev, then sending your prompt.')
  expect(w.menus[0]).toEqual(['Keep the prompt', 'New conversation (~$0)', 'Compact first (~$0 with Jev)', 'Send anyway (~$4.82)'])
  expect(w.asks[0]).not.toMatch(/Tip:/)
  expect(w.menus[1]).toEqual(['Compact with Jev (~1s, ~$0)', 'Compact with a summary (up to ~$2.41)', 'Compact with a summary focused on this prompt (up to ~$2.41)'])
  await clock.settle()
  expect(w.pendingCompact!.args).toBe('')
  const result = await $.session.compact({ trigger: 'manual', messages: history() })
  expect(w.compacted).toEqual([]) // strict: core's summarizer never ran
  expect(result.messages!.length).toBe(1)
  const summary = result.messages![0]!.text
  expect(summary).toMatch(/^# Compacted with Jev\n\nJev kept 1 item word for word, noted 3 and dropped 2; no LLM wrote this summary\.\nFocus: now add the CLI flag/)
  expect(summary).toMatch(/## Goal\n\nWhat the user asked for, in order:\n- Fix the parser\./)
  expect(summary).toMatch(/## Kept verbatim\n\n\*\*Assistant:\*\* Decision: blank lines are skipped before parsing \(keep me\)\./)
  expect(summary).toMatch(/## Files\n\nModified: \/p\/parser\.ts/)
  expect(w.fetches[0].state.current_goal).toBe('now add the CLI flag')
  expect(Object.keys(w.fetches[0].questions)).toEqual(['keep::U001', 'keep::U002', 'keep::U003', 'keep::U004', 'keep::U005', 'keep::U006'])
  w.messages = [...result.messages!]
  w.pendingCompact!.resolve('Compacted.')
  await clock.settle()
  expect(w.submitted).toEqual(['now add the CLI flag'])
  expect(w.logs.at(-1)).toMatch(/^compacted with Jev in \d+\.\d s \(1 kept verbatim, 3 noted, 2 dropped\)/)
})

test('a Jev compaction whose Jev fails is skipped, nothing is spent, and the prompt goes back', async ($, on) => {
  const w = world({ transcript: row(T0 - 2 * 3_600_000, usage1h(600_000)), answers: ['Compact first', 'Compact with Jev'], messages: history(), jev: () => ({ status: 401 }) })
  const clock = stubs(on, w, JEV_ENV)
  await $.session.start({ cwd: '/work', surface: 'terminal', isInteractive: false })
  await $.prompt.submit({ text: 'go on', wait: false, origin: { kind: 'composer' } })
  await clock.settle()
  const result = await $.session.compact({ trigger: 'manual', messages: history() })
  expect(result.skip).toBe('Jev compaction: Jev failed (invalid API key)')
  expect(w.compacted).toEqual([])
  w.pendingCompact!.resolve('Compaction skipped.')
  await clock.settle()
  expect(w.submitted).toEqual([])
  expect(w.filled).toEqual(['go on'])
  expect(w.logs.at(-1)).toBe('compaction with Jev did not run: Jev failed (invalid API key); your prompt is back in the box')
})

test('/compact and automatic compaction: Jev filters what the summarizer reads and the verbatim items follow the summary', async ($, on) => {
  const w = world({ messages: history() })
  stubs(on, w, JEV_ENV)
  await $.session.start({ cwd: '/work', surface: 'terminal', isInteractive: false })
  const result = await $.session.compact({ trigger: 'auto', messages: history() })
  expect(w.compacted.length).toBe(1)
  const read = w.compacted[0].messages
  expect(read.map((m: any) => m.handle)).toEqual(['h1', 'h4', 'h5', 'h6']) // the exploration (drop me) is gone, the rest untouched
  expect(w.fetches[0].state.current_goal).toBe('Fix the parser.')
  expect(result.messages!.map((m: any) => m.text)).toEqual([
    'SUMMARY of 4 (no guidance)',
    '## Kept verbatim\n\n**Assistant:** Decision: blank lines are skipped before parsing (keep me).',
  ])
  expect((result as any).tokensBefore).toBe(1000)
  // A manual compaction with guidance judges against it.
  await $.session.compact({ trigger: 'manual', instructions: 'keep the CLI plan', messages: history() })
  expect(w.fetches[1].state.current_goal).toBe('keep the CLI plan')
  expect(w.compacted[1].instructions).toBe('keep the CLI plan')
  // Jev failing: the compaction runs unchanged. A precompute and a subagent's are never touched.
  w.jev = () => ({ status: 500 })
  const plain = await $.session.compact({ trigger: 'manual', messages: history() })
  expect(w.compacted[2].messages.map((m: any) => m.handle)).toEqual(['h1', 'h2', 'h3', 'h4', 'h5', 'h6'])
  expect(plain.messages!.length).toBe(1)
  w.jev = () => ({})
  await $.session.compact({ trigger: 'precompute', messages: history() })
  await $.session.compact({ trigger: 'auto', agentId: 'a1', messages: history() })
  expect(w.fetches.length).toBe(3)
  expect(w.compacted.length).toBe(5)
  // compact.filter off: untouched.
  w.files['/home/u/.claude/cache-guard.json'] = JSON.stringify({ compact: { filter: false } })
  await $.command.run({ command: 'cache-guard', args: 'status' } as any)
  await $.session.compact({ trigger: 'auto', messages: history() })
  expect(w.fetches.length).toBe(3)
})

test('/cache-guard jev: without a key the setup, with a key a probe; off and on are saved by merging', async ($, on) => {
  const w = world({ answers: ['Turn Jev off (no more tips)', 'Turn Jev on', 'Done', 'Turn Jev off'], files: { '/home/u/.claude/cache-guard.json': '{ "warn": { "minCost": 1 } }' } })
  stubs(on, w)
  await $.session.start({ cwd: '/work', surface: 'terminal', isInteractive: false })
  const setup = await $.command.run({ command: 'cache-guard', args: 'jev' } as any)
  expect(w.asks[0]).toMatch(/^Jev is not set up: no TypeSafe API key \(the plugin option typesafe_api_key, or TYPESAFE_API_KEY in the environment\)\.\nJev, TypeSafe's judgment model/)
  expect(w.asks[0]).toMatch(/https:\/\/console\.typesafe\.ai\/keys/)
  expect(w.asks[0]).toMatch(/claude plugin configure cache-guard@inline --values-stdin/)
  expect(w.menus[0]).toEqual(['Done', 'Turn Jev off (no more tips)'])
  expect(setup.text).toMatch(/^Jev is off: no trimming, no Jev compaction, no tips/)
  expect(JSON.parse(w.files['/home/u/.claude/cache-guard.json']!)).toEqual({ warn: { minCost: 1 }, jev: { enabled: false } })
  expect((await $.command.run({ command: 'cache-guard', args: '' } as any)).text).toMatch(/Jev: off \(\/cache-guard jev turns it on\)\./)
  // Off: the command offers to turn it on, then (still without a key) the setup again.
  const on2 = await $.command.run({ command: 'cache-guard', args: 'jev' } as any)
  expect(w.menus[1]).toEqual(['Turn Jev on', 'Leave it off'])
  expect(on2.text).toMatch(/^Jev is not set up: no TypeSafe API key/)
  expect(JSON.parse(w.files['/home/u/.claude/cache-guard.json']!)).toEqual({ warn: { minCost: 1 }, jev: { enabled: true } })
  // A file that is not a JSON object is left alone.
  w.files['/home/u/.claude/cache-guard.json'] = '[1, 2]'
  w.answers = ['Turn Jev off (no more tips)']
  const refused = await $.command.run({ command: 'cache-guard', args: 'jev' } as any)
  expect(refused.text).toMatch(/^Could not save the setting: \/home\/u\/\.claude\/cache-guard\.json is not a JSON object; fix it by hand$/)
  expect(w.files['/home/u/.claude/cache-guard.json']).toBe('[1, 2]')
})

test('/cache-guard jev with a key probes Jev and reports the latency; /cache-guard compact [focus] compacts with Jev', { options: { typesafe_api_key: 'tsk-config' } }, async ($, on) => {
  const w = world({ answers: ['Done'], messages: history() })
  const clock = stubs(on, w, JEV_ENV)
  await $.session.start({ cwd: '/work', surface: 'terminal', isInteractive: false })
  const probe = await $.command.run({ command: 'cache-guard', args: 'jev' } as any)
  expect(probe.text).toMatch(/^Jev: typesafe\/jev-latest \(key from plugin config\), answered in \d+ ms\.$/)
  expect(w.fetches[0].questions).toEqual({ approved: { type: 'noul', instructions: 'Is the user satisfied?', criteria: { true: 'Satisfied', false: 'Not satisfied' } } })
  expect(w.fetches[0].state).toEqual({ message: 'The tests pass now, thanks.' })
  expect(w.menus[0]).toEqual(['Done', 'Turn Jev off', 'Show the setup'])
  const started = await $.command.run({ command: 'cache-guard', args: 'compact the CLI flag' } as any)
  expect(started.text).toBe('Compacting with Jev.')
  await clock.settle()
  expect(w.pendingCompact!.args).toBe('')
  const result = await $.session.compact({ trigger: 'manual', messages: history() })
  expect(result.messages![0]!.text).toMatch(/^# Compacted with Jev\n\n[^\n]*\nFocus: the CLI flag\n/)
  expect(w.fetches[1].state.current_goal).toBe('the CLI flag')
  w.pendingCompact!.resolve('Compacted.')
  await clock.settle()
  expect(w.logs.at(-1)).toMatch(/^compacted with Jev in \d+\.\d s \(1 kept verbatim, 3 noted, 2 dropped\)$/)
})

test('/cache-guard compact without Jev offers the normal compaction', async ($, on) => {
  const w = world({ answers: ["Compact with Claude Code's summary"], messages: history() })
  const clock = stubs(on, w)
  await $.session.start({ cwd: '/work', surface: 'terminal', isInteractive: false })
  const started = await $.command.run({ command: 'cache-guard', args: 'compact keep the plan' } as any)
  expect(w.asks[0]).toMatch(/^Jev is not set up \(no TypeSafe API key.*\)\. Compact with Claude Code's summary instead\?$/)
  expect(w.menus[0]).toEqual(["Compact with Claude Code's summary", 'Set up Jev'])
  expect(started.text).toBe('Compacting with a summary.')
  await clock.settle()
  expect(w.pendingCompact!.args).toBe('keep the plan')
  const result = await $.session.compact({ trigger: 'manual', instructions: 'keep the plan', messages: history() })
  w.messages = [...result.messages!]
  w.pendingCompact!.resolve('Compacted.')
  await clock.settle()
  expect(w.logs.at(-1)).toBe('compacted')
  expect(w.fetches).toEqual([])
})
