// The pure parts of the Jev integration: the HTTP translation (jev.ts) and Claude Code's
// transcript in and out of lean.ts (units.ts). lean.ts itself is tested in pi-cache-guard.
import { expect, test } from 'claude-code/testing'

import { DEFAULT_SETTINGS } from '../hooks/core'
import { PROBE, describeFailure, readReply, requestBody, resolveJev, toApiQuestions } from '../hooks/jev'
import { boolAnswer, choiceAnswer } from '../hooks/lean'
import { type MessageLike, extractUnits, fileOps, filterMessages, lastUserMessages, resultText, trimFloor, withResultText } from '../hooks/units'

const settings = (jev: Partial<typeof DEFAULT_SETTINGS.jev> = {}, enabled = true) => ({ enabled, jev: { ...DEFAULT_SETTINGS.jev, ...jev } })

test('resolveJev: the plugin option first, then the environment; only TypeSafe is reachable', () => {
  expect(resolveJev(settings(), 'cfg', 'env')).toEqual({ kind: 'ready', target: { model: 'jev-latest', keySource: 'plugin config', apiKey: 'cfg' } })
  expect(resolveJev(settings({ model: 'jev-1.13' }), '  ', 'env')).toEqual({ kind: 'ready', target: { model: 'jev-1.13', keySource: 'TYPESAFE_API_KEY', apiKey: 'env' } })
  expect(resolveJev(settings({ provider: 'typesafe' }), undefined, 'env').kind).toBe('ready')
  expect(resolveJev(settings(), undefined, undefined)).toMatchObject({ kind: 'missing', reason: expect.stringContaining('typesafe_api_key') })
  expect(resolveJev(settings({ provider: 'openrouter' }), 'cfg', 'env')).toMatchObject({ kind: 'missing', reason: expect.stringContaining('"openrouter" is not supported') })
  expect(resolveJev(settings({ enabled: false }), 'cfg', 'env')).toEqual({ kind: 'off' })
  expect(resolveJev(settings({}, false), 'cfg', 'env')).toEqual({ kind: 'off' })
})

test('the request translates bool questions to noul; the reply translates noul back', () => {
  const body = JSON.parse(requestBody('jev-latest', { a: 1 }, {
    ...PROBE.questions,
    pick: { type: 'choice', instructions: 'Which?', criteria: { x: 'X', y: 'Y' } },
    rate: { type: 'score', instructions: 'How?', criteria: ['low', 'high'] },
  }))
  expect(body.model).toBe('jev-latest')
  expect(body.state).toEqual({ a: 1 })
  expect(body.questions.approved).toEqual({ type: 'noul', instructions: 'Is the user satisfied?', criteria: { true: 'Satisfied', false: 'Not satisfied' } })
  expect(body.questions.pick.type).toBe('choice')
  expect(body.questions.rate.type).toBe('score')
  expect(Object.keys(toApiQuestions(PROBE.questions))).toEqual(['approved'])

  const reply = readReply(JSON.stringify({
    model: 'jev-1.13',
    answers: {
      approved: { type: 'noul', noul: 0.92 },
      pick: { type: 'choice', choice: 'y', probabilities: { x: 0.2, y: 0.8 }, confidence: 0.7 },
      rate: { type: 'score', score: 1, confidence: 0.5 },
      bad: { type: 'noul', noul: 'nan' },
    },
    usage: { input_tokens: 123 },
  }))!
  expect(reply.model).toBe('jev-1.13')
  expect(reply.inputTokens).toBe(123)
  expect(boolAnswer(reply.answers, 'approved')).toBe(0.92)
  expect(choiceAnswer(reply.answers, 'pick')).toBe('y')
  expect(reply.answers.rate).toEqual({ type: 'score', score: 1, confidence: 0.5 })
  expect(reply.answers.bad).toBeUndefined()
  expect(readReply('not json')).toBeUndefined()
  expect(readReply('{"model":"x"}')).toBeUndefined()
})

test('failures are described in one line', () => {
  expect(describeFailure(401)).toBe('invalid API key')
  expect(describeFailure(429)).toBe('rate limited (HTTP 429)')
  expect(describeFailure(500)).toBe('HTTP 500')
  expect(describeFailure(undefined, 'fetch failed: connect ETIMEDOUT')).toBe('timed out')
  expect(describeFailure(undefined, 'refused while CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC is set')).toMatch(/network calls are off/)
  expect(describeFailure(undefined, '')).toBe('unknown error')
})

test('trimFloor: the output tools from minChars, Read from readMinChars, nothing else', () => {
  const limits = { minChars: 12_000, readMinChars: 50_000 }
  for (const tool of ['Bash', 'Grep', 'Glob', 'LS', 'WebFetch', 'WebSearch', 'mcp__context7__get-library-docs']) expect(trimFloor(tool, limits)).toBe(12_000)
  expect(trimFloor('Read', limits)).toBe(50_000)
  for (const tool of ['Edit', 'Write', 'MultiEdit', 'NotebookEdit', 'Task', 'Agent', 'TodoWrite', 'AskUserQuestion', 'Skill']) expect(trimFloor(tool, limits)).toBeUndefined()
})

test('a tool_result content, as a string or as blocks, is read and rewritten', () => {
  expect(resultText('plain')).toBe('plain')
  expect(resultText([{ type: 'text', text: 'a' }, { type: 'image', source: {} }, { type: 'text', text: 'b' }])).toBe('a\nb')
  expect(withResultText('plain', 'new')).toBe('new')
  expect(withResultText([{ type: 'text', text: 'a' }, { type: 'image', source: {} }, { type: 'text', text: 'b' }], 'new')).toEqual([{ type: 'text', text: 'new' }, { type: 'image', source: {} }])
  expect(withResultText([{ type: 'image', source: {} }], 'new')).toEqual([{ type: 'image', source: {} }, { type: 'text', text: 'new' }])
})

/** A short conversation: an earlier summary, a request, a read, an edit, a failed test, an answer. */
function conversation(): MessageLike[] {
  return [
    { role: 'user', text: 'This session is being continued from a previous conversation that ran out of context. Earlier: we set up the parser.', toolUses: [], handle: 'h0' },
    { role: 'user', text: 'Fix the parser so that empty lines are skipped.', toolUses: [], handle: 'h1' },
    {
      role: 'assistant',
      text: 'Let me look at the parser.',
      toolUses: [{ tool_use_id: 'c1', tool: 'Read', input: { file_path: '/p/parser.ts' }, text: 'line 1\nline 2' }],
      handle: 'h2',
    },
    { role: 'user', text: '', toolUses: [], toolResults: [{ tool_use_id: 'c1', text: 'line 1\nline 2', isError: false }], handle: 'h3' },
    {
      role: 'assistant',
      text: '',
      toolUses: [
        { tool_use_id: 'c2', tool: 'Edit', input: { file_path: '/p/parser.ts', old_string: 'a', new_string: 'b' }, text: 'ok' },
        { tool_use_id: 'c3', tool: 'Bash', input: { command: 'npm test' }, text: 'FAIL parser.test.ts: expected 2, got 3', isError: true },
      ],
      handle: 'h4',
    },
    { role: 'user', text: '', toolUses: [], toolResults: [{ tool_use_id: 'c2', text: 'ok', isError: false }, { tool_use_id: 'c3', text: 'FAIL parser.test.ts: expected 2, got 3', isError: true }], handle: 'h5' },
    { role: 'assistant', text: 'The test still fails on the count; the fix needs the blank-line case.', toolUses: [], handle: 'h6' },
    { role: 'user', text: 'Then handle blank lines too.', toolUses: [], handle: 'h7' },
  ]
}

test('units: the earlier summary apart, each tool call with its outcome, the last requests, the files', () => {
  const messages = conversation()
  const { units, previousSummary } = extractUnits(messages)
  expect(previousSummary).toMatch(/^This session is being continued/)
  expect(units.map((u) => [u.id, u.kind, u.message])).toEqual([
    ['U001', 'user', 1], ['U002', 'assistant', 2], ['U003', 'tool', 2], ['U004', 'tool', 4], ['U005', 'tool', 4], ['U006', 'assistant', 6], ['U007', 'user', 7],
  ])
  expect(units[4]!.tool).toMatchObject({ name: 'Bash', args: '{"command":"npm test"}', result: 'FAIL parser.test.ts: expected 2, got 3', isError: true, callId: 'c3' })
  expect(units[4]!.text).toBe('Bash({"command":"npm test"})\n[error] FAIL parser.test.ts: expected 2, got 3')
  expect(lastUserMessages(messages, 2)).toBe('Fix the parser so that empty lines are skipped.\n---\nThen handle blank lines too.')
  const ops = fileOps(messages)
  expect([...ops.read]).toEqual(['/p/parser.ts'])
  expect([...ops.edited]).toEqual(['/p/parser.ts'])
  expect([...ops.written]).toEqual([])
})

test('filterMessages: dropped units go, summarized ones are clipped, the rest keep their handles', () => {
  const messages = conversation()
  const { units } = extractUnits(messages)
  const keep = new Map([
    ['U001', 'verbatim'], ['U002', 'drop'], ['U003', 'drop'], ['U004', 'summarize'], ['U005', 'verbatim'], ['U006', 'summarize'], ['U007', 'verbatim'],
  ] as const)
  const long = messages[2]!
  long.toolUses = [{ ...long.toolUses[0]!, text: 'x'.repeat(2_000) }]
  const filtered = filterMessages(messages, units, keep)
  // The summary (no unit) stays; the read's call and result are gone; rows nothing clipped keep their handles.
  expect(filtered.map((m) => m.handle)).toEqual(['h0', 'h1', 'h4', 'h5', 'h6', 'h7'])
  expect(filtered[1]!.text).toBe('Fix the parser so that empty lines are skipped.')
  expect(filtered[2]!.toolUses.map((u) => u.tool_use_id)).toEqual(['c2', 'c3'])
  expect(filtered[2]!.text).toBe('')
  expect(filtered[3]!.toolResults!.length).toBe(2)
  expect(filtered[4]!.text).toBe('The test still fails on the count; the fix needs the blank-line case.')
  // A summarized tool result longer than 600 characters is clipped in its row and its call.
  const read = new Map([['U003', 'summarize'], ['U002', 'verbatim']] as const)
  const clipped = filterMessages(messages, units, read)
  expect(clipped[2]!.toolUses[0]!.text!.length).toBe(600)
  expect(clipped[2]!.handle).toBeUndefined()
  // An assistant row whose text and every call were dropped disappears, as does its results row.
  const fresh = conversation()
  const gone = filterMessages(fresh, extractUnits(fresh).units, new Map([['U004', 'drop'], ['U005', 'drop']] as const))
  expect(gone.map((m) => m.handle)).toEqual(['h0', 'h1', 'h2', 'h3', 'h6', 'h7'])
})
