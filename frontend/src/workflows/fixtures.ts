import type { ActionSpec, Workflow, WorkflowRun } from '../api/client'

export const CATALOG: ActionSpec[] = [
  {
    key: 'case.add_note',
    label: 'Add a note',
    description: 'Adds a note to the case journal.',
    group: 'Case',
    impact: 'read',
    inputs: [{ name: 'body', label: 'Note', required: true, multiline: true, help: '' }],
  },
  {
    key: 'http.post',
    label: 'Call a webhook',
    description: 'POSTs JSON to an HTTPS URL.',
    group: 'Integrations',
    impact: 'change',
    inputs: [
      { name: 'url', label: 'URL', required: true, multiline: false, help: 'https:// only' },
      { name: 'body', label: 'JSON body', required: false, multiline: true, help: '' },
    ],
  },
]

export const WORKFLOW: Workflow = {
  id: 'w1',
  name: 'Password spray response',
  description: '',
  enabled: true,
  trigger: {
    sources: ['entra_id_protection'],
    title_contains: '',
    conditions: [{ path: 'payload.riskEventType', op: 'equals', value: 'passwordSpray' }],
  },
  steps: [
    { name: 'Record', action: 'case.add_note', mode: 'auto', on_error: 'stop', inputs: { body: 'x' } },
    {
      name: 'Notify',
      action: 'http.post',
      mode: 'approval',
      on_error: 'stop',
      inputs: { url: 'https://hooks.example.com' },
    },
  ],
  updated_by: 'user:u1',
  updated_at: '2026-11-11T12:00:00Z',
}

export const RUN: WorkflowRun = {
  id: 'r1',
  workflow_id: 'w1',
  workflow_name: 'Password spray response',
  case_number: 7,
  alert_id: 'a1',
  status: 'waiting',
  started_by: 'token:t1',
  started_at: '2026-11-11T12:00:00Z',
  finished_at: null,
  steps: [
    {
      id: 's1',
      position: 0,
      name: 'Record',
      action: 'case.add_note',
      mode: 'auto',
      on_error: 'stop',
      inputs: { body: 'Spray against ann@example.test' },
      status: 'succeeded',
      output: { note_id: 'n1' },
      error: null,
      decided_by: null,
      decided_at: null,
      decision_reason: null,
      started_at: '2026-11-11T12:00:01Z',
      finished_at: '2026-11-11T12:00:01Z',
    },
    {
      id: 's2',
      position: 1,
      name: 'Notify',
      action: 'http.post',
      mode: 'approval',
      on_error: 'stop',
      inputs: { url: 'https://hooks.example.com' },
      status: 'awaiting_approval',
      output: null,
      error: null,
      decided_by: null,
      decided_at: null,
      decision_reason: null,
      started_at: null,
      finished_at: null,
    },
  ],
}
