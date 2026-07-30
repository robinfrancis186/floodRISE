terraform {
  required_version = ">= 1.8.0"

  backend "gcs" {}

  required_providers {
    google = {
      source  = "hashicorp/google"
      version = ">= 6.30, < 8.0"
    }
    google-beta = {
      source  = "hashicorp/google-beta"
      version = ">= 6.30, < 8.0"
    }
  }
}
