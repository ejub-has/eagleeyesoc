import { fireEvent, screen, within } from '@testing-library/react'
import { afterEach, expect, test, vi } from 'vitest'
import { json, mockApi, renderInTenant } from '../testing'
import { MEMBERS, NO_VERDICT, TENANT } from './fixtures'
import { ObservablePage } from './ObservablePage'

afterEach(() => vi.unstubAllGlobals())

function open() {
  renderInTenant(<ObservablePage />, TENANT, {
    path: '/t/dr/observables/o1',
    route: 'observables/:observableId',
  })
}

test('lists every case the observable appears in', async () => {
  mockApi({
    'GET /api/tenants/dr/observables/o1': () =>
      json({
        id: 'o1',
        type: 'domain',
        value: 'evil.example',
        defanged: 'evil[.]example',
        verdict: NO_VERDICT,
        cases: [
          { number: 9, title: 'Campaign', state: 'triage', severity: 'high', created_at: '2026-10-31T10:00:00Z' },
          { number: 7, title: 'First report', state: 'closed', severity: 'low', created_at: '2026-10-30T10:00:00Z' },
        ],
      }),
  })
  open()
  expect(await screen.findByRole('heading', { name: 'domain: evil[.]example unknown' })).toBeInTheDocument()
  expect(screen.getByText('Seen in 2 cases.')).toBeInTheDocument()
  const rows = screen.getAllByRole('row').slice(1)
  expect(within(rows[0]).getByRole('link', { name: 'Campaign' })).toHaveAttribute('href', '/t/dr/cases/9')
})

test('reports an unknown observable', async () => {
  mockApi({ 'GET /api/tenants/dr/observables/o1': () => json({ detail: 'Observable not found' }, 404) })
  open()
  expect(await screen.findByRole('alert')).toHaveTextContent('Observable not found')
})

test('sets a verdict with confidence and expiry', async () => {
  const page = {
    id: 'o1',
    type: 'domain',
    value: 'evil.example',
    defanged: 'evil[.]example',
    verdict: NO_VERDICT,
    cases: [],
  }
  const requests = mockApi({
    'GET /api/tenants/dr/observables/o1': () => json(page),
    'GET /api/tenants/dr/members': () => json(MEMBERS),
    'PUT /api/tenants/dr/observables/o1/verdict': async (request) => {
      const body = (await request.json()) as { verdict: string; confidence: number }
      return json({
        ...page,
        verdict: {
          ...NO_VERDICT,
          verdict: body.verdict,
          set_verdict: body.verdict,
          confidence: body.confidence,
          set_by: 'user:u1',
          set_at: '2026-11-11T12:00:00Z',
        },
      })
    },
  })
  open()
  fireEvent.change(await screen.findByLabelText('Verdict'), { target: { value: 'malicious' } })
  fireEvent.change(screen.getByLabelText('Confidence (%)'), { target: { value: '85' } })
  fireEvent.change(screen.getByLabelText('Expires'), { target: { value: '30' } })
  fireEvent.change(screen.getByLabelText('Note'), { target: { value: 'Phishing kit' } })
  fireEvent.click(screen.getByRole('button', { name: 'Save verdict' }))

  expect(await screen.findByRole('heading', { name: 'domain: evil[.]example malicious 85%' })).toBeInTheDocument()
  const put = requests.find((r) => r.method === 'PUT')!
  const sent = (await put.json()) as { verdict: string; confidence: number; expires_at: string; note: string }
  expect(sent).toMatchObject({ verdict: 'malicious', confidence: 85, note: 'Phishing kit' })
  const days = (Date.parse(sent.expires_at) - Date.now()) / 86_400_000
  expect(days).toBeGreaterThan(29.9)
  expect(days).toBeLessThan(30.1)
})
