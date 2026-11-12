import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { Link } from 'react-router'
import { api, describeError, type ActionSpec, type Workflow } from '../api/client'
import { useMembers } from '../api/queries'
import { useCaseState } from '../cases/caseNav'
import { useTenant } from '../tenant'
import { toInput, useCatalog } from './data'
import { WorkflowEditor } from './WorkflowEditor'
import { actorName } from './labels'

export function WorkflowsPage() {
  const { slug, permissions } = useTenant()
  const canManage = permissions.includes('config:manage')
  const caseState = useCaseState()
  const members = useMembers(slug)
  const queryClient = useQueryClient()
  const [editing, setEditing] = useState<Workflow | 'new' | null>(null)

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

  if (editing && catalog.data) {
    return (
      <WorkflowEditor
        slug={slug}
        catalog={catalog.data}
        initial={editing === 'new' ? null : editing}
        onDone={() => setEditing(null)}
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
            <button type="button" className="primary" onClick={() => setEditing('new')}>
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
            <p className="trigger-summary">
              <span className="muted">When:</span> {triggerSummary(w)}
            </p>
            <ol className="step-summary">
              {w.steps.map((s, i) => (
                <li key={i}>
                  {s.name}{' '}
                  <span className="muted">({actions[s.action]?.label ?? s.action})</span>
                  {s.mode === 'approval' && <span className="tag">approval</span>}
                </li>
              ))}
            </ol>
            {canManage && (
              <div className="inline-form">
                <button type="button" onClick={() => setEditing(w)}>
                  Edit {w.name}
                </button>
                <button type="button" className="ghost" onClick={() => toggle.mutate(w)}>
                  {w.enabled ? 'Disable' : 'Enable'}
                </button>
              </div>
            )}
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

function triggerSummary(w: Workflow): string {
  const parts: string[] = []
  const t = w.trigger
  if (t.sources?.length) parts.push(`source is ${t.sources.join(' or ')}`)
  if (t.title_contains) parts.push(`title contains "${t.title_contains}"`)
  for (const c of t.conditions ?? []) {
    parts.push(c.op === 'exists' ? `${c.path} exists` : `${c.path} ${c.op} "${c.value}"`)
  }
  return parts.length ? parts.join(', and ') : 'any alert'
}
