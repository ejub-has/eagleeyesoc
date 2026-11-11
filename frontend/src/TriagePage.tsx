import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { Link, useNavigate } from 'react-router'
import { api, describeError, type QueuedAlert } from './api/client'
import { useTenant } from './tenant'

type Decision = { alert: string; kind: 'promote'; into?: number } | { alert: string; kind: 'dismiss' }

export function TriagePage() {
  const { slug, permissions } = useTenant()
  const canDecide = permissions.includes('cases:write')
  const queryClient = useQueryClient()
  const navigate = useNavigate()

  const alerts = useQuery({
    queryKey: ['triage', slug],
    queryFn: async () => {
      const { data, response } = await api.GET('/api/tenants/{slug}/triage', {
        params: { path: { slug } },
      })
      if (!data) throw new Error(`Could not load the triage queue (${response.status})`)
      return data
    },
  })

  const decide = useMutation({
    mutationFn: async ({ decision, reason }: { decision: Decision; reason: string }) => {
      const path = { slug, alert_id: decision.alert }
      if (decision.kind === 'dismiss') {
        const { error, response } = await api.POST('/api/tenants/{slug}/triage/{alert_id}/dismiss', {
          params: { path },
          body: { reason },
        })
        if (!response.ok) throw new Error(describeError(error, response.status))
        return null
      }
      const { data, error, response } = await api.POST('/api/tenants/{slug}/triage/{alert_id}/promote', {
        params: { path },
        body: { reason, into: decision.into ?? null },
      })
      if (!data) throw new Error(describeError(error, response.status))
      return data
    },
    onSuccess: async (promoted) => {
      await queryClient.invalidateQueries({ queryKey: ['triage', slug] })
      if (promoted?.new_case) navigate(`/t/${slug}/cases/${promoted.case_number}`)
    },
  })

  return (
    <section>
      <div className="page-head">
        <h2>Triage</h2>
        {alerts.data && <span className="page-count">{alerts.data.length} waiting</span>}
      </div>
      {alerts.isError && <p role="alert">{alerts.error.message}</p>}
      {decide.isError && <p role="alert">{decide.error.message}</p>}
      {alerts.data?.length === 0 && <p className="empty">No alerts are waiting.</p>}
      <ol className="triage">
        {alerts.data?.map((alert) => (
          <AlertItem
            key={alert.id}
            alert={alert}
            slug={slug}
            canDecide={canDecide}
            busy={decide.isPending}
            onDecide={(decision, reason) => decide.mutate({ decision, reason })}
          />
        ))}
      </ol>
    </section>
  )
}

function AlertItem({
  alert,
  slug,
  canDecide,
  busy,
  onDecide,
}: {
  alert: QueuedAlert
  slug: string
  canDecide: boolean
  busy: boolean
  onDecide: (decision: Decision, reason: string) => void
}) {
  const [reason, setReason] = useState('')
  const ready = reason.trim() !== '' && !busy
  const label = `Reason for ${alert.title}`

  return (
    <li className="card alert-card">
      <h3>{alert.title}</h3>
      <p className="alert-meta">
        <span className="badge">{alert.source}</span>
        {alert.external_id && ` ${alert.external_id}`} | received {new Date(alert.received_at).toLocaleString()}
        {alert.template && ` | template ${alert.template}`}
      </p>
      {alert.matches.length > 0 && (
        <div className="notice">
          <p>Possible duplicates (open cases sharing observables):</p>
          <ul>
            {alert.matches.map((m) => (
              <li key={m.case_number}>
                <Link to={`/t/${slug}/cases/${m.case_number}`}>
                  #{m.case_number} {m.case_title}
                </Link>{' '}
                ({m.observables.join(', ')})
                {canDecide && (
                  <>
                    {' '}
                    <button
                      type="button"
                      disabled={!ready}
                      onClick={() => onDecide({ alert: alert.id, kind: 'promote', into: m.case_number }, reason)}
                    >
                      Add to #{m.case_number}
                    </button>
                  </>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}
      <details>
        <summary>Payload</summary>
        <pre>{JSON.stringify(alert.payload, null, 2)}</pre>
      </details>
      {canDecide && (
        <div className="inline-form">
          <input
            aria-label={label}
            placeholder="Reason (required)"
            maxLength={1000}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
          />
          <button
            type="button"
            className="primary"
            disabled={!ready}
            onClick={() => onDecide({ alert: alert.id, kind: 'promote' }, reason)}
          >
            Open case
          </button>
          <button
            type="button"
            className="ghost"
            disabled={!ready}
            onClick={() => onDecide({ alert: alert.id, kind: 'dismiss' }, reason)}
          >
            Dismiss
          </button>
        </div>
      )}
    </li>
  )
}
