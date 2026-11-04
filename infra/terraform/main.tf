data "azurerm_client_config" "current" {}

resource "random_string" "suffix" {
  length  = 6
  special = false
  upper   = false
}

locals {
  base     = "${var.name}-${random_string.suffix.result}"
  compact  = "${var.name}${random_string.suffix.result}"
  hostname = "${local.base}.${var.location}.cloudapp.azure.com"
  admins   = toset(concat([data.azurerm_client_config.current.object_id], var.cluster_admin_object_ids))
  tags     = { app = "eagle-eye", environment = "pov" }
}

resource "azurerm_resource_group" "main" {
  name     = "rg-${local.base}"
  location = var.location
  tags     = local.tags
}

# Nodes sit in their own subnet so Key Vault can admit them through a service endpoint
# (pods use overlay addresses and leave through the node).
resource "azurerm_virtual_network" "main" {
  name                = "vnet-${local.base}"
  resource_group_name = azurerm_resource_group.main.name
  location            = var.location
  address_space       = ["10.10.0.0/16"]
  tags                = local.tags
}

resource "azurerm_subnet" "nodes" {
  name                 = "nodes"
  resource_group_name  = azurerm_resource_group.main.name
  virtual_network_name = azurerm_virtual_network.main.name
  address_prefixes     = ["10.10.0.0/22"]

  service_endpoint {
    service = "Microsoft.KeyVault"
  }
}

# Static address for the Envoy Gateway load balancer; its DNS label is the public hostname.
resource "azurerm_public_ip" "gateway" {
  name                = "pip-${local.base}"
  resource_group_name = azurerm_resource_group.main.name
  location            = var.location
  allocation_method   = "Static"
  sku                 = "Standard"
  domain_name_label   = local.base
  tags                = local.tags
}

resource "azurerm_kubernetes_cluster" "main" {
  name                      = "aks-${local.base}"
  resource_group_name       = azurerm_resource_group.main.name
  location                  = var.location
  dns_prefix                = local.base
  sku_tier                  = "Free"
  automatic_upgrade_channel = "patch"
  node_os_upgrade_channel   = "NodeImage"
  local_account_disabled    = true
  oidc_issuer_enabled       = true
  workload_identity_enabled = true
  image_cleaner_enabled     = true
  tags                      = local.tags

  default_node_pool {
    name                        = "system"
    vm_size                     = var.node_vm_size
    node_count                  = var.node_count
    os_disk_size_gb             = 64
    os_sku                      = "AzureLinux"
    temporary_name_for_rotation = "rotate"
    vnet_subnet_id              = azurerm_subnet.nodes.id
    upgrade_settings {
      max_surge = "1"
    }
  }

  node_provisioning_profile {
    mode = "Manual"
  }

  identity {
    type = "SystemAssigned"
  }

  azure_active_directory_role_based_access_control {
    tenant_id          = data.azurerm_client_config.current.tenant_id
    azure_rbac_enabled = true
  }

  # Secrets Store CSI driver: syncs Key Vault secrets into the casemgr Secret.
  key_vault_secrets_provider {
    secret_rotation_enabled = true
  }

  api_server_access_profile {
    authorized_ip_ranges = var.admin_ip_ranges
  }

  network_profile {
    network_plugin      = "azure"
    network_plugin_mode = "overlay"
    network_data_plane  = "cilium"
    network_policy      = "cilium"
  }
}

# The cluster identity attaches the gateway address to its load balancer.
resource "azurerm_role_assignment" "aks_network" {
  scope                = azurerm_resource_group.main.id
  role_definition_name = "Network Contributor"
  principal_id         = azurerm_kubernetes_cluster.main.identity[0].principal_id
  principal_type       = "ServicePrincipal"
}

resource "azurerm_role_assignment" "aks_admin" {
  for_each             = local.admins
  scope                = azurerm_kubernetes_cluster.main.id
  role_definition_name = "Azure Kubernetes Service RBAC Cluster Admin"
  principal_id         = each.value
}

# Evidence and database backups. Shared keys are off: access is through Entra ID only, and
# browsers upload with user delegation SAS URLs.
# Queue logging does not apply: no queues are used, and v5 removed queue_properties.
# The network stays open because browsers upload evidence directly; every request still
# needs an Entra ID token or a short-lived SAS.
#trivy:ignore:AZU-0012
resource "azurerm_storage_account" "main" { # nosemgrep: terraform.azure.security.storage.storage-queue-services-logging.storage-queue-services-logging
  name                            = "st${local.compact}"
  resource_group_name             = azurerm_resource_group.main.name
  location                        = var.location
  account_tier                    = "Standard"
  account_replication_type        = "LRS"
  min_tls_version                 = "TLS1_2"
  https_traffic_only_enabled      = true
  shared_access_key_enabled       = false
  default_to_oauth_authentication = true
  tags                            = local.tags

  blob_properties {
    versioning_enabled = true
    delete_retention_policy {
      days = 30
    }
    container_delete_retention_policy {
      days = 30
    }
    cors_rule {
      allowed_origins    = ["https://${local.hostname}"]
      allowed_methods    = ["GET", "PUT"]
      allowed_headers    = ["content-type", "x-ms-blob-type", "x-ms-version", "x-ms-date", "x-ms-client-request-id"]
      exposed_headers    = ["etag", "x-ms-request-id"]
      max_age_in_seconds = 3600
    }
  }
}

resource "azurerm_storage_container" "main" {
  for_each           = toset(["evidence", "backups"])
  name               = each.key
  storage_account_id = azurerm_storage_account.main.id
}

resource "azurerm_role_assignment" "admin_blob" {
  for_each             = local.admins
  scope                = azurerm_storage_account.main.id
  role_definition_name = "Storage Blob Data Contributor"
  principal_id         = each.value
}

# Secrets for the casemgr Kubernetes Secret (OIDC client secret, session key, SMTP).
resource "azurerm_key_vault" "main" {
  name                       = "kv-${local.compact}"
  resource_group_name        = azurerm_resource_group.main.name
  location                   = var.location
  tenant_id                  = data.azurerm_client_config.current.tenant_id
  sku_name                   = "standard"
  rbac_authorization_enabled = true
  soft_delete_retention_days = 7
  purge_protection_enabled   = true
  tags                       = local.tags

  # Only Terraform (control plane) and admins from listed addresses reach the secrets.
  network_acls {
    default_action = "Deny"
    bypass         = "AzureServices"
    ip_rules                   = var.admin_ip_ranges
    virtual_network_subnet_ids = [azurerm_subnet.nodes.id]
  }
}

resource "azurerm_role_assignment" "admin_secrets" {
  for_each             = local.admins
  scope                = azurerm_key_vault.main.id
  role_definition_name = "Key Vault Secrets Officer"
  principal_id         = each.value
}

# Workload identities: the backend and jobs (evidence, Key Vault secrets), and the
# CloudNativePG cluster (backups). casemgr-secrets runs the pod that syncs the secrets.
locals {
  workloads = {
    backend = { subjects = ["casemgr-backend", "casemgr-secrets"], container = "evidence" }
    db      = { subjects = ["casemgr-db"], container = "backups" }
  }
  federations = merge([
    for k, v in local.workloads : { for s in v.subjects : "${k}-${s}" => { identity = k, subject = s } }
  ]...)
}

resource "azurerm_user_assigned_identity" "workload" {
  for_each            = local.workloads
  name                = "id-${local.base}-${each.key}"
  resource_group_name = azurerm_resource_group.main.name
  location            = var.location
  tags                = local.tags
}

resource "azurerm_federated_identity_credential" "workload" {
  for_each                  = local.federations
  name                      = each.value.subject
  user_assigned_identity_id = azurerm_user_assigned_identity.workload[each.value.identity].id
  issuer                    = azurerm_kubernetes_cluster.main.oidc_issuer_url
  subject                   = "system:serviceaccount:casemgr:${each.value.subject}"
  audience                  = ["api://AzureADTokenExchange"]
}

resource "azurerm_role_assignment" "workload_blob" {
  for_each             = local.workloads
  scope                = azurerm_storage_container.main[each.value.container].id
  role_definition_name = "Storage Blob Data Contributor"
  principal_id         = azurerm_user_assigned_identity.workload[each.key].principal_id
  principal_type       = "ServicePrincipal"
}

# Signing user delegation SAS URLs for browser uploads and downloads.
resource "azurerm_role_assignment" "backend_delegator" {
  scope                = azurerm_storage_account.main.id
  role_definition_name = "Storage Blob Delegator"
  principal_id         = azurerm_user_assigned_identity.workload["backend"].principal_id
  principal_type       = "ServicePrincipal"
}

resource "azurerm_role_assignment" "backend_secrets" {
  scope                = azurerm_key_vault.main.id
  role_definition_name = "Key Vault Secrets User"
  principal_id         = azurerm_user_assigned_identity.workload["backend"].principal_id
  principal_type       = "ServicePrincipal"
}

# Images built by the Deploy workflow; the nodes pull with their kubelet identity.
resource "azurerm_container_registry" "main" {
  name                = "cr${local.compact}"
  resource_group_name = azurerm_resource_group.main.name
  location            = var.location
  sku                 = "Basic"
  admin_enabled       = false
  tags                = local.tags
}

resource "azurerm_role_assignment" "aks_pull" {
  scope                = azurerm_container_registry.main.id
  role_definition_name = "AcrPull"
  principal_id         = azurerm_kubernetes_cluster.main.kubelet_identity[0].object_id
  principal_type       = "ServicePrincipal"
}

resource "azurerm_role_assignment" "admin_push" {
  for_each             = local.admins
  scope                = azurerm_container_registry.main.id
  role_definition_name = "AcrPush"
  principal_id         = each.value
}
