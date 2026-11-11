import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useId, useState, type FormEvent } from 'react'
import { createPortal } from 'react-dom'
import {
  api,
  describeError,
  type Case,
  type CaseUpdate,
  type CustomField,
  type Member,
  type Pap,
  type Regulated,
  type Resolution,
  type Tactic,
  type TenantConfig,
  type Tlp,
} from '../api/client'
import { splitList } from '../settings/editing'
import { TagInput } from './TagInput'

const TLPS: Tlp[] = ['clear', 'green', 'amber', 'amber+strict', 'red']
const PAPS: Pap[] = ['clear', 'green', 'amber', 'red']
const REGULATED: Regulated[] = ['pii', 'phi', 'pci', 'cui']
/** MITRE ATT&CK Enterprise tactics, in kill-chain order. */
const TACTICS: [Tactic, string][] = [
  ['TA0043', 'Reconnaissance'],
  ['TA0042', 'Resource Development'],
  ['TA0001', 'Initial Access'],
  ['TA0002', 'Execution'],
  ['TA0003', 'Persistence'],
  ['TA0004', 'Privilege Escalation'],
  ['TA0005', 'Defense Evasion'],
  ['TA0006', 'Credential Access'],
  ['TA0007', 'Discovery'],
  ['TA0008', 'Lateral Movement'],
  ['TA0009', 'Collection'],
  ['TA0011', 'Command and Control'],
  ['TA0010', 'Exfiltration'],
  ['TA0040', 'Impact'],
]
const RESOLUTIONS: Resolution[] = ['true_positive', 'false_positive', 'benign', 'duplicate']

type CustomValue = string | number

interface Draft {
  title: string
  description: string
  state: string
  resolution: string
  impact: string
  urgency: string
  overridden: boolean
  overrideSeverity: string
  justification: string
  owner: string
  team: string
  tlp: Tlp
  pap: Pap
  restricted: boolean
  regulated: Regulated[]
  regions: string
  units: string
  tags: string[]
  techniques: string
  tactics: Tactic[]
  detected: string
  custom: Record<string, CustomValue>
}

function toLocalInput(iso: string | null): string {
  if (!iso) return ''
  const date = new Date(iso)
  return new Date(date.getTime() - date.getTimezoneOffset() * 60_000).toISOString().slice(0, 16)
}

function toDraft(c: Case): Draft {
  return {
    title: c.title,
    description: c.description,
    state: c.state,
    resolution: c.resolution ?? '',
    impact: c.impact,
    urgency: c.urgency,
    overridden: c.override_justification !== null,
    overrideSeverity: c.severity,
    justification: c.override_justification ?? '',
    owner: c.owner_id ?? '',
    team: c.team ?? '',
    tlp: c.tlp,
    pap: c.pap,
    restricted: c.restricted,
    regulated: c.regulated_data,
    regions: c.data_regions.join(', '),
    units: c.business_units.join(', '),
    tags: c.tags,
    techniques: c.attack_techniques.join(', '),
    tactics: c.attack_tactics,
    detected: toLocalInput(c.detected_at),
    custom: c.custom as Record<string, CustomValue>,
  }
}

function toUpdate(d: Draft, config: TenantConfig): CaseUpdate {
  const terminal = config.states.some((s) => s.key === d.state && s.terminal)
  return {
    title: d.title,
    description: d.description,
    state: d.state,
    resolution: terminal && d.resolution ? (d.resolution as Resolution) : null,
    impact: d.impact,
    urgency: d.urgency,
    override: d.overridden ? { severity: d.overrideSeverity, justification: d.justification } : null,
    owner_id: d.owner || null,
    team: d.team || null,
    tlp: d.tlp,
    pap: d.pap,
    restricted: d.restricted,
    regulated_data: d.regulated,
    data_regions: splitList(d.regions),
    business_units: splitList(d.units),
    tags: d.tags,
    attack_techniques: splitList(d.techniques),
    attack_tactics: TACTICS.map(([id]) => id).filter((id) => d.tactics.includes(id)),
    detected_at: d.detected ? new Date(d.detected).toISOString() : null,
    custom: Object.fromEntries(Object.entries(d.custom).filter(([, v]) => v !== '')),
  }
}

/** Only the fields the user changed, so the audit trail and permissions stay precise. */
function changes(before: CaseUpdate, after: CaseUpdate): CaseUpdate {
  return Object.fromEntries(
    Object.entries(after).filter(
      ([key, value]) => JSON.stringify(value) !== JSON.stringify(before[key as keyof CaseUpdate]),
    ),
  )
}

export function CaseForm({
  slug,
  current,
  config,
  members,
  canWrite,
  canRestrict,
  actionsSlot,
}: {
  slug: string
  current: Case
  config: TenantConfig
  members: Member[]
  canWrite: boolean
  canRestrict: boolean
  /** Where to show the Save button, so it stays in view; inline when absent. */
  actionsSlot?: HTMLElement | null
}) {
  const formId = useId()
  const queryClient = useQueryClient()
  const [draft, setDraft] = useState(() => toDraft(current))
  const set = (change: Partial<Draft>) => setDraft({ ...draft, ...change })
  const terminal = config.states.some((s) => s.key === draft.state && s.terminal)

  const save = useMutation({
    mutationFn: async (body: CaseUpdate) => {
      const { data, error, response } = await api.PATCH('/api/tenants/{slug}/cases/{number}', {
        params: { path: { slug, number: current.number } },
        body,
      })
      if (!data) throw new Error(describeError(error, response.status))
      return data
    },
    onSuccess: (updated) => {
      setDraft(toDraft(updated))
      queryClient.setQueryData(['case', slug, current.number], updated)
      return queryClient.invalidateQueries({ queryKey: ['cases', slug] })
    },
  })

  const pending = changes(toUpdate(toDraft(current), config), toUpdate(draft, config))
  const dirty = Object.keys(pending).length > 0

  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    save.mutate(pending)
  }

  function customInput(field: CustomField) {
    const value = draft.custom[field.key] ?? ''
    const setValue = (v: CustomValue) => set({ custom: { ...draft.custom, [field.key]: v } })
    switch (field.type) {
      case 'picklist':
      case 'user':
        return (
          <select aria-label={field.label} value={value} onChange={(e) => setValue(e.target.value)}>
            <option value="" />
            {field.type === 'picklist'
              ? field.options.map((o) => <option key={o}>{o}</option>)
              : members.map((m) => (
                  <option key={m.id} value={m.username}>
                    {m.display_name}
                  </option>
                ))}
          </select>
        )
      case 'number':
        return (
          <input
            aria-label={field.label}
            type="number"
            value={value}
            onChange={(e) => setValue(e.target.value === '' ? '' : Number(e.target.value))}
          />
        )
      default:
        return (
          <input
            aria-label={field.label}
            type={field.type === 'date' ? 'date' : 'text'}
            value={value}
            onChange={(e) => setValue(e.target.value)}
          />
        )
    }
  }

  const saveBar = (
    <div className="save-bar">
      {save.error && (
        <span role="alert" className="save-error">
          {save.error.message}
        </span>
      )}
      {dirty ? (
        <span className="muted">Unsaved changes</span>
      ) : (
        save.isSuccess && <span role="status">Saved</span>
      )}
      <button type="submit" form={formId} disabled={save.isPending}>
        Save case
      </button>
    </div>
  )

  const option = (value: string, label = value) => (
    <option key={value} value={value}>
      {label}
    </option>
  )

  return (
    <form id={formId} className="case-form" onSubmit={onSubmit}>
      <fieldset disabled={!canWrite} className="case-grid">
        <label>
          Title <input value={draft.title} onChange={(e) => set({ title: e.target.value })} />
        </label>
        <label>
          State{' '}
          <select value={draft.state} onChange={(e) => set({ state: e.target.value })}>
            {config.states.map((s) => option(s.key, s.name))}
          </select>
        </label>
        {terminal && (
          <label>
            Resolution{' '}
            <select value={draft.resolution} onChange={(e) => set({ resolution: e.target.value })}>
              <option value="" />
              {RESOLUTIONS.map((r) => option(r, r.replace('_', ' ')))}
            </select>
          </label>
        )}
        <label>
          Impact{' '}
          <select value={draft.impact} onChange={(e) => set({ impact: e.target.value })}>
            {config.severity.impacts.map((i) => option(i))}
          </select>
        </label>
        <label>
          Urgency{' '}
          <select value={draft.urgency} onChange={(e) => set({ urgency: e.target.value })}>
            {config.severity.urgencies.map((u) => option(u))}
          </select>
        </label>
        <label className="check">
          <input
            type="checkbox"
            checked={draft.overridden}
            onChange={(e) => set({ overridden: e.target.checked })}
          />{' '}
          Override severity
        </label>
        {draft.overridden && (
          <>
            <label>
              Severity{' '}
              <select
                value={draft.overrideSeverity}
                onChange={(e) => set({ overrideSeverity: e.target.value })}
              >
                {config.severity.levels.map((l) => option(l.key))}
              </select>
            </label>
            <label>
              Justification{' '}
              <input
                value={draft.justification}
                onChange={(e) => set({ justification: e.target.value })}
              />
            </label>
          </>
        )}
        <label>
          Owner{' '}
          <select value={draft.owner} onChange={(e) => set({ owner: e.target.value })}>
            <option value="">Unassigned</option>
            {members.map((m) => option(m.id, m.display_name))}
          </select>
        </label>
        <label>
          Team{' '}
          <select value={draft.team} onChange={(e) => set({ team: e.target.value })}>
            <option value="">None</option>
            {config.teams.map((t) => option(t.key, t.name))}
          </select>
        </label>
        <label>
          TLP{' '}
          <select value={draft.tlp} onChange={(e) => set({ tlp: e.target.value as Tlp })}>
            {TLPS.map((t) => option(t))}
          </select>
        </label>
        <label>
          PAP{' '}
          <select value={draft.pap} onChange={(e) => set({ pap: e.target.value as Pap })}>
            {PAPS.map((p) => option(p))}
          </select>
        </label>
        <label>
          Detected{' '}
          <input
            type="datetime-local"
            value={draft.detected}
            onChange={(e) => set({ detected: e.target.value })}
          />
        </label>
        {canRestrict && (
          <label className="check">
            <input
              type="checkbox"
              checked={draft.restricted}
              onChange={(e) => set({ restricted: e.target.checked })}
            />{' '}
            Restricted
          </label>
        )}
        <fieldset className="chips">
          <legend>Regulated data</legend>
          {REGULATED.map((r) => (
            <label key={r} className="chip">
              <input
                type="checkbox"
                checked={draft.regulated.includes(r)}
                onChange={(e) =>
                  set({
                    regulated: e.target.checked
                      ? [...draft.regulated, r]
                      : draft.regulated.filter((x) => x !== r),
                  })
                }
              />{' '}
              {r.toUpperCase()}
            </label>
          ))}
        </fieldset>
        <div className="wide field">
          <span className="field-label">Tags</span>
          <TagInput value={draft.tags} onChange={(tags) => set({ tags })} disabled={!canWrite} />
        </div>
        <label>
          Data regions{' '}
          <input
            placeholder="EU, US"
            value={draft.regions}
            onChange={(e) => set({ regions: e.target.value })}
          />
        </label>
        <label>
          Business units{' '}
          <input value={draft.units} onChange={(e) => set({ units: e.target.value })} />
        </label>
        <fieldset className="wide chips">
          <legend>ATT&CK tactics</legend>
          {TACTICS.map(([id, name]) => (
            <label key={id} className="chip">
              <input
                type="checkbox"
                checked={draft.tactics.includes(id)}
                onChange={(e) =>
                  set({ tactics: e.target.checked ? [...draft.tactics, id] : draft.tactics.filter((x) => x !== id) })
                }
              />{' '}
              {name}
            </label>
          ))}
        </fieldset>
        <label>
          ATT&CK techniques{' '}
          <input
            placeholder="T1566.001"
            value={draft.techniques}
            onChange={(e) => set({ techniques: e.target.value })}
          />
        </label>
        {config.custom_fields.map((field) => (
          <label key={field.key}>
            {field.label} {customInput(field)}
          </label>
        ))}
        <label className="wide">
          Description{' '}
          <textarea
            rows={4}
            value={draft.description}
            onChange={(e) => set({ description: e.target.value })}
          />
        </label>
      </fieldset>
      {canWrite && (actionsSlot ? createPortal(saveBar, actionsSlot) : saveBar)}
    </form>
  )
}
