#!/usr/bin/env bash
# Build the images into the registry and install Eagle Eye on AKS. Needs an Azure CLI
# sign-in with the Terraform deployer's rights, Docker, and Terraform (state access).
# Usage: OIDC_CLIENT_ID=<app id> deploy/azure/deploy.sh [tag]
set -euo pipefail
cd "$(dirname "$0")/../.."
TAG=${1:-$(git rev-parse --short=12 HEAD)}
: "${OIDC_CLIENT_ID:?set OIDC_CLIENT_ID to the Eagle Eye Entra app (client) ID}"

out() { terraform -chdir=infra/terraform output -raw "$1"; }
REGISTRY=$(out registry)
RESOURCE_GROUP=$(out resource_group)
CLUSTER=$(out cluster_name)
TENANT_ID=$(out tenant_id)

az acr login -n "${REGISTRY%%.*}"
for component in backend frontend; do
  docker build -t "$REGISTRY/casemgr-$component:$TAG" "$component"
  docker push "$REGISTRY/casemgr-$component:$TAG"
done

stage=$(mktemp -d)
trap 'rm -rf "$stage"' EXIT
cp -r deploy "$stage/"
cat > "$stage/deploy.env" <<ENV
TAG=$TAG
REGISTRY=$REGISTRY
RESOURCE_GROUP=$RESOURCE_GROUP
PUBLIC_IP_NAME=$(out gateway_public_ip_name)
HOSTNAME_PUBLIC=$(out hostname)
KEY_VAULT=$(out key_vault)
TENANT_ID=$TENANT_ID
BLOB_ENDPOINT=$(out blob_endpoint)
BACKEND_CLIENT_ID=$(terraform -chdir=infra/terraform output -json workload_client_ids | jq -r .backend)
DB_CLIENT_ID=$(terraform -chdir=infra/terraform output -json workload_client_ids | jq -r .db)
OIDC_METADATA_URL=${OIDC_METADATA_URL:-https://login.microsoftonline.com/$TENANT_ID/v2.0/.well-known/openid-configuration}
OIDC_CLIENT_ID=$OIDC_CLIENT_ID
ENV

cd "$stage"
az aks command invoke -g "$RESOURCE_GROUP" -n "$CLUSTER" --file . \
  --command "bash deploy/azure/install.sh" --query '[exitCode, logs]' -o tsv | tee "$stage/result"
[ "$(head -c1 "$stage/result")" = 0 ]
