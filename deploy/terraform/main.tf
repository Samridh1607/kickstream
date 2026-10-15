resource "random_string" "suffix" {
  length  = 6
  upper   = false
  special = false
}

locals {
  suffix = random_string.suffix.result
  fqdn   = "${var.name}.${azurerm_container_app_environment.main.default_domain}"

  # Secrets set only when given; their names say nothing about their values.
  optional_secrets = {
    "api-football-key" = { env = "KICKSTREAM_API_FOOTBALL_KEY", value = var.api_football_key }
    "llm-api-key"      = { env = "KICKSTREAM_LLM_API_KEY", value = var.llm_api_key }
  }
  given_secrets = nonsensitive(toset([for name, secret in local.optional_secrets : name if secret.value != null]))
  optional_env = {
    for name, value in {
      KICKSTREAM_LLM_BASE_URL = var.llm_base_url
      KICKSTREAM_LLM_MODEL    = var.llm_model
    } : name => value if value != null
  }
}

resource "azurerm_resource_group" "main" {
  name     = "rg-${var.name}"
  location = var.location
}

resource "azurerm_log_analytics_workspace" "main" {
  name                = "log-${var.name}-${local.suffix}"
  location            = azurerm_resource_group.main.location
  resource_group_name = azurerm_resource_group.main.name
  sku                 = "PerGB2018"
  retention_in_days   = 30
}

resource "azurerm_container_registry" "main" {
  name                = "${replace(var.name, "-", "")}${local.suffix}"
  location            = azurerm_resource_group.main.location
  resource_group_name = azurerm_resource_group.main.name
  sku                 = "Basic"
  admin_enabled       = true
}

# Broadcasts, the studio document, uploaded images and narration cache live in /data.
resource "azurerm_storage_account" "main" {
  name                     = substr("${replace(var.name, "-", "")}${local.suffix}", 0, 24)
  location                 = azurerm_resource_group.main.location
  resource_group_name      = azurerm_resource_group.main.name
  account_tier             = "Standard"
  account_replication_type = "LRS"
  min_tls_version          = "TLS1_2"
}

resource "azurerm_storage_share" "data" {
  name               = "data"
  storage_account_id = azurerm_storage_account.main.id
  quota              = 10
}

# Cameras and voices: the host, guests and the program's receive-only view join rooms here.
resource "azurerm_communication_service" "main" {
  name                = "acs-${var.name}-${local.suffix}"
  resource_group_name = azurerm_resource_group.main.name
  data_location       = var.communication_data_location
}

# Auto live's commentary voice. Its key and region reach the app as KICKSTREAM_SPEECH_*.
resource "azurerm_cognitive_account" "speech" {
  name                = "speech-${var.name}-${local.suffix}"
  location            = azurerm_resource_group.main.location
  resource_group_name = azurerm_resource_group.main.name
  kind                = "SpeechServices"
  sku_name            = var.speech_sku
}

resource "azurerm_container_app_environment" "main" {
  name                       = "cae-${var.name}"
  location                   = azurerm_resource_group.main.location
  resource_group_name        = azurerm_resource_group.main.name
  log_analytics_workspace_id = azurerm_log_analytics_workspace.main.id
}

resource "azurerm_container_app_environment_storage" "data" {
  name                         = "data"
  container_app_environment_id = azurerm_container_app_environment.main.id
  account_name                 = azurerm_storage_account.main.name
  share_name                   = azurerm_storage_share.data.name
  access_key                   = azurerm_storage_account.main.primary_access_key
  access_mode                  = "ReadWrite"
}

# One replica: matches, the studio and live streams are held in this process's memory.
resource "azurerm_container_app" "main" {
  name                         = var.name
  container_app_environment_id = azurerm_container_app_environment.main.id
  resource_group_name          = azurerm_resource_group.main.name
  revision_mode                = "Single"

  registry {
    server               = azurerm_container_registry.main.login_server
    username             = azurerm_container_registry.main.admin_username
    password_secret_name = "registry-password"
  }

  secret {
    name  = "registry-password"
    value = azurerm_container_registry.main.admin_password
  }
  secret {
    name  = "acs-connection-string"
    value = azurerm_communication_service.main.primary_connection_string
  }
  secret {
    name  = "microsoft-provider-authentication-secret"
    value = azuread_application_password.studio.value
  }
  secret {
    name  = "speech-key"
    value = azurerm_cognitive_account.speech.primary_access_key
  }
  dynamic "secret" {
    for_each = local.given_secrets
    content {
      name  = secret.value
      value = local.optional_secrets[secret.value].value
    }
  }

  ingress {
    external_enabled = true
    target_port      = 8000
    transport        = "auto"
    traffic_weight {
      latest_revision = true
      percentage      = 100
    }
  }

  template {
    min_replicas = 1
    max_replicas = 1

    container {
      name   = "kickstream"
      image  = "${azurerm_container_registry.main.login_server}/kickstream:${var.image_tag}"
      cpu    = var.cpu
      memory = var.memory

      # Invite links name this address; requests through it reach only what PublicHostGate allows.
      env {
        name  = "KICKSTREAM_PUBLIC_HOSTS"
        value = local.fqdn
      }
      # Set by the sign-in in auth.tf once someone allowed has signed in.
      env {
        name  = "KICKSTREAM_SIGNED_IN_HEADER"
        value = "x-ms-client-principal-id"
      }
      env {
        name        = "KICKSTREAM_ACS_CONNECTION_STRING"
        secret_name = "acs-connection-string"
      }
      env {
        name        = "KICKSTREAM_SPEECH_KEY"
        secret_name = "speech-key"
      }
      env {
        name  = "KICKSTREAM_SPEECH_REGION"
        value = azurerm_cognitive_account.speech.location
      }
      env {
        name  = "KICKSTREAM_SPEECH_DAILY_CHARS"
        value = tostring(var.speech_daily_chars)
      }
      env {
        name  = "KICKSTREAM_AUTOLIVE"
        value = var.autolive ? "on" : "off"
      }
      dynamic "env" {
        for_each = local.given_secrets
        content {
          name        = local.optional_secrets[env.value].env
          secret_name = env.value
        }
      }
      dynamic "env" {
        for_each = local.optional_env
        content {
          name  = env.key
          value = env.value
        }
      }

      volume_mounts {
        name = "data"
        path = "/data"
      }

      # Straight to the container, past the sign-in. A process that stops answering for three
      # minutes is restarted; auto live then picks up its screens and its 24/7 stream from /data.
      startup_probe {
        transport               = "HTTP"
        port                    = 8000
        path                    = "/api/health"
        interval_seconds        = 10
        timeout                 = 5
        failure_count_threshold = 30
      }
      liveness_probe {
        transport               = "HTTP"
        port                    = 8000
        path                    = "/api/health"
        initial_delay           = 30
        interval_seconds        = 30
        timeout                 = 10
        failure_count_threshold = 6
      }
    }

    volume {
      name         = "data"
      storage_name = azurerm_container_app_environment_storage.data.name
      storage_type = "AzureFile"
    }
  }
}
