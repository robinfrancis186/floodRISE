locals {
  resource_prefix = "${var.project_name}-${var.environment}"

  api_service_name       = "floodrise-api"
  tile_service_name      = "floodrise-tile"
  simulation_job_name    = "floodrise-simulation"
  artifact_registry_name = "${var.project_name}-containers"
  identity_suffix        = var.environment == "production" ? "prod" : (var.environment == "staging" ? "stg" : "demo")

  live_eligible = (
    var.environment == "production" &&
    var.live_integrations_enabled
  )

  notification_io = (
    var.external_notifications_enabled ? "FCM_REVIEWED" :
    var.notification_driver == "demo_log" ? "DEMO_LOG_ONLY" :
    "DISABLED"
  )

  common_labels = {
    application     = "floodrise"
    environment     = var.environment
    managed_by      = "terraform"
    data_mode       = var.environment == "demo" ? "simulated" : (local.live_eligible ? "live_eligible" : "live_inputs_disabled")
    notification_io = lower(local.notification_io)
  }

  immutable_images = compact([
    var.api_image,
    local.tile_service_enabled ? var.tile_image : null,
    local.simulation_job_enabled ? var.simulation_image : null,
  ])

  artifact_digest_pattern = "^${var.region}-docker\\.pkg\\.dev/${var.project_id}/[a-z0-9][a-z0-9._/-]*@sha256:[0-9a-f]{64}$"

  operational_buckets = {
    quarantine = {
      retention_days                = null
      delete_after_days             = 8
      versioning_enabled            = false
      noncurrent_delete_after_days  = null
      soft_delete_retention_seconds = 0
    }
    evidence = {
      retention_days                = null
      delete_after_days             = 31
      versioning_enabled            = false
      noncurrent_delete_after_days  = null
      soft_delete_retention_seconds = 0
    }
    models = {
      retention_days                = 365
      delete_after_days             = 730
      versioning_enabled            = true
      noncurrent_delete_after_days  = 7
      soft_delete_retention_seconds = 604800
    }
    exports = {
      retention_days                = 30
      delete_after_days             = 31
      versioning_enabled            = true
      noncurrent_delete_after_days  = 7
      soft_delete_retention_seconds = 604800
    }
    audit = {
      retention_days                = 2557
      delete_after_days             = 2922
      versioning_enabled            = true
      noncurrent_delete_after_days  = 7
      soft_delete_retention_seconds = 604800
    }
  }

  runtime_secrets = toset([
    "api-database-url",
    "simulation-database-url",
    "session-secret",
  ])

  api_runtime_secrets = toset([
    "api-database-url",
    "session-secret",
  ])

  simulation_runtime_secrets = toset([
    "simulation-database-url",
  ])

  required_services = toset([
    "artifactregistry.googleapis.com",
    "cloudkms.googleapis.com",
    "compute.googleapis.com",
    "firebase.googleapis.com",
    "firebaseappcheck.googleapis.com",
    "firebaserules.googleapis.com",
    "iam.googleapis.com",
    "iamcredentials.googleapis.com",
    "identitytoolkit.googleapis.com",
    "run.googleapis.com",
    "secretmanager.googleapis.com",
    "servicenetworking.googleapis.com",
    "sqladmin.googleapis.com",
    "storage.googleapis.com",
  ])
}

resource "terraform_data" "deployment_guard" {
  input = sha256(jsonencode({
    project_id        = var.project_id
    environment       = var.environment
    deployment_phase  = var.deployment_phase
    region            = var.region
    bucket_location   = var.bucket_location
    boundary_ack      = sha256(var.deployment_boundary_ack)
    runtime_ready     = var.runtime_config_ready
    app_check         = var.firebase_app_check_enabled
    app_check_apps    = sha256(jsonencode(sort(var.firebase_app_check_app_ids)))
    notification_io   = var.external_notifications_enabled
    notification      = var.notification_driver
    live_integrations = var.live_integrations_enabled
    high_availability = var.database_high_availability
    protected         = var.deletion_protection
    backup_retention  = var.backup_retention_days
    log_retention     = var.transaction_log_retention_days
    backup_location   = var.database_backup_location
    target_rpo        = var.target_rpo_minutes
    target_rto        = var.target_rto_minutes
    images            = [for image in local.immutable_images : sha256(image)]
  }))

  lifecycle {
    precondition {
      condition     = var.region == "asia-south1" && var.bucket_location == "ASIA-SOUTH1"
      error_message = "The supported primary deployment and bucket region is asia-south1 (Mumbai)."
    }

    precondition {
      condition     = var.deployment_boundary_ack == "${var.project_id}:${var.environment}"
      error_message = "deployment_boundary_ack must exactly match PROJECT_ID:ENVIRONMENT."
    }

    precondition {
      condition = (
        (var.environment == "demo" && !can(regex("prod(uction)?", lower(var.project_id)))) ||
        (var.environment == "production" && !can(regex("demo", lower(var.project_id)))) ||
        var.environment == "staging"
      )
      error_message = "Project IDs may not visibly contradict the selected environment."
    }

    precondition {
      condition = alltrue([
        for image in local.immutable_images :
        can(regex(local.artifact_digest_pattern, image))
      ])
      error_message = "Every image must be a lowercase SHA-256 digest in this project's asia-south1 Artifact Registry."
    }

    precondition {
      condition     = var.api_min_instances <= var.api_max_instances
      error_message = "api_min_instances may not exceed api_max_instances."
    }

    precondition {
      condition     = !var.firebase_app_check_enabled || length(var.firebase_app_check_app_ids) > 0
      error_message = "App Check enforcement requires at least one allow-listed Firebase web app ID."
    }

    precondition {
      condition     = var.environment != "demo" || !var.firebase_app_check_enabled
      error_message = "Demo App Check remains disabled until static/offline verification keys are separately configured."
    }

    precondition {
      condition = var.environment != "demo" || (
        var.notification_driver == "demo_log" &&
        !var.external_notifications_enabled &&
        !var.live_integrations_enabled
      )
      error_message = "Demo is isolated: use demo_log and disable external notifications and live adapters."
    }

    precondition {
      condition = var.environment != "staging" || (
        var.notification_driver == "disabled" &&
        !var.external_notifications_enabled &&
        !var.live_integrations_enabled
      )
      error_message = "Staging is fail-closed: notification and live-source integrations must be disabled."
    }

    precondition {
      condition = var.environment == "demo" || !var.runtime_config_ready || (
        var.oidc_issuer != null &&
        var.oidc_jwks_url != null &&
        length(var.allowed_origins) > 0
      )
      error_message = "A ready non-demo runtime requires explicit OIDC issuer, JWKS URL, and CORS origins."
    }

    precondition {
      condition = var.environment != "production" || !var.runtime_config_ready || (
        var.oidc_issuer == "https://securetoken.google.com/${var.project_id}" &&
        var.oidc_audience == var.project_id &&
        var.oidc_jwks_url == "https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com"
      )
      error_message = "Production Firebase ID-token verification must bind issuer and audience to the selected project and use the official Google securetoken JWKS endpoint."
    }

    precondition {
      condition = var.deployment_phase != "foundation" || (
        !var.runtime_config_ready &&
        !var.external_notifications_enabled &&
        !var.live_integrations_enabled
      )
      error_message = "Foundation plans may not claim ready runtime configuration or enable external I/O."
    }

    precondition {
      condition     = !var.live_integrations_enabled || var.environment == "production"
      error_message = "Live source adapters may only be enabled in production."
    }

    precondition {
      condition = !var.external_notifications_enabled || (
        var.environment == "production" &&
        var.notification_driver == "fcm" &&
        var.notification_activation_ack == "I_HAVE_AUTHORITY_AND_APPROVAL"
      )
      error_message = "External FCM requires production, the fcm driver, and explicit authority acknowledgement."
    }

    precondition {
      condition = var.external_notifications_enabled || (
        (var.environment == "demo" && var.notification_driver == "demo_log") ||
        (var.environment != "demo" && var.notification_driver == "disabled")
      )
      error_message = "Without explicit activation, demo must use demo_log and non-demo deployments must use disabled."
    }

    precondition {
      condition = var.environment != "production" || (
        var.database_high_availability &&
        var.deletion_protection &&
        !var.bucket_force_destroy &&
        var.backup_retention_days >= 35 &&
        var.transaction_log_retention_days == 7 &&
        var.database_backup_location == "asia" &&
        var.target_rpo_minutes <= 5 &&
        var.target_rto_minutes <= 30 &&
        (
          var.deployment_phase == "foundation" ||
          (
            var.runtime_config_ready &&
            var.firebase_app_check_enabled &&
            var.oidc_issuer != null &&
            var.oidc_jwks_url != null &&
            length(var.allowed_origins) > 0
          )
        )
      )
      error_message = "Production always requires regional HA, deletion protection, protected buckets, 35 backups, 7-day PITR logs, Asia backup location, RPO <=5 and RTO <=30; runtime additionally requires ready secrets/migrations, App Check, and explicit OIDC/CORS configuration."
    }
  }
}
