variable "name" { type = string }
variable "environment" { type = string }
variable "vpc_id" { type = string }
variable "private_subnet_ids" { type = list(string) }
variable "alb_subnet_ids" { type = list(string) }
variable "alb_security_group_id" { type = string }
variable "application_security_group_id" { type = string }
variable "api_image" { type = string }
variable "worker_image" { type = string }
variable "tile_image" { type = string }
variable "api_origin_certificate_arn" {
  type     = string
  nullable = true
}
variable "api_desired_count" { type = number }
variable "worker_desired_count" { type = number }
variable "runtime_config_ready" { type = bool }
variable "application_secret_arn" { type = string }
variable "database_master_secret_arn" {
  type      = string
  sensitive = true
}
variable "database_host" { type = string }
variable "redis_endpoint" { type = string }
variable "jobs_queue_url" { type = string }
variable "jobs_queue_arn" { type = string }
variable "raw_bucket_arn" { type = string }
variable "processed_bucket_arn" { type = string }
variable "audit_bucket_arn" { type = string }
variable "kms_key_arn" { type = string }
variable "user_pool_id" { type = string }
variable "notification_driver" { type = string }
variable "external_notifications_enabled" { type = bool }
