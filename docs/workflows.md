# Workflows (runbooks)

A workflow reacts to incoming alerts: when an alert that matches its trigger arrives on a
case, the workflow starts a **run** on that case. Each step calls an **action**. A step runs
automatically, or waits until someone approves it on the case.

## Designer

The **Workflows** tab shows each workflow as a small flow. Opening one shows the designer:
the trigger at the top, each step as a node joined by arrows, and an exit at the bottom.

- Select the trigger or a step to change it in the side panel.
- Select **+** on an arrow to add a step at that point; the catalog is grouped by product
  (Case, Entra ID, Intune, CrowdStrike, Google Workspace, Slack, webhooks).
- A step that needs approval shows an **Approval** gate on the arrow into it.
- **Run workflow** starts the saved version on a case by number; **Run log** replays this
  workflow's recent runs on the same diagram with each step's status, inputs and result.
- The **⋯** menu explains the workflow in plain language, exports it as JSON, or deletes it
  (only workflows that have never run; disable the others).

People without `config:manage` can view the diagram and run log but not change them.

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
| Entra ID: look up a user | Read | Name, ID, whether enabled |
| Entra ID: require a password change | Change | At the next sign-in; no new password to hand out |
| Entra ID: revoke sign-in sessions | Change | Ends Microsoft 365 (Teams, Outlook) and other Entra sessions |
| Entra ID: disable or enable a user | Change | |
| Entra ID: confirm user compromised | Change | Entra ID Protection risk becomes high |
| Entra ID: disable a device | Change | By device name or object ID |
| Intune: retire a device | Change | Removes company data and management; personal data stays |
| Intune: lock a device | Change | Remote screen lock |
| CrowdStrike: contain a host / lift containment | Change | By Falcon host ID (aid) or hostname |
| Google Workspace: sign a user out | Change | Ends web and device sessions (Gmail, Drive) |
| Google Workspace: revoke app tokens | Change | Every third-party OAuth token the user granted |
| Google Workspace: suspend a user | Change | |
| Slack: reset sessions | Change | Signs the user out everywhere (Enterprise Grid admin API) |

A device or user name that matches several objects fails the step and asks for the ID.

## Connectors

Actions that call another service use a **connector** from Settings > Connectors (tenant
admins). A connector's secret is encrypted in the database with a key derived from
`CASEMGR_SECRET_KEY` and is never shown again; **Test** signs in without changing anything.
Rotating `CASEMGR_SECRET_KEY` makes stored secrets unreadable: save each connector's secret
again afterwards. A step can name a connector by key (input *Connector*); left empty, it
uses the tenant's only connector of that kind.

### Entra ID (Microsoft Graph)

Use a test directory first, never production while you try runbooks out.

1. Entra admin center > App registrations > New registration, e.g. *Eagle Eye workflows*
   (single tenant, no redirect URI).
2. API permissions > Add a permission > Microsoft Graph > **Application permissions**:
   `User.Read.All`, `User.ReadWrite.All` (disable or enable), `User-PasswordProfile.ReadWrite.All`
   (password change), `User.RevokeSessions.All` (sessions), `IdentityRiskyUser.ReadWrite.All`
   (confirm compromised). Grant only the ones your runbooks use, then **Grant admin consent**.
3. Certificates & secrets > New client secret; copy its value.
4. In Eagle Eye, Settings > Connectors > Add Entra ID connector: the directory (tenant) ID
   and application (client) ID from the app's Overview, and the secret. Click **Test**.

Graph refuses changes to administrator accounts unless the app also holds a privileged
directory role; keep runbooks for regular users.

Intune and device actions use the same connector with `Device.ReadWrite.All` (disable a
device) and `DeviceManagementManagedDevices.Read.All` plus
`DeviceManagementManagedDevices.PrivilegedOperations.All` (retire, lock).

### CrowdStrike Falcon

Falcon console > Support and resources > API clients and keys > Add new API client with the
**Hosts** scope (read and write). Add a CrowdStrike connector with your cloud (US-1, US-2,
EU-1, US-GOV-1), the client ID and the secret.

### Google Workspace

1. Google Cloud console: create a service account (no roles needed) and a JSON key.
2. Admin console > Security > Access and data control > API controls > Domain-wide
   delegation: add the service account's client ID with the scopes
   `https://www.googleapis.com/auth/admin.directory.user` and
   `https://www.googleapis.com/auth/admin.directory.user.security`.
3. Add a Google Workspace connector: the service account email, the admin it acts as (a
   user with the User Management admin privilege), and the key's `private_key` value (PEM).

### Slack (Enterprise Grid)

Create a Slack app installed on the org with user scopes `admin.users:write` and
`users:read.email`, installed by an org admin or owner. Add a Slack connector with the
user token (`xoxp-`).

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
