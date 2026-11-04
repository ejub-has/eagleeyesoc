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

## Delivery and Azure decisions (made to keep the project moving; revisit any)

- Change flow: every change goes through a branch and pull request; merge only when all CI checks pass. GitHub branch protection needs a public repository or GitHub Pro, so it is a convention for now.
- Infrastructure changes apply only through the manual `Infra` workflow on `main`; application deploys only through the manual `Deploy` workflow on `main`. Both authenticate to Azure with OIDC (no stored secrets).
- Azure provider: azurerm 5.x, Terraform 1.17; state in a separate key-less storage account.
- Cluster: AKS Free tier, 2 x Standard_D2as_v5, Azure CNI overlay with Cilium, Entra ID RBAC with local accounts off; the Kubernetes API and Key Vault are limited to `admin_ip_ranges` (required).
- Deploys run inside the cluster with `az aks command invoke`, so CI needs no API network access.
- Images: Azure Container Registry (Basic) built by the Deploy workflow, tagged with the commit; GHCR release images remain for tagged releases.
- Secrets: Key Vault, synced into the `casemgr` Secret by the Secrets Store CSI driver with workload identity; the database runtime password is generated in-cluster.
- Evidence and backups: one storage account, shared keys off; browsers upload with user delegation SAS; Barman Cloud backs up to the `backups` container with workload identity.
- TLS: Let's Encrypt HTTP-01 on the Azure-provided hostname. Shared `azure.com` rate limits can refuse issuance; a custom domain with a CNAME is the fix.
- No outbound mail in the proof of value (escalation emails skipped).

