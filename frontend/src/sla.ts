/** "1h 20m left" or "12m overdue" for an SLA deadline. */
export function dueLabel(dueAt: string, now = Date.now()): string {
  const diff = Date.parse(dueAt) - now
  const minutes = Math.round(Math.abs(diff) / 60_000)
  const days = Math.floor(minutes / 1440)
  const hours = Math.floor((minutes % 1440) / 60)
  const span = days ? `${days}d ${hours}h` : hours ? `${hours}h ${minutes % 60}m` : `${minutes}m`
  return diff < 0 ? `${span} overdue` : `${span} left`
}
