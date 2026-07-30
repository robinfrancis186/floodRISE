resource "google_service_account" "api" {
  count = local.api_service_enabled ? 1 : 0

  account_id   = "floodrise-api-${local.identity_suffix}"
  display_name = "floodRISE ${var.environment} API"
}

resource "google_service_account" "tile" {
  count = local.tile_service_enabled ? 1 : 0

  account_id   = "floodrise-tile-${local.identity_suffix}"
  display_name = "floodRISE ${var.environment} tile service"
}

resource "google_service_account" "simulation" {
  count = local.simulation_job_enabled ? 1 : 0

  account_id   = "floodrise-sim-${local.identity_suffix}"
  display_name = "floodRISE ${var.environment} simulation job"
}

resource "google_service_account" "notification" {
  account_id   = "floodrise-notify-${local.identity_suffix}"
  display_name = "floodRISE ${var.environment} notification dispatcher"
}

resource "google_project_iam_member" "api_cloud_sql_client" {
  count = local.api_service_enabled ? 1 : 0

  project = var.project_id
  role    = "roles/cloudsql.client"
  member  = "serviceAccount:${google_service_account.api[0].email}"
}

resource "google_project_iam_member" "api_cloud_sql_instance_user" {
  count = local.api_service_enabled ? 1 : 0

  project = var.project_id
  role    = "roles/cloudsql.instanceUser"
  member  = "serviceAccount:${google_service_account.api[0].email}"
}

resource "google_project_iam_member" "simulation_cloud_sql_client" {
  count = local.simulation_job_enabled ? 1 : 0

  project = var.project_id
  role    = "roles/cloudsql.client"
  member  = "serviceAccount:${google_service_account.simulation[0].email}"
}

resource "google_project_iam_member" "simulation_cloud_sql_instance_user" {
  count = local.simulation_job_enabled ? 1 : 0

  project = var.project_id
  role    = "roles/cloudsql.instanceUser"
  member  = "serviceAccount:${google_service_account.simulation[0].email}"
}

resource "google_secret_manager_secret_iam_member" "api" {
  for_each = local.api_service_enabled ? local.api_runtime_secrets : toset([])

  project   = var.project_id
  secret_id = google_secret_manager_secret.runtime[each.value].secret_id
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.api[0].email}"
}

resource "google_secret_manager_secret_iam_member" "simulation" {
  for_each = local.simulation_job_enabled ? local.simulation_runtime_secrets : toset([])

  project   = var.project_id
  secret_id = google_secret_manager_secret.runtime[each.value].secret_id
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.simulation[0].email}"
}

resource "google_storage_bucket_iam_member" "api_quarantine_object_user" {
  count = local.api_service_enabled ? 1 : 0

  bucket = google_storage_bucket.operational["quarantine"].name
  role   = "roles/storage.objectUser"
  member = "serviceAccount:${google_service_account.api[0].email}"
}

resource "google_storage_bucket_iam_member" "api_evidence_object_user" {
  count = local.api_service_enabled ? 1 : 0

  bucket = google_storage_bucket.operational["evidence"].name
  role   = "roles/storage.objectUser"
  member = "serviceAccount:${google_service_account.api[0].email}"
}

resource "google_storage_bucket_iam_member" "api_model_viewer" {
  count = local.api_tile_integration_enabled || local.api_simulation_dispatch_enabled ? 1 : 0

  bucket = google_storage_bucket.operational["models"].name
  role   = "roles/storage.objectViewer"
  member = "serviceAccount:${google_service_account.api[0].email}"
}

resource "google_storage_bucket_iam_member" "api_export_admin" {
  count = local.api_service_enabled ? 1 : 0

  bucket = google_storage_bucket.operational["exports"].name
  role   = "roles/storage.objectUser"
  member = "serviceAccount:${google_service_account.api[0].email}"
}

resource "google_storage_bucket_iam_member" "api_audit_writer" {
  count = local.api_service_enabled ? 1 : 0

  bucket = google_storage_bucket.operational["audit"].name
  role   = "roles/storage.objectCreator"
  member = "serviceAccount:${google_service_account.api[0].email}"
}

resource "google_storage_bucket_iam_member" "simulation_model_admin" {
  count = local.simulation_job_enabled ? 1 : 0

  bucket = google_storage_bucket.operational["models"].name
  role   = "roles/storage.objectUser"
  member = "serviceAccount:${google_service_account.simulation[0].email}"
}

resource "google_storage_bucket_iam_member" "tile_model_viewer" {
  count = local.tile_service_enabled ? 1 : 0

  bucket = google_storage_bucket.operational["models"].name
  role   = "roles/storage.objectViewer"
  member = "serviceAccount:${google_service_account.tile[0].email}"
}

resource "google_project_iam_custom_role" "simulation_runner" {
  count = local.api_simulation_dispatch_enabled ? 1 : 0

  role_id     = "floodriseSimulationRunner"
  title       = "floodRISE Simulation Runner"
  description = "Execute only the versioned floodRISE Cloud Run simulation job with bounded per-run overrides."
  permissions = [
    "run.jobs.run",
    "run.jobs.runWithOverrides",
  ]
}

resource "google_cloud_run_v2_job_iam_member" "api_simulation_runner" {
  count = local.api_simulation_dispatch_enabled ? 1 : 0

  project  = var.project_id
  location = var.region
  name     = google_cloud_run_v2_job.simulation[0].name
  role     = google_project_iam_custom_role.simulation_runner[0].name
  member   = "serviceAccount:${google_service_account.api[0].email}"
}

resource "google_project_iam_custom_role" "notification_sender" {
  count = var.external_notifications_enabled ? 1 : 0

  role_id     = "floodriseNotificationSender"
  title       = "floodRISE Notification Sender"
  description = "Send reviewed FCM envelopes; grants no Firebase configuration administration."
  permissions = ["cloudmessaging.messages.create"]

  lifecycle {
    precondition {
      condition     = var.environment == "production" && var.notification_driver == "fcm"
      error_message = "The notification sender role may only exist for the reviewed production FCM driver."
    }
  }
}

resource "google_project_iam_member" "notification_fcm_sender" {
  count = var.external_notifications_enabled ? 1 : 0

  project = var.project_id
  role    = google_project_iam_custom_role.notification_sender[0].name
  member  = "serviceAccount:${google_service_account.notification.email}"
}
