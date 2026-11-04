# Azure proof of value

Terraform in `infra/terraform` creates the proof-of-value environment in its own Azure tenant and subscription. The `Infra` GitHub workflow validates every change, plans on pull requests, and applies only when run by hand on `main`; the `Deploy` workflow builds and installs a commit of `main`. Every change to Azure therefore has a commit, a pull request, and a workflow run.

## What it creates

| Resource | Purpose |
|---|---|
| AKS, Free tier, 2 x `Standard_D2as_v5`, Azure Linux, own VNet | Runs the Helm charts. Entra ID RBAC with local accounts off, Cilium network policy, workload identity, Secrets Store CSI driver, automatic patch and node image upgrades |
| Public IP with DNS label | Envoy Gateway address; hostname `<name>-<suffix>.<region>.cloudapp.azure.com` |
| Storage account (shared keys off) | `evidence` and `backups` containers, versioning, 30-day soft delete, CORS for browser uploads |
| Key Vault (RBAC, purge protection, deny by default) | Secrets for the `casemgr` Kubernetes Secret, reachable only from `admin_ip_ranges` and the node subnet |
| Container registry (Basic, no admin user) | Images built by the `Deploy` workflow; nodes pull with their kubelet identity |
| Two user-assigned identities | Workload identities for the backend (evidence) and the database cluster (backups) |

Approximate monthly cost: about USD 125 for the two nodes and their disks, USD 20 for the load balancer and IP, USD 5 for the registry, and a few dollars for storage, the database disk, and Key Vault. Check with the Azure pricing calculator for your region. Stop the cluster when idle (`az aks stop`) to pay only for storage.

## 1. Prerequisites

Azure CLI, Terraform 1.17, kubectl and kubelogin (`az aks install-cli`), Helm 4. Sign in to the proof-of-value tenant: `az login --tenant <tenant-id>` and `az account set --subscription <subscription-id>`.

## 2. State storage (once)

Terraform state lives in a separate storage account, also with shared keys off:

```powershell
$rg = "rg-eagleeye-tfstate"; $sa = "steagleeyetf$((Get-Random -Maximum 99999))"
az group create -n $rg -l eastus2
az storage account create -n $sa -g $rg --sku Standard_LRS --min-tls-version TLS1_2 --allow-shared-key-access false --allow-blob-public-access false
az storage container create -n tfstate --account-name $sa --auth-mode login
az role assignment create --role "Storage Blob Data Contributor" --assignee (az ad signed-in-user show --query id -o tsv) --scope (az storage account show -n $sa -g $rg --query id -o tsv)
```

Copy `backend.hcl.example` to `backend.hcl` and `terraform.tfvars.example` to `terraform.tfvars` and fill them in (both are git-ignored).

## 3. GitHub connection (once)

The workflow signs in to Azure with OpenID Connect, so no secret is stored in GitHub.

```powershell
$app = az ad app create --display-name "eagleeye-github" --query appId -o tsv
az ad sp create --id $app
az ad app federated-credential create --id $app --parameters '{"name":"pov","issuer":"https://token.actions.githubusercontent.com","subject":"repo:ejub-has/eagleeyesoc:environment:pov","audiences":["api://AzureADTokenExchange"]}'
$sub = "/subscriptions/<subscription-id>"
az role assignment create --assignee $app --role Contributor --scope $sub
az role assignment create --assignee $app --role "Role Based Access Control Administrator" --scope $sub
az role assignment create --assignee $app --role "Storage Blob Data Contributor" --scope (az storage account show -n $sa -g $rg --query id -o tsv)
```

In the GitHub repository, create the environment `pov` (Settings, Environments) and these repository variables (Settings, Secrets and variables, Actions, Variables):

| Variable | Value |
|---|---|
| `AZURE_CLIENT_ID` | `$app` |
| `AZURE_TENANT_ID` | tenant ID |
| `AZURE_SUBSCRIPTION_ID` | subscription ID |
| `TF_STATE_RESOURCE_GROUP` | `rg-eagleeye-tfstate` |
| `TF_STATE_STORAGE_ACCOUNT` | `$sa` |
| `CLUSTER_ADMIN_OBJECT_IDS` | JSON list with your object ID, for example `["<az ad signed-in-user show --query id -o tsv>"]` |
| `ENTRA_APP_CLIENT_ID` | Application (client) ID of the Eagle Eye sign-in app (step 6) |
| `ADMIN_IP_RANGES` | Required. JSON list of your public IP, for example `["203.0.113.10/32"]`; only these addresses reach the Kubernetes API and Key Vault secrets. GitHub-hosted runners need neither |

## 4. Apply

Pull requests that change `infra/` show the plan in the `Infra` run. To apply, run the `Infra` workflow on `main` with **apply** checked (Actions, Infra, Run workflow). The run log ends with the outputs.

Locally instead: `terraform init -backend-config=backend.hcl`, `terraform plan -out tfplan`, `terraform apply tfplan`.

## 5. Secrets (once, from an admin address)

```powershell
$kv = terraform -chdir=infra/terraform output -raw key_vault
az keyvault secret set --vault-name $kv -n oidc-client-secret --value "<Eagle Eye app client secret>"
az keyvault secret set --vault-name $kv -n secret-key --value ([Convert]::ToHexString([Security.Cryptography.RandomNumberGenerator]::GetBytes(32)))
```

The cluster reads them through the Secrets Store CSI driver with the backend's workload identity; they never pass through GitHub.

## 6. Sign-in app

Follow `docs/entra-id.md` with the redirect URIs `https://<hostname>/api/auth/callback` and `https://<hostname>`, where `<hostname>` is the `hostname` Terraform output. The Deploy workflow sets the OIDC scope, roles claim, and the metadata URL of the Azure tenant; to sign in through a different Entra tenant, set `OIDC_METADATA_URL` for `deploy/azure/deploy.sh`.

## 7. Deploy

Run the `Deploy` workflow on `main` (Actions, Deploy, Run workflow). It builds both images tagged with the commit, pushes them to the registry, and runs `deploy/azure/install.sh` inside the cluster with `az aks command invoke`, so GitHub never needs network access to the Kubernetes API. The script installs Envoy Gateway, cert-manager, CloudNativePG with the Barman Cloud plugin, the secrets sync, the database (one instance, backups to the `backups` container), and the app. Re-running it upgrades in place.

TLS comes from Let's Encrypt through an HTTP-01 challenge on port 80 (the Gateway's `http` listener serves nothing else). Let's Encrypt applies a shared rate limit to `azure.com` names, so issuance can be refused at busy times; `kubectl -n casemgr describe certificate casemgr-tls` shows why. The lasting fix is a domain of your own pointed at the hostname with a CNAME.

## 8. Cluster access

```powershell
az aks get-credentials -g (terraform output -raw resource_group) -n (terraform output -raw cluster_name)
kubelogin convert-kubeconfig -l azurecli
kubectl get nodes
```

## 9. Tear down

`terraform destroy`, or delete the resource group. Key Vault purge protection keeps the deleted vault for 7 days; a new apply gets a new random name, so this does not block recreating the environment.
