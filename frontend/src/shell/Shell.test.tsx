import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { afterEach, expect, test, vi } from 'vitest'
import type { Me } from '../api/client'
import { json, mockApi, renderWithQuery } from '../testing'
import { NavRail } from './NavRail'
import { ThemeSwitch } from './ThemeSwitch'

afterEach(() => {
  localStorage.clear()
  delete document.documentElement.dataset.theme
  vi.unstubAllGlobals()
})

const ME: Me = {
  id: 'u1',
  username: 'jdoe',
  display_name: 'J Doe',
  email: null,
  is_platform_admin: false,
  tenants: [],
  theme: 'dark',
}

function signedIn(me: Me) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  client.setQueryData(['me'], me)
  return render(
    <QueryClientProvider client={client}>
      <ThemeSwitch />
    </QueryClientProvider>,
  )
}

test('theme defaults to system and leaves the OS in charge', () => {
  renderWithQuery(<ThemeSwitch />)
  expect(screen.getByRole('radio', { name: 'System' })).toHaveAttribute('aria-checked', 'true')
  expect(document.documentElement.dataset.theme).toBeUndefined()
})

test('pins a theme and remembers it', () => {
  renderWithQuery(<ThemeSwitch />)
  fireEvent.click(screen.getByRole('radio', { name: 'Dark' }))
  expect(document.documentElement.dataset.theme).toBe('dark')
  expect(localStorage.getItem('casemgr.theme')).toBe('dark')
  expect(screen.getByRole('radio', { name: 'Dark' })).toHaveAttribute('aria-checked', 'true')

  fireEvent.click(screen.getByRole('radio', { name: 'System' }))
  expect(document.documentElement.dataset.theme).toBeUndefined()
  expect(localStorage.getItem('casemgr.theme')).toBe('system')
})

test('restores a saved theme', () => {
  localStorage.setItem('casemgr.theme', 'light')
  renderWithQuery(<ThemeSwitch />)
  expect(screen.getByRole('radio', { name: 'Light' })).toHaveAttribute('aria-checked', 'true')
})

test('adopts the theme saved on the profile', () => {
  localStorage.setItem('casemgr.theme', 'light')
  signedIn(ME)
  expect(screen.getByRole('radio', { name: 'Dark' })).toHaveAttribute('aria-checked', 'true')
  expect(document.documentElement.dataset.theme).toBe('dark')
  expect(localStorage.getItem('casemgr.theme')).toBe('dark')
})

test('saves a new choice to the profile when signed in', async () => {
  const requests = mockApi({ 'PATCH /api/me/preferences': () => json({ theme: 'light' }) })
  signedIn(ME)
  fireEvent.click(screen.getByRole('radio', { name: 'Light' }))
  expect(document.documentElement.dataset.theme).toBe('light')
  await waitFor(() => expect(requests).toHaveLength(1))
  expect(await requests[0].json()).toEqual({ theme: 'light' })
  expect(screen.getByRole('radio', { name: 'Light' })).toHaveAttribute('aria-checked', 'true')
})

test('keeps the choice local when signed out', () => {
  const requests = mockApi({})
  renderWithQuery(<ThemeSwitch />)
  fireEvent.click(screen.getByRole('radio', { name: 'Dark' }))
  expect(requests).toHaveLength(0)
})

test('navigation expands and remembers the choice', () => {
  render(
    <MemoryRouter initialEntries={['/t/dr/triage']}>
      <NavRail slug="dr" isAdmin={false} />
    </MemoryRouter>,
  )
  const nav = screen.getByRole('navigation', { name: 'Main' })
  expect(nav).toHaveAttribute('data-expanded', 'false')
  expect(screen.getByRole('link', { name: 'Triage' })).toHaveAttribute('aria-current', 'page')
  expect(screen.getByRole('link', { name: 'Cases' })).toHaveAttribute('href', '/t/dr')
  expect(screen.queryByRole('link', { name: 'Settings' })).not.toBeInTheDocument()

  fireEvent.click(screen.getByRole('button', { name: 'Expand navigation' }))
  expect(nav).toHaveAttribute('data-expanded', 'true')
  expect(localStorage.getItem('casemgr.nav-expanded')).toBe('true')
  expect(screen.getByRole('button', { name: 'Collapse navigation' })).toHaveAttribute(
    'aria-expanded',
    'true',
  )
})
