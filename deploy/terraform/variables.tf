variable "name" {
  description = "Name of the app; also the start of its web address."
  type        = string
  default     = "kickstream"
  validation {
    condition     = can(regex("^[a-z][a-z0-9-]{1,22}[a-z0-9]$", var.name))
    error_message = "Use 3-24 lowercase letters, digits and dashes, starting with a letter."
  }
}

variable "location" {
  description = "Azure region."
  type        = string
  default     = "centralindia"
}

variable "communication_data_location" {
  description = "Where Azure Communication Services keeps its data."
  type        = string
  default     = "India"
}

variable "image_tag" {
  description = "Tag of the kickstream image in the registry. The deploy scripts set it."
  type        = string
  default     = "latest"
}

variable "cpu" {
  description = "vCPUs for the app. The hidden browser and ffmpeg need at least 2 to go live."
  type        = number
  default     = 2
}

variable "memory" {
  description = "Memory for the app; Container Apps needs 2Gi per vCPU."
  type        = string
  default     = "4Gi"
}

variable "studio_users" {
  description = "Object IDs of Entra users, besides whoever deploys, who may sign in to the studio."
  type        = list(string)
  default     = []
}

variable "api_football_key" {
  description = "Optional API-Football key, for live matches from api-football.com."
  type        = string
  default     = null
  sensitive   = true
}

variable "llm_base_url" {
  description = "Optional OpenAI-compatible endpoint for the AI commentary and Copilot."
  type        = string
  default     = null
}

variable "llm_model" {
  description = "Optional model name at llm_base_url."
  type        = string
  default     = null
}

variable "llm_api_key" {
  description = "Optional key for llm_base_url."
  type        = string
  default     = null
  sensitive   = true
}

variable "match_log_ttl_days" {
  description = "How long Cosmos DB keeps each match's log, in days."
  type        = number
  default     = 90
}

variable "foundry_project_endpoint" {
  description = "Optional Microsoft Foundry project endpoint; with foundry_deployment, used instead of llm_base_url."
  type        = string
  default     = null
}

variable "foundry_deployment" {
  description = "Optional model deployment name in the Foundry project."
  type        = string
  default     = null
}

variable "foundry_resource_id" {
  description = "Optional resource ID of the Foundry project (or its account); the app's identity is made an Azure AI User there."
  type        = string
  default     = null
}

variable "autolive" {
  description = "Whether auto live starts switched on at /live: rotating screens, AI commentary and a match always playing."
  type        = bool
  default     = true
}

variable "speech_sku" {
  description = "Azure AI Speech tier for auto live's voice. F0 is free but allows 0.5 million characters a month; S0 is pay as you go."
  type        = string
  default     = "S0"
  validation {
    condition     = contains(["F0", "S0"], var.speech_sku)
    error_message = "Use F0 or S0."
  }
}

variable "speech_daily_chars" {
  description = "Most characters auto live sends to Azure Speech a day; past it the browser's voice speaks until midnight UTC."
  type        = number
  default     = 200000
}

variable "public_view" {
  description = "Let anyone watch /live and /match, read-only, without signing in. Every other page still needs a studio user."
  type        = bool
  default     = true
}

variable "real_sources" {
  description = "Offer real match data (StatsBomb, API-Football, OpenLigaDB) besides the synthetic match. Off for the hackathon, whose rules ask for synthetic data."
  type        = bool
  default     = false
}
