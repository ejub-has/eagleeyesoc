import { useMutation, useQuery } from '@tanstack/react-query'
import { useState, type FormEvent } from 'react'
import { Link, Outlet, useMatch } from 'react-router'
import { api, describeError } from '../api/client'
import { useMembers, useTenantConfig } from '../api/queries'
import { dueLabel } from '../sla'
import { useTenant } from '../tenant'
import { useCaseState, useOpenCase } from './caseNav'

export function CasesPage() {
  const tenant = useTenant()
  const { slug, permissions } = tenant
  const openCase = useOpenCase(slug)
  const caseState = useCaseState()
  const caseOpen = !!useMatch('/t/:slug/cases/:number')
  const [state, setState] = useState('')
  const [creating, setCreating] = useState(false)
  const config = useTenantConfig(slug)
  const members = useMembers(slug)
  const cases = useQuery({
    queryKey: ['cases', slug, state],
    queryFn: async () => {
      const { data, response } = await api.GET('/api/tenants/{slug}/cases', {
        params: { path: { slug }, query: state ? { state } : {} },
      })
      if (!data) throw new Error(`Could not load cases (${response.status})`)
      return data
    },
  })

  const create = useMutation({
    mutationFn: async (body: { template: string; title: string; description: string }) => {
      const { data, error, response } = await api.POST('/api/tenants/{slug}/cases', {
        params: { path: { slug } },
        body,
      })
      if (!data) throw new Error(describeError(error, response.status))
      return data
    },
    onSuccess: (created) => {
      setCreating(false)
      openCase(created.number)
    },
  })

  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const form = new FormData(event.currentTarget)
    create.mutate({
      template: String(form.get('template')),
      title: String(form.get('title')),
      description: String(form.get('description')),
    })
  }

  const stateName = (key: string) => config.data?.states.find((s) => s.key === key)?.name ?? key
  const ownerName = (id: string | null) =>
    members.data?.find((m) => m.id === id)?.display_name ?? (id ? 'Unknown' : 'Unassigned')

  const canCreate = permissions.includes('cases:write') && !!config.data

  return (
    <>
      <section inert={caseOpen}>
        <div className="page-head">
          <h2>Cases</h2>
          {cases.data && <span className="page-count">{cases.data.length} shown</span>}
          <div className="page-tools">
            <label className="filter">
              Show{' '}
              <select value={state} onChange={(e) => setState(e.target.value)}>
                <option value="">All states</option>
                {config.data?.states.map((s) => (
                  <option key={s.key} value={s.key}>
                    {s.name}
                  </option>
                ))}
              </select>
            </label>
            {canCreate && (
              <button
                type="button"
                className="primary"
                aria-expanded={creating}
                onClick={() => setCreating(!creating)}
              >
                New case
              </button>
            )}
          </div>
        </div>

        {canCreate && creating && (
          <form className="panel stack" aria-label="Create a case" onSubmit={onSubmit}>
            <label>
              Type{' '}
              <select name="template">
                {config.data!.templates.map((t) => (
                  <option key={t.key} value={t.key}>
                    {t.name}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Title <input name="title" required maxLength={300} />
            </label>
            <label>
              Description <textarea name="description" rows={3} />
            </label>
            <div className="save-bar">
              <button type="submit" disabled={create.isPending}>
                Create case
              </button>
              <button type="button" className="ghost" onClick={() => setCreating(false)}>
                Cancel
              </button>
            </div>
            {create.isError && <p role="alert">{create.error.message}</p>}
          </form>
        )}

        {cases.isError && <p role="alert">{cases.error.message}</p>}
        {cases.data?.length === 0 && <p className="empty">No cases yet.</p>}
        {!!cases.data?.length && (
          <table className="data-table">
            <thead>
              <tr>
                <th>Case</th>
                <th>Title</th>
                <th>Severity</th>
                <th>State</th>
                <th>Owner</th>
                <th>SLA</th>
                <th>Created</th>
              </tr>
            </thead>
            <tbody>
              {cases.data.map((c) => (
                <tr key={c.number}>
                  <td className="num">#{c.number}</td>
                  <td>
                    <Link to={`/t/${slug}/cases/${c.number}`} state={caseState}>
                      {c.title}
                    </Link>
                    {c.major_incident_at && <span className="tag tag-major">Major incident</span>}
                    {c.restricted && <span className="tag">Restricted</span>}
                    {c.tags.map((t) => (
                      <span key={t} className="tag">
                        {t}
                      </span>
                    ))}
                  </td>
                  <td>
                    <span className={`pill sev-${c.severity}`}>
                      {c.priority} {c.severity}
                    </span>
                  </td>
                  <td>{stateName(c.state)}</td>
                  <td className="muted">{ownerName(c.owner_id)}</td>
                  <td>
                    {c.sla_status && (
                      <span className={`pill sla-${c.sla_status}`} title={c.sla_status}>
                        {c.sla_due_at ? dueLabel(c.sla_due_at) : c.sla_status}
                      </span>
                    )}
                  </td>
                  <td className="muted">{new Date(c.created_at).toLocaleString()}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
      <Outlet context={tenant} />
    </>
  )
}
