data "google_project" "current" {
  project_id = var.project_id
}

resource "google_project_service" "required" {
  for_each = local.required_services

  project            = var.project_id
  service            = each.value
  disable_on_destroy = false

  depends_on = [terraform_data.deployment_guard]
}

resource "google_artifact_registry_repository" "containers" {
  location      = var.region
  repository_id = local.artifact_registry_name
  description   = "Immutable floodRISE runtime images"
  format        = "DOCKER"

  docker_config {
    immutable_tags = true
  }

  cleanup_policy_dry_run = true

  depends_on = [google_project_service.required["artifactregistry.googleapis.com"]]
}

resource "google_firebase_project" "current" {
  provider = google-beta
  project  = var.project_id

  depends_on = [google_project_service.required["firebase.googleapis.com"]]
}

resource "google_identity_platform_config" "current" {
  provider = google-beta
  project  = var.project_id

  autodelete_anonymous_users = true
  authorized_domains         = var.firebase_authorized_domains

  sign_in {
    anonymous {
      enabled = false
    }

    email {
      enabled           = true
      password_required = false
    }
  }

  depends_on = [
    google_firebase_project.current,
    google_project_service.required["identitytoolkit.googleapis.com"],
  ]
}
