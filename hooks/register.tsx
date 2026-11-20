import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, RenderNode } from 'claude-code'

import type { Row, RowStatus, Step, StepStatus } from '../types'

const PANE = 'agent-progress'
const COMMAND = 'progress'
const TOOL = 'progress'
const TOOL_FULL = 'mcp__agent-progress__progress'
/** How long a finished row stays in the band above the prompt. */
const LINGER_MS = 30_000
/** The animation's frame time while anything runs. */
const FRAME_MS = 250
/** How long an agent gets to explain itself before the mod writes its line. */
const EXPLAIN_AFTER_MS = 4_000

const rowsAtom = atom({ plugin: 'agent-progress', key: 'rows' } as const, [], { shape: 'rows-1' })
const nowAtom = atom({ plugin: 'agent-progress', key: 'now' } as const, 0)
const batchAtom = atom({ plugin: 'agent-progress', key: 'batchStart' } as const, 0)
const hiddenAtom = atom({ plugin: 'agent-progress', key: 'isBandHidden' } as const, false)
const requestAtom = atom({ plugin: 'agent-progress', key: 'request' } as const, '')
const expandedAtom = atom({ plugin: 'agent-progress', key: 'expanded' } as const, [])
const explainedAtom = atom({ plugin: 'agent-progress', key: 'isExplained' } as const, false)

const NUDGE = [
  `Required progress reporting: the user watches a live progress bar for you. If you have the \`${TOOL_FULL}\` tool, your very first action must be to call it with:`,
  `- \`steps\`: your plan as 2-6 short steps in plain everyday words a non-programmer would follow ("Find where logins are handled", not "grep auth middleware")`,
  `- \`purpose\`: one plain sentence on how your work helps the user's overall goal, starting "Claude is" (for example "Claude is reading your login code so it can find why sign-in breaks.")`,
  `- \`done: 0\``,
  `After you finish each step, call it again with \`done\` set to how many steps are finished. Do this even for small tasks. It costs nothing and does not change how you do the work.`,
  '',
  '---',
  '',
].join('\n')

// ---------------------------------------------------------------- measuring

type Measure = { value: number; isExact: boolean }

const isLive = (row: Row) => row.status === 'running'

/**
 * How far along a row is. A checklist gives the steps done; within the step
 * under way the bar keeps moving, slowing as it nears the next step's mark
 * and never passing it, so it reads as a loading bar and never lies.
 */
export function measure(row: Row, all: readonly Row[], now: number): Measure {
  if (row.status === 'done') return { value: 1, isExact: true }

  if (row.kind === 'workflow') {
    const kids = all.filter(r => r.parent === row.id)
    if (kids.length === 0) return { value: 0, isExact: false }
    const sum = kids.reduce((s, k) => s + measure(k, all, now).value, 0)
    return { value: Math.min(0.95, sum / kids.length), isExact: false }
  }

  if (row.steps.length > 0) {
    const total = row.steps.length
    const done = row.steps.filter(s => s.status === 'completed').length
    let value = done / total
    if (isLive(row) && done < total) {
      const stepAt = row.stepAt ?? row.startedAt
      const perStep = done > 0 ? Math.max(5_000, (stepAt - row.startedAt) / done) : 40_000
      value += (0.85 * (1 - Math.exp(-(now - stepAt) / perStep))) / total
    }
    return { value: Math.min(isLive(row) ? 0.99 : 1, value), isExact: true }
  }

  // No checklist: an estimate from its activity and time, which slows as it
  // goes and never claims to be finished.
  const effort = row.tools + Math.max(0, now - row.startedAt) / 10_000
  return { value: Math.min(0.9, 1 - Math.exp(-effort / 15)), isExact: false }
}

/** Milliseconds left, when there is enough to go on. */
export function etaOf(row: Row, m: Measure, now: number): number | undefined {
  if (!isLive(row)) return undefined
  const elapsed = now - row.startedAt
  if (m.value < 0.05 || elapsed < 5_000) return undefined
  return (elapsed * (1 - m.value)) / m.value
}

export function overall(rows: readonly Row[], now: number, batchStart: number) {
  const top = rows.filter(r => !r.parent && r.startedAt >= batchStart)
  if (top.length === 0) return undefined
  const ms = top.map(r => measure(r, rows, now))
  const value = ms.reduce((s, m) => s + m.value, 0) / top.length
  const etas = top
    .map((r, i) => etaOf(r, ms[i]!, now))
    .filter((x): x is number => x !== undefined)
  const running = top.filter(isLive).length
  const lastEnd = Math.max(...top.map(r => r.endedAt ?? now))
  const start = Math.min(...top.map(r => r.startedAt))
  return {
    value,
    isExact: ms.every(m => m.isExact),
    // Agents run side by side, so the batch is done when the slowest is.
    eta: running > 0 && etas.length > 0 ? Math.max(...etas) : undefined,
    elapsed: (running > 0 ? now : lastEnd) - start,
    running,
    total: top.length,
  }
}

// ---------------------------------------------------------------- formatting

export function duration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000))
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ${String(s % 60).padStart(2, '0')}s`
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`
}

function fit(text: string, width: number): string {
  if (width <= 0) return ''
  const one = text.replace(/\s+/g, ' ').trim()
  if (one.length <= width) return one.padEnd(width)
  return width === 1 ? '…' : one.slice(0, width - 1) + '…'
}

const pct = (m: Measure) => `${m.isExact ? '' : '~'}${Math.round(m.value * 100)}%`

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1)

const SPIN = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']

function glyph(status: RowStatus, now: number) {
  switch (status) {
    case 'done':
      return { text: '✔', color: 'success' }
    case 'failed':
      return { text: '✘', color: 'error' }
    case 'stopped':
      return { text: '■', color: 'warning' }
    default:
      return { text: SPIN[Math.floor(now / 100) % SPIN.length]!, color: 'suggestion' }
  }
}

const fillColor = (status: RowStatus) =>
  status === 'done'
    ? 'success'
    : status === 'failed'
      ? 'error'
      : status === 'stopped'
        ? 'warning'
        : 'suggestion'

/** What the row is on now, in plain words: its current step, else its last action. */
function nowDoing(row: Row): string {
  if (row.status === 'done') return 'Finished'
  if (row.status === 'failed') return 'Ran into a problem and stopped'
  if (row.status === 'stopped') return 'Stopped'
  const at = row.steps.findIndex(s => s.status === 'in_progress')
  const next = at >= 0 ? at : row.steps.findIndex(s => s.status === 'pending')
  if (next >= 0) return `Step ${next + 1} of ${row.steps.length}: ${row.steps[next]!.subject}`
  if (row.kind === 'workflow') return row.detail || 'Working'
  return row.detail || 'Getting started'
}

function statusWords(row: Row): string {
  switch (row.status) {
    case 'done':
      return 'Done'
    case 'failed':
      return 'Failed'
    case 'stopped':
      return 'Stopped'
    default:
      return 'Working'
  }
}

const STEP_GLYPH: Record<StepStatus, { text: string; color?: string }> = {
  completed: { text: '✔', color: 'success' },
  in_progress: { text: '›', color: 'suggestion' },
  pending: { text: '○' },
}

// ---------------------------------------------------------------- reading tool calls

const base = (path: unknown) => String(path ?? '').split('/').pop() ?? ''

/** What a command is for, in everyday words, when its description is missing. */
function plainCommand(cmd: string): string {
  const c = cmd.trim()
  if (/\b(test|jest|vitest|pytest|mocha|spec)\b/.test(c)) return 'Running the tests'
  if (/\b(build|tsc|compile|webpack|vite build|make)\b/.test(c)) return 'Building the project'
  if (/\b(npm|pnpm|yarn|bun|pip|brew) (i|install|add)\b/.test(c)) return 'Installing packages'
  if (/\b(lint|eslint|prettier|ruff|black)\b/.test(c)) return 'Checking code style'
  if (/^git (status|diff|log|show)\b/.test(c)) return 'Looking at recent changes'
  if (/^git (commit|add)\b/.test(c)) return 'Saving changes to git'
  if (/^git push\b/.test(c)) return 'Pushing changes'
  if (/^(curl|wget)\b/.test(c)) return 'Downloading something'
  if (/^(ls|find|tree|cat|head|tail|sed -n|grep|rg|wc)\b/.test(c)) return 'Looking through files'
  if (/^(mkdir|cp|mv|rm|touch)\b/.test(c)) return 'Moving files around'
  return 'Running a command'
}

export function describe(tool: string, a: Record<string, unknown>): string {
  const clip = (s: unknown) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, 80)
  switch (tool) {
    case 'Bash':
      return a.description ? cap(clip(a.description)) : plainCommand(String(a.command ?? ''))
    case 'Read':
      return `Reading ${base(a.file_path)}`
    case 'Edit':
    case 'MultiEdit':
      return `Editing ${base(a.file_path)}`
    case 'Write':
      return `Writing ${base(a.file_path)}`
    case 'NotebookEdit':
      return `Editing ${base(a.notebook_path)}`
    case 'Grep':
      return `Searching the code for "${clip(a.pattern).slice(0, 30)}"`
    case 'Glob':
      return 'Finding files'
    case 'WebSearch':
      return `Searching the web for "${clip(a.query).slice(0, 40)}"`
    case 'WebFetch':
      return 'Reading a web page'
    case 'Agent':
    case 'Task':
      return `Handing off: ${clip(a.description) || 'a helper task'}`
    case 'ToolSearch':
      return 'Getting its tools ready'
    case 'TodoWrite':
    case 'TaskCreate':
    case 'TaskUpdate':
      return 'Updating its plan'
    case 'Skill':
      return 'Looking up how to do this'
    default: {
      if (tool.includes('chrome') || tool.includes('Browser')) return 'Using the browser'
      const short = tool.startsWith('mcp__') ? tool.split('__').slice(2).join(' ') : tool
      return cap(short.replace(/[_-]/g, ' '))
    }
  }
}

export function workflowMeta(a: Record<string, unknown>) {
  const script = typeof a.script === 'string' ? a.script : ''
  const name =
    /name\s*:\s*['"`]([^'"`]+)['"`]/.exec(script)?.[1] ??
    (typeof a.name === 'string' ? a.name : undefined) ??
    (typeof a.scriptPath === 'string' ? base(a.scriptPath).replace(/\.\w+$/, '') : undefined) ??
    'workflow'
  const task = /description\s*:\s*['"`]([^'"`]+)['"`]/.exec(script)?.[1] ?? ''
  return { name, task }
}

/** Steps from the plan the agent reported: the first `done` are finished. */
export function stepsFrom(plan: readonly string[], done: number, isLiveRow: boolean): Step[] {
  return plan.map((subject, i) => ({
    id: String(i),
    subject,
    status: (i < done ? 'completed' : i === done && isLiveRow ? 'in_progress' : 'pending') as StepStatus,
  }))
}

/** One sentence, cleaned: no quotes, no trailing chatter, a full stop. */
export function sentence(text: string): string {
  const one = text.replace(/\s+/g, ' ').trim()
  const first = (/^(.+?[.!?])["'”]?(\s|$)/.exec(one)?.[1] ?? one).replace(/^["'“]+|["'”]+$/g, '')
  const clipped = first.length > 160 ? first.slice(0, 159).trimEnd() + '…' : first
  return /[.!?…]$/.test(clipped) ? clipped : clipped + '.'
}

// ---------------------------------------------------------------- state changes

/** Applies `fn` to the row `id`; `make` builds it first when missing. */
async function touch($: EngineInterface, id: string, fn: (row: Row) => Row, make?: () => Row) {
  await update($, rowsAtom, rows => {
    const at = rows.findIndex(r => r.id === id)
    if (at < 0) return make ? [...rows, fn(make())].slice(-200) : rows
    const next = rows.slice()
    next[at] = fn(rows[at]!)
    return next
  })
}

/** Starts a new batch when nothing was running. */
async function beginBatch($: EngineInterface, now: number) {
  const rows = await read($, rowsAtom)
  if (!rows.some(r => isLive(r) && !r.parent)) await update($, batchAtom, () => now)
}

function mainRow(now: number): Row {
  return {
    id: 'main',
    kind: 'main',
    title: 'Your request',
    task: '',
    detail: '',
    startedAt: now,
    stepAt: now,
    status: 'running',
    steps: [],
    tools: 0,
  }
}

/** Keeps the main checklist's status in step with its checklist. */
function settle(row: Row, now: number): Row {
  if (row.kind !== 'main') return row
  const isDone = row.steps.length > 0 && row.steps.every(s => s.status === 'completed')
  if (isDone && row.status !== 'done') return { ...row, status: 'done', endedAt: now }
  if (!isDone && row.status === 'done') return { ...row, status: 'running', endedAt: undefined }
  return row
}

const doneCount = (steps: readonly Step[]) => steps.filter(s => s.status === 'completed').length

async function setSteps($: EngineInterface, id: string, steps: (old: Step[]) => Step[]) {
  const now = await $.clock.now()
  if (id === 'main') {
    const rows = await read($, rowsAtom)
    if (!rows.some(r => r.id === 'main')) await beginBatch($, now)
  }
  await touch(
    $,
    id,
    row => {
      const next = steps(row.steps)
      // a step finished: the next one starts its clock now
      const moved = doneCount(next) !== doneCount(row.steps) || row.steps.length === 0
      return settle({ ...row, steps: next, stepAt: moved ? now : row.stepAt }, now)
    },
    id === 'main' ? () => mainRow(now) : undefined,
  )
}

async function end($: EngineInterface, id: string, status: RowStatus) {
  const now = await $.clock.now()
  await touch($, id, row =>
    row.status === 'running' || status === 'failed'
      ? {
          ...row,
          status,
          endedAt: row.endedAt ?? now,
          // a finished agent's checklist is finished, whatever it last said
          steps:
            status === 'done'
              ? row.steps.map(s => ({ ...s, status: 'completed' as const }))
              : row.steps,
        }
      : row,
  )
}

const toggle = (id: string) => (list: readonly string[]) =>
  list.includes(id) ? list.filter(x => x !== id) : [...list, id]

/** Writes the plain "how this helps" line for a row that has none. */
async function explain($: EngineInterface, row: Row) {
  const request = (await read($, requestAtom)).slice(0, 800)
  const prompt = [
    "A coding assistant called Claude split the user's request into parts and handed one part to a helper agent.",
    `The user's request: ${request || '(not known)'}`,
    `The helper's task, in a few words: ${row.title}`,
    row.brief ? `The start of the helper's instructions: ${row.brief.slice(0, 700)}` : '',
    '',
    'Write ONE short sentence (at most 22 words) in plain everyday words a non-programmer understands, saying what this helper is doing and how it helps the user\'s request. Start with "Claude is". Name the concrete thing, avoid jargon and file names. Reply with the sentence only.',
  ]
    .filter(Boolean)
    .join('\n')
  const r = await $.model.complete({ model: 'haiku', prompt, maxTokens: 80, timeoutMs: 20_000 })
  const text = r.isAnswered && r.text.trim() ? sentence(r.text) : ''
  await touch($, row.id, x => (x.purpose ? x : { ...x, purpose: text || `Claude is working on: ${row.title}.` }))
}

// ---------------------------------------------------------------- the mod

export const register: Register = on => {
  /** Rows whose line is being written, so each is asked once. */
  const explaining = new Set<string>()

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: COMMAND,
      description: 'Show progress of your agents, subagents and workflows',
      argumentHint: '[explain | hide | show | clear]',
    })
    await $.tool.register({
      name: TOOL,
      description:
        "Drives the user's live progress bar for you. Call it FIRST, before any other tool, with `steps` (your plan, 2-6 short plain-language items), `purpose` (one plain sentence starting \"Claude is\" on how your work helps the user's goal) and `done: 0`; then after each step you finish, with the new `done` count. Resend `steps` if the plan changes.",
      inputSchema: {
        type: 'object',
        properties: {
          steps: {
            type: 'array',
            items: { type: 'string' },
            description: 'Your whole plan, in order, a few plain everyday words per step',
          },
          purpose: {
            type: 'string',
            description:
              'One plain sentence, starting "Claude is", on how your work helps the user\'s overall goal',
          },
          done: { type: 'number', description: 'How many steps are finished' },
        },
        required: ['done'],
      },
      isDeferred: false,
    })

    await update($, nowAtom, () => Date.now())
    // The animation clock: it writes only while something is moving, and
    // hands rows that have no "how this helps" line to the explainer.
    $.clock.every(FRAME_MS, () => {
      void (async () => {
        const [rows, now] = await Promise.all([read($, rowsAtom), $.clock.now()])
        const isMoving = rows.some(
          r => isLive(r) || (r.endedAt !== undefined && now - r.endedAt < LINGER_MS + 2_000),
        )
        if (isMoving) await update($, nowAtom, () => now)
        for (const row of rows) {
          if (row.purpose || row.kind === 'main' || explaining.has(row.id)) continue
          if (isLive(row) && now - row.startedAt < EXPLAIN_AFTER_MS) continue
          explaining.add(row.id)
          void explain($, row).catch(() => explaining.delete(row.id))
        }
      })()
    })

    return next(e)
  })

  on('prompt.submit', async ($, e, next) => {
    await update($, requestAtom, () => e.text.slice(0, 2_000))
    // A finished checklist of the main conversation belongs to the last request.
    await update($, rowsAtom, rows => rows.filter(r => !(r.id === 'main' && r.status === 'done')))
    return next(e)
  })

  // ---- agents and workflows starting

  on('agent.spawn', async ($, e, next) => {
    const isWorkflow = e.workflow !== undefined
    const prompt = e.resume || e.prompt.includes(TOOL_FULL) ? e.prompt : NUDGE + e.prompt
    const res = await next({ ...e, prompt })
    if (res.deny !== undefined || !res.agentId) return res

    const now = await $.clock.now()
    const parent = isWorkflow ? `wf:${e.tool_use_id}` : undefined
    if (!parent) await beginBatch($, now)

    await touch(
      $,
      res.agentId,
      row => (e.resume ? { ...row, status: 'running', endedAt: undefined } : row),
      () => ({
        id: res.agentId!,
        kind: 'agent',
        title: cap(e.description || e.name || `Helper ${isWorkflow ? e.workflow!.agentIndex : ''}`.trim()),
        task: e.name ?? '',
        detail: 'Getting started',
        brief: e.prompt.slice(0, 1_200),
        parent,
        startedAt: now,
        stepAt: now,
        status: 'running',
        steps: [],
        tools: 0,
      }),
    )
    if (parent) {
      await touch(
        $,
        parent,
        row => (isLive(row) ? row : { ...row, status: 'running', endedAt: undefined }),
        () => ({
          id: parent,
          kind: 'workflow',
          title: 'Workflow',
          task: '',
          detail: '',
          startedAt: now,
          status: 'running',
          steps: [],
          tools: 0,
        }),
      )
    }
    return res
  })

  // ---- what they do

  on('tool.offer', { tool: TOOL_FULL }, ($, e) => ({ isOffered: e.agentId !== undefined })).catch(
    ($, e, next) => next(e),
  )

  on('tool.run', { tool: TOOL_FULL }, async ($, e) => {
    const a = e as unknown as Record<string, unknown>
    const id = e.agentId ?? 'main'
    const done = Math.max(0, Math.floor(Number(a.done) || 0))
    const plan = Array.isArray(a.steps) ? a.steps.map(String).filter(Boolean) : undefined
    await setSteps($, id, old => stepsFrom(plan ?? old.map(s => s.subject), done, true))
    if (typeof a.purpose === 'string' && a.purpose.trim()) {
      const purpose = sentence(a.purpose)
      await touch($, id, row => ({ ...row, purpose }))
    }
    return { result: 'Recorded.' }
  })

  on('tool.call', async ($, e, next) => {
    if (e.tool === TOOL_FULL) return next(e)
    const a = e as unknown as Record<string, unknown>
    const id = e.agentId ?? 'main'

    if (e.agentId) {
      await touch($, e.agentId, row => ({ ...row, tools: row.tools + 1, detail: describe(e.tool, a) }))
    }

    if (e.tool === 'Workflow') {
      const now = await $.clock.now()
      const { name, task } = workflowMeta(a)
      const title = cap((task || name).replace(/[-_]/g, ' '))
      await beginBatch($, now)
      const wf = `wf:${e.tool_use_id}`
      await touch(
        $,
        wf,
        row => ({ ...row, title, task: name, brief: task || row.brief }),
        () => ({
          id: wf,
          kind: 'workflow',
          title,
          task: name,
          brief: task,
          detail: 'Starting up',
          startedAt: now,
          status: 'running',
          steps: [],
          tools: 0,
        }),
      )
    }

    if (e.tool === 'TodoWrite' && Array.isArray(a.todos)) {
      const todos = a.todos as { content?: string; activeForm?: string; status?: StepStatus }[]
      await setSteps($, id, () =>
        todos.map((t, i) => ({
          id: `todo-${i}`,
          subject: String((t.status === 'in_progress' ? t.activeForm : t.content) ?? t.content ?? ''),
          status: t.status ?? 'pending',
        })),
      )
    }

    const ran = await next(e)
    if (ran.deny !== undefined || ran.isError) return ran

    if (e.tool === 'TaskCreate') {
      const task = (ran.result as { task?: { id?: string; subject?: string } } | undefined)?.task
      if (task?.id) {
        const step: Step = { id: task.id, subject: String(task.subject ?? a.subject ?? ''), status: 'pending' }
        await setSteps($, id, old => [...old.filter(s => s.id !== step.id), step])
      }
    }

    if (e.tool === 'TaskUpdate' && typeof a.taskId === 'string') {
      const taskId = a.taskId
      const rows = await read($, rowsAtom)
      // A task belongs to whoever made it, wherever it is updated from.
      const owner = rows.find(r => r.steps.some(s => s.id === taskId))?.id ?? id
      const status = a.status as StepStatus | 'deleted' | undefined
      await setSteps($, owner, old => {
        if (status === 'deleted') return old.filter(s => s.id !== taskId)
        return old.map(s =>
          s.id === taskId
            ? {
                ...s,
                subject: typeof a.subject === 'string' ? a.subject : s.subject,
                status: status ?? s.status,
              }
            : s,
        )
      })
    }
    return ran
  })

  // ---- endings

  on('turn.complete', async ($, e, next) => {
    const res = await next(e)
    if (e.agentId) await end($, e.agentId, e.isAborted ? 'stopped' : 'done')
    return res
  })

  on('agent.report', async ($, e, next) => {
    const res = await next(e)
    await end($, e.agentId, e.status === 'completed' ? 'done' : e.status === 'failed' ? 'failed' : 'stopped')
    return res
  })

  on('session.receive', async ($, e, next) => {
    const res = await next(e)
    if (e.origin.kind !== 'task-notification') return res
    const rows = await read($, rowsAtom)
    const wf = rows.find(r => r.kind === 'workflow' && e.text.includes(r.id.slice(3)))
    if (wf) {
      const said = /<status>\s*([a-z_]+)\s*<\/status>/i.exec(e.text)?.[1]?.toLowerCase() ?? 'completed'
      const status: RowStatus =
        said === 'failed' ? 'failed' : said === 'killed' || said === 'stopped' ? 'stopped' : 'done'
      await end($, wf.id, status)
      // its agents are over too
      for (const kid of rows.filter(r => r.parent === wf.id && isLive(r))) await end($, kid.id, status)
    }
    return res
  })

  // ---- the command

  on('command.run', { command: COMMAND }, async ($, e) => {
    const arg = e.args.trim().toLowerCase()
    if (arg === 'hide') {
      await update($, hiddenAtom, () => true)
      return { text: 'Progress line hidden. `/progress show` brings it back.' }
    }
    if (arg === 'show') {
      await update($, hiddenAtom, () => false)
      return { text: 'Progress line shown.' }
    }
    if (arg === 'explain') {
      const isOn = !(await read($, explainedAtom))
      await update($, explainedAtom, () => isOn)
      return {
        text: isOn
          ? 'Every agent now shows how it helps. `/progress explain` again to fold them.'
          : 'Folded. Click an agent to open just that one.',
      }
    }
    if (arg === 'clear') {
      await update($, rowsAtom, rows => rows.filter(isLive))
      return { text: 'Cleared finished agents.' }
    }
    const { isPlaced } = await $.ui.open({ id: PANE, title: 'Agent progress' })
    if (isPlaced) return { text: 'Opened the agent progress pane.' }
    return { text: plainTable(await read($, rowsAtom), await $.clock.now(), await read($, batchAtom)) }
  })

  // ---- drawing

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey || (await read($, hiddenAtom))) return next(e)
    const [rows, tick, batchStart, expanded, isExplained] = await Promise.all([
      read($, rowsAtom),
      read($, nowAtom),
      read($, batchAtom),
      read($, expandedAtom),
      read($, explainedAtom),
    ])
    const now = Math.max(tick, ...rows.map(r => r.startedAt))
    const shown = rows.filter(
      r => !r.parent && (isLive(r) || (r.endedAt !== undefined && now - r.endedAt < LINGER_MS)),
    )
    if (shown.length === 0) return next(e)

    const { Box, Button, Text } = $.ui.resolve(e)
    const W = Math.max(40, e.props.bodyColumns)
    const all = overall(rows, now, batchStart)

    // One line per agent: what it's working on, its bar, and what it's doing right now.
    const barW = W >= 120 ? 20 : W >= 90 ? 14 : 10
    const titleW = Math.min(40, Math.max(14, Math.floor(W * 0.3)))
    const doingW = Math.max(0, W - 4 - titleW - 2 - barW - 6 - 2)

    const running = shown.filter(isLive).length
    const head =
      (running > 0 ? `${running} ${running === 1 ? 'agent' : 'agents'} working` : 'All done') +
      (all && running > 0 ? ` · ${pct(all)} overall` : '') +
      (all?.eta !== undefined ? ` · about ${duration(all.eta)} left` : '')

    // Room: the header, a line per row, and the opened rows' extra lines.
    let room = Math.max(2, Math.min(14, e.props.maxRows)) - 1
    const lines: RenderNode[] = []
    let more = 0
    for (const row of shown) {
      if (room < 1) {
        more += 1
        continue
      }
      room -= 1
      const isOpen = isExplained || expanded.includes(row.id)
      const m = measure(row, rows, now)
      const g = glyph(row.status, now)
      const eta = etaOf(row, m, now)
      const doing = nowDoing(row) + (eta !== undefined ? ` · ~${duration(eta)} left` : '')
      lines.push(
        <Button key={row.id} plain onPress={() => update($, expandedAtom, toggle(row.id))}>
          <Text color={g.color}>{g.text} </Text>
          <Text dimColor>{isOpen ? '▾ ' : '▸ '}</Text>
          <Text bold>{fit(row.title, titleW)}  </Text>
          {bar(Text, m.value, barW, fillColor(row.status), isLive(row), now)}
          <Text>{pct(m).padStart(5)}  </Text>
          {doingW > 8 ? <Text dimColor>{fit(doing, doingW)}</Text> : ''}
        </Button>,
      )
      const extra = 1 + (row.steps.length ? 1 : 0)
      if (isOpen && room >= extra) {
        room -= extra
        lines.push(
          <Text wrap="truncate">
            {'    '}
            <Text italic dimColor={!row.purpose}>{row.purpose ?? 'Writing a plain summary…'}</Text>
          </Text>,
        )
        if (row.steps.length) lines.push(stepLine(Text, row, W - 4))
      }
    }

    return (
      <Box flexDirection="column">
        <Text dimColor wrap="truncate">
          {head}
        </Text>
        {lines}
        {more > 0 && <Text dimColor>{`  +${more} more · /progress`}</Text>}
      </Box>
    )
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Button, Text } = $.ui.resolve(e)
    const [rows, tick, batchStart, expanded, isExplained] = await Promise.all([
      read($, rowsAtom),
      read($, nowAtom),
      read($, batchAtom),
      read($, expandedAtom),
      read($, explainedAtom),
    ])
    const now = Math.max(tick, ...rows.map(r => r.startedAt), 0)
    if (rows.length === 0) {
      return (
        <Box flexDirection="column">
          <Text dimColor>No agents yet.</Text>
          <Text dimColor>Each one shows up here as soon as it starts.</Text>
        </Box>
      )
    }

    const W = Math.max(50, e.props.bodyColumns)
    const nameW = Math.min(36, Math.max(16, Math.floor(W * 0.24)))
    const barW = W >= 130 ? 22 : 14
    const statusW = 18
    const timeW = 22
    const doingW = Math.max(0, W - 2 - nameW - 1 - barW - 7 - statusW - timeW - 2)
    // Too narrow for a table that keeps the titles whole: two lines per agent.
    const isNarrow = W < 120

    // Workflows and lone agents first, each workflow's agents under it.
    const ordered: { row: Row; depth: number }[] = []
    for (const row of rows.filter(r => !r.parent)) {
      ordered.push({ row, depth: 0 })
      for (const kid of rows.filter(r => r.parent === row.id)) ordered.push({ row: kid, depth: 1 })
    }
    const room = Math.max(3, (e.viewport?.rows ?? 30) - 8)
    const visible = ordered.slice(-room)
    const all = overall(rows, now, batchStart)

    return (
      <Box flexDirection="column">
        {isNarrow ? (
          ''
        ) : (
        <Text bold wrap="truncate">
          {'  '}
          {fit('Working on', nameW)} {fit('Progress', barW + 7)}
          {fit('Status', statusW)}
          {doingW > 8 ? fit('Right now', doingW) + ' ' : ''}
          {fit('Time', timeW)}
        </Text>
        )}
        {visible.map(({ row, depth }) => {
          const m = measure(row, rows, now)
          const g = glyph(row.status, now)
          const eta = etaOf(row, m, now)
          const elapsed = (row.endedAt ?? now) - row.startedAt
          const time = isLive(row)
            ? `${duration(elapsed)}${eta !== undefined ? ` · ~${duration(eta)} left` : ''}`
            : duration(elapsed)
          const name = (depth ? '  └ ' : '') + row.title
          const isOpen = isExplained || expanded.includes(row.id)
          const pad = depth ? '        ' : '    '
          return (
            <Box flexDirection="column" marginBottom={isNarrow || isOpen ? 1 : 0}>
              {isNarrow ? (
                <Button key={row.id} plain onPress={() => update($, expandedAtom, toggle(row.id))}>
                  <Text dimColor>{isOpen ? '▾ ' : '▸ '}</Text>
                  <Text bold={depth === 0}>{fit(name, Math.max(10, W - 2 - 30))}</Text>
                  <Text color={g.color}>{'  ' + g.text} </Text>
                  <Text color={isLive(row) ? 'suggestion' : undefined}>{fit(statusWords(row), 8)}</Text>
                  <Text dimColor>{fit(time, 18)}</Text>
                </Button>
              ) : (
              <Button key={row.id} plain onPress={() => update($, expandedAtom, toggle(row.id))}>
                <Text dimColor>{isOpen ? '▾ ' : '▸ '}</Text>
                <Text bold={depth === 0}>{fit(name, nameW)} </Text>
                {bar(Text, m.value, barW, fillColor(row.status), isLive(row), now)}
                <Text>{pct(m).padStart(5)}  </Text>
                <Text color={g.color}>{g.text} </Text>
                <Text color={isLive(row) ? 'suggestion' : undefined}>{fit(statusWords(row), statusW - 2)}</Text>
                {doingW > 8 ? <Text dimColor>{fit(nowDoing(row), doingW)} </Text> : ''}
                <Text dimColor>{fit(time, timeW)}</Text>
              </Button>
              )}
              {isNarrow && (
                <Text wrap="truncate">
                  {pad}
                  {bar(Text, m.value, Math.max(10, Math.min(30, W - 50)), fillColor(row.status), isLive(row), now)}
                  <Text>{pct(m).padStart(5)}  </Text>
                  <Text dimColor>{nowDoing(row)}</Text>
                </Text>
              )}
              {isOpen && (
                <Box flexDirection="column">
                  {row.kind !== 'main' && (
                    <Text>
                      {pad}
                      <Text italic dimColor={!row.purpose}>{row.purpose ?? 'Writing a plain summary…'}</Text>
                    </Text>
                  )}
                  {row.steps.map((s, i) => (
                    <Text wrap="truncate">
                      {pad}
                      <Text color={STEP_GLYPH[s.status].color}>{STEP_GLYPH[s.status].text} </Text>
                      <Text dimColor={s.status === 'completed'}>{`${i + 1}. ${s.subject}`}</Text>
                    </Text>
                  ))}
                </Box>
              )}
            </Box>
          )
        })}
        {all && (
          <Box borderStyle="round" borderDimColor marginTop={1} paddingX={1}>
            <Text wrap="truncate">
              <Text bold>Overall  </Text>
              {bar(Text, all.value, Math.max(10, Math.min(48, W - 56)), 'success', all.running > 0, now)}
              <Text bold>{pct(all).padStart(5)}</Text>
              <Text dimColor>
                {`   ${all.running > 0 ? `${all.running} of ${all.total} working` : `${all.total} done`} · ${duration(all.elapsed)}` +
                  (all.eta !== undefined ? ` · ~${duration(all.eta)} left` : '')}
              </Text>
            </Text>
          </Box>
        )}
      </Box>
    )
  })
}

// ---------------------------------------------------------------- pieces

type TextEl = (props: {
  color?: string
  backgroundColor?: string
  dimColor?: boolean
  wrap?: string
  children?: unknown
}) => RenderNode

const EIGHTHS = ['', '▏', '▎', '▍', '▌', '▋', '▊', '▉']

/**
 * A bar filled to an eighth of a cell. While it runs, a soft glint sweeps
 * along the filled part, so a bar that is waiting still looks alive.
 */
function bar(T: unknown, value: number, width: number, color: string, isMoving: boolean, now: number) {
  const Text = T as TextEl
  const cells = Math.max(0, Math.min(1, value)) * width
  const eighths = Math.round((cells - Math.floor(cells)) * 8)
  const full = Math.min(width, Math.floor(cells) + (eighths === 8 ? 1 : 0))
  const part = eighths === 0 || eighths === 8 || full >= width ? '' : EIGHTHS[eighths]!
  const rest = Math.max(0, width - full - (part ? 1 : 0))

  let before = full
  let glint = 0
  if (isMoving && full >= 3) {
    const at = Math.floor(now / 90) % (full + 8)
    if (at < full) {
      before = at
      glint = Math.min(2, full - at)
    }
  }
  const after = full - before - glint

  return (
    <Text>
      <Text color={color}>{'█'.repeat(before)}</Text>
      {glint > 0 ? (
        <Text color={color} dimColor>
          {'█'.repeat(glint)}
        </Text>
      ) : (
        ''
      )}
      {after > 0 ? <Text color={color}>{'█'.repeat(after)}</Text> : ''}
      {part ? (
        <Text color={color} backgroundColor="subtle">
          {part}
        </Text>
      ) : (
        ''
      )}
      <Text color="subtle">{'█'.repeat(rest)}</Text>
    </Text>
  )
}

/** The checklist on one line: ✔ done · › under way · ○ still to do. */
function stepLine(T: unknown, row: Row, width: number) {
  const Text = T as TextEl
  let left = width
  const parts: RenderNode[] = []
  for (const s of row.steps) {
    if (left < 10) break
    const g = STEP_GLYPH[s.status]
    const words = fit(s.subject, Math.min(32, Math.max(8, left - 4))).trimEnd()
    left -= words.length + 5
    parts.push(
      <Text>
        <Text color={g.color}>{g.text} </Text>
        <Text dimColor={s.status !== 'in_progress'}>{words}   </Text>
      </Text>,
    )
  }
  return (
    <Text wrap="truncate">
      {'    '}
      {parts}
    </Text>
  )
}

/** The pane's table as text, for a terminal too narrow to seat the pane. */
export function plainTable(rows: readonly Row[], now: number, batchStart: number): string {
  if (rows.length === 0) return 'No agents yet.'
  const lines: string[] = []
  for (const row of rows) {
    const m = measure(row, rows, now)
    const eta = etaOf(row, m, now)
    const filled = Math.round(m.value * 12)
    lines.push(
      [
        (row.parent ? '  └ ' : '') + row.title,
        '█'.repeat(filled) + '░'.repeat(12 - filled),
        pct(m),
        statusWords(row),
        nowDoing(row),
        duration((row.endedAt ?? now) - row.startedAt) + (eta !== undefined ? ` / ~${duration(eta)} left` : ''),
      ].join('  '),
    )
    if (row.purpose) lines.push(`    ${row.purpose}`)
  }
  const all = overall(rows, now, batchStart)
  if (all)
    lines.push(
      `Overall ${pct(all)} · ${duration(all.elapsed)}${all.eta !== undefined ? ` · ~${duration(all.eta)} left` : ''}`,
    )
  return lines.join('\n')
}
