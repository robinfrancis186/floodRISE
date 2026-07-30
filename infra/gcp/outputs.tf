output "firebase_project" {
  description = "Firebase project identity used by the web clients and App Check."
  value = {
    project_id     = var.project_id
    project_number = data.google_project.current.number
    environment    = var.environment
  }
}

output "cloud_run_api_uri" {
  description = "Public API origin used by the Firebase Hosting /api rewrite. Application controls and App Check protect this path; Cloud Armor is not attached."
  value       = try(google_cloud_run_v2_service.api[0].uri, null)
}

output "cloud_run_tile_uri" {
  description = "Internal-only deterministic-demo tile URI, or null until reviewed PGM artifacts are acknowledged."
  value       = try(google_cloud_run_v2_service.tile[0].uri, null)
  sensitive   = true
}

output "simulation_job" {
  value = {
    enabled  = local.simulation_job_enabled
    name     = try(google_cloud_run_v2_job.simulation[0].name, null)
    location = local.simulation_job_enabled ? var.region : null
  }
}

output "model_service_boundary" {
  description = "Fail-closed model runtime status. Production remains disabled until reviewed COG and live-model implementations exist."
  value = {
    api_enabled                       = local.api_service_enabled
    simulation_job_enabled            = local.simulation_job_enabled
    tile_service_enabled              = local.tile_service_enabled
    tile_representation               = local.tile_service_enabled ? "PACKAGED_PGM_DEMO_ONLY" : "DISABLED"
    production_model_services_off     = var.environment == "production"
    public_demo_api_intentionally_off = var.environment == "demo"
  }
}

output "cloud_sql" {
  value = {
    instance_name   = google_sql_database_instance.postgres.name
    connection_name = google_sql_database_instance.postgres.connection_name
    private_ip      = google_sql_database_instance.postgres.private_ip_address
    database        = google_sql_database.floodrise.name
  }
  sensitive = true
}

output "operational_buckets" {
  description = "Private CMEK bucket names by data class."
  value = {
    for key, bucket in google_storage_bucket.operational :
    key => bucket.name
  }
}

output "runtime_secret_ids" {
  description = "Populate versions out-of-band; Terraform intentionally stores no secret payload."
  value = {
    for key, secret in google_secret_manager_secret.runtime :
    key => secret.secret_id
  }
}

output "artifact_registry_repository" {
  value = google_artifact_registry_repository.containers.name
}

output "recovery_objectives" {
  value = {
    target_rpo_minutes             = var.target_rpo_minutes
    target_rto_minutes             = var.target_rto_minutes
    database_high_availability     = var.database_high_availability
    point_in_time_recovery         = true
    transaction_log_retention_days = var.transaction_log_retention_days
    backup_retention_days          = var.backup_retention_days
    backup_location                = var.database_backup_location
  }
}

output "notification_boundary" {
  value = {
    driver                      = var.notification_driver
    external_notifications      = var.external_notifications_enabled
    demo_external_io_hard_block = var.environment == "demo"
  }
}
