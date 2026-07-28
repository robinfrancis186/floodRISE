variable "project_name" {
  description = "Short resource-name prefix."
  type        = string
  default     = "floodrise"
}

variable "environment" {
  description = "Deployment boundary; demo and production must use separate accounts or credentials."
  type        = string
  default     = "demo"

  validation {
    condition     = contains(["demo", "staging", "production"], var.environment)
    error_message = "environment must be demo, staging, or production."
  }
}

variable "aws_region" {
  description = "Primary AWS region; Mumbai is the supported default."
  type        = string
  default     = "ap-south-1"
}

variable "backup_region" {
  description = "Secondary region used for cross-region backup copies."
  type        = string
  default     = "ap-south-2"
}

variable "vpc_cidr" {
  type    = string
  default = "10.53.0.0/16"
}

variable "enable_nat_gateway" {
  description = "Enables controlled egress for image pulls and permitted live adapters."
  type        = bool
  default     = false
}

variable "api_image" {
  description = "Immutable API container image reference. Deployment guards require a same-account ECR SHA-256 digest."
  type        = string
}

variable "worker_image" {
  description = "Immutable worker container image reference. Deployment guards require a same-account ECR SHA-256 digest."
  type        = string
}

variable "tile_image" {
  description = "Immutable restricted tile-facade image reference. Deployment guards require a same-account ECR SHA-256 digest."
  type        = string
}

variable "api_origin_certificate_arn" {
  description = "ACM certificate for CloudFront-to-ALB TLS. Required in production."
  type        = string
  default     = null
  nullable    = true
}

variable "api_desired_count" {
  type    = number
  default = 2
}

variable "worker_desired_count" {
  type    = number
  default = 1
}

variable "runtime_config_ready" {
  description = "Starts API/worker services only after the out-of-band application secret is populated."
  type        = bool
  default     = false
}

variable "db_instance_class" {
  type    = string
  default = "db.t4g.medium"
}

variable "multi_az" {
  description = "Creates a redundant RDS deployment. Required for production."
  type        = bool
  default     = false
}

variable "deletion_protection" {
  description = "Protects durable stores from Terraform deletion. Required for production."
  type        = bool
  default     = false
}

variable "backup_retention_days" {
  description = "RDS automated backup/PITR retention window."
  type        = number
  default     = 7
}

variable "cross_region_backup_enabled" {
  description = "Copies AWS Backup recovery points to the secondary region."
  type        = bool
  default     = false
}

variable "target_rpo_minutes" {
  description = "Documented recovery-point objective; validated operationally."
  type        = number
  default     = 5
}

variable "target_rto_minutes" {
  description = "Documented recovery-time objective; validated by restore drills."
  type        = number
  default     = 30
}

variable "cognito_domain_prefix" {
  description = "Globally unique Cognito hosted UI prefix."
  type        = string
}

variable "oauth_callback_urls" {
  type = list(string)
}

variable "oauth_logout_urls" {
  type = list(string)
}

variable "notification_driver" {
  description = "The demo environment permits only demo_log."
  type        = string
  default     = "demo_log"
}

variable "external_notifications_enabled" {
  description = "Must remain false in this scaffold. Enabling a real provider requires a separate authority-reviewed code change."
  type        = bool
  default     = false
}

variable "live_integrations_enabled" {
  description = "Fail-closed switch for permitted production source adapters. Staging and demo must keep this false."
  type        = bool
  default     = false
}

variable "approved_adapter_egress_cidrs" {
  description = "Explicit IPv4 CIDRs for reviewed worker source adapters. Global default routes are rejected."
  type        = list(string)
  default     = []

  validation {
    condition = alltrue([
      for cidr in var.approved_adapter_egress_cidrs :
      can(cidrnetmask(cidr)) && cidr != "0.0.0.0/0"
    ])
    error_message = "approved_adapter_egress_cidrs must contain valid, scoped IPv4 CIDRs and may not contain 0.0.0.0/0."
  }
}

variable "enable_waf_logging" {
  description = "Send CloudFront WAF logs to a redacted CloudWatch log group."
  type        = bool
  default     = true
}
