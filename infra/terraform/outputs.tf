output "cloudfront_domain_name" {
  value = module.edge.cloudfront_domain_name
}

output "api_load_balancer_dns_name" {
  value = module.compute.load_balancer_dns_name
}

output "cognito_user_pool_id" {
  value = module.identity.user_pool_id
}

output "cognito_client_id" {
  value = module.identity.client_id
}

output "application_secret_arn" {
  description = "Populate this secret out-of-band; Terraform intentionally creates no secret value."
  value       = module.data.application_secret_arn
}

output "recovery_objectives" {
  value = {
    target_rpo_minutes = var.target_rpo_minutes
    target_rto_minutes = var.target_rto_minutes
    multi_az           = var.multi_az
    cross_region_copy  = var.cross_region_backup_enabled
  }
}
