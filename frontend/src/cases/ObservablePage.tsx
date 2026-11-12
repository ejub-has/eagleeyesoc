import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState, type FormEvent } from 'react'
import { Link, useParams } from 'react-router'
import { api, describeError, type VerdictIn, type VerdictOut } from '../api/client'
import { useMembers } from '../api/queries'
import { useTenant } from '../tenant'
import { useCaseState } from './caseNav'
import { VerdictPill } from './VerdictPill'

const VERDICTS: VerdictIn['verdict'][] = ['malicious', 'suspicious', 'benign', 'unknown']
const EXPIRY: [string, number | null][] = [
  ['No expiry', null],
  ['7 days', 7],
  ['30 days', 30],
  ['90 days', 90],
  ['1 year', 365],
]

export function ObservablePage() {
  const { slug, permissions } = useTenant()
  const caseState = useCaseState()
  const observableId = useParams().observableId ?? ''
  const observable = useQuery({
    queryKey: ['observable', slug, observableId],
    queryFn: async () => {
      const { data, response } = await api.GET('/api/tenants/{slug}/observables/{observable_id}', {
        params: { path: { slug, observable_id: observableId } },
      })
      if (!data) {
        throw new Error(response.status === 404 ? 'Observable not found' : `Error ${response.status}`)
      }
      return data
    },
  })

  if (observable.isError) return <p role="alert">{observable.error.message}</p>
  if (!observable.data) return <p>Loading...</p>
  const { type, defanged, cases, verdict } = observable.data

  return (
    <article>
      <h2>
        {type}: <code>{defanged}</code> <VerdictPill verdict={verdict} />
      </h2>
      <VerdictForm
        key={verdict.set_at ?? 'none'}
        current={verdict}
        url={{ slug, observable_id: observableId }}
        canWrite={permissions.includes('cases:write')}
      />
      <p>
        Seen in {cases.length} case{cases.length === 1 ? '' : 's'}.
      </p>
      <table>
        <thead>
          <tr>
            <th>#</th>
            <th>Title</th>
            <th>State</th>
            <th>Severity</th>
            <th>Created</th>
          </tr>
        </thead>
        <tbody>
          {cases.map((c) => (
            <tr key={c.number}>
              <td>{c.number}</td>
              <td>
                <Link to={`/t/${slug}/cases/${c.number}`} state={caseState}>{c.title}</Link>
              </td>
              <td>{c.state}</td>
              <td>{c.severity}</td>
              <td>{new Date(c.created_at).toLocaleString()}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </article>
  )
}

function VerdictForm({
  current,
  url,
  canWrite,
}: {
  current: VerdictOut
  url: { slug: string; observable_id: string }
  canWrite: boolean
}) {
  const queryClient = useQueryClient()
  const members = useMembers(url.slug)
  const keep = current.expires_at && !current.expired ? 'keep' : ''
  const [expiry, setExpiry] = useState(keep || '90')
  const save = useMutation({
    mutationFn: async (body: VerdictIn) => {
      const { data, error } = await api.PUT('/api/tenants/{slug}/observables/{observable_id}/verdict', {
        params: { path: url },
        body,
      })
      if (!data) throw new Error(describeError(error))
      return data
    },
    onSuccess: (page) => {
      queryClient.setQueryData(['observable', url.slug, url.observable_id], page)
      void queryClient.invalidateQueries({ queryKey: ['case', url.slug] })
    },
  })

  const setBy = current.set_by?.startsWith('user:')
    ? (members.data?.find((m) => `user:${m.id}` === current.set_by)?.display_name ?? 'a former member')
    : current.set_by

  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const form = new FormData(event.currentTarget)
    const confidence = String(form.get('confidence'))
    const days = expiry === 'keep' ? null : Number(expiry) || null
    save.mutate({
      verdict: String(form.get('verdict')) as VerdictIn['verdict'],
      confidence: confidence === '' ? null : Number(confidence),
      expires_at:
        expiry === 'keep'
          ? current.expires_at
          : days
            ? new Date(Date.now() + days * 86_400_000).toISOString()
            : null,
      note: String(form.get('note') ?? '') || null,
    })
  }

  return (
    <section className="panel verdict">
      <h3>Verdict</h3>
      {current.set_at ? (
        <p className="muted">
          Set to {current.set_verdict} by {setBy} on {new Date(current.set_at).toLocaleString()}
          {current.expires_at &&
            `; ${current.expired ? 'expired' : 'expires'} ${new Date(current.expires_at).toLocaleString()}`}
          .{current.note && ` ${current.note}`}
        </p>
      ) : (
        <p className="muted">No verdict yet. It applies to every case that has this observable.</p>
      )}
      {canWrite && (
        <form className="inline-form verdict-form" onSubmit={onSubmit}>
          <label>
            Verdict{' '}
            <select name="verdict" defaultValue={current.set_verdict}>
              {VERDICTS.map((v) => (
                <option key={v} value={v}>
                  {v}
                </option>
              ))}
            </select>
          </label>
          <label>
            Confidence (%){' '}
            <input
              name="confidence"
              type="number"
              min={0}
              max={100}
              defaultValue={current.confidence ?? ''}
            />
          </label>
          <label>
            Expires{' '}
            <select value={expiry} onChange={(e) => setExpiry(e.target.value)}>
              {keep && (
                <option value="keep">Keep ({new Date(current.expires_at!).toLocaleDateString()})</option>
              )}
              {EXPIRY.map(([label, days]) => (
                <option key={label} value={days ?? 'never'}>
                  {label}
                </option>
              ))}
            </select>
          </label>
          <label className="verdict-note">
            Note <input name="note" maxLength={2000} defaultValue={current.note ?? ''} />
          </label>
          <button type="submit" disabled={save.isPending}>
            Save verdict
          </button>
          {save.isError && <p role="alert">{save.error.message}</p>}
          {save.isSuccess && <span role="status">Saved</span>}
        </form>
      )}
    </section>
  )
}
