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

async function open(name: string, tenant = ADMIN) {
  renderInTenant(<WorkflowsPage />, tenant)
  fireEvent.click(await screen.findByRole('button', { name }))
  return screen.findByRole('list', { name: 'Workflow diagram' })
}

test('lists workflows as a flow with their trigger and recent runs', async () => {
  routes()
  renderInTenant(<WorkflowsPage />, TENANT)
  const card = (await screen.findByRole('heading', { name: 'Password spray response' })).closest('article')!
  const flow = within(card).getByRole('list', { name: 'Password spray response steps' })
  expect(flow).toHaveTextContent(
    'When source is entra_id_protection, and payload.riskEventType equals "passwordSpray"',
  )
  expect(within(flow).getByText('approval, then')).toBeInTheDocument()
  expect(screen.queryByRole('button', { name: 'New workflow' })).not.toBeInTheDocument()
  expect(screen.getByRole('button', { name: 'View Password spray response' })).toBeInTheDocument()
  expect(await screen.findByRole('link', { name: '#7' })).toBeInTheDocument()
  expect(screen.getByText('1 of 2 done')).toBeInTheDocument()
})

test('builds a workflow on the diagram and saves it', async () => {
  const requests = routes({ [`POST ${BASE}/workflows`]: () => json(WORKFLOW, 201) })
  renderInTenant(<WorkflowsPage />, ADMIN)
  fireEvent.click(await screen.findByRole('button', { name: 'New workflow' }))
  const diagram = await screen.findByRole('list', { name: 'Workflow diagram' })
  expect(within(diagram).getByRole('button', { name: 'Trigger' })).toHaveAttribute('aria-pressed', 'true')

  fireEvent.change(screen.getByLabelText('Workflow name'), { target: { value: 'Spray' } })
  fireEvent.change(screen.getByLabelText('Alert sources'), { target: { value: 'entra_id_protection' } })
  fireEvent.click(screen.getByRole('button', { name: 'Add condition' }))
  fireEvent.change(screen.getByLabelText('Condition 1 field'), { target: { value: 'payload.riskEventType' } })
  fireEvent.change(screen.getByLabelText('Condition 1 value'), { target: { value: 'passwordSpray' } })
  expect(within(diagram).getByRole('button', { name: 'Trigger' })).toHaveTextContent(
    'When source is entra_id_protection, and payload.riskEventType equals "passwordSpray"',
  )

  fireEvent.click(within(diagram).getByRole('button', { name: 'Add a step after the trigger' }))
  fireEvent.click(screen.getByRole('button', { name: /^Call a webhook/ }))
  expect(within(diagram).getByRole('button', { name: 'Step 1: Call a webhook' })).toHaveAttribute(
    'aria-pressed',
    'true',
  )
  expect(screen.getByLabelText('Runs')).toHaveValue('approval')
  expect(within(diagram).getByText('Approval')).toBeInTheDocument()
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
  expect(await screen.findByRole('heading', { name: 'Password spray response' })).toBeInTheDocument()
  expect(screen.queryByText('Unsaved changes')).not.toBeInTheDocument()
})

test('asks for a name and a step before saving', async () => {
  const requests = routes()
  renderInTenant(<WorkflowsPage />, ADMIN)
  fireEvent.click(await screen.findByRole('button', { name: 'New workflow' }))
  fireEvent.click(await screen.findByRole('button', { name: 'Save workflow' }))
  expect(screen.getByRole('alert')).toHaveTextContent('Name the workflow')
  fireEvent.change(screen.getByLabelText('Workflow name'), { target: { value: 'Spray' } })
  fireEvent.click(screen.getByRole('button', { name: 'Save workflow' }))
  expect(screen.getByRole('alert')).toHaveTextContent('Add at least one step')
  expect(requests.some((r) => r.method === 'POST')).toBe(false)
})

test('edits, inserts and reorders steps of a saved workflow', async () => {
  const requests = routes({
    [`PUT ${BASE}/workflows/w1`]: async (request) => json({ ...WORKFLOW, ...(await request.json()) }),
  })
  const diagram = await open('Edit Password spray response')
  expect(within(diagram).getByText('Approval')).toBeInTheDocument()
  expect(screen.getByRole('button', { name: 'Save workflow' })).toBeDisabled()

  fireEvent.click(within(diagram).getByRole('button', { name: 'Step 2: Notify' }))
  fireEvent.change(screen.getByLabelText('Runs'), { target: { value: 'auto' } })
  expect(within(diagram).queryByText('Approval')).not.toBeInTheDocument()
  expect(screen.getByText('Unsaved changes')).toBeInTheDocument()

  fireEvent.click(within(diagram).getByRole('button', { name: 'Add a step after step 1' }))
  fireEvent.change(screen.getByLabelText('Find an action'), { target: { value: 'note' } })
  expect(screen.queryByRole('button', { name: /^Call a webhook/ })).not.toBeInTheDocument()
  fireEvent.click(screen.getByRole('button', { name: /^Add a note/ }))
  fireEvent.change(screen.getByLabelText('Step name'), { target: { value: 'Tell the user' } })
  fireEvent.click(screen.getByRole('button', { name: 'Move down' }))
  expect(within(diagram).getByRole('button', { name: 'Step 3: Tell the user' })).toBeInTheDocument()
  fireEvent.click(screen.getByRole('button', { name: 'Save workflow' }))

  await vi.waitFor(() => expect(requests.some((r) => r.method === 'PUT')).toBe(true))
  const body = await requests.find((r) => r.method === 'PUT')!.json()
  expect(body.steps.map((s: { name: string; mode: string }) => [s.name, s.mode])).toEqual([
    ['Record', 'auto'],
    ['Notify', 'auto'],
    ['Tell the user', 'auto'],
  ])
})

test('shows a past run on the diagram', async () => {
  routes()
  await open('Edit Password spray response')
  fireEvent.click(screen.getByRole('radio', { name: 'Run log' }))
  expect(await screen.findByRole('button', { name: /Case #7/ })).toHaveAttribute('aria-pressed', 'true')
  const run = screen.getByRole('list', { name: 'Run on case #7' })
  expect(within(run).getByRole('button', { name: 'Step 1: Record' })).toHaveTextContent('succeeded')
  fireEvent.click(within(run).getByRole('button', { name: 'Step 2: Notify' }))
  const details = screen.getByRole('complementary', { name: 'Details' })
  expect(within(details).getByText('awaiting approval')).toBeInTheDocument()
  expect(within(details).getByRole('link', { name: 'Open case #7' })).toBeInTheDocument()
})

test('runs the workflow on a case', async () => {
  const requests = routes({ [`POST ${BASE}/cases/7/workflow-runs`]: () => json(RUN, 201) })
  await open('Edit Password spray response')
  fireEvent.click(screen.getByRole('button', { name: 'Run workflow' }))
  fireEvent.change(screen.getByLabelText('Run on case number'), { target: { value: '7' } })
  fireEvent.click(screen.getByRole('button', { name: 'Start run' }))
  expect(await screen.findByRole('list', { name: 'Run on case #7' })).toBeInTheDocument()
  const post = requests.find((r) => r.method === 'POST')!
  expect(await post.json()).toEqual({ workflow_id: 'w1' })
})

test('explains the workflow in plain language', async () => {
  routes()
  await open('Edit Password spray response')
  fireEvent.click(screen.getByRole('button', { name: 'More workflow actions' }))
  fireEvent.click(screen.getByRole('menuitem', { name: 'Explain workflow' }))
  const explanation = screen.getByRole('complementary', { name: 'Explanation' })
  expect(explanation).toHaveTextContent('1. Record: Add a note, automatically; stops the run if it fails.')
  expect(explanation).toHaveTextContent('2. Notify: Call a webhook, once someone with approval rights approves it')
})

test('is read-only without config rights', async () => {
  routes()
  const diagram = await open('View Password spray response', TENANT)
  expect(screen.queryByRole('button', { name: 'Save workflow' })).not.toBeInTheDocument()
  expect(within(diagram).queryByRole('button', { name: /Add a step/ })).not.toBeInTheDocument()
  fireEvent.click(within(diagram).getByRole('button', { name: 'Trigger' }))
  expect(screen.getByLabelText('Workflow name')).toBeDisabled()
})
