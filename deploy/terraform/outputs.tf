output "url" {
  description = "The studio. Guests' invite links start with it too."
  value       = "https://${local.fqdn}"
}

output "autolive_url" {
  description = "Auto live's controls; the stream itself shows /live?output."
  value       = "https://${local.fqdn}/live"
}

output "registry_name" {
  description = "The container registry the deploy scripts build the image in."
  value       = azurerm_container_registry.main.name
}

output "resource_group" {
  value = azurerm_resource_group.main.name
}

output "cosmos_endpoint" {
  description = "The match log's Cosmos DB account."
  value       = azurerm_cosmosdb_account.main.endpoint
}

output "container_app" {
  value = azurerm_container_app.main.name
}
