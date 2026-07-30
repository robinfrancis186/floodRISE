locals {
  # The checked-in API is production-only. The deterministic demo remains a
  # local/static-fixture workflow unless its private model workers are
  # deliberately prepared with persistent configuration.
  api_service_enabled = (
    var.environment == "production" &&
    var.deployment_phase == "runtime" &&
    var.runtime_config_ready
  )
  demo_model_runtime_ready = (
    var.environment == "demo" &&
    var.deployment_phase == "runtime" &&
    var.runtime_config_ready
  )
  simulation_job_enabled = local.demo_model_runtime_ready
  tile_service_enabled = (
    local.demo_model_runtime_ready &&
    var.demo_tile_artifacts_ack == "I_HAVE_REVIEWED_DEMO_TILE_ARTIFACTS"
  )

  # These stay false with the current product boundary: the public API exists
  # only in production, while deterministic model services exist only in demo.
  api_simulation_dispatch_enabled = local.api_service_enabled && local.simulation_job_enabled
  api_tile_integration_enabled    = local.api_service_enabled && local.tile_service_enabled

  api_plain_environment = merge(
    {
      FLOODRISE_ENV                               = var.environment
      FLOODRISE_DEMO_MODE                         = tostring(var.environment == "demo")
      FLOODRISE_DEMO_ALERT_SINK                   = "fake://notification-sink"
      FLOODRISE_DATABASE_ALLOWED_HOST             = google_sql_database_instance.postgres.private_ip_address
      FLOODRISE_ALLOWED_ORIGINS                   = join(",", var.allowed_origins)
      FLOODRISE_OIDC_AUDIENCE                     = var.oidc_audience
      FLOODRISE_SECURE_COOKIES                    = tostring(var.environment != "demo")
      FLOODRISE_FIREBASE_APP_CHECK_ENABLED        = tostring(var.firebase_app_check_enabled)
      FLOODRISE_FIREBASE_APP_CHECK_PROJECT_NUMBER = tostring(data.google_project.current.number)
      FLOODRISE_FIREBASE_APP_CHECK_APP_IDS        = join(",", var.firebase_app_check_app_ids)
      FLOODRISE_FIREBASE_APP_CHECK_JWKS_URL       = var.firebase_app_check_jwks_url
      FLOODRISE_OBJECT_STORE_PROVIDER             = "gcs"
      FLOODRISE_OBJECT_STORE_BUCKET               = google_storage_bucket.operational["quarantine"].name
      FLOODRISE_OBJECT_STORE_REGION               = var.region
      FLOODRISE_GCS_QUARANTINE_BUCKET             = google_storage_bucket.operational["quarantine"].name
      FLOODRISE_GCS_CLEAN_BUCKET                  = google_storage_bucket.operational["evidence"].name
      FLOODRISE_NOTIFICATION_DRIVER               = var.notification_driver
      FLOODRISE_EXTERNAL_NOTIFICATIONS_ENABLED    = tostring(var.external_notifications_enabled)
      FLOODRISE_GCP_PROJECT_ID                    = var.project_id
      FLOODRISE_GCP_REGION                        = var.region
    },
    local.api_simulation_dispatch_enabled ? {
      FLOODRISE_GCP_SIMULATION_JOB = google_cloud_run_v2_job.simulation[0].name
    } : {},
    local.api_tile_integration_enabled ? {
      FLOODRISE_TILE_BASE_URL = google_cloud_run_v2_service.tile[0].uri
    } : {},
    var.oidc_issuer == null ? {} : {
      FLOODRISE_OIDC_ISSUER = var.oidc_issuer
    },
    var.oidc_jwks_url == null ? {} : {
      FLOODRISE_OIDC_JWKS_URL = var.oidc_jwks_url
    },
  )

  job_plain_environment = merge(
    {
      FLOODRISE_ENV                   = var.environment
      FLOODRISE_DEMO_MODE             = tostring(var.environment == "demo")
      FLOODRISE_DEMO_ALERT_SINK       = "fake://notification-sink"
      FLOODRISE_DATABASE_ALLOWED_HOST = google_sql_database_instance.postgres.private_ip_address
      FLOODRISE_JOB_OPERATION         = "simulation"
      FLOODRISE_JOB_INCIDENT_ID       = "inc-demo-kerala-flood-2023"
      FLOODRISE_JOB_TRIGGER           = "deterministic Kerala competition replay"
      FLOODRISE_OBJECT_STORE_PROVIDER = "gcs"
      FLOODRISE_OBJECT_STORE_BUCKET   = google_storage_bucket.operational["models"].name
      FLOODRISE_OBJECT_STORE_REGION   = var.region
    },
  )
}

resource "terraform_data" "model_service_guard" {
  input = {
    api_enabled        = local.api_service_enabled
    simulation_enabled = local.simulation_job_enabled
    tile_enabled       = local.tile_service_enabled
    tile_ack           = sha256(var.demo_tile_artifacts_ack)
  }

  lifecycle {
    precondition {
      condition = var.demo_tile_artifacts_ack == "" || (
        var.environment == "demo" &&
        var.deployment_phase == "runtime" &&
        var.runtime_config_ready
      )
      error_message = "The demo tile acknowledgement is valid only for a ready demo runtime; production and unready runtimes must leave it empty."
    }

    precondition {
      condition     = !local.simulation_job_enabled || var.simulation_image != null
      error_message = "A ready deterministic demo simulation job requires an immutable simulation_image digest."
    }

    precondition {
      condition     = !local.tile_service_enabled || var.tile_image != null
      error_message = "The acknowledged deterministic demo tile service requires an immutable tile_image digest."
    }
  }
}

resource "google_cloud_run_v2_service" "tile" {
  count = local.tile_service_enabled ? 1 : 0

  name                = local.tile_service_name
  location            = var.region
  ingress             = "INGRESS_TRAFFIC_INTERNAL_ONLY"
  deletion_protection = false

  template {
    service_account                  = google_service_account.tile[0].email
    execution_environment            = "EXECUTION_ENVIRONMENT_GEN2"
    timeout                          = "60s"
    max_instance_request_concurrency = 40

    scaling {
      min_instance_count = 0
      max_instance_count = var.tile_max_instances
    }

    vpc_access {
      egress = "PRIVATE_RANGES_ONLY"

      network_interfaces {
        network    = google_compute_network.runtime.id
        subnetwork = google_compute_subnetwork.runtime.id
        tags       = ["floodrise-runtime", "floodrise-tile"]
      }
    }

    volumes {
      name = "models"

      gcs {
        bucket    = google_storage_bucket.operational["models"].name
        read_only = true
      }
    }

    containers {
      name  = "tile"
      image = var.tile_image

      ports {
        name           = "http1"
        container_port = 8790
      }

      env {
        name  = "FLOODRISE_ENV"
        value = var.environment
      }

      env {
        name  = "FLOODRISE_RASTER_MANIFEST"
        value = "/mnt/floodrise-models/current/manifest.json"
      }

      resources {
        limits = {
          cpu    = "1"
          memory = "1Gi"
        }
        cpu_idle          = true
        startup_cpu_boost = true
      }

      volume_mounts {
        name       = "models"
        mount_path = "/mnt/floodrise-models"
      }

      startup_probe {
        initial_delay_seconds = 1
        timeout_seconds       = 3
        period_seconds        = 5
        failure_threshold     = 12

        tcp_socket {
          port = 8790
        }
      }

      liveness_probe {
        initial_delay_seconds = 10
        timeout_seconds       = 3
        period_seconds        = 10
        failure_threshold     = 3

        http_get {
          path = "/health"
          port = 8790
        }
      }
    }
  }

  traffic {
    type    = "TRAFFIC_TARGET_ALLOCATION_TYPE_LATEST"
    percent = 100
  }

  depends_on = [
    google_project_service.required["run.googleapis.com"],
    google_storage_bucket_iam_member.tile_model_viewer,
  ]
}

resource "google_cloud_run_v2_service" "api" {
  count = local.api_service_enabled ? 1 : 0

  name                = local.api_service_name
  location            = var.region
  ingress             = "INGRESS_TRAFFIC_ALL"
  deletion_protection = var.environment == "production"

  template {
    service_account                  = google_service_account.api[0].email
    execution_environment            = "EXECUTION_ENVIRONMENT_GEN2"
    timeout                          = "60s"
    max_instance_request_concurrency = 80

    scaling {
      min_instance_count = var.api_min_instances
      max_instance_count = var.api_max_instances
    }

    vpc_access {
      egress = "PRIVATE_RANGES_ONLY"

      network_interfaces {
        network    = google_compute_network.runtime.id
        subnetwork = google_compute_subnetwork.runtime.id
        tags       = ["floodrise-runtime", "floodrise-api"]
      }
    }

    containers {
      name  = "api"
      image = var.api_image

      ports {
        name           = "http1"
        container_port = 8787
      }

      dynamic "env" {
        for_each = local.api_plain_environment

        content {
          name  = env.key
          value = env.value
        }
      }

      dynamic "env" {
        for_each = local.api_service_enabled ? [1] : []

        content {
          name = "FLOODRISE_DATABASE_URL"

          value_source {
            secret_key_ref {
              secret  = google_secret_manager_secret.runtime["api-database-url"].secret_id
              version = "latest"
            }
          }
        }
      }

      dynamic "env" {
        for_each = local.api_service_enabled ? [1] : []

        content {
          name = "FLOODRISE_SESSION_SECRET"

          value_source {
            secret_key_ref {
              secret  = google_secret_manager_secret.runtime["session-secret"].secret_id
              version = "latest"
            }
          }
        }
      }

      resources {
        limits = {
          cpu    = "2"
          memory = "2Gi"
        }
        cpu_idle          = true
        startup_cpu_boost = true
      }

      startup_probe {
        initial_delay_seconds = 1
        timeout_seconds       = 3
        period_seconds        = 5
        failure_threshold     = 18

        tcp_socket {
          port = 8787
        }
      }

      liveness_probe {
        initial_delay_seconds = 15
        timeout_seconds       = 5
        period_seconds        = 15
        failure_threshold     = 3

        http_get {
          path = "/health"
          port = 8787
        }
      }
    }
  }

  traffic {
    type    = "TRAFFIC_TARGET_ALLOCATION_TYPE_LATEST"
    percent = 100
  }

  depends_on = [
    google_project_service.required["run.googleapis.com"],
    google_project_iam_member.api_cloud_sql_client,
    google_project_iam_member.api_cloud_sql_instance_user,
    google_secret_manager_secret_iam_member.api,
    google_storage_bucket_iam_member.api_quarantine_object_user,
    google_storage_bucket_iam_member.api_evidence_object_user,
    google_storage_bucket_iam_member.api_model_viewer,
    google_storage_bucket_iam_member.api_export_admin,
    google_storage_bucket_iam_member.api_audit_writer,
    google_cloud_run_v2_job_iam_member.api_simulation_runner,
  ]
}

resource "google_cloud_run_v2_job" "simulation" {
  count = local.simulation_job_enabled ? 1 : 0

  name                = local.simulation_job_name
  location            = var.region
  deletion_protection = false

  template {
    task_count  = 1
    parallelism = 1

    template {
      service_account       = google_service_account.simulation[0].email
      execution_environment = "EXECUTION_ENVIRONMENT_GEN2"
      timeout               = "3600s"
      max_retries           = 2

      vpc_access {
        egress = "PRIVATE_RANGES_ONLY"

        network_interfaces {
          network    = google_compute_network.runtime.id
          subnetwork = google_compute_subnetwork.runtime.id
          tags       = ["floodrise-runtime", "floodrise-simulation"]
        }
      }

      volumes {
        name = "models"

        gcs {
          bucket    = google_storage_bucket.operational["models"].name
          read_only = false
        }
      }

      containers {
        name    = "simulation"
        image   = var.simulation_image
        command = ["/opt/floodrise-venv/bin/python", "-m", "app.gcp_job"]

        dynamic "env" {
          for_each = local.job_plain_environment

          content {
            name  = env.key
            value = env.value
          }
        }

        dynamic "env" {
          for_each = local.simulation_job_enabled ? [1] : []

          content {
            name = "FLOODRISE_DATABASE_URL"

            value_source {
              secret_key_ref {
                secret  = google_secret_manager_secret.runtime["simulation-database-url"].secret_id
                version = "latest"
              }
            }
          }
        }

        resources {
          limits = {
            cpu    = "4"
            memory = "8Gi"
          }
        }

        volume_mounts {
          name       = "models"
          mount_path = "/mnt/floodrise-models"
        }
      }
    }
  }

  depends_on = [
    google_project_service.required["run.googleapis.com"],
    google_project_iam_member.simulation_cloud_sql_client,
    google_project_iam_member.simulation_cloud_sql_instance_user,
    google_secret_manager_secret_iam_member.simulation,
    google_storage_bucket_iam_member.simulation_model_admin,
  ]
}

# Firebase Hosting invokes the API rewrite without a Google identity. App Check,
# OIDC, application authorization, idempotency, and approval controls remain
# mandatory at the FastAPI boundary. This is not a Cloud Armor protected path.
resource "google_cloud_run_v2_service_iam_member" "api_public_invoker" {
  count = length(google_cloud_run_v2_service.api)

  project  = var.project_id
  location = var.region
  name     = google_cloud_run_v2_service.api[0].name
  role     = "roles/run.invoker"
  member   = "allUsers"
}

resource "google_cloud_run_v2_service_iam_member" "api_tile_invoker" {
  count = local.api_tile_integration_enabled ? 1 : 0

  project  = var.project_id
  location = var.region
  name     = google_cloud_run_v2_service.tile[0].name
  role     = "roles/run.invoker"
  member   = "serviceAccount:${google_service_account.api[0].email}"
}
