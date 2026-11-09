import { fireEvent, screen } from '@testing-library/react'
import { afterEach, expect, test, vi } from 'vitest'
import { TENANT } from './cases/fixtures'
import { json, mockApi, renderInTenant } from './testing'
import { TriagePage } from './TriagePage'

afterEach(() => vi.unstubAllGlobals())

const ALERT = {
  id: 'a1',
  source: 'elastic',
  external_id: 'e-1',
  title: 'Reported email',
  template: 'phishing',
  received_at: '2026-11-09T12:00:00Z',
  payload: { source_ip: '198.51.100.23' },
  matches: [{ case_number: 7, case_title: 'Campaign', observables: ['ipv4:198.51.100[.]23'] }],
}

function render(tenant = TENANT) {
  renderInTenant(<TriagePage />, tenant, { route: 'triage', path: '/t/dr/triage' })
}

function api(queue = [ALERT]) {
  return mockApi({
    'GET /api/tenants/dr/triage': () => json(queue),
    'POST /api/tenants/dr/triage/a1/promote': async (request) => {
      const body = await request.json()
      return json({ case_number: body.into ?? 12, new_case: body.into == null })
    },
    'POST /api/tenants/dr/triage/a1/dismiss': () => new Response(null, { status: 204 }),
  })
}

function giveReason(text: string) {
  fireEvent.change(screen.getByLabelText('Reason for Reported email'), { target: { value: text } })
}

test('lists waiting alerts with likely duplicate cases', async () => {
  api()
  render()
  expect(await screen.findByRole('heading', { name: 'Reported email' })).toBeInTheDocument()
  expect(screen.getByRole('link', { name: '#7 Campaign' })).toHaveAttribute('href', '/t/dr/cases/7')
  expect(screen.getByText(/ipv4:198\.51\.100\[\.\]23/)).toBeInTheDocument()
  expect(screen.getByRole('button', { name: 'Open case' })).toBeDisabled()
})

test('opens a case with a reason and goes to it', async () => {
  const requests = api()
  render()
  await screen.findByRole('heading', { name: 'Reported email' })
  giveReason('User clicked the link')
  fireEvent.click(screen.getByRole('button', { name: 'Open case' }))

  expect(await screen.findByText('Now at /t/dr/cases/12')).toBeInTheDocument()
  const promote = requests.find((r) => r.method === 'POST')!
  expect(await promote.json()).toEqual({ reason: 'User clicked the link', into: null })
})

test('adds an alert to a matching case or dismisses it', async () => {
  const requests = api()
  render()
  await screen.findByRole('heading', { name: 'Reported email' })
  giveReason('Same sender')
  fireEvent.click(screen.getByRole('button', { name: 'Add to #7' }))
  await vi.waitFor(() => expect(requests.filter((r) => r.method === 'POST')).toHaveLength(1))
  expect(await requests.find((r) => r.method === 'POST')!.json()).toEqual({ reason: 'Same sender', into: 7 })

  fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }))
  await vi.waitFor(() => expect(requests.some((r) => new URL(r.url).pathname.endsWith('/dismiss'))).toBe(true))
})

test('read-only users see the queue without actions', async () => {
  api()
  render({ ...TENANT, permissions: ['cases:read'] })
  await screen.findByRole('heading', { name: 'Reported email' })
  expect(screen.queryByRole('button', { name: 'Open case' })).not.toBeInTheDocument()
  expect(screen.queryByRole('button', { name: 'Add to #7' })).not.toBeInTheDocument()
})

test('says when the queue is empty and reports failures', async () => {
  api([])
  render()
  expect(await screen.findByText('No alerts are waiting.')).toBeInTheDocument()
  vi.unstubAllGlobals()
  mockApi({ 'GET /api/tenants/dr/triage': () => json({}, 500) })
  render()
  expect(await screen.findByRole('alert')).toHaveTextContent('Could not load the triage queue (500)')
})
