import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useState, type FormEvent } from 'react'
import {
  api,
  describeError,
  type ActionSpec,
  type Workflow,
  type WorkflowCondition,
  type WorkflowIn,
  type WorkflowStepDef,
} from '../api/client'
import { toInput } from './data'

const EMPTY: WorkflowIn = {
  name: '',
  description: '',
  enabled: true,
  trigger: { sources: [], title_contains: '', conditions: [] },
  steps: [],
}

/** Create or change a workflow: its trigger and its ordered steps. */
export function WorkflowEditor({
  slug,
  catalog,
  initial,
  onDone,
}: {
  slug: string
  catalog: ActionSpec[]
  initial: Workflow | null
  onDone: () => void
}) {
  const queryClient = useQueryClient()
  const [draft, setDraft] = useState<WorkflowIn>(initial ? toInput(initial) : EMPTY)
  const [sources, setSources] = useState((draft.trigger.sources ?? []).join(', '))
  const actions = Object.fromEntries(catalog.map((a) => [a.key, a]))
  const conditions = draft.trigger.conditions ?? []

  const save = useMutation({
    mutationFn: async (body: WorkflowIn) => {
      const { error, response } = initial
        ? await api.PUT('/api/tenants/{slug}/workflows/{workflow_id}', {
            params: { path: { slug, workflow_id: initial.id } },
            body,
          })
        : await api.POST('/api/tenants/{slug}/workflows', { params: { path: { slug } }, body })
      if (!response.ok) {
        throw new Error(
          response.status === 409 ? 'A workflow with this name already exists' : describeError(error, response.status),
        )
      }
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['workflows', slug] })
      onDone()
    },
  })
  const remove = useMutation({
    mutationFn: async () => {
      const { response } = await api.DELETE('/api/tenants/{slug}/workflows/{workflow_id}', {
        params: { path: { slug, workflow_id: initial!.id } },
      })
      if (response.status === 409) throw new Error('This workflow has runs; disable it instead.')
      if (!response.ok) throw new Error(`Could not delete (${response.status})`)
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['workflows', slug] })
      onDone()
    },
  })

  const setTrigger = (change: Partial<WorkflowIn['trigger']>) =>
    setDraft({ ...draft, trigger: { ...draft.trigger, ...change } })
  const setCondition = (i: number, change: Partial<WorkflowCondition>) =>
    setTrigger({ conditions: conditions.map((c, j) => (j === i ? { ...c, ...change } : c)) })
  const setStep = (i: number, change: Partial<WorkflowStepDef>) =>
    setDraft({ ...draft, steps: draft.steps.map((s, j) => (j === i ? { ...s, ...change } : s)) })
  const moveStep = (i: number, by: number) => {
    const steps = [...draft.steps]
    ;[steps[i], steps[i + by]] = [steps[i + by], steps[i]]
    setDraft({ ...draft, steps })
  }

  function addStep(key: string) {
    const spec = actions[key]
    if (!spec) return
    const step: WorkflowStepDef = {
      name: spec.label,
      action: key,
      mode: spec.impact === 'change' ? 'approval' : 'auto',
      on_error: 'stop',
      inputs: Object.fromEntries(spec.inputs.map((input) => [input.name, ''])),
    }
    setDraft({ ...draft, steps: [...draft.steps, step] })
  }

  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const list = sources
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
    const steps = draft.steps.map((s) => ({
      ...s,
      inputs: Object.fromEntries(Object.entries(s.inputs ?? {}).filter(([, v]) => v !== '')),
    }))
    save.mutate({ ...draft, trigger: { ...draft.trigger, sources: list }, steps })
  }

  return (
    <form className="workflow-editor" onSubmit={onSubmit} aria-label="Workflow">
      <div className="page-head">
        <h2>{initial ? `Edit ${initial.name}` : 'New workflow'}</h2>
        <div className="page-tools">
          {initial && (
            <button type="button" className="ghost" onClick={() => remove.mutate()}>
              Delete
            </button>
          )}
          <button type="button" className="ghost" onClick={onDone}>
            Cancel
          </button>
          <button type="submit" disabled={save.isPending || draft.steps.length === 0}>
            Save workflow
          </button>
        </div>
      </div>
      {save.isError && <p role="alert">{save.error.message}</p>}
      {remove.isError && <p role="alert">{remove.error.message}</p>}

      <fieldset className="case-grid">
        <legend>Workflow</legend>
        <label>
          Name
          <input
            required
            maxLength={120}
            value={draft.name}
            onChange={(e) => setDraft({ ...draft, name: e.target.value })}
          />
        </label>
        <label className="check">
          <input
            type="checkbox"
            checked={draft.enabled}
            onChange={(e) => setDraft({ ...draft, enabled: e.target.checked })}
          />
          Enabled
        </label>
        <label className="wide">
          Description
          <textarea
            rows={2}
            maxLength={2000}
            value={draft.description}
            onChange={(e) => setDraft({ ...draft, description: e.target.value })}
          />
        </label>
      </fieldset>

      <fieldset className="case-grid">
        <legend>When an alert arrives</legend>
        <label>
          Sources (comma-separated)
          <input
            value={sources}
            placeholder="e.g. entra_id_protection, crowdstrike"
            onChange={(e) => setSources(e.target.value)}
          />
        </label>
        <label>
          Title contains
          <input
            maxLength={200}
            value={draft.trigger.title_contains ?? ''}
            onChange={(e) => setTrigger({ title_contains: e.target.value })}
          />
        </label>
        <div className="wide">
          <span className="field-label">Conditions on alert fields (all must match)</span>
          {conditions.map((c, i) => (
            <div key={i} className="inline-form">
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
                className="ghost"
                onClick={() => setTrigger({ conditions: conditions.filter((_, j) => j !== i) })}
              >
                Remove condition {i + 1}
              </button>
            </div>
          ))}
          <button
            type="button"
            onClick={() => setTrigger({ conditions: [...conditions, { path: '', op: 'equals', value: '' }] })}
          >
            Add condition
          </button>
        </div>
      </fieldset>

      <fieldset>
        <legend>Steps, in order</legend>
        <p className="muted">
          Inputs can use placeholders such as <code>{'{{alert.payload.userPrincipalName}}'}</code> or{' '}
          <code>{'{{case.number}}'}</code>.
        </p>
        <ol className="step-editor">
          {draft.steps.map((step, i) => {
            const spec = actions[step.action]
            return (
              <li key={i} className="card">
                <div className="inline-form">
                  <label>
                    Step {i + 1} name
                    <input
                      required
                      maxLength={120}
                      value={step.name}
                      onChange={(e) => setStep(i, { name: e.target.value })}
                    />
                  </label>
                  <span className="muted">
                    {spec?.label ?? step.action}
                    {spec?.impact === 'change' && <span className="tag">changes things</span>}
                  </span>
                  <label>
                    Mode
                    <select
                      value={step.mode ?? 'auto'}
                      onChange={(e) => setStep(i, { mode: e.target.value as 'auto' | 'approval' })}
                    >
                      <option value="auto">Automatic</option>
                      <option value="approval">Needs approval</option>
                    </select>
                  </label>
                  <label>
                    On error
                    <select
                      value={step.on_error ?? 'stop'}
                      onChange={(e) => setStep(i, { on_error: e.target.value as 'stop' | 'continue' })}
                    >
                      <option value="stop">Stop the run</option>
                      <option value="continue">Continue</option>
                    </select>
                  </label>
                  <button type="button" className="ghost" disabled={i === 0} onClick={() => moveStep(i, -1)}>
                    Move step {i + 1} up
                  </button>
                  <button
                    type="button"
                    className="ghost"
                    disabled={i === draft.steps.length - 1}
                    onClick={() => moveStep(i, 1)}
                  >
                    Move step {i + 1} down
                  </button>
                  <button
                    type="button"
                    className="ghost"
                    onClick={() => setDraft({ ...draft, steps: draft.steps.filter((_, j) => j !== i) })}
                  >
                    Remove step {i + 1}
                  </button>
                </div>
                {spec?.description && <p className="muted">{spec.description}</p>}
                <div className="case-grid">
                  {spec?.inputs.map((input) => {
                    const props = {
                      required: input.required,
                      value: step.inputs?.[input.name] ?? '',
                      placeholder: input.help,
                      onChange: (e: { target: { value: string } }) =>
                        setStep(i, { inputs: { ...step.inputs, [input.name]: e.target.value } }),
                    }
                    return (
                      <label key={input.name} className={input.multiline ? 'wide' : undefined}>
                        {input.label}
                        {input.multiline ? <textarea rows={3} {...props} /> : <input {...props} />}
                      </label>
                    )
                  })}
                </div>
              </li>
            )
          })}
        </ol>
        <label>
          Add a step{' '}
          <select value="" onChange={(e) => addStep(e.target.value)}>
            <option value="">Choose an action...</option>
            {[...new Set(catalog.map((a) => a.group))].map((group) => (
              <optgroup key={group} label={group}>
                {catalog
                  .filter((a) => a.group === group)
                  .map((a) => (
                    <option key={a.key} value={a.key}>
                      {a.label}
                    </option>
                  ))}
              </optgroup>
            ))}
          </select>
        </label>
      </fieldset>
    </form>
  )
}
