output "resource_group" {
  value = azurerm_resource_group.main.name
}

output "cluster_name" {
  value = azurerm_kubernetes_cluster.main.name
}

output "hostname" {
  description = "Public hostname; use https://<hostname> for publicUrl and the Entra ID redirect URIs."
  value       = local.hostname
}

output "gateway_public_ip_name" {
  value = azurerm_public_ip.gateway.name
}

output "storage_account" {
  value = azurerm_storage_account.main.name
}

output "blob_endpoint" {
  value = azurerm_storage_account.main.primary_blob_endpoint
}

output "key_vault" {
  value = azurerm_key_vault.main.name
}

output "tenant_id" {
  value = data.azurerm_client_config.current.tenant_id
}

output "workload_client_ids" {
  description = "Client IDs for the azure.workload.identity/client-id service account annotation."
  value       = { for k, v in azurerm_user_assigned_identity.workload : k => v.client_id }
}
