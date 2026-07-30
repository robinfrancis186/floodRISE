resource "google_compute_network" "runtime" {
  name                            = "${local.resource_prefix}-runtime"
  auto_create_subnetworks         = false
  routing_mode                    = "REGIONAL"
  delete_default_routes_on_create = false

  depends_on = [google_project_service.required["compute.googleapis.com"]]
}

resource "google_compute_subnetwork" "runtime" {
  name                     = "${local.resource_prefix}-runtime"
  region                   = var.region
  network                  = google_compute_network.runtime.id
  ip_cidr_range            = var.network_cidr
  private_ip_google_access = true

  log_config {
    aggregation_interval = "INTERVAL_5_SEC"
    flow_sampling        = 0.5
    metadata             = "INCLUDE_ALL_METADATA"
  }
}

resource "google_compute_global_address" "private_services" {
  name          = "${local.resource_prefix}-private-services"
  purpose       = "VPC_PEERING"
  address_type  = "INTERNAL"
  address       = var.private_service_range_address
  prefix_length = 16
  network       = google_compute_network.runtime.id

  depends_on = [google_project_service.required["servicenetworking.googleapis.com"]]
}

resource "google_service_networking_connection" "private_services" {
  network                 = google_compute_network.runtime.id
  service                 = "servicenetworking.googleapis.com"
  reserved_peering_ranges = [google_compute_global_address.private_services.name]
}
