import { matchPath, useLocation, useNavigate, type Location } from 'react-router'

/** Routing state that opens a case over the page it was opened from. */
export interface CaseState {
  background: Location
}

/** The page under an open case, if the case was opened over one. */
export function useBackground(): Location | undefined {
  return (useLocation().state as CaseState | null)?.background
}

/**
 * State for a link to a case: open it over the current page. From a case that is already
 * open, keep the page under it; a case reached by its own URL sits over the cases list.
 */
export function useCaseState(): CaseState {
  const location = useLocation()
  const background = useBackground()
  if (background) return { background }
  const onCase = matchPath('/t/:slug/cases/:number', location.pathname)
  if (onCase) {
    return { background: { ...location, pathname: `/t/${onCase.params.slug}`, search: '', state: null } }
  }
  return { background: location }
}

/** Navigate to a case, opening it over the current page. */
export function useOpenCase(slug: string): (number: number) => void {
  const navigate = useNavigate()
  const state = useCaseState()
  return (number) => navigate(`/t/${slug}/cases/${number}`, { state })
}
