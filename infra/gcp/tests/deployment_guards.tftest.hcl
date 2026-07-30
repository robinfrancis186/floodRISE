mock_provider "google" {}
mock_provider "google-beta" {}

variables {
  project_id              = "floodrise-demo-5305"
  environment             = "demo"
  deployment_boundary_ack = "floodrise-demo-5305:demo"

  api_image = "asia-south1-docker.pkg.dev/floodrise-demo-5305/floodrise-containers/floodrise-api@sha256:0000000000000000000000000000000000000000000000000000000000000000"

  notification_driver            = "demo_log"
  external_notifications_enabled = false
  live_integrations_enabled      = false
}

run "unready_demo_omits_all_remote_runtimes" {
  command = plan

  assert {
    condition     = output.notification_boundary.demo_external_io_hard_block
    error_message = "Demo must report a hard external notification boundary."
  }

  assert {
    condition = (
      output.cloud_run_api_uri == null &&
      output.cloud_run_tile_uri == null &&
      output.simulation_job.name == null
    )
    error_message = "An unready demo must create no remote API, tile service, or simulation job."
  }

  assert {
    condition = (
      length(google_service_account.api) == 0 &&
      length(google_service_account.tile) == 0 &&
      length(google_service_account.simulation) == 0
    )
    error_message = "An unready demo must not provision remote runtime identities."
  }

  assert {
    condition = (
      length(keys(google_secret_manager_secret_iam_member.api)) == 0 &&
      length(keys(google_secret_manager_secret_iam_member.simulation)) == 0
    )
    error_message = "An unready demo must not grant runtime secret access."
  }

  assert {
    condition = (
      !output.model_service_boundary.api_enabled &&
      !output.model_service_boundary.simulation_job_enabled &&
      !output.model_service_boundary.tile_service_enabled
    )
    error_message = "The model boundary output must make the unready state explicit."
  }

  assert {
    condition     = length(google_project_iam_custom_role.simulation_runner) == 0
    error_message = "No API-to-job execution role may exist when the remote demo API is absent."
  }

  assert {
    condition     = google_sql_database_instance.postgres.settings[0].ip_configuration[0].ssl_mode == "ENCRYPTED_ONLY"
    error_message = "Cloud SQL must reject unencrypted PostgreSQL transport."
  }

  assert {
    condition = alltrue([
      for bucket_name in ["quarantine", "evidence"] :
      google_storage_bucket.operational[bucket_name].versioning[0].enabled == false
    ])
    error_message = "Short-lived private photo buckets must not retain deleted bytes as noncurrent versions."
  }

  assert {
    condition = alltrue([
      for bucket_name in ["quarantine", "evidence"] :
      length(google_storage_bucket.operational[bucket_name].retention_policy) == 0
    ])
    error_message = "Short-lived private photo buckets must not impose a minimum bucket retention period that blocks prompt deletion."
  }

  assert {
    condition = alltrue([
      for bucket_name in ["quarantine", "evidence"] :
      tonumber(google_storage_bucket.operational[bucket_name].soft_delete_policy[0].retention_duration_seconds) == 0
    ])
    error_message = "Short-lived private photo buckets must disable soft delete so disposal deadlines are real maximums."
  }

  assert {
    condition = alltrue([
      for bucket_name, expected_age in {
        quarantine = 8
        evidence   = 31
        } : anytrue([
          for rule in google_storage_bucket.operational[bucket_name].lifecycle_rule :
          try(
            one(rule.action).type == "Delete" &&
            tonumber(one(rule.condition).age) == expected_age,
            false
          )
      ])
    ])
    error_message = "Short-lived private photo buckets must retain their eight-day and 31-day lifecycle fallbacks."
  }

  assert {
    condition = alltrue([
      for bucket_name in ["models", "exports", "audit"] :
      google_storage_bucket.operational[bucket_name].versioning[0].enabled == true &&
      length(google_storage_bucket.operational[bucket_name].retention_policy) == 1 &&
      tonumber(google_storage_bucket.operational[bucket_name].soft_delete_policy[0].retention_duration_seconds) == 604800
    ])
    error_message = "Durable model, export, and audit buckets must preserve explicit versioning, minimum retention, and seven-day recovery."
  }
}

run "ready_demo_creates_private_simulation_only" {
  command = plan

  variables {
    runtime_config_ready = true
    simulation_image     = "asia-south1-docker.pkg.dev/floodrise-demo-5305/floodrise-containers/floodrise-api@sha256:0000000000000000000000000000000000000000000000000000000000000000"
  }

  assert {
    condition = (
      output.cloud_run_api_uri == null &&
      output.cloud_run_tile_uri == null &&
      output.simulation_job.name == "floodrise-simulation"
    )
    error_message = "A ready demo may create only the private deterministic simulation job by default."
  }

  assert {
    condition = toset(keys(google_secret_manager_secret_iam_member.simulation)) == toset([
      "simulation-database-url",
    ])
    error_message = "The demo simulation identity may access only its independently revocable database URL."
  }

  assert {
    condition = (
      length(google_service_account.api) == 0 &&
      length(keys(google_secret_manager_secret_iam_member.api)) == 0 &&
      length(google_cloud_run_v2_job_iam_member.api_simulation_runner) == 0
    )
    error_message = "The private demo job must not create a public API identity or API-to-job grant."
  }

  assert {
    condition     = google_cloud_run_v2_job.simulation[0].template[0].template[0].vpc_access[0].egress == "PRIVATE_RANGES_ONLY"
    error_message = "The demo job must route private database traffic through VPC while retaining managed public HTTPS egress."
  }
}

run "reviewed_demo_artifacts_enable_private_tile_service" {
  command = plan

  variables {
    runtime_config_ready    = true
    simulation_image        = "asia-south1-docker.pkg.dev/floodrise-demo-5305/floodrise-containers/floodrise-api@sha256:0000000000000000000000000000000000000000000000000000000000000000"
    tile_image              = "asia-south1-docker.pkg.dev/floodrise-demo-5305/floodrise-containers/floodrise-tile@sha256:0000000000000000000000000000000000000000000000000000000000000000"
    demo_tile_artifacts_ack = "I_HAVE_REVIEWED_DEMO_TILE_ARTIFACTS"
  }

  assert {
    condition = (
      length(google_cloud_run_v2_service.tile) == 1 &&
      length(google_service_account.tile) == 1 &&
      length(google_storage_bucket_iam_member.tile_model_viewer) == 1
    )
    error_message = "The internal tile service and its narrow identity may exist only after exact artifact acknowledgement."
  }

  assert {
    condition     = output.model_service_boundary.tile_representation == "PACKAGED_PGM_DEMO_ONLY"
    error_message = "The enabled tile service must remain explicitly labeled as deterministic demo PGM."
  }

  assert {
    condition     = google_cloud_run_v2_service.tile[0].template[0].vpc_access[0].egress == "PRIVATE_RANGES_ONLY"
    error_message = "The tile service must use split managed/private egress rather than unreachable all-VPC egress."
  }
}

run "tile_ack_without_ready_demo_is_rejected" {
  command = plan

  variables {
    demo_tile_artifacts_ack = "I_HAVE_REVIEWED_DEMO_TILE_ARTIFACTS"
  }

  expect_failures = [terraform_data.model_service_guard]
}

run "invalid_tile_ack_is_rejected" {
  command = plan

  variables {
    demo_tile_artifacts_ack = "reviewed"
  }

  expect_failures = [var.demo_tile_artifacts_ack]
}

run "demo_external_notifications_are_rejected" {
  command = plan

  variables {
    notification_driver            = "fcm"
    external_notifications_enabled = true
    notification_activation_ack    = "I_HAVE_AUTHORITY_AND_APPROVAL"
  }

  expect_failures = [
    terraform_data.deployment_guard,
    google_project_iam_custom_role.notification_sender,
  ]
}

run "mutable_or_cross_project_images_are_rejected" {
  command = plan

  variables {
    api_image = "asia-south1-docker.pkg.dev/another-project/floodrise-containers/floodrise-api:latest"
  }

  expect_failures = [terraform_data.deployment_guard]
}

run "weak_production_recovery_is_rejected" {
  command = plan

  variables {
    project_id              = "floodrise-production-5305"
    environment             = "production"
    deployment_boundary_ack = "floodrise-production-5305:production"

    api_image = "asia-south1-docker.pkg.dev/floodrise-production-5305/floodrise-containers/floodrise-api@sha256:0000000000000000000000000000000000000000000000000000000000000000"

    runtime_config_ready           = true
    allowed_origins                = ["https://app.example.invalid"]
    oidc_issuer                    = "https://securetoken.google.com/floodrise-production-5305"
    oidc_audience                  = "floodrise-production-5305"
    oidc_jwks_url                  = "https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com"
    firebase_app_check_enabled     = true
    firebase_app_check_app_ids     = ["1:123456789012:web:0000000000000000000000"]
    notification_driver            = "disabled"
    database_high_availability     = false
    deletion_protection            = false
    backup_retention_days          = 7
    transaction_log_retention_days = 7
    target_rpo_minutes             = 15
    target_rto_minutes             = 60
  }

  expect_failures = [terraform_data.deployment_guard]
}

run "production_foundation_omits_public_runtime" {
  command = plan

  variables {
    project_id              = "floodrise-production-5305"
    environment             = "production"
    deployment_boundary_ack = "floodrise-production-5305:production"
    deployment_phase        = "foundation"

    api_image = "asia-south1-docker.pkg.dev/floodrise-production-5305/floodrise-containers/floodrise-api@sha256:0000000000000000000000000000000000000000000000000000000000000000"

    runtime_config_ready           = false
    firebase_app_check_enabled     = false
    notification_driver            = "disabled"
    database_high_availability     = true
    deletion_protection            = true
    backup_retention_days          = 35
    transaction_log_retention_days = 7
    target_rpo_minutes             = 5
    target_rto_minutes             = 30
  }

  assert {
    condition     = output.cloud_run_api_uri == null
    error_message = "A production foundation plan must not create a public API revision."
  }

  assert {
    condition = (
      output.cloud_run_tile_uri == null &&
      output.simulation_job.name == null &&
      output.simulation_job.location == null
    )
    error_message = "Production foundation must create no model runtime or model-service output."
  }
}

run "guarded_production_profile" {
  command = plan

  variables {
    project_id              = "floodrise-production-5305"
    environment             = "production"
    deployment_boundary_ack = "floodrise-production-5305:production"

    api_image = "asia-south1-docker.pkg.dev/floodrise-production-5305/floodrise-containers/floodrise-api@sha256:0000000000000000000000000000000000000000000000000000000000000000"

    runtime_config_ready           = true
    allowed_origins                = ["https://app.example.invalid"]
    oidc_issuer                    = "https://securetoken.google.com/floodrise-production-5305"
    oidc_audience                  = "floodrise-production-5305"
    oidc_jwks_url                  = "https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com"
    firebase_app_check_enabled     = true
    firebase_app_check_app_ids     = ["1:123456789012:web:0000000000000000000000"]
    notification_driver            = "disabled"
    database_high_availability     = true
    deletion_protection            = true
    backup_retention_days          = 35
    transaction_log_retention_days = 7
    target_rpo_minutes             = 5
    target_rto_minutes             = 30
  }

  assert {
    condition     = output.recovery_objectives.database_high_availability
    error_message = "The production profile must retain regional database HA."
  }

  assert {
    condition     = output.recovery_objectives.point_in_time_recovery
    error_message = "The production profile must retain point-in-time recovery."
  }

  assert {
    condition = (
      length(google_cloud_run_v2_service.api) == 1 &&
      output.cloud_run_tile_uri == null &&
      !output.simulation_job.enabled &&
      output.simulation_job.name == null &&
      output.model_service_boundary.production_model_services_off
    )
    error_message = "Production may create the protected API but must omit demo-only tile and simulation runtimes."
  }

  assert {
    condition = (
      length(google_service_account.tile) == 0 &&
      length(google_service_account.simulation) == 0 &&
      length(google_project_iam_custom_role.simulation_runner) == 0 &&
      length(google_cloud_run_v2_job_iam_member.api_simulation_runner) == 0 &&
      length(google_storage_bucket_iam_member.api_model_viewer) == 0
    )
    error_message = "Production must receive no dormant model-service identities, execution permissions, or model-bucket read grant."
  }

  assert {
    condition = (
      !contains(keys(local.api_plain_environment), "FLOODRISE_GCP_SIMULATION_JOB") &&
      !contains(keys(local.api_plain_environment), "FLOODRISE_TILE_BASE_URL")
    )
    error_message = "The production API must not advertise unavailable model services."
  }

  assert {
    condition     = google_cloud_run_v2_service.api[0].template[0].vpc_access[0].egress == "PRIVATE_RANGES_ONLY"
    error_message = "The production API must preserve managed public HTTPS egress while routing private database traffic through VPC."
  }
}
