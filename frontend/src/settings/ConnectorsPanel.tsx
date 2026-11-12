import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState, type FormEvent } from 'react'
import { api, describeError, type ConnectorOut } from '../api/client'

type Kind = ConnectorOut['kind']

const KINDS: Record<Kind, { label: string; secret: string; multiline?: boolean }> = {
  entra: { label: 'Entra ID and Intune (Microsoft Graph)', secret: 'Client secret' },
  crowdstrike: { label: 'CrowdStrike Falcon', secret: 'Client secret' },
  google: { label: 'Google Workspace', secret: 'Private key (PEM)', multiline: true },
  slack: { label: 'Slack (Enterprise Grid)', secret: 'User token (xoxp-)' },
}

const FIELDS: Record<Kind, [string, string][]> = {
  entra: [
    ['directory_id', 'Directory (tenant) ID'],
    ['client_id', 'Application (client) ID'],
  ],
  crowdstrike: [['client_id', 'API client ID']],
  google: [
    ['client_email', 'Service account email'],
    ['admin_subject', 'Admin to act as (email)'],
  ],
  slack: [],
}

/** Credentials for services that workflow actions call. Secrets are write-only. */
export function ConnectorsPanel({ slug }: { slug: string }) {
  const queryClient = useQueryClient()
  const [editing, setEditing] = useState<ConnectorOut | 'new' | null>(null)
  const [tested, setTested] = useState<Record<string, string>>({})
  const refresh = () => queryClient.invalidateQueries({ queryKey: ['connectors', slug] })

  const connectors = useQuery({
    queryKey: ['connectors', slug],
    queryFn: async () => {
      const { data, error, response } = await api.GET('/api/tenants/{slug}/connectors', {
        params: { path: { slug } },
      })
      if (!data) throw new Error(describeError(error, response.status))
      return data
    },
  })

  const test = useMutation({
    mutationFn: async (c: ConnectorOut) => {
      const { error, response } = await api.POST('/api/tenants/{slug}/connectors/{connector_id}/test', {
        params: { path: { slug, connector_id: c.id } },
      })
      const detail = (error as { detail?: unknown } | undefined)?.detail
      return [c.id, response.ok ? 'Signed in' : `Failed: ${typeof detail === 'string' ? detail : response.status}`]
    },
    onSuccess: ([id, result]) => setTested({ ...tested, [id]: result }),
  })

  const remove = useMutation({
    mutationFn: async (c: ConnectorOut) => {
      const { response } = await api.DELETE('/api/tenants/{slug}/connectors/{connector_id}', {
        params: { path: { slug, connector_id: c.id } },
      })
      if (!response.ok) throw new Error(`Could not delete (${response.status})`)
    },
    onSuccess: refresh,
  })

  return (
    <section className="panel">
      <h3>Connectors</h3>
      <p className="muted">
        Credentials workflow actions use to act on other services. A secret can be replaced
        but is never shown again.
      </p>
      {connectors.isError && <p className="step-error">{connectors.error.message}</p>}
      {!!connectors.data?.length && (
        <table className="data-table">
          <thead>
            <tr>
              <th>Key</th>
              <th>Name</th>
              <th>Service</th>
              <th>Secret</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {connectors.data.map((c) => (
              <tr key={c.id}>
                <td>
                  <code>{c.key}</code>
                </td>
                <td>{c.name}</td>
                <td>{KINDS[c.kind].label}</td>
                <td className="muted">
                  {c.secret_set_at ? `set ${new Date(c.secret_set_at).toLocaleDateString()}` : 'missing'}
                </td>
                <td>
                  <div className="inline-form">
                    <button type="button" onClick={() => test.mutate(c)} disabled={test.isPending}>
                      Test {c.key}
                    </button>
                    <button type="button" className="ghost" onClick={() => setEditing(c)}>
                      Edit {c.key}
                    </button>
                    <button type="button" className="ghost" onClick={() => remove.mutate(c)}>
                      Delete {c.key}
                    </button>
                    {tested[c.id] && <span role="status">{tested[c.id]}</span>}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {remove.isError && <p className="step-error">{remove.error.message}</p>}
      {editing ? (
        <ConnectorForm
          slug={slug}
          initial={editing === 'new' ? null : editing}
          onDone={() => {
            setEditing(null)
            void refresh()
          }}
        />
      ) : (
        <button type="button" onClick={() => setEditing('new')}>
          Add connector
        </button>
      )}
    </section>
  )
}

function ConnectorForm({
  slug,
  initial,
  onDone,
}: {
  slug: string
  initial: ConnectorOut | null
  onDone: () => void
}) {
  const [kind, setKind] = useState<Kind>(initial?.kind ?? 'entra')
  const save = useMutation({
    mutationFn: async (form: FormData) => {
      const secret = String(form.get('secret') ?? '')
      const settings: Record<string, string> = Object.fromEntries(
        FIELDS[kind].map(([name]) => [name, String(form.get(name) ?? '').trim()]),
      )
      if (kind === 'crowdstrike') settings.cloud = String(form.get('cloud'))
      const body = {
        key: initial?.key ?? String(form.get('key')),
        kind,
        name: String(form.get('name')),
        settings,
        secret: secret || null,
      }
      const { error, response } = initial
        ? await api.PUT('/api/tenants/{slug}/connectors/{connector_id}', {
            params: { path: { slug, connector_id: initial.id } },
            body,
          })
        : await api.POST('/api/tenants/{slug}/connectors', { params: { path: { slug } }, body })
      if (!response.ok) {
        throw new Error(
          response.status === 409
            ? 'A connector with this key already exists'
            : describeError(error, response.status),
        )
      }
    },
    onSuccess: onDone,
  })

  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    save.mutate(new FormData(event.currentTarget))
  }

  const settings = (initial?.settings ?? {}) as Record<string, string | undefined>
  const secretLabel = KINDS[kind].secret + (initial ? ' (leave empty to keep)' : '')
  return (
    <form className="case-grid" onSubmit={onSubmit} aria-label="Connector" autoComplete="off">
      <label>
        Service
        <select value={kind} disabled={!!initial} onChange={(e) => setKind(e.target.value as Kind)}>
          {(Object.keys(KINDS) as Kind[]).map((k) => (
            <option key={k} value={k}>
              {KINDS[k].label}
            </option>
          ))}
        </select>
      </label>
      <label>
        Key
        <input
          key={kind}
          name="key"
          required
          pattern="[a-z0-9][a-z0-9_\-]{0,39}"
          defaultValue={initial?.key ?? kind}
          disabled={!!initial}
        />
      </label>
      <label>
        Name
        <input
          key={`name-${kind}`}
          name="name"
          required
          maxLength={120}
          defaultValue={initial?.name ?? KINDS[kind].label}
        />
      </label>
      {kind === 'crowdstrike' && (
        <label>
          Cloud
          <select name="cloud" defaultValue={settings.cloud ?? 'us-2'}>
            <option value="us-1">US-1</option>
            <option value="us-2">US-2</option>
            <option value="eu-1">EU-1</option>
            <option value="us-gov-1">US-GOV-1</option>
          </select>
        </label>
      )}
      {FIELDS[kind].map(([name, label]) => (
        <label key={name}>
          {label}
          <input name={name} required defaultValue={settings[name] ?? ''} />
        </label>
      ))}
      <label className={KINDS[kind].multiline ? 'wide' : undefined}>
        {secretLabel}
        {KINDS[kind].multiline ? (
          <textarea name="secret" rows={4} required={!initial} spellCheck={false} />
        ) : (
          <input name="secret" type="password" required={!initial} autoComplete="new-password" />
        )}
      </label>
      <div className="save-bar wide">
        <button type="submit" disabled={save.isPending}>
          Save connector
        </button>
        <button type="button" className="ghost" onClick={onDone}>
          Cancel
        </button>
        {save.isError && <span role="alert">{save.error.message}</span>}
      </div>
    </form>
  )
}
