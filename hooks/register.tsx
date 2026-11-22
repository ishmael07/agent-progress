// Agent Progress: live progress bars for Claude Code agents, subagents and
// workflows, in plain words. https://github.com/ishmael07/agent-progress

import { atom, read, update } from 'claude-code'
import type { EngineInterface, PluginOptions, Register, RenderNode } from 'claude-code'

import type { Row, RowStatus, Step, StepStatus } from '../types'

const PANE = 'agent-progress'
const COMMAND = 'progress'
const TOOL = 'progress'
const TOOL_FULL = 'mcp__agent-progress__progress'
/** How long a finished agent stays in the strip above the prompt. */
const LINGER_MS = 30_000
/** The animation's frame time while anything runs. */
const FRAME_MS = 250
/** How long an agent gets to explain itself before the mod writes its line. */
const EXPLAIN_AFTER_MS = 4_000
/** Where `/progress off` is remembered between sessions. */
const OFF_KEY = 'isOff'
/** A step's length before any step has finished, for the bar's motion. */
const FIRST_STEP_GUESS_MS = 40_000

const rowsAtom = atom({ plugin: 'agent-progress', key: 'rows' } as const, [], { shape: 'rows-1' })
const nowAtom = atom({ plugin: 'agent-progress', key: 'now' } as const, 0)
const hiddenAtom = atom({ plugin: 'agent-progress', key: 'isBandHidden' } as const, false)
const requestAtom = atom({ plugin: 'agent-progress', key: 'request' } as const, '')
const expandedAtom = atom({ plugin: 'agent-progress', key: 'expanded' } as const, [])
const explainedAtom = atom({ plugin: 'agent-progress', key: 'isExplained' } as const, false)
const earlierAtom = atom({ plugin: 'agent-progress', key: 'showEarlier' } as const, false)
const announcedAtom = atom({ plugin: 'agent-progress', key: 'announcedBatch' } as const, 0)

/** The settings people can change in /config. */
type Settings = { checklists: boolean; summaries: boolean; strip: boolean; notify: boolean }

export function settingsFrom(options: PluginOptions | undefined): Settings {
  const on = (key: string, fallback: boolean) =>
    typeof options?.[key] === 'boolean' ? (options[key] as boolean) : fallback
  return {
    checklists: on('checklists', true),
    summaries: on('summaries', true),
    strip: on('strip', true),
    notify: on('notify', false),
  }
}

export const NUDGE = [
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
const doneCount = (steps: readonly Step[]) => steps.filter(s => s.status === 'completed').length

/**
 * Where a checklist row stands: steps done, and once one has finished, the
 * average time a step takes, measured, not guessed.
 */
function pace(row: Row, now: number) {
  const total = row.steps.length
  const done = doneCount(row.steps)
  const stepAt = row.stepAt ?? row.startedAt
  const perStep = done > 0 ? Math.max(3_000, (stepAt - row.startedAt) / done) : undefined
  return { total, done, perStep, into: Math.max(0, now - stepAt) }
}

/**
 * How far along a row is. A checklist gives the steps done; within the step
 * under way the bar keeps moving at the agent's own pace, but never passes
 * the next step's mark, so it reads as a loading bar and never overstates.
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
    const p = pace(row, now)
    let value = p.done / p.total
    if (isLive(row) && p.done < p.total) {
      const frac = p.perStep
        ? Math.min(0.9, p.into / p.perStep)
        : 0.85 * (1 - Math.exp(-p.into / FIRST_STEP_GUESS_MS))
      value += frac / p.total
    }
    return { value: Math.min(isLive(row) ? 0.99 : 1, value), isExact: true }
  }

  // No checklist: an estimate from its activity and time, which slows as it
  // goes and never claims to be finished.
  const effort = row.tools + Math.max(0, now - row.startedAt) / 10_000
  return { value: Math.min(0.9, 1 - Math.exp(-effort / 15)), isExact: false }
}

/**
 * Milliseconds left, only once there is something real to go on: a checklist
 * with at least one finished step. It counts down smoothly as the current
 * step runs, and reads 0 ("finishing up") when a step runs long.
 */
export function etaOf(row: Row, all: readonly Row[], now: number): number | undefined {
  if (!isLive(row)) return undefined
  if (row.kind === 'workflow') {
    const etas = all
      .filter(r => r.parent === row.id && isLive(r))
      .map(r => etaOf(r, all, now))
      .filter((x): x is number => x !== undefined)
    return etas.length ? Math.max(...etas) : undefined
  }
  if (row.steps.length === 0) return undefined
  const p = pace(row, now)
  if (!p.perStep || p.done >= p.total) return undefined
  return Math.max(0, (p.total - p.done) * p.perStep - p.into)
}

/**
 * The current batch: the latest run of top-level agents whose times overlap,
 * worked out from the rows themselves, so agents started at the same moment
 * always land in the same batch. A gap with nothing running starts a new one.
 */
export function batches(rows: readonly Row[], now: number): Row[][] {
  // the main conversation's own checklist isn't an agent, so it never holds a batch open
  const top = rows.filter(r => !r.parent && r.kind !== 'main').slice().sort((a, b) => a.startedAt - b.startedAt)
  const groups: Row[][] = []
  let groupEnd = -Infinity
  for (const r of top) {
    if (r.startedAt > groupEnd || groups.length === 0) groups.push([])
    groups[groups.length - 1]!.push(r)
    groupEnd = Math.max(groupEnd, isLive(r) ? Infinity : (r.endedAt ?? now))
  }
  return groups
}

export function currentBatch(rows: readonly Row[], now: number): Row[] {
  return batches(rows, now).at(-1) ?? []
}

/** When the current batch began: its first agent's start, or 0 with none. */
export const batchStartOf = (rows: readonly Row[], now: number) =>
  currentBatch(rows, now)[0]?.startedAt ?? 0

export function overall(rows: readonly Row[], now: number) {
  const top = currentBatch(rows, now)
  if (top.length === 0) return undefined
  const ms = top.map(r => measure(r, rows, now))
  const running0 = top.filter(isLive).length
  // never round up to 100% while something is still running
  const value = Math.min(running0 > 0 ? 0.99 : 1, ms.reduce((s, m) => s + m.value, 0) / top.length)
  const etas = top.map(r => etaOf(r, rows, now)).filter((x): x is number => x !== undefined)
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

// ---------------------------------------------------------------- labels

/** Agent types that say nothing on their own; those agents get a number instead. */
const PLAIN_TYPES = new Set(['general-purpose', 'fork', 'teammate', ''])

/**
 * The short label in front of each bar, so it's clear which agent it is: the
 * agent's name or special kind, else "Agent 1", "Agent 2"… in the order they
 * started, counted afresh for each batch. A workflow's agents count within it.
 */
export function labelsFor(rows: readonly Row[], now: number): Map<string, string> {
  const labels = new Map<string, string>()
  const top = rows.filter(r => !r.parent).slice().sort((a, b) => a.startedAt - b.startedAt)
  let n = 0
  let groupEnd = -Infinity
  for (const r of top) {
    if (r.kind !== 'main' && r.startedAt > groupEnd) n = 0
    if (r.kind === 'main') labels.set(r.id, 'Main')
    else if (r.kind === 'workflow') labels.set(r.id, 'Workflow')
    else labels.set(r.id, r.label ?? `Agent ${++n}`)
    if (r.kind !== 'main') groupEnd = Math.max(groupEnd, isLive(r) ? Infinity : (r.endedAt ?? now))
    let k = 0
    for (const kid of rows.filter(x => x.parent === r.id).sort((a, b) => a.startedAt - b.startedAt)) {
      labels.set(kid.id, kid.label ?? `Agent ${++k}`)
    }
  }
  return labels
}

/** The width that fits the longest label shown, capped so titles keep room. */
const labelWidth = (labels: Map<string, string>, shown: readonly Row[]) =>
  Math.min(14, Math.max(0, ...shown.map(r => (labels.get(r.id) ?? '').length)))

// ---------------------------------------------------------------- words

/** A time of day in the person's own format, like "3:42 PM". */
export function clockTime(ms: number): string {
  const d = new Date(ms)
  try {
    return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
  } catch {
    const h = d.getHours()
    return `${h % 12 || 12}:${String(d.getMinutes()).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}`
  }
}

export function duration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000))
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ${String(s % 60).padStart(2, '0')}s`
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`
}

/** "~1m 05s left", "finishing up", or nothing when there is no estimate. */
export function timeLeft(eta: number | undefined): string {
  if (eta === undefined) return ''
  return eta < 1_500 ? 'finishing up' : `~${duration(eta)} left`
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
  status === 'done' ? 'success' : status === 'failed' ? 'error' : status === 'stopped' ? 'warning' : 'suggestion'

/** What the row is on now, in plain words: its current step, else its last action. */
function nowDoing(row: Row, now: number): string {
  if (row.status === 'done') return `Done in ${duration((row.endedAt ?? now) - row.startedAt)}`
  if (row.status === 'failed') return 'Ran into a problem and stopped'
  if (row.status === 'stopped') return 'Stopped'
  const at = row.steps.findIndex(s => s.status === 'in_progress')
  const next = at >= 0 ? at : row.steps.findIndex(s => s.status === 'pending')
  if (next >= 0) return `Step ${next + 1} of ${row.steps.length} · ${row.steps[next]!.subject}`
  if (row.kind === 'workflow') return row.detail || 'Working'
  return row.detail || 'Getting started'
}

/** The step an agent is on, split so it can sit on a line of its own. */
export function stepInfo(row: Row): { label: string; text: string } {
  const at = row.steps.findIndex(s => s.status === 'in_progress')
  const next = at >= 0 ? at : row.steps.findIndex(s => s.status === 'pending')
  if (next >= 0) return { label: `Step ${next + 1} of ${row.steps.length}`, text: row.steps[next]!.subject }
  return { label: '', text: row.kind === 'workflow' ? row.detail || 'Working' : row.detail || 'Getting started' }
}

/** The time on the right of a row: what's left when known, else how long so far. */
function clock(row: Row, all: readonly Row[], now: number): string {
  if (!isLive(row)) return duration((row.endedAt ?? now) - row.startedAt)
  return timeLeft(etaOf(row, all, now)) || duration(now - row.startedAt)
}

/** A step status from outside, held to the three the mod draws. */
const asStatus = (s: unknown): StepStatus =>
  s === 'completed' || s === 'in_progress' || s === 'pending' ? s : 'pending'

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
/**
 * How the table opens: no fill of its own, so it sits on the terminal's own
 * background. (A solid color fills only the body; Claude Code keeps its own
 * frame around it, so a darker fill shows as a box inside a gray frame.)
 */
async function paneOpenArgs(_$: EngineInterface) {
  return { id: PANE, title: 'Agents', backgroundColor: 'transparent' } as const
}

async function touch($: EngineInterface, id: string, fn: (row: Row) => Row, make?: () => Row) {
  await update($, rowsAtom, rows => {
    const at = rows.findIndex(r => r.id === id)
    if (at < 0) return make ? [...rows, fn(make())].slice(-200) : rows
    const next = rows.slice()
    next[at] = fn(rows[at]!)
    return next
  })
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

async function setSteps($: EngineInterface, id: string, steps: (old: Step[]) => Step[]) {
  const now = await $.clock.now()
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
          steps: status === 'done' ? row.steps.map(s => ({ ...s, status: 'completed' as const })) : row.steps,
        }
      : row,
  )
}

/** Says so once when every agent of the batch has finished. */
async function announceIfDone($: EngineInterface, settings: Settings) {
  const [rows, announced, now, isOff] = await Promise.all([
    read($, rowsAtom),
    read($, announcedAtom),
    $.clock.now(),
    read($, hiddenAtom),
  ])
  const batchStart = batchStartOf(rows, now)
  const top = currentBatch(rows, now).filter(r => r.kind !== 'main')
  if (top.length === 0 || top.some(isLive) || announced === batchStart) return
  if (isOff) return
  await update($, announcedAtom, () => batchStart)
  const failed = top.filter(r => r.status === 'failed').length
  const took = duration(Math.max(...top.map(r => r.endedAt ?? now)) - Math.min(...top.map(r => r.startedAt)))
  const what = top.length === 1 ? '1 agent' : `${top.length} agents`
  const text = failed ? `${what} finished · ${failed} ran into a problem · ${took}` : `${what} done · ${took}`
  $.ui.toast(text)
  if (settings.notify) void $.ui.notify(text, { title: 'Agent Progress' })
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

export const register: Register = (on, options) => {
  const settings = settingsFrom(options)
  /** Rows whose line is being written, so each is asked once. */
  const explaining = new Set<string>()
  /** The animation clock, so a second session start replaces it rather than adding one. */
  let ticker: { cancel: () => void } | undefined

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: COMMAND,
      description: 'See what your agents are doing: progress, steps and time left',
      argumentHint: '[on | off | explain | clear]',
      // runs the moment it's typed, even while Claude is busy, instead of waiting in line
      immediate: true,
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
            description: 'One plain sentence, starting "Claude is", on how your work helps the user\'s overall goal',
          },
          done: { type: 'number', description: 'How many steps are finished' },
        },
        required: ['done'],
      },
      isDeferred: false,
    })

    await update($, nowAtom, () => Date.now())
    // "/progress off" holds across sessions
    try {
      if ((await $.store.get(OFF_KEY)) === true) await update($, hiddenAtom, () => true)
    } catch {
      // nothing saved, or no store here: stay on
    }
    // A table already open from before this load gets the current look.
    try {
      if ((await $.ui.panes()).some(p => p.id === PANE)) void $.ui.open(await paneOpenArgs($))
    } catch {
      // no surface to ask yet; the next open sets it
    }
    // The animation clock: it writes only while something is moving, and
    // hands rows that have no "how this helps" line to the explainer.
    ticker?.cancel()
    ticker = $.clock.every(FRAME_MS, () => {
      void (async () => {
        const [rows, now] = await Promise.all([read($, rowsAtom), $.clock.now()])
        const isMoving = rows.some(
          r => isLive(r) || (r.endedAt !== undefined && now - r.endedAt < LINGER_MS + 2_000),
        )
        if (isMoving) await update($, nowAtom, () => now)
        if (!settings.summaries) return
        for (const row of rows) {
          if (row.purpose || row.kind === 'main' || explaining.has(row.id)) continue
          if (isLive(row) && now - row.startedAt < EXPLAIN_AFTER_MS) continue
          explaining.add(row.id)
          // a failed call isn't retried; the row gets a plain line from its title instead
          void explain($, row).catch(() =>
            touch($, row.id, x => (x.purpose ? x : { ...x, purpose: `Claude is working on: ${row.title}.` })),
          )
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
    const isAsked = settings.checklists && !e.resume && !e.prompt.includes(TOOL_FULL)
    const res = await next(isAsked ? { ...e, prompt: NUDGE + e.prompt } : e)
    if (res.deny !== undefined || !res.agentId) return res

    const now = await $.clock.now()
    const parent = isWorkflow ? `wf:${e.tool_use_id}` : undefined

    await touch(
      $,
      res.agentId,
      // a resumed agent starts a fresh run: its clock restarts and it joins the batch running now
      row => (e.resume ? { ...row, status: 'running', endedAt: undefined, startedAt: now, stepAt: now } : row),
      () => ({
        id: res.agentId!,
        kind: 'agent',
        title: cap(e.description || e.name || `Helper ${isWorkflow ? e.workflow!.agentIndex : ''}`.trim()),
        label: e.name || (PLAIN_TYPES.has(e.subagentType) ? undefined : e.subagentType),
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

  // The progress tool is for subagents only, and only while checklists are on.
  on('tool.offer', { tool: TOOL_FULL }, ($, e) => ({
    isOffered: settings.checklists && e.agentId !== undefined,
  })).catch(($, e, next) => next(e))

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

    if (e.tool === 'Workflow' && e.tool_use_id) {
      const now = await $.clock.now()
      const { name, task } = workflowMeta(a)
      const title = cap((task || name).replace(/[-_]/g, ' '))
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
      const todos = (a.todos as unknown[]).filter(
        (t): t is { content?: string; activeForm?: string; status?: string } => !!t && typeof t === 'object',
      )
      await setSteps($, id, () =>
        todos.map((t, i) => ({
          id: `todo-${i}`,
          subject: String((t.status === 'in_progress' ? t.activeForm : t.content) ?? t.content ?? ''),
          status: asStatus(t.status),
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
      const status = a.status === 'deleted' ? 'deleted' : a.status === undefined ? undefined : asStatus(a.status)
      await setSteps($, owner, old => {
        if (status === 'deleted') return old.filter(s => s.id !== taskId)
        return old.map(s =>
          s.id === taskId
            ? { ...s, subject: typeof a.subject === 'string' ? a.subject : s.subject, status: status ?? s.status }
            : s,
        )
      })
    }
    return ran
  })

  // ---- endings

  on('turn.complete', async ($, e, next) => {
    const res = await next(e)
    if (e.agentId) {
      await end($, e.agentId, e.isAborted ? 'stopped' : 'done')
      await announceIfDone($, settings)
    }
    return res
  })

  on('agent.report', async ($, e, next) => {
    const res = await next(e)
    await end($, e.agentId, e.status === 'completed' ? 'done' : e.status === 'failed' ? 'failed' : 'stopped')
    await announceIfDone($, settings)
    return res
  })

  on('session.receive', async ($, e, next) => {
    const res = await next(e)
    if (e.origin.kind !== 'task-notification') return res
    const rows = await read($, rowsAtom)
    const wf = rows.find(r => r.kind === 'workflow' && e.text.includes(r.id.slice(3)))
    if (wf) {
      const said = /<status>\s*([a-z_]+)\s*<\/status>/i.exec(e.text)?.[1]?.toLowerCase() ?? 'completed'
      const status: RowStatus = said === 'failed' ? 'failed' : said === 'killed' || said === 'stopped' ? 'stopped' : 'done'
      await end($, wf.id, status)
      // its agents are over too
      for (const kid of rows.filter(r => r.parent === wf.id && isLive(r))) await end($, kid.id, status)
      await announceIfDone($, settings)
    }
    return res
  })

  // ---- the command

  on('command.run', { command: COMMAND }, async ($, e) => {
    const arg = (e.args ?? '').trim().toLowerCase()
    if (['on', 'off', 'toggle', 'hide', 'show'].includes(arg)) {
      const isOff = arg === 'toggle' ? !(await read($, hiddenAtom)) : arg === 'off' || arg === 'hide'
      await update($, hiddenAtom, () => isOff)
      await $.store.set(OFF_KEY, isOff).catch(() => undefined)
      return {
        text: isOff
          ? "Agent Progress is off: bars won't pop up on their own. `/progress` still shows them anytime, and `/progress on` turns them back on."
          : 'Agent Progress is on: bars show above the prompt while agents work.',
      }
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
    if (arg && arg !== 'open') {
      return { text: 'Use `/progress` to see your agents, or `/progress on | off | toggle | explain | clear`.' }
    }
    // the live bars draw right here in the chat (below), and the table opens on the side
    void $.ui.open(await paneOpenArgs($))
    return { text: plainTable(await read($, rowsAtom), await $.clock.now()) }
  })

  // ---- drawing: the live bars in the chat, where /progress was typed

  on('ui.render', { component: 'CommandOutput', props: { command: COMMAND } }, async ($, e, next) => {
    const args = (e.props.args ?? '').trim().toLowerCase()
    if (args && args !== 'open') return next(e)
    const { Box, Text } = $.ui.resolve(e)
    const [rows, tick] = await Promise.all([read($, rowsAtom), read($, nowAtom)])
    const now = Math.max(tick, ...rows.map(r => r.startedAt), 0)
    const W = Math.max(40, (e.viewport?.columns ?? 100) - 4)
    const batch = currentBatch(rows, now)
    const shown = rows.filter(r => !r.parent && (isLive(r) || batch.includes(r)))
    if (shown.length === 0) {
      return (
        <Box flexDirection="column">
          <Text bold>No agents running</Text>
          <Text dimColor>Their bars show up here and above the prompt the moment one starts.</Text>
        </Box>
      )
    }
    const all = overall(rows, now)
    const running = shown.filter(isLive).length
    const labels = labelsFor(rows, now)
    const tagW = labelWidth(labels, shown)
    const barW = W >= 110 ? 22 : W >= 80 ? 16 : 10
    const titleW = Math.min(44, Math.max(14, Math.floor(W * 0.34)))
    const restW = Math.max(0, W - 2 - (tagW + 2) - titleW - 2 - barW - 6 - 3)
    const indent = 2 + tagW + 2
    return (
      <Box flexDirection="column">
        <Text dimColor>
          {(running > 0 ? `${running} ${running === 1 ? 'agent' : 'agents'} working` : 'All done') +
            (all ? ` · ${pct(all)}` : '') +
            (all?.eta !== undefined ? ` · ${timeLeft(all.eta)}` : '')}
        </Text>
        {shown.map(row => {
          const m = measure(row, rows, now)
          const g = glyph(row.status, now)
          const right = isLive(row) ? clock(row, rows, now) : nowDoing(row, now)
          return (
            <Box flexDirection="column">
              <Text wrap="truncate">
                <Text color={g.color}>{g.text} </Text>
                <Text dimColor>{fit(labels.get(row.id) ?? '', tagW)}{'  '}</Text>
                <Text bold={isLive(row)} dimColor={!isLive(row)}>
                  {fit(row.title, titleW)}{'  '}
                </Text>
                {bar(Text, m.value, barW, fillColor(row.status), isLive(row), now)}
                <Text dimColor={!isLive(row)}> {pct(m).padStart(4)}   </Text>
                {restW > 6 ? <Text dimColor>{fit(right, restW)}</Text> : ''}
              </Text>
              {isLive(row) && stepRow(Text, row, indent)}
            </Box>
          )
        })}
      </Box>
    )
  })

  // ---- drawing: the strip above the prompt

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (!settings.strip || e.props.hasSurvey || (await read($, hiddenAtom))) return next(e)
    const [rows, tick, expanded, isExplained] = await Promise.all([
      read($, rowsAtom),
      read($, nowAtom),
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
    const all = overall(rows, now)

    // One line per agent: which one, what it's on, a bar, and what it's doing right now.
    const labels = labelsFor(rows, now)
    const tagW = labelWidth(labels, shown)
    const barW = W >= 120 ? 24 : W >= 90 ? 16 : 10
    const titleW = Math.min(44, Math.max(14, Math.floor(W * 0.34)))
    const restW = Math.max(0, W - 2 - (tagW + 2) - titleW - 2 - barW - 1 - 4 - 3)
    const indent = 2 + tagW + 2

    const running = shown.filter(isLive).length
    const head =
      (running > 0 ? `${running} ${running === 1 ? 'agent' : 'agents'} working` : 'All done') +
      (all && running > 0 ? ` · ${pct(all)}` : '') +
      (all?.eta !== undefined ? ` · ${timeLeft(all.eta)}` : '')

    let room = Math.max(2, Math.min(14, e.props.maxRows ?? 14)) - 1
    const lines: RenderNode[] = []
    let more = 0
    for (const row of shown) {
      // a running agent takes two lines: its bar, and the step it's on underneath
      const need = isLive(row) ? 2 : 1
      if (room < need) {
        more += 1
        continue
      }
      room -= need
      const isOpen = isExplained || expanded.includes(row.id)
      const m = measure(row, rows, now)
      const g = glyph(row.status, now)
      const right = isLive(row) ? clock(row, rows, now) : nowDoing(row, now)
      lines.push(
        <Button key={row.id} plain onPress={() => update($, expandedAtom, toggle(row.id))}>
          <Text color={g.color}>{g.text} </Text>
          <Text dimColor>{fit(labels.get(row.id) ?? '', tagW)}{'  '}</Text>
          <Text bold={isLive(row)} dimColor={!isLive(row)}>
            {fit(row.title, titleW)}{'  '}
          </Text>
          {bar(Text, m.value, barW, fillColor(row.status), isLive(row), now)}
          <Text dimColor={!isLive(row)}> {pct(m).padStart(4)}   </Text>
          {restW > 6 ? <Text dimColor>{fit(right, restW)}</Text> : ''}
        </Button>,
      )
      if (isLive(row)) lines.push(stepRow(Text, row, indent))
      const extra = (row.purpose || settings.summaries ? 1 : 0) + (row.steps.length ? 1 : 0)
      if (isOpen && extra > 0 && room >= extra) {
        room -= extra
        if (row.purpose || settings.summaries) {
          lines.push(
            <Text wrap="truncate">
              {' '.repeat(indent)}
              <Text italic dimColor={!row.purpose}>
                {row.purpose ?? 'Writing a plain summary…'}
              </Text>
            </Text>,
          )
        }
        if (row.steps.length) lines.push(stepLine(Text, row, W - indent, indent))
      }
    }

    return (
      <Box flexDirection="column">
        <Button key="open-table" plain onPress={() => void paneOpenArgs($).then(args => $.ui.open(args))}>
          <Text dimColor>{head}</Text>
        </Button>
        {lines}
        {more > 0 && <Text dimColor>{`  +${more} more · /progress`}</Text>}
      </Box>
    )
  })

  // ---- drawing: the table

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Button, Text } = $.ui.resolve(e)
    const [rows, tick, expanded, isExplained, showEarlier] = await Promise.all([
      read($, rowsAtom),
      read($, nowAtom),
      read($, expandedAtom),
      read($, explainedAtom),
      read($, earlierAtom),
    ])
    const now = Math.max(tick, ...rows.map(r => r.startedAt), 0)
    const W = Math.max(40, e.props.bodyColumns)

    if (rows.length === 0) {
      return (
        <Box flexDirection="column" paddingTop={1}>
          <Text bold>No agents running</Text>
          <Text dimColor>Each one shows up here the moment it starts.</Text>
        </Box>
      )
    }

    const top = rows.filter(r => !r.parent)
    const batch = currentBatch(rows, now)
    const current = top.filter(r => isLive(r) || batch.includes(r))
    const earlier = top.filter(r => !current.includes(r))
    const all = overall(rows, now)
    const working = current.filter(isLive).length
    const finished = current.length - working

    const barW = Math.max(10, Math.min(36, W - 30))
    const timeW = 18

    const labels = labelsFor(rows, now)
    const card = (row: Row, depth: number) => {
      const m = measure(row, rows, now)
      const g = glyph(row.status, now)
      const isOpen = isExplained || expanded.includes(row.id)
      const pad = depth ? '      ' : '    '
      const lead = depth ? '  └ ' : ''
      const titleW = Math.max(8, W - 4 - lead.length - timeW)
      return (
        <Box flexDirection="column" marginBottom={1}>
          <Button key={row.id} plain onPress={() => update($, expandedAtom, toggle(row.id))}>
            <Text dimColor>{isOpen ? '▾ ' : '▸ '}</Text>
            <Text color={g.color}>{g.text} </Text>
            <Text dimColor>
              {lead}
              {labels.get(row.id) ?? ''}
              {' · '}
            </Text>
            <Text bold={depth === 0 && isLive(row)} dimColor={!isLive(row)}>
              {fit(row.title, Math.max(4, titleW - (labels.get(row.id) ?? '').length - 3))}
            </Text>
            <Text dimColor>
              {(isLive(row) ? clock(row, rows, now) : clockTime(row.endedAt ?? now)).padStart(timeW)}
            </Text>
          </Button>
          <Text wrap="truncate">
            {pad}
            {bar(Text, m.value, barW, fillColor(row.status), isLive(row), now)}
            <Text dimColor={!isLive(row)}> {pct(m).padStart(4)}</Text>
            {row.status === 'failed' || row.status === 'stopped' ? <Text dimColor>{'   ' + nowDoing(row, now)}</Text> : ''}
          </Text>
          {isLive(row) && stepRow(Text, row, pad.length)}
          {isOpen && (
            <Text dimColor wrap="truncate">
              {pad}
              {`Started ${clockTime(row.startedAt)}` +
                (row.endedAt !== undefined && !isLive(row)
                  ? ` · finished ${clockTime(row.endedAt)} · took ${duration(row.endedAt - row.startedAt)}`
                  : ` · running for ${duration(now - row.startedAt)}`)}
            </Text>
          )}
          {isOpen && row.kind !== 'main' && (row.purpose || settings.summaries) && (
            <Text>
              {pad}
              <Text italic dimColor={!row.purpose}>
                {row.purpose ?? 'Writing a plain summary…'}
              </Text>
            </Text>
          )}
          {isOpen &&
            row.steps.map(s => (
              <Text wrap="truncate">
                {pad}
                <Text color={(STEP_GLYPH[s.status] ?? STEP_GLYPH.pending).color}>{(STEP_GLYPH[s.status] ?? STEP_GLYPH.pending).text} </Text>
                <Text dimColor={s.status !== 'in_progress'} bold={s.status === 'in_progress'}>
                  {s.subject}
                </Text>
              </Text>
            ))}
        </Box>
      )
    }

    const cards: RenderNode[] = []
    for (const row of current) {
      cards.push(card(row, 0))
      for (const kid of rows.filter(r => r.parent === row.id)) cards.push(card(kid, 1))
    }

    const counts = [working ? `${working} working` : '', finished ? `${finished} done` : '']
      .filter(Boolean)
      .join(' · ')

    return (
      <Box flexDirection="column">
        <Text wrap="truncate">
          <Text bold>{'Agents'}</Text>
          <Text dimColor>{(counts || 'idle').padStart(Math.max(0, W - 6))}</Text>
        </Text>
        <Text dimColor>{'─'.repeat(W)}</Text>
        <Text> </Text>
        {cards}
        {earlier.length > 0 && (
          <Button key="earlier" plain onPress={() => update($, earlierAtom, v => !v)}>
            <Text dimColor>
              {showEarlier ? '▾ ' : '▸ '}
              {`Earlier · ${earlier.length} finished`}
            </Text>
          </Button>
        )}
        {showEarlier &&
          batches(rows, now)
            .slice(0, -1)
            .reverse()
            .map(group => {
              const start = Math.min(...group.map(r => r.startedAt))
              const end = Math.max(...group.map(r => r.endedAt ?? now))
              const count = group.length === 1 ? '1 agent' : `${group.length} agents`
              return (
                <Box flexDirection="column" marginTop={1}>
                  <Text dimColor>{`  ${clockTime(start)} · ${count} · took ${duration(end - start)}`}</Text>
                  <Text> </Text>
                  {group.map(r => card(r, 0))}
                </Box>
              )
            })}
        {all && all.total > 1 && (
          <Box borderStyle="round" borderDimColor marginTop={1} paddingX={1}>
            <Text wrap="truncate">
              <Text bold>Overall </Text>
              {bar(Text, all.value, Math.max(8, Math.min(30, W - 40)), 'success', all.running > 0, now)}
              <Text bold> {pct(all).padStart(4)}</Text>
              <Text dimColor>
                {`  ${duration(all.elapsed)}` + (all.eta !== undefined ? ` · ${timeLeft(all.eta)}` : '')}
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
  bold?: boolean
  italic?: boolean
  wrap?: string
  children?: unknown
}) => RenderNode

const EIGHTHS = ['', '▏', '▎', '▍', '▌', '▋', '▊', '▉']

/**
 * A solid bar filled to an eighth of a cell. While it runs, a soft glint
 * sweeps along the filled part, so a bar that is waiting still looks alive.
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
    const at = Math.floor(now / 80) % (full + 10)
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

/** The step an agent is on, on its own line: "Step 3 of 5", then the step. */
function stepRow(T: unknown, row: Row, indent: number) {
  const Text = T as TextEl
  const s = stepInfo(row)
  return (
    <Text wrap="truncate">
      {' '.repeat(indent)}
      {s.label ? <Text dimColor>{s.label + '   '}</Text> : ''}
      <Text dimColor={!s.label}>{s.text}</Text>
    </Text>
  )
}

/** The checklist on one line: ✔ done · › under way · ○ still to do. */
function stepLine(T: unknown, row: Row, width: number, indent = 2) {
  const Text = T as TextEl
  let left = width
  const parts: RenderNode[] = []
  for (const s of row.steps) {
    if (left < 10) break
    const g = STEP_GLYPH[s.status] ?? STEP_GLYPH.pending
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
      {' '.repeat(indent)}
      {parts}
    </Text>
  )
}

/**
 * The text summary /progress hands back: the current batch, one line per
 * agent, kept short because Claude reads it too.
 */
export function plainTable(rows: readonly Row[], now: number): string {
  const batch = currentBatch(rows, now)
  const shown = rows.filter(r => !r.parent && (isLive(r) || batch.includes(r)))
  if (shown.length === 0) return 'No agents running.'
  const labels = labelsFor(rows, now)
  const lines = shown.map(row => {
    const m = measure(row, rows, now)
    const filled = Math.round(m.value * 12)
    return [
      `${labels.get(row.id)} · ${row.title}`,
      '█'.repeat(filled) + '░'.repeat(12 - filled),
      pct(m),
      isLive(row) ? `${nowDoing(row, now)} · ${clock(row, rows, now)}` : nowDoing(row, now),
    ].join('  ')
  })
  const all = overall(rows, now)
  if (all) lines.push(`Overall ${pct(all)} · ${duration(all.elapsed)}${all.eta !== undefined ? ` · ${timeLeft(all.eta)}` : ''}`)
  const earlier = rows.filter(r => !r.parent && !shown.includes(r)).length
  if (earlier) lines.push(`${earlier} earlier ${earlier === 1 ? 'agent' : 'agents'} finished`)
  return lines.join('\n')
}
