import { useEffect, useState } from 'react'

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

/**
 * The theme choice. Saved in this browser so the page paints in the right theme at once;
 * `saved` is the choice stored on the user's profile, adopted when it arrives or changes
 * (signing in on another device), and `save` stores a new choice there.
 */
export function useTheme(
  saved?: ThemeChoice,
  save?: (choice: ThemeChoice) => void,
): [ThemeChoice, (choice: ThemeChoice) => void] {
  const [choice, setChoice] = useState<ThemeChoice>(() => {
    const stored = read(THEME_KEY)
    return stored === 'light' || stored === 'dark' ? stored : 'system'
  })

  useEffect(() => {
    if (saved) setChoice(saved)
  }, [saved])

  useEffect(() => {
    write(THEME_KEY, choice)
    applyTheme(choice)
  }, [choice])

  function change(next: ThemeChoice) {
    setChoice(next)
    save?.(next)
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
