import { expect, test } from 'vitest'
import { dueLabel } from './sla'

const NOW = Date.parse('2026-11-11T12:00:00Z')

test.each([
  ['2026-11-11T12:12:00Z', '12m left'],
  ['2026-11-11T13:20:00Z', '1h 20m left'],
  ['2026-11-12T14:00:00Z', '1d 2h left'],
  ['2026-11-11T11:48:00Z', '12m overdue'],
  ['2026-11-11T09:00:00Z', '3h 0m overdue'],
])('%s is %s', (dueAt, label) => {
  expect(dueLabel(dueAt, NOW)).toBe(label)
})
