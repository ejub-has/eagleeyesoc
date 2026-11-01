# Decisions

Recorded decisions for Eagle Eye. Newer entries supersede older ones.

## Environment and scope

- Priorities: integrations and SSO first, then the other Must items in `cyber-ir-case-management-requirements.md`.
- EDR is CrowdStrike (US-2 cloud, Falcon Fusion SOAR). SIEM is Elastic (self-managed, Enterprise license).
- Source connections are configured manually by an admin; both sources push alerts (CrowdStrike through a Fusion SOAR workflow, Elastic from Kibana).
- Identity provider: a new Entra ID tenant, separate from the corporate tenant.
- Proof of value runs in a separate Azure tenant; data is sanitized or synthetic alerts only.
- Infrastructure as code: Terraform.
- Search: PostgreSQL full-text search first.
- Kubernetes: start with whatever is cheapest while meeting the app's functional needs; monthly cloud budget about 200 USD while testing.
- Intake hostname: the Azure-provided one (no custom subdomains).

## Repository and build decisions

- GitHub repo: https://github.com/ejub-has/eagleeyesoc, public visibility. Never commit secrets, real alert data, tenant IDs, or hostnames of internal systems.
- History: single import commit of the project_boxed_wine baseline, then normal commits.
- Naming: only visible text is rebranded to Eagle Eye; internal identifiers (`casemgr`, `CASEMGR_` variables, `casemgr-<tenant>-<role>` groups) are kept.
- Entra ID role source: App Roles through the `roles` claim.
- Evidence storage on Azure: port `backend/app/storage.py` from the S3 API to Azure Blob Storage.
- Database for the proof of value: single-instance CloudNativePG on AKS.
- IMAP email intake is skipped for now; alerts arrive by push only.
