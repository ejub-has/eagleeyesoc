import { fireEvent, screen, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { afterEach, expect, test, vi } from 'vitest'
import App from './App'
import type { Me } from './api/client'
import { CASE, CONFIG, MEMBERS } from './cases/fixtures'
import { json, mockApi, renderWithQuery } from './testing'

const ME: Me = {
  id: '00000000-0000-0000-0000-000000000001',
  username: 'jdoe',
  display_name: 'J Doe',
  email: 'jdoe@example.test',
  is_platform_admin: false,
  tenants: [
    { slug: 'detect-respond', name: 'Detect and Respond', permissions: ['cases:read'] },
    { slug: 'insider-threat', name: 'Insider Threat', permissions: ['cases:read'] },
  ],
  theme: 'system',
}

afterEach(() => {
  vi.unstubAllGlobals()
  localStorage.clear()
})

/** The API a signed-in user's pages call, with empty tenants. */
function signedIn(me: Me = ME) {
  return mockApi({
    'GET /api/me': () => json(me),
    'GET /api/tenants/detect-respond/cases': () => json([]),
    'GET /api/tenants/insider-threat/cases': () => json([]),
    'GET /api/tenants/detect-respond/members': () => json([]),
    'GET /api/tenants/insider-threat/members': () => json([]),
    'GET /api/tenants/detect-respond/tokens': () => json([]),
    'POST /api/auth/logout': () => json({ logout_url: '/' }),
  })
}

function renderApp(path = '/') {
  return renderWithQuery(
    <MemoryRouter initialEntries={[path]}>
      <App />
    </MemoryRouter>,
  )
}

test('offers sign in when there is no session', async () => {
  mockApi({ 'GET /api/me': () => json({ detail: 'Not authenticated' }, 401) })
  renderApp()
  expect(await screen.findByRole('link', { name: 'Sign in' })).toHaveAttribute(
    'href',
    '/api/auth/login',
  )
})

test('opens the first tenant with its cases', async () => {
  signedIn()
  renderApp()
  expect(await screen.findByRole('heading', { name: 'Detect and Respond' })).toBeInTheDocument()
  expect(screen.getByText('J Doe')).toBeInTheDocument()
  expect(screen.getAllByRole('option').map((o) => o.textContent)).toContain('Insider Threat')
  expect(await screen.findByText('No cases yet.')).toBeInTheDocument()
  expect(screen.queryByRole('link', { name: 'Settings' })).not.toBeInTheDocument()
})

test('switches tenant and remembers the choice', async () => {
  signedIn()
  renderApp()
  fireEvent.change(await screen.findByLabelText('Tenant'), {
    target: { value: 'insider-threat' },
  })
  expect(await screen.findByRole('heading', { name: 'Insider Threat' })).toBeInTheDocument()
  expect(localStorage.getItem('casemgr.tenant')).toBe('insider-threat')
})

test('returns to the remembered tenant', async () => {
  localStorage.setItem('casemgr.tenant', 'insider-threat')
  signedIn()
  renderApp()
  expect(await screen.findByRole('heading', { name: 'Insider Threat' })).toBeInTheDocument()
})

test('ignores tenants the user no longer belongs to', async () => {
  localStorage.setItem('casemgr.tenant', 'revoked-tenant')
  signedIn()
  renderApp('/t/revoked-tenant')
  expect(await screen.findByRole('heading', { name: 'Detect and Respond' })).toBeInTheDocument()
})

test('tenant admins reach settings', async () => {
  const admin = {
    ...ME,
    tenants: [{ ...ME.tenants[0], permissions: ['cases:read', 'tokens:manage'] }],
  }
  signedIn(admin)
  renderApp()
  fireEvent.click(await screen.findByRole('link', { name: 'Settings' }))
  expect(await screen.findByRole('heading', { name: 'API tokens' })).toBeInTheDocument()
  fireEvent.click(screen.getByRole('link', { name: 'Cases' }))
  expect(await screen.findByRole('heading', { name: 'Cases' })).toBeInTheDocument()
})

test('quick search opens the search page', async () => {
  signedIn()
  renderApp()
  const box = await screen.findByRole<HTMLInputElement>('searchbox', { name: 'Quick search' })
  fireEvent.change(box, { target: { value: 'evil.example' } })
  fireEvent.submit(box.form!)
  expect(await screen.findByRole('heading', { name: 'Search' })).toBeInTheDocument()
  expect(screen.getByLabelText('Search terms')).toHaveValue('evil.example')
})

test('opens a case over the list and closes back to it', async () => {
  mockApi({
    'GET /api/me': () => json(ME),
    'GET /api/tenants/detect-respond/config': () => json(CONFIG),
    'GET /api/tenants/detect-respond/members': () => json(MEMBERS),
    'GET /api/tenants/detect-respond/cases': () => json([CASE]),
    'GET /api/tenants/detect-respond/cases/7': () => json(CASE),
  })
  renderApp()
  fireEvent.click(await screen.findByRole('link', { name: 'Suspicious email' }))
  const drawer = await screen.findByRole('dialog', { name: 'Case 7' })
  expect(await within(drawer).findByRole('heading', { name: '#7 Suspicious email' })).toBeInTheDocument()
  expect(screen.getByRole('heading', { name: 'Cases', hidden: true })).toBeInTheDocument()

  fireEvent.click(within(drawer).getByRole('button', { name: 'Close case' }))
  await vi.waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
  expect(screen.getByRole('link', { name: 'Suspicious email' })).toBeInTheDocument()
})

test('a case opened from the dashboard keeps the dashboard underneath', async () => {
  mockApi({
    'GET /api/me': () => json(ME),
    'GET /api/tenants/detect-respond/config': () => json(CONFIG),
    'GET /api/tenants/detect-respond/members': () => json(MEMBERS),
    'GET /api/tenants/detect-respond/cases/7': () => json(CASE),
    'GET /api/tenants/detect-respond/clocks': () =>
      json([{ ...CASE.clocks[0], status: 'pending', case_number: 7 }]),
  })
  renderApp('/t/detect-respond/dashboard')
  fireEvent.click(await screen.findByRole('link', { name: '#7' }))
  await screen.findByRole('dialog', { name: 'Case 7' })
  expect(screen.getByRole('heading', { name: 'Dashboard', hidden: true })).toBeInTheDocument()
  fireEvent.keyDown(document.body, { key: 'Escape' })
  await vi.waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
  expect(screen.getByRole('heading', { name: 'Dashboard' })).toBeInTheDocument()
})

test('a case reached by its URL opens linked cases over the cases list', async () => {
  const merged = { ...CASE, merged_into: 9 }
  mockApi({
    'GET /api/me': () => json(ME),
    'GET /api/tenants/detect-respond/config': () => json(CONFIG),
    'GET /api/tenants/detect-respond/members': () => json(MEMBERS),
    'GET /api/tenants/detect-respond/cases': () => json([CASE]),
    'GET /api/tenants/detect-respond/cases/7': () => json(merged),
    'GET /api/tenants/detect-respond/cases/9': () => json({ ...CASE, number: 9, title: 'Parent case' }),
  })
  renderApp('/t/detect-respond/cases/7')
  fireEvent.click(await screen.findByRole('link', { name: '#9' }))
  expect(await screen.findByRole('heading', { name: '#9 Parent case' })).toBeInTheDocument()
  expect(screen.getAllByRole('dialog')).toHaveLength(1)
})

test('explains when the user has no tenants', async () => {
  signedIn({ ...ME, tenants: [] })
  renderApp()
  expect(await screen.findByText(/do not have access to any tenant/)).toBeInTheDocument()
  expect(screen.queryByLabelText('Tenant')).not.toBeInTheDocument()
})

test('reports a server error', async () => {
  mockApi({ 'GET /api/me': () => json({ detail: 'boom' }, 500) })
  renderApp()
  expect(await screen.findByRole('alert')).toHaveTextContent('Could not load your profile (500)')
})

test('signs out through the API', async () => {
  const requests = signedIn()
  renderApp()
  fireEvent.click(await screen.findByRole('button', { name: 'Sign out' }))
  await vi.waitFor(() =>
    expect(requests.map((r) => `${r.method} ${new URL(r.url).pathname}`)).toContain(
      'POST /api/auth/logout',
    ),
  )
})
