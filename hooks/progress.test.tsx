import type { On } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'

const BAND = {
  plugin: 'agent-progress',
  component: 'AbovePrompt',
  requestId: 'band',
  props: {
    hasSurvey: false,
    isCollapsed: false,
    isWorking: true,
    maxRows: 12,
    bodyColumns: 120,
    scroll: { offset: 0, bodyRows: 12 },
    view: {},
  },
} as const

const PANE = {
  plugin: 'agent-progress',
  component: 'Pane',
  requestId: 'agent-progress',
  props: {
    title: 'Agent progress',
    isFocused: false,
    bodyColumns: 150,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 30 },
    view: {},
  },
} as const

const ORIGIN = { plugin: 'engine', tier: 'core' } as const

const seen = { prompt: '', explainPrompt: '', theme: 'dark', opened: [] as unknown[] }

/** Stands in for the engine beneath the mod. */
function engine(on: On) {
  on('turn.complete', () => ({ text: 'ok' }))
  on('command.register', () => ({ value: { command: 'progress' } }))
  on('tool.register', () => ({ value: { tool: 'mcp__agent-progress__progress' } }))
  on('ui.open', (_, e) => {
    seen.opened.push((e as any).backgroundColor)
    return { value: { isPlaced: true } } as never
  })
  on('config.list', () => ({ value: [{ key: 'theme', label: 'Theme', kind: 'enum', value: seen.theme, provider: ORIGIN }] }) as never)
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('prompt.submit', (_, e) => ({ text: e.text }))
  on('tool.call', () => ({ result: {} }))
  on('model.complete', (_, e) => {
    seen.explainPrompt = String(e.prompt)
    return {
      value: {
        isAnswered: true,
        text: '"Claude is reading your login code so it can find why sign-in breaks." Hope that helps!',
        usage: { input_tokens: 1, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
      },
    } as never
  })
  let n = 0
  on('agent.spawn', (_, e) => {
    seen.prompt = e.prompt
    return { model: 'opus', agentId: e.resume?.agentId ?? `agent-${++n}` }
  })
}

async function spawn($: any, description: string) {
  return $.agent.spawn({
    tool_use_id: `call-${description}`,
    prompt: 'Look into why users cannot log in.',
    description,
    subagentType: 'general-purpose',
    provider: ORIGIN,
    parentModel: 'opus',
    background: true,
    fork: false,
  })
}

async function texts(ui: { findAll: (q: { type: 'Text' }) => Promise<{ text: string }[]> }) {
  return (await ui.findAll({ type: 'Text' })).map(t => t.text).join('\n')
}

test('a subagent shows a plain-language bar that follows its checklist', async ($, on) => {
  engine(on)
  const clock = mock.clock(on, { now: 1_000_000 })
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await spawn($, 'Build the replay harness')
  // the agent is told to report first, before its own task
  expect(seen.prompt.startsWith('Required progress reporting')).toBe(true)
  expect(seen.prompt).toContain('Look into why users cannot log in.')

  await $.tool.run({
    tool: 'mcp__agent-progress__progress',
    tool_use_id: 't1',
    agentId: 'agent-1',
    steps: ['Read the old code', 'Write the harness', 'Run the tests', 'Clean up'],
    purpose: 'Claude is building a test rig so your replay results can be trusted',
    done: 1,
  } as any)
  await clock.advance(20_000)

  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  const all = await texts(ui)
  expect(all).toContain('1 agent working')
  expect(all).toContain('Build the replay harness')
  // the step sits on its own line under the bar
  expect(all).toMatch(/Step 2 of 4\s+Write the harness/)
  expect(all).not.toContain('general-purpose')
  // 1 of 4 steps done, and the bar has moved on within step 2, short of step 3's mark
  const shown = Number(/ (\d+)%/.exec(all)?.[1])
  expect(shown).toBeGreaterThan(25)
  expect(shown).toBeLessThan(50)
  await ui.unmount()
})

test('pressing a row opens how it helps and its checklist', async ($, on) => {
  engine(on)
  mock.clock(on, { now: 1_000_000 })
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await spawn($, 'Fix the login bug')
  await $.tool.run({
    tool: 'mcp__agent-progress__progress',
    tool_use_id: 't1',
    agentId: 'agent-1',
    steps: ['Find where logins are handled', 'Fix the check'],
    purpose: 'Claude is finding why sign-in fails so it can fix it',
    done: 0,
  } as any)

  for (const site of [BAND, PANE] as const) {
    const ui = await $.ui.mount({ ...site, surface: 'terminal' } as any)
    expect(await texts(ui)).not.toContain('Claude is finding why sign-in fails')
    await ui.press({ key: 'agent-1' })
    const open = await texts(ui)
    expect(open).toContain('Claude is finding why sign-in fails so it can fix it.')
    expect(open).toContain('Find where logins are handled')
    await ui.press({ key: 'agent-1' })
    expect(await texts(ui)).not.toContain('Claude is finding why sign-in fails')
    await ui.unmount()
  }
})

test('an agent that does not explain itself gets a plain line written for it', async ($, on) => {
  engine(on)
  const clock = mock.clock(on, { now: 1_000_000 })
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.prompt.submit({ text: 'Users say they cannot log in, please fix it' } as any)
  await spawn($, 'Find the login bug')
  await $.tool.call({ tool: 'Bash', tool_use_id: 'b1', command: 'npm test', agentId: 'agent-1' } as any)
  await clock.advance(6_000)
  await clock.advance(1_000)

  expect(seen.explainPrompt).toContain('Users say they cannot log in')
  await $.command.run({ command: 'progress', args: 'explain' } as any)
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  const all = await texts(ui)
  // one sentence, quotes and chatter cut
  expect(all).toContain('Claude is reading your login code so it can find why sign-in breaks.')
  expect(all).not.toContain('Hope that helps')
  expect(all).toMatch(/~\d+%/)
  expect(all).toContain('Running the tests')
  await ui.unmount()
})

test('a finished agent turns done, and the table shows both with an overall bar', { timeoutMs: 30_000 }, async ($, on) => {
  engine(on)
  const clock = mock.clock(on, { now: 1_000_000 })
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await spawn($, 'Write the docs')
  await spawn($, 'Fix the tests')
  await clock.advance(5_000)
  await $.turn.complete({ answer: 'ok', durationMs: 5_000, isAborted: false, turnId: 'x', agentId: 'agent-1', reason: 'completed' } as any)

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    const all = await texts(ui)
    expect(all).toContain('Agents')
    expect(all).toContain('1 working · 1 done')
    expect(all).toContain('Write the docs')
    expect(all).toContain('✔')
    expect(all).toContain('Getting started')
    expect(all).toContain('Fix the tests')
    expect(all).toContain('Overall')
    await ui.unmount()
  }
})

test('time left appears once a step has finished, and counts down', async ($, on) => {
  engine(on)
  const clock = mock.clock(on, { now: 1_000_000 })
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await spawn($, 'Build the thing')
  const report = (done: number) =>
    $.tool.run({ tool: 'mcp__agent-progress__progress', tool_use_id: `p${done}`, agentId: 'agent-1', steps: ['One', 'Two', 'Three', 'Four'], done } as any)
  await report(0)
  await clock.advance(10_000)
  let ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  // no finished step yet: no guess at the time, just how long so far
  expect(await texts(ui)).not.toContain('left')
  await ui.unmount()

  await report(1) // one step took 10s, three to go: about 30s
  await clock.advance(5_000)
  ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await texts(ui)).toContain('~25s left')
  await ui.unmount()
})

test('everything done: one notice for the batch', async ($, on) => {
  engine(on)
  const toasts: string[] = []
  on('ui.toast', (_, e) => {
    toasts.push(String((e as any).text))
    return { value: undefined } as never
  })
  const clock = mock.clock(on, { now: 1_000_000 })
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await spawn($, 'One')
  await spawn($, 'Two')
  await clock.advance(3_000)
  await $.turn.complete({ answer: 'ok', durationMs: 1, isAborted: false, turnId: 'a', agentId: 'agent-1' } as any)
  expect(toasts.length).toBe(0)
  await $.turn.complete({ answer: 'ok', durationMs: 1, isAborted: false, turnId: 'b', agentId: 'agent-2' } as any)
  expect(toasts).toEqual(['2 agents done · 3s'])
})

test('with checklists and summaries off, agents are left alone', { options: { checklists: false, summaries: false } }, async ($, on) => {
  engine(on)
  seen.explainPrompt = ''
  const clock = mock.clock(on, { now: 1_000_000 })
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await spawn($, 'Find the login bug')
  expect(seen.prompt).toBe('Look into why users cannot log in.')
  await clock.advance(8_000)
  expect(seen.explainPrompt).toBe('')
})

test('finished agents of an earlier batch fold under "Earlier"', { timeoutMs: 30_000 }, async ($, on) => {
  engine(on)
  const clock = mock.clock(on, { now: 1_000_000 })
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await spawn($, 'Old job')
  await clock.advance(2_000)
  await $.turn.complete({ answer: 'ok', durationMs: 1, isAborted: false, turnId: 'a', agentId: 'agent-1' } as any)
  await clock.advance(60_000)
  await spawn($, 'New job')

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  let all = await texts(ui)
  expect(all).toContain('New job')
  expect(all).toContain('Earlier · 1 finished')
  expect(all).not.toContain('Old job')
  await ui.press({ key: 'earlier' })
  all = await texts(ui)
  expect(all).toContain('Old job')
  await ui.unmount()
})

test('the band stays out of the way when nothing is running', async ($, on) => {
  engine(on)
  on('ui.render', ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text>engine</Text>
  })
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect((await ui.find({ type: 'Text' }))?.text).toBe('engine')
  await ui.unmount()
})

test('agents started together stay in one batch for the overall %', { timeoutMs: 30_000 }, async ($, on) => {
  engine(on)
  const clock = mock.clock(on, { now: 1_000_000 })
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  // started in the same moment; one finishes first
  await Promise.all([spawn($, 'Long job'), spawn($, 'Quick one'), spawn($, 'Quick two')])
  await clock.advance(4_000)
  await $.turn.complete({ answer: 'ok', durationMs: 1, isAborted: false, turnId: 'a', agentId: 'agent-2' } as any)
  await $.turn.complete({ answer: 'ok', durationMs: 1, isAborted: false, turnId: 'b', agentId: 'agent-3' } as any)

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  const all = await texts(ui)
  expect(all).toContain('1 working · 2 done')
  expect(all).not.toContain('Earlier')
  // two done and one still going: the overall can't be 100%
  expect(all).not.toMatch(/Overall[\s\S]*\b100%/)
  await ui.unmount()
})

test('a resumed agent joins the batch running now and gets its own done notice', { timeoutMs: 30_000 }, async ($, on) => {
  engine(on)
  const toasts: string[] = []
  on('ui.toast', (_, e) => {
    toasts.push(String((e as any).text))
    return { value: undefined } as never
  })
  const clock = mock.clock(on, { now: 1_000_000 })
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await spawn($, 'Old job')
  await clock.advance(2_000)
  await $.turn.complete({ answer: 'ok', durationMs: 1, isAborted: false, turnId: 'a', agentId: 'agent-1' } as any)
  await clock.advance(60_000)
  await spawn($, 'New job')
  await clock.advance(2_000)
  await $.turn.complete({ answer: 'ok', durationMs: 1, isAborted: false, turnId: 'b', agentId: 'agent-2' } as any)
  await clock.advance(60_000)
  // the old agent is picked up again
  await $.agent.spawn({ tool_use_id: 'r', prompt: 'more', description: 'Old job', subagentType: 'general-purpose', provider: ORIGIN, parentModel: 'opus', background: true, fork: false, resume: { agentId: 'agent-1' } } as any)
  await clock.advance(3_000)
  await $.turn.complete({ answer: 'ok', durationMs: 1, isAborted: false, turnId: 'c', agentId: 'agent-1' } as any)
  expect(toasts.length).toBe(3)
  expect(toasts[2]).toBe('1 agent done · 3s')
})

test('/progress draws the live bars right in the chat', async ($, on) => {
  engine(on)
  mock.clock(on, { now: 1_000_000 })
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  const OUT = { plugin: 'agent-progress', component: 'CommandOutput', requestId: 'm1', props: { command: 'progress', args: '', text: '', isErrored: false } } as const
  let ui = await $.ui.mount({ ...OUT, surface: 'terminal' } as any)
  expect(await texts(ui)).toContain('No agents running')
  await ui.unmount()

  await spawn($, 'Fix the login bug')
  ui = await $.ui.mount({ ...OUT, surface: 'terminal' } as any)
  const all = await texts(ui)
  expect(all).toContain('1 agent working')
  expect(all).toContain('Fix the login bug')
  await ui.unmount()
})

test('each bar is labelled: its name or kind, else Agent 1, Agent 2…', async ($, on) => {
  engine(on)
  mock.clock(on, { now: 1_000_000 })
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await spawn($, 'Write the docs')
  await spawn($, 'Fix the tests')
  await $.agent.spawn({ tool_use_id: 'x', prompt: 'look', description: 'Map the code', subagentType: 'Explore', provider: ORIGIN, parentModel: 'opus', background: true, fork: false } as any)
  await $.agent.spawn({ tool_use_id: 'y', prompt: 'go', description: 'Ship it', name: 'scout', subagentType: 'general-purpose', provider: ORIGIN, parentModel: 'opus', background: true, fork: false } as any)

  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  const all = await texts(ui)
  expect(all).toMatch(/Agent 1\s+Write the docs/)
  expect(all).toMatch(/Agent 2\s+Fix the tests/)
  expect(all).toMatch(/Explore\s+Map the code/)
  expect(all).toMatch(/scout\s+Ship it/)
  await ui.unmount()
})

test('/progress off stops the bars popping up, and is remembered', async ($, on) => {
  engine(on)
  mock.store(on)
  mock.clock(on, { now: 1_000_000 })
  on('ui.render', ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text>engine</Text>
  })
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  const off = await $.command.run({ command: 'progress', args: 'off' } as any)
  expect(String((off as any).text)).toContain('is off')
  await spawn($, 'Quiet job')
  let ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect((await ui.find({ type: 'Text' }))?.text).toBe('engine')
  await ui.unmount()

  // remembered: a new session starts with it off
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect((await ui.find({ type: 'Text' }))?.text).toBe('engine')
  await ui.unmount()

  // /progress still shows them on demand, in the chat
  const OUT = { plugin: 'agent-progress', component: 'CommandOutput', requestId: 'm2', props: { command: 'progress', args: '', text: '', isErrored: false } } as const
  ui = await $.ui.mount({ ...OUT, surface: 'terminal' } as any)
  expect(await texts(ui)).toContain('Quiet job')
  await ui.unmount()

  await $.command.run({ command: 'progress', args: 'toggle' } as any)
  ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await texts(ui)).toContain('Quiet job')
  await ui.unmount()
})

test('finished agents show when they finished, and Earlier groups each batch with its time', { timeoutMs: 30_000 }, async ($, on) => {
  engine(on)
  const clock = mock.clock(on, { now: Date.UTC(2026, 10, 21, 15, 0, 0) })
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await spawn($, 'Old job')
  await clock.advance(16_000)
  await $.turn.complete({ answer: 'ok', durationMs: 1, isAborted: false, turnId: 'a', agentId: 'agent-1' } as any)
  await clock.advance(120_000)
  await spawn($, 'New job')
  await clock.advance(5_000)
  await $.turn.complete({ answer: 'ok', durationMs: 1, isAborted: false, turnId: 'b', agentId: 'agent-2' } as any)

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  let all = await texts(ui)
  expect(all).toMatch(/New job[\s\S]*\d{1,2}:\d{2}/)
  await ui.press({ key: 'earlier' })
  all = await texts(ui)
  expect(all).toMatch(/\d{1,2}:\d{2}.*· 1 agent · took 16s/)
  expect(all).toContain('Old job')
  await ui.press({ key: 'agent-1' })
  all = await texts(ui)
  expect(all).toMatch(/Started \d{1,2}:\d{2}.* · finished \d{1,2}:\d{2}.* · took 16s/)
  await ui.unmount()
})

test('the table sits on the terminal\'s own background, dark or light', async ($, on) => {
  engine(on)
  seen.theme = 'dark'
  seen.opened = []
  mock.clock(on, { now: 1_000_000 })
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.command.run({ command: 'progress', args: '' } as any)
  seen.theme = 'light'
  await $.command.run({ command: 'progress', args: '' } as any)
  expect(seen.opened.filter(Boolean)).toEqual(['transparent', 'transparent'])
  seen.theme = 'dark'
})
