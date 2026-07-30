resource "google_storage_bucket" "operational" {
  for_each = local.operational_buckets

  name                        = "${var.project_id}-${var.environment}-${each.key}"
  project                     = var.project_id
  location                    = var.bucket_location
  storage_class               = "STANDARD"
  force_destroy               = var.bucket_force_destroy
  uniform_bucket_level_access = true
  public_access_prevention    = "enforced"

  versioning {
    enabled = each.value.versioning_enabled
  }

  encryption {
    default_kms_key_name = google_kms_crypto_key.data.id
  }

  soft_delete_policy {
    retention_duration_seconds = each.value.soft_delete_retention_seconds
  }

  dynamic "retention_policy" {
    for_each = each.value.retention_days == null ? [] : [each.value.retention_days]

    content {
      retention_period = retention_policy.value * 86400
      is_locked        = false
    }
  }

  lifecycle_rule {
    condition {
      age = each.value.delete_after_days
    }

    action {
      type = "Delete"
    }
  }

  dynamic "lifecycle_rule" {
    for_each = each.value.noncurrent_delete_after_days == null ? [] : [
      each.value.noncurrent_delete_after_days
    ]

    content {
      condition {
        days_since_noncurrent_time = lifecycle_rule.value
      }

      action {
        type = "Delete"
      }
    }
  }

  lifecycle_rule {
    condition {
      age                   = 1
      with_state            = "ANY"
      matches_prefix        = [""]
      matches_storage_class = ["STANDARD", "NEARLINE", "COLDLINE", "ARCHIVE"]
    }

    action {
      type = "AbortIncompleteMultipartUpload"
    }
  }

  depends_on = [
    google_kms_crypto_key_iam_member.storage,
    google_project_service.required["storage.googleapis.com"],
  ]
}

resource "google_secret_manager_secret" "runtime" {
  for_each = local.runtime_secrets

  secret_id = "${local.resource_prefix}-${each.value}"

  replication {
    user_managed {
      replicas {
        location = var.region

        customer_managed_encryption {
          kms_key_name = google_kms_crypto_key.data.id
        }
      }
    }
  }

  depends_on = [
    google_kms_crypto_key_iam_member.secret_manager,
    google_project_service.required["secretmanager.googleapis.com"],
  ]
}
