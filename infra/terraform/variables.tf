variable "subscription_id" {
  description = "Azure subscription for the proof of value."
  type        = string
}

variable "location" {
  description = "Azure region."
  type        = string
  default     = "eastus2"
}

variable "name" {
  description = "Name prefix for resources and the DNS label (<name>-<suffix>.<location>.cloudapp.azure.com)."
  type        = string
  default     = "eagleeye"
}

variable "node_vm_size" {
  description = "VM size of the AKS nodes."
  type        = string
  default     = "Standard_D2as_v5"
}

variable "node_count" {
  description = "Number of AKS nodes."
  type        = number
  default     = 2
}

variable "admin_ip_ranges" {
  description = "Admin CIDRs (for example your public IP as x.x.x.x/32) allowed to reach the Kubernetes API and Key Vault secrets."
  type        = list(string)

  validation {
    condition     = length(var.admin_ip_ranges) > 0
    error_message = "Set at least one admin CIDR."
  }
}

variable "cluster_admin_object_ids" {
  description = "Entra object IDs (users or groups) given cluster admin, Key Vault secrets officer, and blob data access. The deploying identity is always included."
  type        = list(string)
  default     = []
}
