import { useState } from 'react'

export type ThemeChoice = 'light' | 'dark' | 'system'

export const THEME_KEY = 'casemgr.theme'
const NAV_KEY = 'casemgr.nav-expanded'

function read(key: string): string | null {
  try {
    return localStorage.getItem(key)
  } catch {
    return null
  }
}

function write(key: string, value: string) {
  try {
    localStorage.setItem(key, value)
  } catch {
    // Remembering a display choice is a convenience only.
  }
}

/** Light or Dark pins the palette; System leaves prefers-color-scheme in charge (see index.css). */
export function applyTheme(choice: ThemeChoice) {
  if (choice === 'system') delete document.documentElement.dataset.theme
  else document.documentElement.dataset.theme = choice
}

export function useTheme(): [ThemeChoice, (choice: ThemeChoice) => void] {
  const [choice, setChoice] = useState<ThemeChoice>(() => {
    const stored = read(THEME_KEY)
    return stored === 'light' || stored === 'dark' ? stored : 'system'
  })
  function change(next: ThemeChoice) {
    write(THEME_KEY, next)
    applyTheme(next)
    setChoice(next)
  }
  return [choice, change]
}

export function useNavExpanded(): [boolean, () => void] {
  const [expanded, setExpanded] = useState(() => read(NAV_KEY) === 'true')
  function toggle() {
    write(NAV_KEY, String(!expanded))
    setExpanded(!expanded)
  }
  return [expanded, toggle]
}
