import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useId, useState, type FormEvent } from 'react'
import { Link, Outlet, useMatch } from 'react-router'
import { api, describeError } from '../api/client'
import { useMembers, useTenantConfig } from '../api/queries'
import { dueLabel } from '../sla'
import { useTenant } from '../tenant'
import { CaseBoard } from './CaseBoard'
import { useCaseState, useOpenCase } from './caseNav'

type View = 'list' | 'board'
const VIEW_KEY = 'casemgr.cases-view'

function storedView(): View {
  try {
    return localStorage.getItem(VIEW_KEY) === 'board' ? 'board' : 'list'
  } catch {
    return 'list'
  }
}

export function CasesPage() {
  const tenant = useTenant()
  const { slug, permissions } = tenant
  const openCase = useOpenCase(slug)
  const caseState = useCaseState()
  const caseOpen = !!useMatch('/t/:slug/cases/:number')
  const queryClient = useQueryClient()
  const [view, setViewState] = useState<View>(storedView)
  const [state, setState] = useState('')
  const [text, setText] = useState('')
  const [severity, setSeverity] = useState('')
  const [owner, setOwner] = useState('')
  const [tag, setTag] = useState('')
  const [creating, setCreating] = useState(false)
  const filterId = useId()
  const config = useTenantConfig(slug)
  const members = useMembers(slug)
  // The board shows every state as a column, so it always loads all cases.
  const stateFilter = view === 'board' ? '' : state
  const cases = useQuery({
    queryKey: ['cases', slug, stateFilter],
    queryFn: async () => {
      const { data, response } = await api.GET('/api/tenants/{slug}/cases', {
        params: { path: { slug }, query: stateFilter ? { state: stateFilter } : {} },
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

  const move = useMutation({
    mutationFn: async ({ number, to }: { number: number; to: string }) => {
      const { error, response } = await api.PATCH('/api/tenants/{slug}/cases/{number}', {
        params: { path: { slug, number } },
        body: { state: to },
      })
      if (!response.ok) throw new Error(`#${number}: ${describeError(error, response.status)}`)
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: ['cases', slug] }),
  })

  function setView(next: View) {
    setViewState(next)
    try {
      localStorage.setItem(VIEW_KEY, next)
    } catch {
      // Remembering the view is a convenience only.
    }
  }

  const needle = text.trim().toLowerCase()
  const shown = (cases.data ?? []).filter(
    (c) =>
      (!needle || c.title.toLowerCase().includes(needle) || `#${c.number}` === needle) &&
      (!severity || c.severity === severity) &&
      (!owner || (owner === 'none' ? c.owner_id === null : c.owner_id === owner)) &&
      (!tag || c.tags.includes(tag)),
  )
  const allTags = [...new Set((cases.data ?? []).flatMap((c) => c.tags))].sort()

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
          {cases.data && <span className="page-count">{shown.length} shown</span>}
          <div className="page-tools">
            <div className="segmented" role="radiogroup" aria-label="View">
              {(['list', 'board'] as const).map((v) => (
                <button
                  key={v}
                  type="button"
                  role="radio"
                  aria-checked={view === v}
                  onClick={() => setView(v)}
                >
                  {v === 'list' ? 'List' : 'Board'}
                </button>
              ))}
            </div>
            {view === 'list' && (
              <div className="filter">
                <label htmlFor={filterId}>Show</label>
                <select id={filterId} value={state} onChange={(e) => setState(e.target.value)}>
                  <option value="">All</option>
                  {config.data?.states.map((s) => (
                    <option key={s.key} value={s.key}>
                      {s.name}
                    </option>
                  ))}
                </select>
              </div>
            )}
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

        <div className="filter-bar">
          <input
            type="search"
            aria-label="Filter cases"
            placeholder="Filter by title or #number"
            value={text}
            onChange={(e) => setText(e.target.value)}
          />
          <select aria-label="Severity" value={severity} onChange={(e) => setSeverity(e.target.value)}>
            <option value="">Any severity</option>
            {config.data?.severity.levels.map((level) => (
              <option key={level.key} value={level.key}>
                {level.key}
              </option>
            ))}
          </select>
          <select aria-label="Assigned to" value={owner} onChange={(e) => setOwner(e.target.value)}>
            <option value="">Anyone</option>
            <option value="none">Unassigned</option>
            {members.data?.map((m) => (
              <option key={m.id} value={m.id}>
                {m.display_name}
              </option>
            ))}
          </select>
          {allTags.length > 0 && (
            <select aria-label="Tag" value={tag} onChange={(e) => setTag(e.target.value)}>
              <option value="">Any tag</option>
              {allTags.map((t) => (
                <option key={t} value={t}>
                  {t}
                </option>
              ))}
            </select>
          )}
          {(text || severity || owner || tag) && (
            <button
              type="button"
              className="ghost"
              onClick={() => {
                setText('')
                setSeverity('')
                setOwner('')
                setTag('')
              }}
            >
              Reset filters
            </button>
          )}
        </div>

        {cases.isError && <p role="alert">{cases.error.message}</p>}
        {move.isError && <p role="alert">Could not move {move.error.message}</p>}
        {cases.data?.length === 0 && <p className="empty">No cases yet.</p>}
        {view === 'board' && config.data && members.data && !!cases.data?.length && (
          <CaseBoard
            slug={slug}
            cases={shown}
            states={config.data.states}
            members={members.data}
            caseState={caseState}
            canMove={permissions.includes('cases:write')}
            onMove={(number, to) => move.mutate({ number, to })}
          />
        )}
        {view === 'list' && !!cases.data?.length && (
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
              {shown.map((c) => (
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
