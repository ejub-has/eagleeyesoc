import { useState } from 'react'
import type {
  ActionSpec,
  Member,
  WorkflowCondition,
  WorkflowIn,
  WorkflowStep,
  WorkflowStepDef,
} from '../api/client'
import { Icon } from '../shell/icons'
import { groupIcon } from './flow'
import { actorName } from './labels'

/** Name, description and the alerts that start the workflow. */
export function TriggerPanel({
  draft,
  sources,
  readOnly,
  onSources,
  onChange,
}: {
  draft: WorkflowIn
  sources: string
  readOnly: boolean
  onSources: (text: string) => void
  onChange: (draft: WorkflowIn) => void
}) {
  const conditions = draft.trigger.conditions ?? []
  const setTrigger = (change: Partial<WorkflowIn['trigger']>) =>
    onChange({ ...draft, trigger: { ...draft.trigger, ...change } })
  const setCondition = (i: number, change: Partial<WorkflowCondition>) =>
    setTrigger({ conditions: conditions.map((c, j) => (j === i ? { ...c, ...change } : c)) })

  return (
    <fieldset className="inspector-body" disabled={readOnly}>
      <legend className="inspector-title">
        <Icon name="bolt" size={18} /> Trigger
      </legend>
      <label>
        Workflow name
        <input
          required
          maxLength={120}
          value={draft.name}
          onChange={(e) => onChange({ ...draft, name: e.target.value })}
        />
      </label>
      <label>
        Description
        <textarea
          rows={2}
          maxLength={2000}
          value={draft.description}
          onChange={(e) => onChange({ ...draft, description: e.target.value })}
        />
      </label>
      <h4>Starts when an alert arrives</h4>
      <label>
        Alert sources
        <input
          value={sources}
          placeholder="entra_id_protection, crowdstrike"
          onChange={(e) => onSources(e.target.value)}
        />
        <span className="hint">Comma-separated; leave empty for any source.</span>
      </label>
      <label>
        Alert title contains
        <input
          maxLength={200}
          value={draft.trigger.title_contains ?? ''}
          onChange={(e) => setTrigger({ title_contains: e.target.value })}
        />
      </label>
      <span className="field-label">Conditions on alert fields (all must match)</span>
      {conditions.map((c, i) => (
        <div key={i} className="condition">
          <input
            aria-label={`Condition ${i + 1} field`}
            placeholder="payload.riskEventType"
            value={c.path}
            onChange={(e) => setCondition(i, { path: e.target.value })}
          />
          <select
            aria-label={`Condition ${i + 1} test`}
            value={c.op ?? 'equals'}
            onChange={(e) => setCondition(i, { op: e.target.value as WorkflowCondition['op'] })}
          >
            <option value="equals">equals</option>
            <option value="contains">contains</option>
            <option value="exists">exists</option>
          </select>
          {c.op !== 'exists' && (
            <input
              aria-label={`Condition ${i + 1} value`}
              placeholder="passwordSpray"
              value={c.value ?? ''}
              onChange={(e) => setCondition(i, { value: e.target.value })}
            />
          )}
          <button
            type="button"
            className="ghost icon-button"
            aria-label={`Remove condition ${i + 1}`}
            onClick={() => setTrigger({ conditions: conditions.filter((_, j) => j !== i) })}
          >
            <Icon name="close" size={16} />
          </button>
        </div>
      ))}
      <button
        type="button"
        className="ghost"
        onClick={() => setTrigger({ conditions: [...conditions, { path: '', op: 'equals', value: '' }] })}
      >
        Add condition
      </button>
    </fieldset>
  )
}

/** One step: what it runs, whether it waits for approval, and its inputs. */
export function StepPanel({
  index,
  step,
  spec,
  count,
  readOnly,
  onChange,
  onMove,
  onRemove,
}: {
  index: number
  step: WorkflowStepDef
  spec: ActionSpec | undefined
  count: number
  readOnly: boolean
  onChange: (change: Partial<WorkflowStepDef>) => void
  onMove: (by: number) => void
  onRemove: () => void
}) {
  return (
    <fieldset className="inspector-body" disabled={readOnly}>
      <legend className="inspector-title">
        <Icon name={groupIcon(spec?.group)} size={18} /> Step {index + 1}
      </legend>
      <p className="muted">
        <strong>{spec ? `${spec.group} · ${spec.label}` : step.action}</strong>
        {spec?.description && <> — {spec.description}</>}
      </p>
      <label>
        Step name
        <input
          required
          maxLength={120}
          value={step.name}
          onChange={(e) => onChange({ name: e.target.value })}
        />
      </label>
      <label>
        Runs
        <select
          value={step.mode ?? 'auto'}
          onChange={(e) => onChange({ mode: e.target.value as 'auto' | 'approval' })}
        >
          <option value="auto">Automatically</option>
          <option value="approval">After approval</option>
        </select>
      </label>
      <label>
        If it fails
        <select
          value={step.on_error ?? 'stop'}
          onChange={(e) => onChange({ on_error: e.target.value as 'stop' | 'continue' })}
        >
          <option value="stop">Stop the run</option>
          <option value="continue">Continue with the next step</option>
        </select>
      </label>
      {!!spec?.inputs.length && <h4>Inputs</h4>}
      {spec?.inputs.map((input) => {
        const props = {
          required: input.required,
          value: step.inputs?.[input.name] ?? '',
          placeholder: input.help,
          onChange: (e: { target: { value: string } }) =>
            onChange({ inputs: { ...step.inputs, [input.name]: e.target.value } }),
        }
        return (
          <label key={input.name}>
            {input.label}
            {input.multiline ? <textarea rows={3} {...props} /> : <input {...props} />}
          </label>
        )
      })}
      <p className="hint">
        Inputs can use placeholders such as <code>{'{{alert.payload.userPrincipalName}}'}</code> or{' '}
        <code>{'{{case.number}}'}</code>.
      </p>
      <div className="inspector-actions">
        <button type="button" className="ghost" disabled={index === 0} onClick={() => onMove(-1)}>
          Move up
        </button>
        <button type="button" className="ghost" disabled={index === count - 1} onClick={() => onMove(1)}>
          Move down
        </button>
        <button type="button" className="ghost danger" onClick={onRemove}>
          Remove step
        </button>
      </div>
    </fieldset>
  )
}

/** The action catalog, grouped by product, to add a step at a point in the flow. */
export function ActionPicker({
  catalog,
  after,
  onPick,
}: {
  catalog: ActionSpec[]
  after: string
  onPick: (spec: ActionSpec) => void
}) {
  const [text, setText] = useState('')
  const needle = text.trim().toLowerCase()
  const shown = catalog.filter((a) =>
    `${a.group} ${a.label} ${a.description}`.toLowerCase().includes(needle),
  )
  const groups = [...new Set(shown.map((a) => a.group))]
  return (
    <div className="inspector-body">
      <h3 className="inspector-title">
        <Icon name="plus" size={18} /> Add a step after {after}
      </h3>
      <input
        aria-label="Find an action"
        placeholder="Find an action…"
        value={text}
        onChange={(e) => setText(e.target.value)}
      />
      {groups.length === 0 && <p className="muted">No actions match.</p>}
      {groups.map((group) => (
        <section key={group} className="picker-group" aria-label={group}>
          <h4>
            <Icon name={groupIcon(group)} size={16} /> {group}
          </h4>
          {shown
            .filter((a) => a.group === group)
            .map((a) => (
              <button key={a.key} type="button" className="picker-item" onClick={() => onPick(a)}>
                <span>{a.label}</span>
                {a.impact === 'change' && <span className="tag">changes things</span>}
                <span className="muted">{a.description}</span>
              </button>
            ))}
        </section>
      ))}
    </div>
  )
}

/** What happened at one step of a run. */
export function RunStepPanel({
  index,
  step,
  spec,
  members,
}: {
  index: number
  step: WorkflowStep
  spec: ActionSpec | undefined
  members: Member[]
}) {
  return (
    <div className="inspector-body">
      <h3 className="inspector-title">
        <Icon name={groupIcon(spec?.group)} size={18} /> Step {index + 1}: {step.name}
      </h3>
      <p>
        <span className={`pill step-${step.status}`}>{step.status.replace('_', ' ')}</span>{' '}
        <span className="muted">{spec?.label ?? step.action}</span>
      </p>
      {step.error && <p className="step-error">{step.error}</p>}
      <dl className="step-detail">
        {step.started_at && (
          <>
            <dt>Started</dt>
            <dd>{new Date(step.started_at).toLocaleString()}</dd>
          </>
        )}
        {step.finished_at && (
          <>
            <dt>Finished</dt>
            <dd>{new Date(step.finished_at).toLocaleString()}</dd>
          </>
        )}
        {step.decided_by && (
          <>
            <dt>{step.status === 'rejected' ? 'Rejected by' : 'Approved by'}</dt>
            <dd>
              {actorName(step.decided_by, members)}
              {step.decision_reason && `: ${step.decision_reason}`}
            </dd>
          </>
        )}
      </dl>
      {Object.keys(step.inputs ?? {}).length > 0 && (
        <>
          <h4>Inputs</h4>
          <pre className="json">{JSON.stringify(step.inputs, null, 2)}</pre>
        </>
      )}
      {step.output && (
        <>
          <h4>Output</h4>
          <pre className="json">{JSON.stringify(step.output, null, 2)}</pre>
        </>
      )}
    </div>
  )
}
