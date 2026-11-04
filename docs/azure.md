# Azure proof of value

Terraform in `infra/terraform` creates the proof-of-value environment in its own Azure tenant and subscription. The `Infra` GitHub workflow validates every change, plans on pull requests, and applies only when run by hand on `main`, so every change to Azure has a commit, a pull request, and a workflow run.

## What it creates

| Resource | Purpose |
|---|---|
| AKS, Free tier, 2 x `Standard_D2as_v5`, Azure Linux | Runs the Helm charts. Entra ID RBAC with local accounts off, Cilium network policy, workload identity, automatic patch and node image upgrades |
| Public IP with DNS label | Envoy Gateway address; hostname `<name>-<suffix>.<region>.cloudapp.azure.com` |
| Storage account (shared keys off) | `evidence` and `backups` containers, versioning, 30-day soft delete, CORS for browser uploads |
| Key Vault (RBAC, purge protection, deny by default) | Secrets for the `casemgr` Kubernetes Secret, reachable only from `admin_ip_ranges` |
| Two user-assigned identities | Workload identities for the backend (evidence) and the database cluster (backups) |

Approximate monthly cost: about USD 125 for the two nodes and their disks, USD 20 for the load balancer and IP, and a few dollars for storage and Key Vault. Check with the Azure pricing calculator for your region. Stop the cluster when idle (`az aks stop`) to pay only for storage.

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
| `ADMIN_IP_RANGES` | Required. JSON list of your public IP, for example `["203.0.113.10/32"]`; only these addresses reach the Kubernetes API and Key Vault secrets. GitHub-hosted runners need neither |

## 4. Apply

Pull requests that change `infra/` show the plan in the `Infra` run. To apply, run the `Infra` workflow on `main` with **apply** checked (Actions, Infra, Run workflow). The run log ends with the outputs.

Locally instead: `terraform init -backend-config=backend.hcl`, `terraform plan -out tfplan`, `terraform apply tfplan`.

## 5. Cluster access

```powershell
az aks get-credentials -g (terraform output -raw resource_group) -n (terraform output -raw cluster_name)
kubelogin convert-kubeconfig -l azurecli
kubectl get nodes
```

## 6. Tear down

`terraform destroy`, or delete the resource group. Key Vault purge protection keeps the deleted vault for 7 days; a new apply gets a new random name, so this does not block recreating the environment.
