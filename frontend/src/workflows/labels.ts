import type { Member } from '../api/client'

/** "user:<id>" as the member's name; tokens and workflows as short labels. */
export function actorName(actor: string, members: Member[]): string {
  const [kind, id] = actor.split(':', 2)
  if (kind === 'user') return members.find((m) => m.id === id)?.display_name ?? 'a former member'
  if (kind === 'token') return 'an API token'
  if (kind === 'workflow') return 'a workflow'
  return actor
}
