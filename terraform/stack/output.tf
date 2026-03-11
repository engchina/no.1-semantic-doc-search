locals {
  instance_access_ip = local.compute_subnet_prohibits_public_ip ? oci_core_instance.generated_oci_core_instance.private_ip : oci_core_instance.generated_oci_core_instance.public_ip
}

output "autonomous_data_warehouse_admin_password" {
  #   value = random_string.autonomous_data_warehouse_admin_password.result
  value = var.adb_password
}

output "autonomous_data_warehouse_ocid" {
  description = "Autonomous Database OCID"
  value       = oci_database_autonomous_database.generated_database_autonomous_database.id
}

output "adb_ocid" {
  description = "Autonomous Database OCID"
  value       = oci_database_autonomous_database.generated_database_autonomous_database.id
}

output "autonomous_data_warehouse_high_connection_string" {
  value = lookup(
    oci_database_autonomous_database.generated_database_autonomous_database.connection_strings[0].all_connection_strings,
    "HIGH",
    "unavailable",
  )
}

output "ssh_to_instance" {
  description = "convenient command to ssh to the instance"
  value       = "ssh -o ServerAliveInterval=10 ubuntu@${local.instance_access_ip}"
}

output "application_url" {
  description = "URL to access the application"
  value       = "http://${local.instance_access_ip}/ai"
}

output "api_url" {
  description = "URL to access the API"
  value       = "http://${local.instance_access_ip}/ai/api"
}

output "dify_url" {
  description = "URL to access Dify (if enabled)"
  value       = var.enable_dify ? "http://${local.instance_access_ip}/" : "Dify is not enabled"
}

output "dify_bucket_name" {
  description = "Dify bucket name (if enabled)"
  value       = var.enable_dify ? var.dify_bucket_name : "N/A"
}

output "document_bucket_name" {
  description = "Document storage bucket name"
  value       = var.oci_bucket_name
}

output "external_api_keys" {
  description = "External API Keys for external access (masked)"
  value       = var.external_api_keys != "" ? "Configured (${length(split(",", var.external_api_keys))} keys)" : "Not configured"
  sensitive   = true
}
