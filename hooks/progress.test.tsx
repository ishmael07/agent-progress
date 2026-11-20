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

const seen = { prompt: '', explainPrompt: '' }

/** Stands in for the engine beneath the mod. */
function engine(on: On) {
  on('turn.complete', () => ({ text: 'ok' }))
  on('command.register', () => ({ value: { command: 'progress' } }))
  on('tool.register', () => ({ value: { tool: 'mcp__agent-progress__progress' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
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
    return { model: 'opus', agentId: `agent-${++n}` }
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
  expect(all).toContain('Step 2 of 4: Write the harness')
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

test('a finished agent turns done, and the pane shows the table and overall bar', { timeoutMs: 30_000 }, async ($, on) => {
  engine(on)
  const clock = mock.clock(on, { now: 1_000_000 })
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await spawn($, 'Write the docs')
  await spawn($, 'Fix the tests')
  await clock.advance(90_000)
  await $.turn.complete({ answer: 'ok', durationMs: 90_000, isAborted: false, turnId: 'x', agentId: 'agent-1', reason: 'completed' } as any)

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    const all = await texts(ui)
    expect(all).toContain('Working on')
    expect(all).toContain('Write the docs')
    expect(all).toContain('Done')
    expect(all).toContain('Fix the tests')
    expect(all).toContain('Overall')
    expect(all).toContain('1 of 2 working')
    await ui.unmount()
  }
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
