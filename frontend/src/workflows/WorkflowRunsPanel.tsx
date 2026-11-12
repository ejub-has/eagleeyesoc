import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { api, describeError, type Member, type WorkflowRun, type WorkflowStep } from '../api/client'
import { actorName } from './labels'

const ACTIVE = new Set(['running', 'waiting'])

/** Workflow runs on a case: each step's status and result, with approval where it waits. */
export function WorkflowRunsPanel({
  slug,
  number,
  members,
  canWrite,
  canApprove,
}: {
  slug: string
  number: number
  members: Member[]
  canWrite: boolean
  canApprove: boolean
}) {
  const queryClient = useQueryClient()
  const key = ['workflow-runs', slug, number]
  const runs = useQuery({
    queryKey: key,
    queryFn: async () => {
      const { data, error, response } = await api.GET('/api/tenants/{slug}/cases/{number}/workflow-runs', {
        params: { path: { slug, number } },
      })
      if (!data) throw new Error(describeError(error, response.status))
      return data
    },
    // Poll while a run is working through its steps, so results appear without a reload.
    refetchInterval: (query) => (query.state.data?.some((r) => ACTIVE.has(r.status)) ? 3000 : false),
  })
  const workflows = useQuery({
    queryKey: ['workflows', slug],
    enabled: canWrite,
    queryFn: async () => {
      const { data, error, response } = await api.GET('/api/tenants/{slug}/workflows', {
        params: { path: { slug } },
      })
      if (!data) throw new Error(describeError(error, response.status))
      return data
    },
  })
  const [chosen, setChosen] = useState('')
  const [reasons, setReasons] = useState<Record<string, string>>({})

  const change = useMutation({
    mutationFn: async (call: () => Promise<{ error?: unknown; response: Response }>) => {
      const { error, response } = await call()
      if (!response.ok) throw new Error(describeError(error, response.status))
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: key })
      void queryClient.invalidateQueries({ queryKey: ['case', slug, number] })
    },
  })

  function decide(run: WorkflowRun, step: WorkflowStep, approve: boolean) {
    const reason = reasons[step.id] ?? ''
    const path = { slug, run_id: run.id, step_id: step.id }
    change.mutate(() =>
      approve
        ? api.POST('/api/tenants/{slug}/workflow-runs/{run_id}/steps/{step_id}/approve', {
            params: { path },
            body: { reason },
          })
        : api.POST('/api/tenants/{slug}/workflow-runs/{run_id}/steps/{step_id}/reject', {
            params: { path },
            body: { reason },
          }),
    )
  }

  const startable = (workflows.data ?? []).filter((w) => w.enabled)

  return (
    <section>
      <h3>Workflows</h3>
      {runs.isError && <p className="step-error">Workflow runs: {runs.error.message}</p>}
      {runs.data?.length === 0 && <p className="empty">No workflow has run on this case.</p>}
      {runs.data?.map((run) => (
        <div key={run.id} className="run">
          <div className="run-head">
            <strong>{run.workflow_name}</strong>
            <span className={`pill run-${run.status}`}>{run.status}</span>
            <span className="muted">
              started {new Date(run.started_at).toLocaleString()} by {actorName(run.started_by, members)}
            </span>
            {canWrite && ACTIVE.has(run.status) && (
              <button
                type="button"
                className="ghost"
                onClick={() =>
                  change.mutate(() =>
                    api.POST('/api/tenants/{slug}/workflow-runs/{run_id}/cancel', {
                      params: { path: { slug, run_id: run.id } },
                    }),
                  )
                }
              >
                Cancel run
              </button>
            )}
          </div>
          <ol className="steps">
            {run.steps.map((step) => (
              <li key={step.id} className={`step step-${step.status}`}>
                <div className="step-head">
                  <span>{step.name}</span>
                  <span className={`pill step-${step.status}`}>{step.status.replace('_', ' ')}</span>
                  {step.mode === 'approval' && <span className="tag">needs approval</span>}
                </div>
                <dl className="step-detail">
                  {Object.entries(step.inputs).map(([name, value]) => (
                    <div key={name}>
                      <dt>{name}</dt>
                      <dd>
                        <code>{typeof value === 'string' ? value : JSON.stringify(value)}</code>
                      </dd>
                    </div>
                  ))}
                </dl>
                {step.error && <p className="step-error">{step.error}</p>}
                {step.decided_by && (
                  <p className="muted">
                    {step.status === 'rejected' ? 'Rejected' : 'Approved'} by{' '}
                    {actorName(step.decided_by, members)}
                    {step.decision_reason && `: ${step.decision_reason}`}
                  </p>
                )}
                {canApprove && step.status === 'awaiting_approval' && (
                  <div className="inline-form">
                    <input
                      value={reasons[step.id] ?? ''}
                      onChange={(e) => setReasons({ ...reasons, [step.id]: e.target.value })}
                      aria-label={`Reason for ${step.name}`}
                      placeholder="Reason (optional)"
                      maxLength={2000}
                    />
                    <button
                      type="button"
                      className="primary"
                      disabled={change.isPending}
                      onClick={() => decide(run, step, true)}
                    >
                      Approve {step.name}
                    </button>
                    <button
                      type="button"
                      disabled={change.isPending}
                      onClick={() => decide(run, step, false)}
                    >
                      Reject
                    </button>
                  </div>
                )}
              </li>
            ))}
          </ol>
        </div>
      ))}
      {change.isError && <p role="alert">{change.error.message}</p>}
      {canWrite && startable.length > 0 && (
        <div className="inline-form">
          <label>
            Run workflow{' '}
            <select value={chosen} onChange={(e) => setChosen(e.target.value)}>
              <option value="">Choose...</option>
              {startable.map((w) => (
                <option key={w.id} value={w.id}>
                  {w.name}
                </option>
              ))}
            </select>
          </label>
          <button
            type="button"
            disabled={!chosen || change.isPending}
            onClick={() => {
              change.mutate(() =>
                api.POST('/api/tenants/{slug}/cases/{number}/workflow-runs', {
                  params: { path: { slug, number } },
                  body: { workflow_id: chosen },
                }),
              )
              setChosen('')
            }}
          >
            Start
          </button>
        </div>
      )}
    </section>
  )
}
