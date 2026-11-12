import type { VerdictOut } from '../api/client'

/** The verdict in effect, coloured by severity; an expired verdict reads as unknown. */
export function VerdictPill({ verdict }: { verdict: VerdictOut }) {
  const title = verdict.expired
    ? `${verdict.set_verdict} verdict expired ${new Date(verdict.expires_at!).toLocaleDateString()}`
    : undefined
  return (
    <span className={`pill verdict-${verdict.verdict}`} title={title}>
      {verdict.verdict}
      {verdict.confidence != null && !verdict.expired && ` ${verdict.confidence}%`}
      {verdict.expired && ' (expired)'}
    </span>
  )
}
