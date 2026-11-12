import { fireEvent, screen } from '@testing-library/react'
import { afterEach, expect, test, vi } from 'vitest'
import { MEMBERS, TENANT } from '../cases/fixtures'
import { json, mockApi, renderInTenant } from '../testing'
import { RUN, WORKFLOW } from './fixtures'
import { WorkflowRunsPanel } from './WorkflowRunsPanel'

afterEach(() => vi.unstubAllGlobals())

const BASE = '/api/tenants/dr'

function show(canApprove = true) {
  renderInTenant(
    <WorkflowRunsPanel slug="dr" number={7} members={MEMBERS} canWrite canApprove={canApprove} />,
    TENANT,
  )
}

test('shows steps and approves the waiting one with a reason', async () => {
  let run = RUN
  const requests = mockApi({
    [`GET ${BASE}/cases/7/workflow-runs`]: () => json([run]),
    [`GET ${BASE}/workflows`]: () => json([WORKFLOW]),
    [`POST ${BASE}/workflow-runs/r1/steps/s2/approve`]: () => {
      run = { ...RUN, status: 'running', steps: [RUN.steps[0], { ...RUN.steps[1], status: 'queued' }] }
      return json(run)
    },
  })
  show()
  expect(await screen.findByText('Spray against ann@example.test')).toBeInTheDocument()
  expect(screen.getByText('awaiting approval')).toBeInTheDocument()
  fireEvent.change(screen.getByLabelText('Reason for Notify'), { target: { value: 'confirmed' } })
  fireEvent.click(screen.getByRole('button', { name: 'Approve Notify' }))
  expect(await screen.findByText('queued')).toBeInTheDocument()
  const approve = requests.find((r) => r.url.endsWith('/approve'))!
  expect(await approve.json()).toEqual({ reason: 'confirmed' })
})

test('hides approval without the permission and starts a run by hand', async () => {
  const requests = mockApi({
    [`GET ${BASE}/cases/7/workflow-runs`]: () => json([]),
    [`GET ${BASE}/workflows`]: () => json([WORKFLOW]),
    [`POST ${BASE}/cases/7/workflow-runs`]: () => json(RUN, 201),
  })
  show(false)
  expect(await screen.findByText('No workflow has run on this case.')).toBeInTheDocument()
  expect(screen.queryByRole('button', { name: /Approve/ })).not.toBeInTheDocument()
  fireEvent.change(await screen.findByLabelText('Run workflow'), { target: { value: 'w1' } })
  fireEvent.click(screen.getByRole('button', { name: 'Start' }))
  await vi.waitFor(() => expect(requests.some((r) => r.method === 'POST')).toBe(true))
  const start = requests.find((r) => r.method === 'POST')!
  expect(await start.json()).toEqual({ workflow_id: 'w1' })
})
