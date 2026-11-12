import { useState, type DragEvent } from 'react'
import { Link } from 'react-router'
import type { Case, Member, State } from '../api/client'
import { dueLabel } from '../sla'
import type { CaseState } from './caseNav'

type Summary = Pick<
  Case,
  | 'number'
  | 'title'
  | 'state'
  | 'severity'
  | 'priority'
  | 'owner_id'
  | 'tags'
  | 'restricted'
  | 'major_incident_at'
  | 'sla_status'
  | 'sla_due_at'
  | 'created_at'
>

/** Cases as cards in one column per state, in workflow order; drag a card to move it. */
export function CaseBoard({
  slug,
  cases,
  states,
  members,
  caseState,
  canMove,
  onMove,
}: {
  slug: string
  cases: Summary[]
  states: State[]
  members: Member[]
  caseState: CaseState
  canMove: boolean
  onMove: (number: number, state: string) => void
}) {
  const [over, setOver] = useState<string | null>(null)

  function drop(event: DragEvent<HTMLElement>, state: string) {
    event.preventDefault()
    setOver(null)
    const number = Number(event.dataTransfer.getData('text/plain'))
    const current = cases.find((c) => c.number === number)
    if (current && current.state !== state) onMove(number, state)
  }

  return (
    <div className="board" role="list" aria-label="Cases by state">
      {states.map((state) => {
        const column = cases.filter((c) => c.state === state.key)
        return (
          <section
            key={state.key}
            role="listitem"
            aria-label={`${state.name}, ${column.length} cases`}
            className={`board-column${over === state.key ? ' drop-target' : ''}`}
            onDragOver={(e) => {
              if (!canMove) return
              e.preventDefault()
              setOver(state.key)
            }}
            onDragLeave={() => setOver(null)}
            onDrop={(e) => drop(e, state.key)}
          >
            <header className="board-column-head">
              <h3>{state.name}</h3>
              <span className="count">{column.length}</span>
            </header>
            <div className="board-cards">
              {column.length === 0 && <p className="board-empty">No cases</p>}
              {column.map((c) => (
                <article
                  key={c.number}
                  className="board-card"
                  draggable={canMove}
                  onDragStart={(e) => {
                    e.dataTransfer.setData('text/plain', String(c.number))
                    e.dataTransfer.effectAllowed = 'move'
                  }}
                >
                  <div className="board-card-top">
                    <span className={`pill sev-${c.severity}`}>
                      {c.priority} {c.severity}
                    </span>
                    {c.sla_status && (
                      <span className={`pill sla-${c.sla_status}`} title={`SLA ${c.sla_status}`}>
                        {c.sla_due_at ? dueLabel(c.sla_due_at) : c.sla_status}
                      </span>
                    )}
                    <span className="board-number">#{c.number}</span>
                  </div>
                  <Link className="board-title" to={`/t/${slug}/cases/${c.number}`} state={caseState}>
                    {c.title}
                  </Link>
                  {(c.tags.length > 0 || c.major_incident_at || c.restricted) && (
                    <div className="board-tags">
                      {c.major_incident_at && <span className="tag tag-major">Major incident</span>}
                      {c.restricted && <span className="tag">Restricted</span>}
                      {c.tags.map((t) => (
                        <span key={t} className="tag">
                          {t}
                        </span>
                      ))}
                    </div>
                  )}
                  <div className="board-card-foot">
                    <span className="muted">Created {created(c.created_at)}</span>
                    <Avatar id={c.owner_id} members={members} />
                  </div>
                  {canMove && (
                    <select
                      className="board-move"
                      aria-label={`Move #${c.number} to`}
                      value={c.state}
                      onChange={(e) => onMove(c.number, e.target.value)}
                    >
                      {states.map((s) => (
                        <option key={s.key} value={s.key}>
                          {s.name}
                        </option>
                      ))}
                    </select>
                  )}
                </article>
              ))}
            </div>
          </section>
        )
      })}
    </div>
  )
}

function Avatar({ id, members }: { id: string | null; members: Member[] }) {
  const name = members.find((m) => m.id === id)?.display_name
  if (!name) return <span className="avatar empty" title="Unassigned" aria-label="Unassigned" />
  const initials = name
    .split(/\s+/)
    .map((part) => part[0])
    .join('')
    .slice(0, 2)
    .toUpperCase()
  return (
    <span className="avatar" title={name} aria-label={`Owner ${name}`}>
      {initials}
    </span>
  )
}

function created(iso: string): string {
  const date = new Date(iso)
  const today = new Date()
  const time = date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
  if (date.toDateString() === today.toDateString()) return `today at ${time}`
  return date.toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' })
}
