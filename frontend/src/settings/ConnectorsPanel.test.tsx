import { fireEvent, screen } from '@testing-library/react'
import { afterEach, expect, test, vi } from 'vitest'
import type { ConnectorOut } from '../api/client'
import { json, mockApi, renderWithQuery } from '../testing'
import { ConnectorsPanel } from './ConnectorsPanel'

afterEach(() => vi.unstubAllGlobals())

const BASE = '/api/tenants/dr/connectors'
const ENTRA: ConnectorOut = {
  id: 'c1',
  key: 'entra',
  kind: 'entra',
  name: 'Corporate Entra ID',
  settings: { directory_id: '11111111-2222-3333-4444-555555555555', client_id: '66666666-7777-8888-9999-000000000000' },
  secret_set: true,
  secret_set_at: '2026-11-11T12:00:00Z',
  updated_by: 'user:u1',
  updated_at: '2026-11-11T12:00:00Z',
}

test('adds an Entra ID connector with its secret', async () => {
  const requests = mockApi({
    [`GET ${BASE}`]: () => json([]),
    [`POST ${BASE}`]: () => json(ENTRA, 201),
  })
  renderWithQuery(<ConnectorsPanel slug="dr" />)
  fireEvent.click(await screen.findByRole('button', { name: 'Add Entra ID connector' }))
  fireEvent.change(screen.getByLabelText('Directory (tenant) ID'), {
    target: { value: ENTRA.settings.directory_id },
  })
  fireEvent.change(screen.getByLabelText('Application (client) ID'), {
    target: { value: ENTRA.settings.client_id },
  })
  fireEvent.change(screen.getByLabelText('Client secret'), { target: { value: 'shh' } })
  fireEvent.click(screen.getByRole('button', { name: 'Save connector' }))
  await vi.waitFor(() => expect(requests.some((r) => r.method === 'POST')).toBe(true))
  expect(await requests.find((r) => r.method === 'POST')!.json()).toEqual({
    key: 'entra',
    kind: 'entra',
    name: 'Entra ID',
    settings: ENTRA.settings,
    secret: 'shh',
  })
})

test('tests a connector and keeps the secret when editing without one', async () => {
  const requests = mockApi({
    [`GET ${BASE}`]: () => json([ENTRA]),
    [`POST ${BASE}/c1/test`]: () => json({ detail: 'Entra ID sign-in failed (invalid_client)' }, 400),
    [`PUT ${BASE}/c1`]: () => json(ENTRA),
  })
  renderWithQuery(<ConnectorsPanel slug="dr" />)
  fireEvent.click(await screen.findByRole('button', { name: 'Test entra' }))
  expect(await screen.findByRole('status')).toHaveTextContent('Failed: Entra ID sign-in failed (invalid_client)')
  fireEvent.click(screen.getByRole('button', { name: 'Edit entra' }))
  fireEvent.click(screen.getByRole('button', { name: 'Save connector' }))
  await vi.waitFor(() => expect(requests.some((r) => r.method === 'PUT')).toBe(true))
  const body = (await requests.find((r) => r.method === 'PUT')!.json()) as { secret: string | null }
  expect(body.secret).toBeNull()
})
