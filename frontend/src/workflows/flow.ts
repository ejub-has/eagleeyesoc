import type { ActionSpec, WorkflowIn, WorkflowStepDef, WorkflowTrigger } from '../api/client'
import type { IconName } from '../shell/icons'

export const EMPTY: WorkflowIn = {
  name: '',
  description: '',
  enabled: true,
  trigger: { sources: [], title_contains: '', conditions: [] },
  steps: [],
}

/** What part of the diagram is open in the side panel. */
export type Selection =
  | { kind: 'trigger' }
  | { kind: 'step'; index: number }
  | { kind: 'add'; index: number }
  | null

/** The trigger as a sentence: "source is x, and title contains y". */
export function triggerSummary(t: WorkflowTrigger): string {
  const parts: string[] = []
  if (t.sources?.length) parts.push(`source is ${t.sources.join(' or ')}`)
  if (t.title_contains) parts.push(`title contains "${t.title_contains}"`)
  for (const c of t.conditions ?? []) {
    parts.push(c.op === 'exists' ? `${c.path} exists` : `${c.path} ${c.op} "${c.value}"`)
  }
  return parts.length ? parts.join(', and ') : 'any alert'
}

const GROUP_ICONS: Record<string, IconName> = {
  Case: 'note',
  'Entra ID': 'user',
  'Google Workspace': 'apps',
  Slack: 'apps',
  Intune: 'device',
  CrowdStrike: 'shield',
}

export function groupIcon(group: string | undefined): IconName {
  return (group && GROUP_ICONS[group]) || 'webhook'
}

/** A new step for an action: actions that change things wait for approval by default. */
export function newStep(spec: ActionSpec): WorkflowStepDef {
  return {
    name: spec.label,
    action: spec.key,
    mode: spec.impact === 'change' ? 'approval' : 'auto',
    on_error: 'stop',
    inputs: Object.fromEntries(spec.inputs.map((input) => [input.name, ''])),
  }
}

export function parseSources(text: string): string[] {
  return text
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
}

/** The draft as the API takes it: sources parsed and empty inputs left out. */
export function toSave(draft: WorkflowIn, sources: string): WorkflowIn {
  return {
    ...draft,
    trigger: { ...draft.trigger, sources: parseSources(sources) },
    steps: draft.steps.map((s) => ({
      ...s,
      inputs: Object.fromEntries(Object.entries(s.inputs ?? {}).filter(([, v]) => v !== '')),
    })),
  }
}

/** A plain-language account of what the workflow does, one line per step. */
export function explain(draft: WorkflowIn, actions: Record<string, ActionSpec>): string[] {
  const lines = [`Starts on a new case when an alert arrives where ${triggerSummary(draft.trigger)}.`]
  draft.steps.forEach((s, i) => {
    const label = actions[s.action]?.label ?? s.action
    const when = s.mode === 'approval' ? 'once someone with approval rights approves it' : 'automatically'
    const failure = s.on_error === 'continue' ? 'carries on if it fails' : 'stops the run if it fails'
    lines.push(`${i + 1}. ${s.name}: ${label}, ${when}; ${failure}.`)
  })
  lines.push('Every step is recorded on the case timeline and in the audit log.')
  return lines
}
