variable "name" { type = string }
variable "environment" { type = string }
variable "api_origin_dns" { type = string }
variable "api_origin_https" { type = bool }
variable "enable_waf_logs" { type = bool }
variable "origin_verify_header_value" {
  type      = string
  sensitive = true

  validation {
    condition     = length(var.origin_verify_header_value) >= 32
    error_message = "The CloudFront origin-verification value must contain at least 32 characters."
  }
}
