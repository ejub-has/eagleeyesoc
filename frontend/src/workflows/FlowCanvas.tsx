import type { ActionSpec, WorkflowTrigger } from '../api/client'
import { Icon } from '../shell/icons'
import { groupIcon, triggerSummary, type Selection } from './flow'

/** The parts of a step the diagram draws; saved steps and run steps both have them. */
export type FlowStep = {
  name: string
  action: string
  mode?: string | null
  on_error?: string | null
  status?: string
}

const STATUS_LABELS: Record<string, string> = {
  awaiting_approval: 'awaiting approval',
}

/**
 * A workflow drawn top to bottom: the trigger, each step joined by arrows, then the end.
 * Steps that wait for approval show a gate on the arrow into them; with `onInsert`, each
 * arrow has a "+" to add a step there.
 */
export function FlowCanvas({
  trigger,
  steps,
  actions,
  selected,
  onSelect,
  onInsert,
  zoom = 1,
  label = 'Workflow diagram',
}: {
  trigger: WorkflowTrigger
  steps: FlowStep[]
  actions: Record<string, ActionSpec>
  selected: Selection
  onSelect: (selection: Selection) => void
  onInsert?: (index: number) => void
  zoom?: number
  label?: string
}) {
  const isSelected = (s: Selection) => JSON.stringify(s) === JSON.stringify(selected)

  function edge(index: number, after: string, gate: boolean) {
    const adding = isSelected({ kind: 'add', index })
    return (
      <div className={`flow-edge${gate ? ' gated' : ''}`}>
        {onInsert && (
          <button
            type="button"
            className={`flow-add${adding ? ' active' : ''}`}
            aria-label={`Add a step after ${after}`}
            title="Add a step here"
            onClick={() => onInsert(index)}
          >
            <Icon name="plus" size={14} />
          </button>
        )}
        {gate && (
          <span className="flow-gate" title="A person must approve before this step runs">
            <Icon name="gate" size={16} />
            Approval
          </span>
        )}
      </div>
    )
  }

  return (
    <div className="flow-viewport">
      <ol className="flow" aria-label={label} style={{ transform: `scale(${zoom})` }}>
        <li>
          <button
            type="button"
            className="flow-node kind-trigger"
            aria-pressed={isSelected({ kind: 'trigger' })}
            aria-label="Trigger"
            onClick={() => onSelect({ kind: 'trigger' })}
          >
            <span className="flow-icon">
              <Icon name="bolt" />
            </span>
            <span className="flow-text">
              <span className="flow-type">Trigger · New alert</span>
              <span className="flow-name">When {triggerSummary(trigger)}</span>
            </span>
          </button>
          {edge(0, 'the trigger', steps[0]?.mode === 'approval')}
        </li>
        {steps.map((step, i) => {
          const spec = actions[step.action]
          const next = steps[i + 1]
          return (
            <li key={i}>
              <button
                type="button"
                className={`flow-node kind-step${step.status ? ` status-${step.status}` : ''}`}
                aria-pressed={isSelected({ kind: 'step', index: i })}
                aria-label={`Step ${i + 1}: ${step.name}`}
                onClick={() => onSelect({ kind: 'step', index: i })}
              >
                <span className="flow-icon">
                  <Icon name={groupIcon(spec?.group)} />
                </span>
                <span className="flow-text">
                  <span className="flow-type">
                    {spec ? `${spec.group} · ${spec.label}` : step.action}
                  </span>
                  <span className="flow-name">{step.name}</span>
                  <span className="flow-badges">
                    {spec?.impact === 'change' && <span className="tag">changes things</span>}
                    {step.on_error === 'continue' && <span className="tag">continues on error</span>}
                    {step.status && (
                      <span className={`pill step-${step.status}`}>
                        {STATUS_LABELS[step.status] ?? step.status}
                      </span>
                    )}
                  </span>
                </span>
              </button>
              {edge(i + 1, `step ${i + 1}`, next?.mode === 'approval')}
            </li>
          )
        })}
        <li>
          <div className="flow-node kind-exit">
            <span className="flow-icon">
              <Icon name="flag" />
            </span>
            <span className="flow-text">
              <span className="flow-type">Exit</span>
              <span className="flow-name">Run complete</span>
            </span>
          </div>
        </li>
      </ol>
    </div>
  )
}
