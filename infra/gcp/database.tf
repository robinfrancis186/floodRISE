resource "google_sql_database_instance" "postgres" {
  name                = "${local.resource_prefix}-postgres"
  region              = var.region
  database_version    = "POSTGRES_16"
  encryption_key_name = google_kms_crypto_key.database.id
  deletion_protection = var.deletion_protection

  settings {
    tier              = var.database_tier
    availability_type = var.database_high_availability ? "REGIONAL" : "ZONAL"
    disk_type         = "PD_SSD"
    disk_size         = var.database_disk_size_gb
    disk_autoresize   = true

    backup_configuration {
      enabled                        = true
      start_time                     = "18:30"
      location                       = var.database_backup_location
      point_in_time_recovery_enabled = true
      transaction_log_retention_days = var.transaction_log_retention_days

      backup_retention_settings {
        retained_backups = var.backup_retention_days
        retention_unit   = "COUNT"
      }
    }

    ip_configuration {
      ipv4_enabled                                  = false
      private_network                               = google_compute_network.runtime.id
      enable_private_path_for_google_cloud_services = true
      ssl_mode                                      = "ENCRYPTED_ONLY"
    }

    database_flags {
      name  = "cloudsql.iam_authentication"
      value = "on"
    }

    insights_config {
      query_insights_enabled  = true
      query_string_length     = 1024
      record_application_tags = true
      record_client_address   = false
    }

    maintenance_window {
      day          = 7
      hour         = 20
      update_track = "stable"
    }

    user_labels = local.common_labels
  }

  depends_on = [
    google_kms_crypto_key_iam_member.cloud_sql,
    google_service_networking_connection.private_services,
    google_project_service.required["sqladmin.googleapis.com"],
  ]

  lifecycle {
    precondition {
      condition     = var.environment != "production" || var.database_high_availability
      error_message = "Production Cloud SQL must use regional high availability."
    }
  }
}

resource "google_sql_database" "floodrise" {
  name      = "floodrise"
  instance  = google_sql_database_instance.postgres.name
  charset   = "UTF8"
  collation = "en_US.UTF8"
}
