import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { Link } from 'react-router'
import { api, describeError, type ActionSpec, type Workflow } from '../api/client'
import { useMembers } from '../api/queries'
import { useCaseState } from '../cases/caseNav'
import { useTenant } from '../tenant'
import { Icon } from '../shell/icons'
import { toInput, useCatalog } from './data'
import { groupIcon, triggerSummary } from './flow'
import { actorName } from './labels'
import { WorkflowDesigner } from './WorkflowDesigner'

export function WorkflowsPage() {
  const { slug, permissions } = useTenant()
  const canManage = permissions.includes('config:manage')
  const canRun = permissions.includes('cases:write')
  const caseState = useCaseState()
  const members = useMembers(slug)
  const queryClient = useQueryClient()
  const [open, setOpen] = useState<Workflow | 'new' | null>(null)

  const workflows = useQuery({
    queryKey: ['workflows', slug],
    queryFn: async () => {
      const { data, error, response } = await api.GET('/api/tenants/{slug}/workflows', {
        params: { path: { slug } },
      })
      if (!data) throw new Error(describeError(error, response.status))
      return data
    },
  })
  const catalog = useCatalog(slug)
  const runs = useQuery({
    queryKey: ['workflow-runs-recent', slug],
    queryFn: async () => {
      const { data, error, response } = await api.GET('/api/tenants/{slug}/workflow-runs', {
        params: { path: { slug } },
      })
      if (!data) throw new Error(describeError(error, response.status))
      return data
    },
    refetchInterval: 10_000,
  })

  const toggle = useMutation({
    mutationFn: async (w: Workflow) => {
      const { error, response } = await api.PUT('/api/tenants/{slug}/workflows/{workflow_id}', {
        params: { path: { slug, workflow_id: w.id } },
        body: { ...toInput(w), enabled: !w.enabled },
      })
      if (!response.ok) throw new Error(describeError(error, response.status))
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['workflows', slug] }),
  })

  const actions: Record<string, ActionSpec> = Object.fromEntries(
    (catalog.data ?? []).map((a) => [a.key, a]),
  )

  if (open && catalog.data) {
    return (
      <WorkflowDesigner
        key={open === 'new' ? 'new' : open.id}
        slug={slug}
        catalog={catalog.data}
        initial={open === 'new' ? null : open}
        members={members.data ?? []}
        caseState={caseState}
        canManage={canManage}
        canRun={canRun}
        onDone={() => setOpen(null)}
      />
    )
  }

  return (
    <section>
      <div className="page-head">
        <h2>Workflows</h2>
        {workflows.data && <span className="page-count">{workflows.data.length} runbooks</span>}
        {canManage && (
          <div className="page-tools">
            <button type="button" className="primary" onClick={() => setOpen('new')}>
              New workflow
            </button>
          </div>
        )}
      </div>
      {workflows.isError && <p role="alert">{workflows.error.message}</p>}
      {toggle.isError && <p role="alert">{toggle.error.message}</p>}
      {workflows.data?.length === 0 && (
        <p className="empty">
          No workflows yet. A workflow starts on matching alerts and runs its steps on the case.
        </p>
      )}
      <div className="cards">
        {workflows.data?.map((w) => (
          <article key={w.id} className="card workflow-card">
            <div className="workflow-card-head">
              <h3>{w.name}</h3>
              <span className={`pill ${w.enabled ? 'run-succeeded' : 'run-cancelled'}`}>
                {w.enabled ? 'enabled' : 'disabled'}
              </span>
            </div>
            {w.description && <p className="muted">{w.description}</p>}
            <ol className="mini-flow" aria-label={`${w.name} steps`}>
              <li className="mini-node kind-trigger" title={`When ${triggerSummary(w.trigger)}`}>
                <Icon name="bolt" size={14} />
                <span>When {triggerSummary(w.trigger)}</span>
              </li>
              {w.steps.map((s, i) => (
                <li key={i} className="mini-node">
                  {s.mode === 'approval' && (
                    <span className="mini-gate" title="Needs approval">
                      <Icon name="gate" size={14} />
                      <span className="visually-hidden">approval, then</span>
                    </span>
                  )}
                  <Icon name={groupIcon(actions[s.action]?.group)} size={14} />
                  <span>{s.name}</span>
                </li>
              ))}
            </ol>
            <div className="inline-form">
              <button type="button" onClick={() => setOpen(w)}>
                {canManage ? `Edit ${w.name}` : `View ${w.name}`}
              </button>
              {canManage && (
                <button type="button" className="ghost" onClick={() => toggle.mutate(w)}>
                  {w.enabled ? 'Disable' : 'Enable'}
                </button>
              )}
            </div>
          </article>
        ))}
      </div>

      <h3 className="section-title">Recent runs</h3>
      {runs.data?.length === 0 && <p className="empty">No runs yet.</p>}
      {!!runs.data?.length && (
        <table className="data-table">
          <thead>
            <tr>
              <th>Workflow</th>
              <th>Case</th>
              <th>Status</th>
              <th>Steps</th>
              <th>Started</th>
            </tr>
          </thead>
          <tbody>
            {runs.data.map((r) => (
              <tr key={r.id}>
                <td>{r.workflow_name}</td>
                <td>
                  <Link to={`/t/${slug}/cases/${r.case_number}`} state={caseState}>
                    #{r.case_number}
                  </Link>
                </td>
                <td>
                  <span className={`pill run-${r.status}`}>{r.status}</span>
                </td>
                <td className="muted">
                  {r.steps.filter((s) => s.status === 'succeeded').length} of {r.steps.length} done
                </td>
                <td className="muted">
                  {new Date(r.started_at).toLocaleString()} by{' '}
                  {actorName(r.started_by, members.data ?? [])}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  )
}
