import { fireEvent, screen, within } from '@testing-library/react'
import { afterEach, expect, test, vi } from 'vitest'
import { MEMBERS, TENANT } from '../cases/fixtures'
import { json, mockApi, renderInTenant } from '../testing'
import { CATALOG, RUN, WORKFLOW } from './fixtures'
import { WorkflowsPage } from './WorkflowsPage'

afterEach(() => vi.unstubAllGlobals())

const BASE = '/api/tenants/dr'
const ADMIN = { ...TENANT, permissions: [...TENANT.permissions, 'config:manage'] }

function routes(extra: Record<string, (r: Request) => Response | Promise<Response>> = {}) {
  return mockApi({
    [`GET ${BASE}/workflows`]: () => json([WORKFLOW]),
    [`GET ${BASE}/workflow-actions`]: () => json(CATALOG),
    [`GET ${BASE}/workflow-runs`]: () => json([RUN]),
    [`GET ${BASE}/members`]: () => json(MEMBERS),
    ...extra,
  })
}

test('lists workflows with their trigger and recent runs', async () => {
  routes()
  renderInTenant(<WorkflowsPage />, TENANT)
  const card = (await screen.findByRole('heading', { name: 'Password spray response' })).closest('article')!
  expect(card).toHaveTextContent(
    'When: source is entra_id_protection, and payload.riskEventType equals "passwordSpray"',
  )
  expect(within(card).getByText('approval')).toBeInTheDocument()
  expect(screen.queryByRole('button', { name: 'New workflow' })).not.toBeInTheDocument()
  expect(await screen.findByRole('link', { name: '#7' })).toBeInTheDocument()
  expect(screen.getByText('1 of 2 done')).toBeInTheDocument()
})

test('creates a workflow with a condition and a step that needs approval', async () => {
  const requests = routes({ [`POST ${BASE}/workflows`]: () => json(WORKFLOW, 201) })
  renderInTenant(<WorkflowsPage />, ADMIN)
  fireEvent.click(await screen.findByRole('button', { name: 'New workflow' }))
  fireEvent.change(await screen.findByLabelText('Name'), { target: { value: 'Spray' } })
  fireEvent.change(screen.getByLabelText('Sources (comma-separated)'), {
    target: { value: 'entra_id_protection' },
  })
  fireEvent.click(screen.getByRole('button', { name: 'Add condition' }))
  fireEvent.change(screen.getByLabelText('Condition 1 field'), { target: { value: 'payload.riskEventType' } })
  fireEvent.change(screen.getByLabelText('Condition 1 value'), { target: { value: 'passwordSpray' } })
  fireEvent.change(screen.getByLabelText('Add a step'), { target: { value: 'http.post' } })
  expect(screen.getByLabelText('Mode')).toHaveValue('approval')
  fireEvent.change(screen.getByLabelText('URL'), { target: { value: 'https://hooks.example.com' } })
  fireEvent.click(screen.getByRole('button', { name: 'Save workflow' }))

  await vi.waitFor(() => expect(requests.some((r) => r.method === 'POST')).toBe(true))
  const body = await requests.find((r) => r.method === 'POST')!.json()
  expect(body).toMatchObject({
    name: 'Spray',
    trigger: {
      sources: ['entra_id_protection'],
      conditions: [{ path: 'payload.riskEventType', op: 'equals', value: 'passwordSpray' }],
    },
    steps: [
      {
        name: 'Call a webhook',
        action: 'http.post',
        mode: 'approval',
        inputs: { url: 'https://hooks.example.com' },
      },
    ],
  })
  expect(await screen.findByRole('heading', { name: 'Workflows' })).toBeInTheDocument()
})
