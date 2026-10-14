# The studio has no sign-in of its own, so Container Apps signs people in with Microsoft Entra ID
# in front of it. Only the users assigned below get in; guests' invite pages stay open.

data "azuread_client_config" "current" {}

locals {
  studio_users = distinct(concat([data.azuread_client_config.current.object_id], var.studio_users))
  # Everything a guest's invite page loads. The rest needs a signed-in studio user.
  public_paths = ["/guest/*", "/api/guest/*", "/assets/*"]
}

resource "azuread_application" "studio" {
  display_name     = "Kickstream studio (${var.name})"
  sign_in_audience = "AzureADMyOrg"
  owners           = [data.azuread_client_config.current.object_id]

  web {
    redirect_uris = ["https://${local.fqdn}/.auth/login/aad/callback"]
    implicit_grant {
      id_token_issuance_enabled = true
    }
  }

  required_resource_access {
    resource_app_id = "00000003-0000-0000-c000-000000000000" # Microsoft Graph
    resource_access {
      id   = "e1fe6dd8-ba31-4d61-89e7-88639da4683d" # User.Read
      type = "Scope"
    }
  }
}

resource "azuread_application_password" "studio" {
  application_id = azuread_application.studio.id
  display_name   = "Container Apps sign-in"
}

resource "azuread_service_principal" "studio" {
  client_id                    = azuread_application.studio.client_id
  app_role_assignment_required = true
  owners                       = [data.azuread_client_config.current.object_id]
}

resource "azuread_app_role_assignment" "studio" {
  for_each            = toset(local.studio_users)
  app_role_id         = "00000000-0000-0000-0000-000000000000" # default access
  principal_object_id = each.value
  resource_object_id  = azuread_service_principal.studio.object_id
}

resource "azapi_resource" "auth" {
  type      = "Microsoft.App/containerApps/authConfigs@2024-03-01"
  name      = "current"
  parent_id = azurerm_container_app.main.id

  body = {
    properties = {
      platform = { enabled = true }
      globalValidation = {
        unauthenticatedClientAction = "RedirectToLoginPage"
        redirectToProvider          = "azureactivedirectory"
        excludedPaths               = local.public_paths
      }
      identityProviders = {
        azureActiveDirectory = {
          enabled = true
          registration = {
            clientId                = azuread_application.studio.client_id
            clientSecretSettingName = "microsoft-provider-authentication-secret"
            openIdIssuer            = "https://login.microsoftonline.com/${data.azuread_client_config.current.tenant_id}/v2.0"
          }
          validation = {
            defaultAuthorizationPolicy = {
              allowedPrincipals = { identities = local.studio_users }
            }
          }
        }
      }
    }
  }
}
