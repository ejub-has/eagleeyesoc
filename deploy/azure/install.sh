#!/usr/bin/env bash
# Install or upgrade Eagle Eye on the AKS proof-of-value cluster. Runs inside the cluster
# through `az aks command invoke` (deploy/azure/deploy.sh), so the Kubernetes API stays
# limited to admin addresses. Reads the environment from ./deploy.env.
set -euo pipefail
cd "$(dirname "$0")/../.."
# shellcheck source=/dev/null
source deploy.env

helm upgrade --install eg oci://docker.io/envoyproxy/gateway-helm --version v1.9.3 \
  -n envoy-gateway-system --create-namespace --wait
helm upgrade --install cert-manager oci://quay.io/jetstack/charts/cert-manager --version v1.21.3 \
  -n cert-manager --create-namespace --set crds.enabled=true --set config.enableGatewayAPI=true --wait
kubectl apply --server-side -f https://raw.githubusercontent.com/cloudnative-pg/cloudnative-pg/release-1.30/releases/cnpg-1.30.1.yaml
kubectl -n cnpg-system rollout status deploy/cnpg-controller-manager --timeout=5m
kubectl apply -f https://github.com/cloudnative-pg/plugin-barman-cloud/releases/download/v0.15.1/manifest.yaml
kubectl -n cnpg-system rollout status deploy/barman-cloud --timeout=5m

kubectl create namespace casemgr --dry-run=client -o yaml | kubectl apply -f -
kubectl label namespace casemgr pod-security.kubernetes.io/enforce=restricted --overwrite

kubectl apply -f - <<YAML
apiVersion: gateway.networking.k8s.io/v1
kind: GatewayClass
metadata:
  name: envoy
spec:
  controllerName: gateway.envoyproxy.io/gatewayclass-controller
---
# Puts the Gateway's load balancer on the Terraform-managed public IP (and its DNS label).
apiVersion: gateway.envoyproxy.io/v1alpha1
kind: EnvoyProxy
metadata:
  name: azure-lb
  namespace: casemgr
spec:
  provider:
    type: Kubernetes
    kubernetes:
      envoyService:
        annotations:
          service.beta.kubernetes.io/azure-load-balancer-resource-group: ${RESOURCE_GROUP}
          service.beta.kubernetes.io/azure-pip-name: ${PUBLIC_IP_NAME}
---
apiVersion: cert-manager.io/v1
kind: ClusterIssuer
metadata:
  name: letsencrypt
spec:
  acme:
    server: https://acme-v02.api.letsencrypt.org/directory
    privateKeySecretRef:
      name: letsencrypt-account
    solvers:
      - http01:
          gatewayHTTPRoute:
            parentRefs:
              - { name: casemgr, namespace: casemgr, sectionName: http }
---
# Key Vault secrets become the casemgr Secret. The CSI driver syncs a Secret only while a
# pod mounts the volume, so a pause pod keeps it mounted.
apiVersion: secrets-store.csi.x-k8s.io/v1
kind: SecretProviderClass
metadata:
  name: casemgr
  namespace: casemgr
spec:
  provider: azure
  parameters:
    clientID: ${BACKEND_CLIENT_ID}
    keyvaultName: ${KEY_VAULT}
    tenantId: ${TENANT_ID}
    objects: |
      array:
        - |
          objectName: oidc-client-secret
          objectType: secret
        - |
          objectName: secret-key
          objectType: secret
  secretObjects:
    - secretName: casemgr
      type: Opaque
      data:
        - { objectName: oidc-client-secret, key: CASEMGR_OIDC_CLIENT_SECRET }
        - { objectName: secret-key, key: CASEMGR_SECRET_KEY }
---
apiVersion: v1
kind: ServiceAccount
metadata:
  name: casemgr-secrets
  namespace: casemgr
  annotations:
    azure.workload.identity/client-id: ${BACKEND_CLIENT_ID}
automountServiceAccountToken: false
---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: casemgr-secrets
  namespace: casemgr
spec:
  selector:
    matchLabels: { app: casemgr-secrets }
  template:
    metadata:
      labels: { app: casemgr-secrets, azure.workload.identity/use: "true" }
    spec:
      serviceAccountName: casemgr-secrets
      automountServiceAccountToken: false
      securityContext: { runAsNonRoot: true, runAsUser: 65535, seccompProfile: { type: RuntimeDefault } }
      containers:
        - name: pause
          image: registry.k8s.io/pause:3.10
          securityContext: { allowPrivilegeEscalation: false, readOnlyRootFilesystem: true, capabilities: { drop: [ALL] } }
          resources:
            requests: { cpu: 5m, memory: 16Mi }
            limits: { memory: 32Mi }
          volumeMounts:
            - { name: secrets, mountPath: /mnt/secrets, readOnly: true }
      volumes:
        - name: secrets
          csi:
            driver: secrets-store.csi.k8s.io
            readOnly: true
            volumeAttributes: { secretProviderClass: casemgr }
YAML
kubectl -n casemgr rollout status deploy/casemgr-secrets --timeout=5m
timeout 120 bash -c 'until kubectl -n casemgr get secret casemgr >/dev/null 2>&1; do sleep 2; done'

if ! kubectl -n casemgr get secret casemgr-db-runtime >/dev/null 2>&1; then
  kubectl -n casemgr create secret generic casemgr-db-runtime --type=kubernetes.io/basic-auth \
    --from-literal=username=casemgr_app --from-literal=password="$(openssl rand -hex 24)"
fi

helm upgrade --install casemgr-db deploy/helm/casemgr-db -n casemgr -f deploy/azure/db-values.yaml \
  --set backup.destinationPath="${BLOB_ENDPOINT}backups/" \
  --set workloadIdentity.clientId="${DB_CLIENT_ID}"
kubectl -n casemgr wait cluster/casemgr-db --for=condition=Ready --timeout=20m

helm upgrade --install casemgr deploy/helm/casemgr -n casemgr -f deploy/azure/values.yaml \
  --set publicUrl="https://${HOSTNAME_PUBLIC}" \
  --set gateway.hostname="${HOSTNAME_PUBLIC}" \
  --set images.backend="${REGISTRY}/casemgr-backend:${TAG}" \
  --set images.frontend="${REGISTRY}/casemgr-frontend:${TAG}" \
  --set workloadIdentity.clientId="${BACKEND_CLIENT_ID}" \
  --set config.BLOB_ACCOUNT_URL="${BLOB_ENDPOINT}" \
  --set blobPublicOrigin="${BLOB_ENDPOINT%/}" \
  --set config.OIDC_METADATA_URL="${OIDC_METADATA_URL}" \
  --set config.OIDC_CLIENT_ID="${OIDC_CLIENT_ID}" \
  --wait --timeout 15m

kubectl -n casemgr get pods
echo "Eagle Eye ${TAG} is at https://${HOSTNAME_PUBLIC}"
