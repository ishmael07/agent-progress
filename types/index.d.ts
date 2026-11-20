export type StepStatus = 'pending' | 'in_progress' | 'completed'
export type Step = { id: string; subject: string; status: StepStatus }

export type RowStatus = 'running' | 'done' | 'failed' | 'stopped'

export type Row = {
  /** agentId, `wf:<tool_use_id>` for a workflow, or `main` */
  id: string
  kind: 'agent' | 'workflow' | 'main'
  /** what it was asked to do, in a few words */
  title: string
  /** its name or workflow name, if it has one */
  task: string
  /** what it is doing right now (its last action) */
  detail: string
  /** the start of the instructions it was given, to explain it from */
  brief?: string
  /** one plain sentence: how this agent helps the overall request */
  purpose?: string
  /** the workflow row this agent belongs to */
  parent?: string
  startedAt: number
  endedAt?: number
  /** when its current step began, for the bar's motion within a step */
  stepAt?: number
  status: RowStatus
  /** its checklist; empty when it keeps none */
  steps: Step[]
  /** tool calls so far, the fallback progress signal */
  tools: number
}

declare module 'claude-code' {
  interface PluginState {
    'agent-progress': {
      rows: Shaped<Row[]>
      now: number
      batchStart: number
      isBandHidden: boolean
      /** the person's latest request, to explain agents against */
      request: string
      /** rows opened to show how they help */
      expanded: string[]
      /** show every row opened */
      isExplained: boolean
    }
  }
}
