resource "google_project_service_identity" "cloud_sql" {
  provider = google-beta
  project  = var.project_id
  service  = "sqladmin.googleapis.com"

  depends_on = [google_project_service.required["sqladmin.googleapis.com"]]
}

resource "google_project_service_identity" "secret_manager" {
  provider = google-beta
  project  = var.project_id
  service  = "secretmanager.googleapis.com"

  depends_on = [google_project_service.required["secretmanager.googleapis.com"]]
}

data "google_storage_project_service_account" "current" {
  project = var.project_id

  depends_on = [google_project_service.required["storage.googleapis.com"]]
}

resource "google_kms_key_ring" "runtime" {
  name     = "${local.resource_prefix}-runtime"
  location = var.region

  depends_on = [google_project_service.required["cloudkms.googleapis.com"]]
}

resource "google_kms_crypto_key" "data" {
  name            = "operational-data"
  key_ring        = google_kms_key_ring.runtime.id
  rotation_period = "7776000s"

  lifecycle {
    prevent_destroy = true
  }
}

resource "google_kms_crypto_key" "database" {
  name            = "cloud-sql"
  key_ring        = google_kms_key_ring.runtime.id
  rotation_period = "7776000s"

  lifecycle {
    prevent_destroy = true
  }
}

resource "google_kms_crypto_key_iam_member" "storage" {
  crypto_key_id = google_kms_crypto_key.data.id
  role          = "roles/cloudkms.cryptoKeyEncrypterDecrypter"
  member        = "serviceAccount:${data.google_storage_project_service_account.current.email_address}"
}

resource "google_kms_crypto_key_iam_member" "cloud_sql" {
  crypto_key_id = google_kms_crypto_key.database.id
  role          = "roles/cloudkms.cryptoKeyEncrypterDecrypter"
  member        = "serviceAccount:${google_project_service_identity.cloud_sql.email}"
}

resource "google_kms_crypto_key_iam_member" "secret_manager" {
  crypto_key_id = google_kms_crypto_key.data.id
  role          = "roles/cloudkms.cryptoKeyEncrypterDecrypter"
  member        = "serviceAccount:${google_project_service_identity.secret_manager.email}"
}
