variable "project_name" {
  description = "Short resource prefix. Cloud Run names remain canonical for Firebase Hosting rewrites."
  type        = string
  default     = "floodrise"

  validation {
    condition     = can(regex("^[a-z][a-z0-9-]{2,23}$", var.project_name))
    error_message = "project_name must be 3-24 lowercase letters, digits, or hyphens and start with a letter."
  }
}

variable "project_id" {
  description = "Existing Google Cloud/Firebase project. Demo and production must use different projects."
  type        = string

  validation {
    condition     = can(regex("^[a-z][a-z0-9-]{4,28}[a-z0-9]$", var.project_id))
    error_message = "project_id must be a valid Google Cloud project ID."
  }
}

variable "environment" {
  description = "Deployment boundary. Each environment requires a distinct project and Terraform state."
  type        = string
  default     = "demo"

  validation {
    condition     = contains(["demo", "staging", "production"], var.environment)
    error_message = "environment must be demo, staging, or production."
  }
}

variable "deployment_boundary_ack" {
  description = "Explicit anti-footgun acknowledgement in the form PROJECT_ID:ENVIRONMENT."
  type        = string
}

variable "deployment_phase" {
  description = "foundation creates durable dependencies without a public API; runtime requires populated secrets and security activation."
  type        = string
  default     = "runtime"

  validation {
    condition     = contains(["foundation", "runtime"], var.deployment_phase)
    error_message = "deployment_phase must be foundation or runtime."
  }
}

variable "region" {
  description = "Primary Google Cloud region. Mumbai is the supported deployment region."
  type        = string
  default     = "asia-south1"
}

variable "bucket_location" {
  description = "Regional location for operational buckets."
  type        = string
  default     = "ASIA-SOUTH1"
}

variable "database_backup_location" {
  description = "Cloud SQL backup location. Production uses the Asia multi-region for geographic separation."
  type        = string
  default     = "asia"
}

variable "network_cidr" {
  description = "Direct VPC egress subnet for Cloud Run workloads."
  type        = string
  default     = "10.53.0.0/24"

  validation {
    condition     = can(cidrnetmask(var.network_cidr))
    error_message = "network_cidr must be a valid IPv4 CIDR."
  }
}

variable "private_service_range_address" {
  description = "Base address reserved for private service access to Cloud SQL."
  type        = string
  default     = "10.54.0.0"

  validation {
    condition     = can(cidrhost("${var.private_service_range_address}/16", 0))
    error_message = "private_service_range_address must be a valid IPv4 network address."
  }
}

variable "api_image" {
  description = "Immutable API image in this project's regional Artifact Registry, including @sha256 digest."
  type        = string
}

variable "tile_image" {
  description = "Optional immutable demo tile image. Required only after reviewed packaged-PGM artifacts are acknowledged; production tile service deployment is disabled."
  type        = string
  default     = null
  nullable    = true
}

variable "simulation_image" {
  description = "Optional immutable deterministic-demo simulation image. Required only for a ready demo runtime; production simulation deployment is disabled until an approved live model exists."
  type        = string
  default     = null
  nullable    = true
}

variable "runtime_config_ready" {
  description = "Injects runtime secrets only after the foundation, secret versions, extensions, and migrations are complete."
  type        = bool
  default     = false
}

variable "demo_tile_artifacts_ack" {
  description = "Exact acknowledgement that reviewed deterministic demo PGM artifacts and their manifest already exist in the demo model bucket. Empty keeps the tile service absent."
  type        = string
  default     = ""

  validation {
    condition = contains([
      "",
      "I_HAVE_REVIEWED_DEMO_TILE_ARTIFACTS",
    ], var.demo_tile_artifacts_ack)
    error_message = "demo_tile_artifacts_ack must be empty or exactly I_HAVE_REVIEWED_DEMO_TILE_ARTIFACTS."
  }
}

variable "allowed_origins" {
  description = "Explicit browser origins accepted by the API."
  type        = list(string)
  default     = []

  validation {
    condition = alltrue([
      for origin in var.allowed_origins :
      can(regex("^https://[A-Za-z0-9.-]+(?::[0-9]+)?$", origin))
    ])
    error_message = "allowed_origins must contain HTTPS origins without paths."
  }
}

variable "oidc_issuer" {
  description = "Identity Platform or authority-approved upstream OIDC issuer."
  type        = string
  default     = null
  nullable    = true
}

variable "oidc_audience" {
  description = "OIDC audience accepted by the API."
  type        = string
  default     = "floodrise-api"
}

variable "oidc_jwks_url" {
  description = "HTTPS JWKS endpoint for the configured issuer."
  type        = string
  default     = null
  nullable    = true
}

variable "firebase_authorized_domains" {
  description = "Identity Platform authorized domains. Configure separate domains per project."
  type        = list(string)
  default     = []
}

variable "firebase_app_check_enabled" {
  description = "Require Firebase App Check tokens at the custom FastAPI boundary."
  type        = bool
  default     = false
}

variable "firebase_app_check_app_ids" {
  description = "Allow-listed Firebase web app IDs whose App Check tokens may reach the API."
  type        = list(string)
  default     = []

  validation {
    condition = alltrue([
      for app_id in var.firebase_app_check_app_ids :
      can(regex("^1:[0-9]+:web:[0-9a-f]+$", app_id))
    ])
    error_message = "firebase_app_check_app_ids must contain Firebase web app IDs such as 1:123456789:web:abcdef."
  }
}

variable "firebase_app_check_jwks_url" {
  description = "Official HTTPS JWKS endpoint used to validate Firebase App Check tokens."
  type        = string
  default     = "https://firebaseappcheck.googleapis.com/v1/jwks"

  validation {
    condition     = can(regex("^https://", var.firebase_app_check_jwks_url))
    error_message = "firebase_app_check_jwks_url must use HTTPS."
  }
}

variable "notification_driver" {
  description = "Demo must use demo_log, staging must use disabled, and reviewed production may use fcm."
  type        = string
  default     = "demo_log"

  validation {
    condition     = contains(["demo_log", "disabled", "fcm"], var.notification_driver)
    error_message = "notification_driver must be demo_log, disabled, or fcm."
  }
}

variable "external_notifications_enabled" {
  description = "Enables FCM only in an authority-reviewed production project."
  type        = bool
  default     = false
}

variable "notification_activation_ack" {
  description = "Required exact acknowledgement when production FCM is activated."
  type        = string
  default     = ""
  sensitive   = true
}

variable "live_integrations_enabled" {
  description = "Reserved activation switch for authority-approved live source adapters."
  type        = bool
  default     = false
}

variable "api_min_instances" {
  description = "Minimum API instances. Zero is appropriate for the competition demo."
  type        = number
  default     = 0

  validation {
    condition     = var.api_min_instances >= 0 && var.api_min_instances <= 10
    error_message = "api_min_instances must be between 0 and 10."
  }
}

variable "api_max_instances" {
  description = "Maximum API instances."
  type        = number
  default     = 10

  validation {
    condition     = var.api_max_instances >= 1 && var.api_max_instances <= 100
    error_message = "api_max_instances must be between 1 and 100."
  }
}

variable "tile_max_instances" {
  description = "Maximum internal tile service instances."
  type        = number
  default     = 6

  validation {
    condition     = var.tile_max_instances >= 1 && var.tile_max_instances <= 50
    error_message = "tile_max_instances must be between 1 and 50."
  }
}

variable "database_tier" {
  description = "Cloud SQL machine tier."
  type        = string
  default     = "db-custom-2-7680"
}

variable "database_disk_size_gb" {
  description = "Initial SSD size; automatic growth remains enabled."
  type        = number
  default     = 50

  validation {
    condition     = var.database_disk_size_gb >= 20
    error_message = "database_disk_size_gb must be at least 20."
  }
}

variable "database_high_availability" {
  description = "Creates a regional Cloud SQL instance. Required in production."
  type        = bool
  default     = false
}

variable "deletion_protection" {
  description = "Protects Cloud SQL from accidental Terraform deletion. Required in production."
  type        = bool
  default     = false
}

variable "backup_retention_days" {
  description = "Number of retained automated Cloud SQL backups."
  type        = number
  default     = 7

  validation {
    condition     = var.backup_retention_days >= 7 && var.backup_retention_days <= 365
    error_message = "backup_retention_days must be between 7 and 365."
  }
}

variable "transaction_log_retention_days" {
  description = "Cloud SQL transaction-log retention used for point-in-time recovery."
  type        = number
  default     = 7

  validation {
    condition     = var.transaction_log_retention_days >= 1 && var.transaction_log_retention_days <= 7
    error_message = "transaction_log_retention_days must be between 1 and 7."
  }
}

variable "target_rpo_minutes" {
  description = "Declared recovery-point objective; must be demonstrated in restore drills."
  type        = number
  default     = 5
}

variable "target_rto_minutes" {
  description = "Declared recovery-time objective; must be demonstrated in restore drills."
  type        = number
  default     = 30
}

variable "bucket_force_destroy" {
  description = "Allows Terraform to delete non-empty buckets. Production guard requires false."
  type        = bool
  default     = false
}
