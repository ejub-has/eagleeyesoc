import { fireEvent, screen, within } from '@testing-library/react'
import { afterEach, expect, test, vi } from 'vitest'
import { json, mockApi, renderInTenant } from '../testing'
import { CasesPage } from './CasesPage'
import { CASE, CONFIG, MEMBERS, TENANT } from './fixtures'

afterEach(() => {
  vi.unstubAllGlobals()
  localStorage.clear()
})

function api(initial = [CASE]) {
  let cases = initial
  return mockApi({
    'GET /api/tenants/dr/config': () => json(CONFIG),
    'GET /api/tenants/dr/members': () => json(MEMBERS),
    'GET /api/tenants/dr/cases': (request) => {
      const state = new URL(request.url).searchParams.get('state')
      return json(cases.filter((c) => !state || c.state === state))
    },
    'POST /api/tenants/dr/cases': async (request) =>
      json({ ...CASE, number: 8, ...(await request.json()) }, 201),
    'PATCH /api/tenants/dr/cases/7': async (request) => {
      const body = (await request.json()) as { state: string }
      if (body.state === 'closed') return json({ detail: 'Close the case from its page' }, 409)
      cases = cases.map((c) => (c.number === 7 ? { ...c, ...body } : c))
      return json(cases[0])
    },
  })
}

test('lists cases with state, severity, and owner names', async () => {
  api([CASE, { ...CASE, number: 8, title: 'Ransom note', owner_id: null, restricted: true }])
  renderInTenant(<CasesPage />, TENANT)
  const rows = (await screen.findAllByRole('row')).slice(1)
  expect(rows.map((r) => within(r).getAllByRole('cell').map((c) => c.textContent))).toEqual([
    ['#7', 'Suspicious email', 'P1 high', 'New', 'J Doe', 'pending', expect.any(String)],
    ['#8', 'Ransom noteRestricted', 'P1 high', 'New', 'Unassigned', 'pending', expect.any(String)],
  ])
  expect(screen.getByRole('link', { name: 'Suspicious email' })).toHaveAttribute('href', '/t/dr/cases/7')
})

test('shows time left on the next SLA deadline', async () => {
  const due = new Date(Date.now() + 80 * 60_000 + 30_000).toISOString()
  api([{ ...CASE, sla_status: 'warning', sla_due_at: due }])
  renderInTenant(<CasesPage />, TENANT)
  expect(await screen.findByTitle('warning')).toHaveTextContent('1h 20m left')
})

test('filters by state', async () => {
  const requests = api()
  renderInTenant(<CasesPage />, TENANT)
  await screen.findByRole('link', { name: 'Suspicious email' })
  fireEvent.change(screen.getByLabelText('Show'), { target: { value: 'triage' } })
  expect(await screen.findByText('No cases yet.')).toBeInTheDocument()
  expect(requests.at(-1)!.url).toContain('state=triage')
})

test('creates a case from a template and opens it', async () => {
  const requests = api([])
  renderInTenant(<CasesPage />, TENANT)
  fireEvent.click(await screen.findByRole('button', { name: 'New case' }))
  fireEvent.change(screen.getByLabelText('Type'), { target: { value: 'bec' } })
  fireEvent.change(screen.getByLabelText('Title'), { target: { value: 'CFO wire request' } })
  fireEvent.click(screen.getByRole('button', { name: 'Create case' }))

  expect(await screen.findByText('Now at /t/dr/cases/8')).toBeInTheDocument()
  const post = requests.find((r) => r.method === 'POST')!
  expect(await post.json()).toEqual({ template: 'bec', title: 'CFO wire request', description: '' })
})

test('read-only roles cannot create cases', async () => {
  api()
  renderInTenant(<CasesPage />, { ...TENANT, permissions: ['cases:read'] })
  await screen.findByRole('link', { name: 'Suspicious email' })
  expect(screen.queryByRole('button', { name: 'New case' })).not.toBeInTheDocument()
})

test('reports a failed load', async () => {
  mockApi({
    'GET /api/tenants/dr/config': () => json(CONFIG),
    'GET /api/tenants/dr/members': () => json(MEMBERS),
    'GET /api/tenants/dr/cases': () => json({}, 500),
  })
  renderInTenant(<CasesPage />, TENANT)
  expect(await screen.findByRole('alert')).toHaveTextContent('Could not load cases (500)')
})

const TWO = [CASE, { ...CASE, number: 8, title: 'Ransom note', owner_id: null, tags: ['vip'] }]

test('board shows a column per state and moves a case', async () => {
  const requests = api(TWO)
  renderInTenant(<CasesPage />, TENANT)
  fireEvent.click(await screen.findByRole('radio', { name: 'Board' }))
  const column = await screen.findByRole('listitem', { name: 'New, 2 cases' })
  expect(within(column).getByRole('link', { name: 'Ransom note' })).toBeInTheDocument()
  expect(screen.getByRole('listitem', { name: 'Triage, 0 cases' })).toBeInTheDocument()
  expect(within(column).getByLabelText('Owner J Doe')).toHaveTextContent('JD')
  expect(localStorage.getItem('casemgr.cases-view')).toBe('board')

  fireEvent.change(screen.getByLabelText('Move #7 to'), { target: { value: 'triage' } })
  expect(await screen.findByRole('listitem', { name: 'Triage, 1 cases' })).toBeInTheDocument()
  const patch = requests.find((r) => r.method === 'PATCH')!
  expect(await patch.json()).toEqual({ state: 'triage' })
})

test('a move the server refuses is reported', async () => {
  api(TWO)
  localStorage.setItem('casemgr.cases-view', 'board')
  renderInTenant(<CasesPage />, TENANT)
  fireEvent.change(await screen.findByLabelText('Move #7 to'), { target: { value: 'closed' } })
  expect(await screen.findByRole('alert')).toHaveTextContent('Could not move #7')
})

test('filters by text, owner and tag in either view', async () => {
  api(TWO)
  renderInTenant(<CasesPage />, TENANT)
  await screen.findByRole('link', { name: 'Ransom note' })
  fireEvent.change(screen.getByLabelText('Filter cases'), { target: { value: 'ransom' } })
  expect(screen.queryByRole('link', { name: 'Suspicious email' })).not.toBeInTheDocument()
  expect(screen.getByText('1 shown')).toBeInTheDocument()
  fireEvent.click(screen.getByRole('button', { name: 'Reset filters' }))
  fireEvent.change(screen.getByLabelText('Assigned to'), { target: { value: 'u1' } })
  expect(screen.queryByRole('link', { name: 'Ransom note' })).not.toBeInTheDocument()
  fireEvent.change(screen.getByLabelText('Assigned to'), { target: { value: '' } })
  fireEvent.change(screen.getByLabelText('Tag'), { target: { value: 'vip' } })
  fireEvent.click(screen.getByRole('radio', { name: 'Board' }))
  const column = await screen.findByRole('listitem', { name: 'New, 1 cases' })
  expect(within(column).getByRole('link', { name: 'Ransom note' })).toBeInTheDocument()
})
