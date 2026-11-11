import { fireEvent, render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { afterEach, expect, test } from 'vitest'
import { NavRail } from './NavRail'
import { ThemeSwitch } from './ThemeSwitch'

afterEach(() => {
  localStorage.clear()
  delete document.documentElement.dataset.theme
})

test('theme defaults to system and leaves the OS in charge', () => {
  render(<ThemeSwitch />)
  expect(screen.getByRole('radio', { name: 'System' })).toHaveAttribute('aria-checked', 'true')
  expect(document.documentElement.dataset.theme).toBeUndefined()
})

test('pins a theme and remembers it', () => {
  render(<ThemeSwitch />)
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
  render(<ThemeSwitch />)
  expect(screen.getByRole('radio', { name: 'Light' })).toHaveAttribute('aria-checked', 'true')
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
