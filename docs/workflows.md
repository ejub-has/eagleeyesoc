# Workflows (runbooks)

A workflow reacts to incoming alerts: when an alert that matches its trigger arrives on a
case, the workflow starts a **run** on that case. Each step calls an **action**. A step runs
automatically, or waits until someone approves it on the case.

## Trigger

Every part must match (empty parts match anything; text comparisons ignore case):

- **Sources**: alert sources, e.g. `entra_id_protection` (the `<source>` in the webhook URL).
- **Title contains**: text in the alert title.
- **Conditions**: tests on alert fields by path, e.g. `payload.riskEventType` *equals*
  `passwordSpray`, `payload.userPrincipalName` *exists*, `title` *contains* `spray`.

Alerts held in the triage queue start workflows when an analyst opens a case from them.
A workflow runs at most once per alert. You can also start any workflow on a case by hand.

## Steps and templates

Step inputs can use `{{path}}` placeholders, filled in when the run starts:

| Placeholder | Value |
| --- | --- |
| `{{alert.payload.<field>}}` | A field of the alert as received (`.0` or `[0]` for list items) |
| `{{alert.title}}`, `{{alert.source}}`, `{{alert.external_id}}` | Alert basics |
| `{{case.number}}`, `{{case.title}}`, `{{case.severity}}` | Case basics |

A missing field fills in as empty; a required input left empty fails its step.

**Mode**: *auto* runs as soon as the step is reached; *approval* waits for an analyst, IR
lead or admin (the `workflows:approve` permission) to approve or reject it. Actions that
change something outside the case (webhooks, accounts, devices, tokens) default to
*approval*. **On error**: *stop* ends the run; *continue* moves to the next step.

Rejecting a step cancels the run. Every step's outcome is added to the case timeline and
the audit log.

## Actions

| Action | Impact | Notes |
| --- | --- | --- |
| Add a note, task, or timeline event | Case | |
| Call a webhook | Change | HTTPS only; private and internal addresses are refused |

Connector actions (Entra ID, Intune, CrowdStrike, Google Workspace, Slack) are added with
connectors; see `PLAN.md`.

## Running

The `worker` service (compose) or the `<release>-worker` Deployment (Helm, `worker.replicas`)
executes queued steps within seconds. Several workers can run side by side.

## Example: password spray

Trigger: source `entra_id_protection`, condition `payload.riskEventType` equals
`passwordSpray`. Steps:

1. *Add a note* (auto): `Password spray against {{alert.payload.userPrincipalName}}`.
2. *Force password change at next sign-in* (approval), user `{{alert.payload.userPrincipalName}}`.
3. *Revoke sign-in sessions* (approval), same user.

Steps 2 and 3 need the Entra ID connector.
