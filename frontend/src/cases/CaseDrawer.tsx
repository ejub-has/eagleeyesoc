import { useEffect, useRef } from 'react'
import { useNavigate, useParams } from 'react-router'
import { Icon } from '../shell/icons'
import { useTenant } from '../tenant'
import { CasePage } from './CasePage'
import { useBackground } from './caseNav'

/** A case opened as a panel over the page it came from; closing returns to that page. */
export function CaseDrawer() {
  const { slug } = useTenant()
  const number = useParams().number
  const navigate = useNavigate()
  const background = useBackground()
  const panel = useRef<HTMLDivElement>(null)
  const under = background ? `${background.pathname}${background.search}` : `/t/${slug}`

  function close() {
    navigate(under)
  }

  function back() {
    const index = (window.history.state as { idx?: number } | null)?.idx ?? 0
    if (index > 0) navigate(-1)
    else close()
  }

  useEffect(() => {
    panel.current?.focus()
  }, [number])

  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      const field = (event.target as HTMLElement).closest('input, select, textarea')
      if (event.key === 'Escape' && !field) navigate(under)
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [navigate, under])

  return (
    <>
      <div className="drawer-backdrop" onClick={close} />
      <div ref={panel} className="drawer" role="dialog" aria-label={`Case ${number}`} tabIndex={-1}>
        <div className="drawer-bar">
          <button type="button" className="ghost icon-button" aria-label="Back" title="Back" onClick={back}>
            <Icon name="back" size={18} />
          </button>
          <span className="drawer-title">Case #{number}</span>
          <button type="button" className="ghost icon-button" aria-label="Close case" title="Close (Esc)" onClick={close}>
            <Icon name="close" size={18} />
          </button>
        </div>
        <div className="drawer-body">
          <CasePage />
        </div>
      </div>
    </>
  )
}
