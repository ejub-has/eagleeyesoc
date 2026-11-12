import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState, type FormEvent } from 'react'
import { Link } from 'react-router'
import {
  api,
  describeError,
  type ActionSpec,
  type Member,
  type Workflow,
  type WorkflowIn,
  type WorkflowRun,
  type WorkflowStepDef,
} from '../api/client'
import type { CaseState } from '../cases/caseNav'
import { Icon } from '../shell/icons'
import { toInput } from './data'
import { EMPTY, explain, newStep, toSave, type Selection } from './flow'
import { FlowCanvas } from './FlowCanvas'
import { ActionPicker, RunStepPanel, StepPanel, TriggerPanel } from './Inspector'
import { actorName } from './labels'

type Tab = 'designer' | 'runs'
const ZOOMS = [0.5, 0.67, 0.8, 0.9, 1, 1.1, 1.25, 1.5]

/**
 * A workflow as a diagram: the trigger, its steps joined by arrows, and the end. Select a
 * node to change it in the side panel, or a "+" on an arrow to add a step there. The run
 * log replays past runs on the same diagram.
 */
export function WorkflowDesigner({
  slug,
  catalog,
  initial,
  members,
  caseState,
  canManage,
  canRun,
  onDone,
}: {
  slug: string
  catalog: ActionSpec[]
  initial: Workflow | null
  members: Member[]
  caseState: CaseState
  canManage: boolean
  canRun: boolean
  onDone: () => void
}) {
  const queryClient = useQueryClient()
  const [saved, setSaved] = useState<Workflow | null>(initial)
  const [draft, setDraft] = useState<WorkflowIn>(initial ? toInput(initial) : EMPTY)
  const [sources, setSources] = useState((draft.trigger.sources ?? []).join(', '))
  const [selected, setSelected] = useState<Selection>(initial ? null : { kind: 'trigger' })
  const [tab, setTab] = useState<Tab>('designer')
  const [zoom, setZoom] = useState(1)
  const [menu, setMenu] = useState(false)
  const [explaining, setExplaining] = useState(false)
  const [starting, setStarting] = useState(false)
  const [caseNumber, setCaseNumber] = useState('')
  const [runId, setRunId] = useState<string | null>(null)
  const [runSelected, setRunSelected] = useState<Selection>(null)
  const [problem, setProblem] = useState('')

  const actions: Record<string, ActionSpec> = Object.fromEntries(catalog.map((a) => [a.key, a]))
  const body = toSave(draft, sources)
  const dirty = !saved || !same(body, toInput(saved))
  const readOnly = !canManage

  const runs = useQuery({
    queryKey: ['workflow-runs-recent', slug],
    enabled: !!saved,
    queryFn: async () => {
      const { data, error, response } = await api.GET('/api/tenants/{slug}/workflow-runs', {
        params: { path: { slug } },
      })
      if (!data) throw new Error(describeError(error, response.status))
      return data
    },
    refetchInterval: tab === 'runs' ? 5000 : false,
  })
  const mine = (runs.data ?? []).filter((r) => r.workflow_id === saved?.id)
  const run = mine.find((r) => r.id === runId) ?? mine[0]

  const save = useMutation({
    mutationFn: async (input: WorkflowIn) => {
      const { data, error, response } = saved
        ? await api.PUT('/api/tenants/{slug}/workflows/{workflow_id}', {
            params: { path: { slug, workflow_id: saved.id } },
            body: input,
          })
        : await api.POST('/api/tenants/{slug}/workflows', { params: { path: { slug } }, body: input })
      if (!data) {
        throw new Error(
          response.status === 409
            ? 'A workflow with this name already exists'
            : describeError(error, response.status),
        )
      }
      return data
    },
    onSuccess: (data) => {
      setSaved(data)
      setDraft(toInput(data))
      setSources(data.trigger.sources.join(', '))
      void queryClient.invalidateQueries({ queryKey: ['workflows', slug] })
    },
  })
  const remove = useMutation({
    mutationFn: async () => {
      if (!saved) return
      const { response } = await api.DELETE('/api/tenants/{slug}/workflows/{workflow_id}', {
        params: { path: { slug, workflow_id: saved.id } },
      })
      if (response.status === 409) throw new Error('This workflow has runs; disable it instead.')
      if (!response.ok) throw new Error(`Could not delete (${response.status})`)
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['workflows', slug] })
      onDone()
    },
  })
  const start = useMutation({
    mutationFn: async (number: number) => {
      const { data, error, response } = await api.POST('/api/tenants/{slug}/cases/{number}/workflow-runs', {
        params: { path: { slug, number } },
        body: { workflow_id: saved!.id },
      })
      if (!data) throw new Error(`Case #${number}: ${describeError(error, response.status)}`)
      return data
    },
    onSuccess: (data: WorkflowRun) => {
      queryClient.setQueryData<WorkflowRun[]>(['workflow-runs-recent', slug], (old) => [
        data,
        ...(old ?? []).filter((r) => r.id !== data.id),
      ])
      void queryClient.invalidateQueries({ queryKey: ['workflow-runs-recent', slug] })
      setStarting(false)
      setCaseNumber('')
      setRunId(data.id)
      setRunSelected(null)
      setTab('runs')
    },
  })

  function onSave() {
    setProblem('')
    if (!draft.name.trim()) {
      setProblem('Name the workflow on the Trigger.')
      setSelected({ kind: 'trigger' })
      return
    }
    if (draft.steps.length === 0) {
      setProblem('Add at least one step with a "+" on the diagram.')
      return
    }
    save.mutate(body)
  }

  function toggleEnabled() {
    if (saved && !dirty) save.mutate({ ...toInput(saved), enabled: !saved.enabled })
    else setDraft({ ...draft, enabled: !draft.enabled })
  }

  function setStep(i: number, change: Partial<WorkflowStepDef>) {
    setDraft({ ...draft, steps: draft.steps.map((s, j) => (j === i ? { ...s, ...change } : s)) })
  }

  function insert(index: number, spec: ActionSpec) {
    const steps = [...draft.steps]
    steps.splice(index, 0, newStep(spec))
    setDraft({ ...draft, steps })
    setSelected({ kind: 'step', index })
  }

  function move(i: number, by: number) {
    const steps = [...draft.steps]
    ;[steps[i], steps[i + by]] = [steps[i + by], steps[i]]
    setDraft({ ...draft, steps })
    setSelected({ kind: 'step', index: i + by })
  }

  function exportJson() {
    setMenu(false)
    const blob = new Blob([JSON.stringify(body, null, 2)], { type: 'application/json' })
    const link = document.createElement('a')
    link.href = URL.createObjectURL(blob)
    link.download = `${(draft.name || 'workflow').toLowerCase().replace(/[^a-z0-9]+/g, '-')}.json`
    link.click()
    URL.revokeObjectURL(link.href)
  }

  function onStart(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const number = Number(caseNumber)
    if (Number.isInteger(number) && number > 0) start.mutate(number)
  }

  const zoomAt = ZOOMS.indexOf(zoom)
  const enabled = saved && !dirty ? saved.enabled : draft.enabled
  const step = selected?.kind === 'step' ? draft.steps[selected.index] : undefined
  const runStep = run && runSelected?.kind === 'step' ? run.steps[runSelected.index] : undefined

  return (
    <section className="designer">
      <div className="designer-bar">
        <button type="button" className="ghost icon-button" aria-label="Back to workflows" onClick={onDone}>
          <Icon name="back" size={18} />
        </button>
        <div className="designer-heading">
          <h2>{draft.name || 'New workflow'}</h2>
          <span className={`pill ${enabled ? 'run-succeeded' : 'run-cancelled'}`}>
            {enabled ? 'enabled' : 'disabled'}
          </span>
          {canManage && dirty && <span className="muted">Unsaved changes</span>}
        </div>
        <div className="segmented" role="radiogroup" aria-label="Workflow view">
          <button type="button" role="radio" aria-checked={tab === 'designer'} onClick={() => setTab('designer')}>
            Designer
          </button>
          <button
            type="button"
            role="radio"
            aria-checked={tab === 'runs'}
            disabled={!saved}
            onClick={() => setTab('runs')}
          >
            Run log
          </button>
        </div>
        <div className="designer-tools">
          {canManage && (
            <button type="button" className="ghost" onClick={toggleEnabled} disabled={save.isPending}>
              {enabled ? 'Disable' : 'Enable'}
            </button>
          )}
          {canRun && saved && (
            <button type="button" className="ghost" aria-expanded={starting} onClick={() => setStarting(!starting)}>
              <Icon name="play" size={16} /> Run workflow
            </button>
          )}
          {canManage && (
            <button type="button" className="primary" onClick={onSave} disabled={save.isPending || !dirty}>
              Save workflow
            </button>
          )}
          <div className="menu-wrap">
            <button
              type="button"
              className="ghost icon-button"
              aria-label="More workflow actions"
              aria-expanded={menu}
              onClick={() => setMenu(!menu)}
            >
              <Icon name="more" size={20} />
            </button>
            {menu && (
              <div className="menu" role="menu">
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    setMenu(false)
                    setExplaining(true)
                  }}
                >
                  Explain workflow
                </button>
                <button type="button" role="menuitem" onClick={exportJson}>
                  Export as JSON
                </button>
                {canManage && saved && (
                  <button
                    type="button"
                    role="menuitem"
                    className="danger"
                    onClick={() => {
                      setMenu(false)
                      remove.mutate()
                    }}
                  >
                    Delete workflow
                  </button>
                )}
              </div>
            )}
          </div>
        </div>
      </div>

      {starting && (
        <form className="inline-form start-run" onSubmit={onStart} aria-label="Run on a case">
          <label>
            Run on case number
            <input
              inputMode="numeric"
              required
              pattern="[0-9]+"
              value={caseNumber}
              onChange={(e) => setCaseNumber(e.target.value)}
            />
          </label>
          <button type="submit" className="primary" disabled={start.isPending}>
            Start run
          </button>
          {dirty && <span className="muted">Runs use the last saved version.</span>}
        </form>
      )}
      {problem && <p role="alert">{problem}</p>}
      {save.isError && <p role="alert">{save.error.message}</p>}
      {remove.isError && <p role="alert">{remove.error.message}</p>}
      {start.isError && <p role="alert">{start.error.message}</p>}
      {explaining && (
        <aside className="explain card" aria-label="Explanation">
          <button
            type="button"
            className="ghost icon-button"
            aria-label="Close explanation"
            onClick={() => setExplaining(false)}
          >
            <Icon name="close" size={16} />
          </button>
          {explain(body, actions).map((line) => (
            <p key={line}>{line}</p>
          ))}
        </aside>
      )}

      {tab === 'designer' && (
        <div className="designer-main">
          <div className="canvas">
            <FlowCanvas
              trigger={body.trigger}
              steps={draft.steps}
              actions={actions}
              selected={selected}
              onSelect={setSelected}
              onInsert={readOnly ? undefined : (index) => setSelected({ kind: 'add', index })}
              zoom={zoom}
            />
            <Zoom zoomAt={zoomAt} onZoom={(at) => setZoom(ZOOMS[at])} />
          </div>
          <aside className="inspector" aria-label="Details">
            {!selected && (
              <p className="muted inspector-empty">
                Select the trigger or a step to see its settings
                {readOnly ? '.' : ', or a "+" on an arrow to add a step there.'}
              </p>
            )}
            {selected?.kind === 'trigger' && (
              <TriggerPanel
                draft={draft}
                sources={sources}
                readOnly={readOnly}
                onSources={setSources}
                onChange={setDraft}
              />
            )}
            {selected?.kind === 'step' && step && (
              <StepPanel
                key={selected.index}
                index={selected.index}
                step={step}
                spec={actions[step.action]}
                count={draft.steps.length}
                readOnly={readOnly}
                onChange={(change) => setStep(selected.index, change)}
                onMove={(by) => move(selected.index, by)}
                onRemove={() => {
                  setDraft({ ...draft, steps: draft.steps.filter((_, j) => j !== selected.index) })
                  setSelected(null)
                }}
              />
            )}
            {selected?.kind === 'add' && (
              <ActionPicker
                catalog={catalog}
                after={selected.index === 0 ? 'the trigger' : `step ${selected.index}`}
                onPick={(spec) => insert(selected.index, spec)}
              />
            )}
          </aside>
        </div>
      )}

      {tab === 'runs' && (
        <div className="designer-main runs-view">
          <nav className="run-list" aria-label="Runs">
            {runs.isError && <p role="alert">{runs.error.message}</p>}
            {runs.data && mine.length === 0 && <p className="empty">No runs of this workflow yet.</p>}
            {mine.map((r) => (
              <button
                key={r.id}
                type="button"
                className="run-item"
                aria-pressed={r.id === run?.id}
                onClick={() => {
                  setRunId(r.id)
                  setRunSelected(null)
                }}
              >
                <span className="run-item-head">
                  <strong>Case #{r.case_number}</strong>
                  <span className={`pill run-${r.status}`}>{r.status}</span>
                </span>
                <span className="muted">
                  {new Date(r.started_at).toLocaleString()} by {actorName(r.started_by, members)}
                </span>
              </button>
            ))}
          </nav>
          {run && (
            <>
              <div className="canvas">
                <FlowCanvas
                  label={`Run on case #${run.case_number}`}
                  trigger={saved?.trigger ?? body.trigger}
                  steps={run.steps}
                  actions={actions}
                  selected={runSelected}
                  onSelect={setRunSelected}
                  zoom={zoom}
                />
                <Zoom zoomAt={zoomAt} onZoom={(at) => setZoom(ZOOMS[at])} />
              </div>
              <aside className="inspector" aria-label="Details">
                <p>
                  <Link to={`/t/${slug}/cases/${run.case_number}`} state={caseState}>
                    Open case #{run.case_number}
                  </Link>
                </p>
                {runStep && runSelected?.kind === 'step' ? (
                  <RunStepPanel
                    index={runSelected.index}
                    step={runStep}
                    spec={actions[runStep.action]}
                    members={members}
                  />
                ) : (
                  <p className="muted inspector-empty">
                    Select a step to see its inputs, result and who approved it. Approve waiting steps on
                    the case.
                  </p>
                )}
              </aside>
            </>
          )}
        </div>
      )}
    </section>
  )
}

function Zoom({ zoomAt, onZoom }: { zoomAt: number; onZoom: (at: number) => void }) {
  return (
    <div className="zoom" role="group" aria-label="Zoom">
      <button
        type="button"
        className="ghost icon-button"
        aria-label="Zoom out"
        disabled={zoomAt <= 0}
        onClick={() => onZoom(zoomAt - 1)}
      >
        <Icon name="minus" size={16} />
      </button>
      <button type="button" className="ghost zoom-level" aria-label="Reset zoom" onClick={() => onZoom(ZOOMS.indexOf(1))}>
        {Math.round(ZOOMS[zoomAt] * 100)}%
      </button>
      <button
        type="button"
        className="ghost icon-button"
        aria-label="Zoom in"
        disabled={zoomAt >= ZOOMS.length - 1}
        onClick={() => onZoom(zoomAt + 1)}
      >
        <Icon name="plus" size={16} />
      </button>
    </div>
  )
}

/** Equal as JSON, whatever order the keys came in. */
function same(a: unknown, b: unknown): boolean {
  const sorted = (_: string, v: unknown) =>
    v && typeof v === 'object' && !Array.isArray(v)
      ? Object.fromEntries(Object.entries(v).sort(([x], [y]) => x.localeCompare(y)))
      : v
  return JSON.stringify(a, sorted) === JSON.stringify(b, sorted)
}
