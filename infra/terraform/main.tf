locals {
  name = "${var.project_name}-${var.environment}"
  common_tags = {
    Project        = "floodRISE"
    Environment    = var.environment
    ManagedBy      = "Terraform"
    DataMode       = var.environment == "demo" ? "SIMULATED" : "LIVE_ELIGIBLE"
    NotificationIO = var.external_notifications_enabled ? "REVIEW_REQUIRED" : "DISABLED"
  }
}

resource "terraform_data" "deployment_guard" {
  input = sha256(jsonencode({
    environment     = var.environment
    region          = var.aws_region
    demo_egress     = var.enable_nat_gateway
    notification_io = var.external_notifications_enabled
    notification    = var.notification_driver
    multi_az        = var.multi_az
    protected       = var.deletion_protection
    cross_region    = var.cross_region_backup_enabled
    retention       = var.backup_retention_days
    target_rpo      = var.target_rpo_minutes
    target_rto      = var.target_rto_minutes
    origin_tls      = var.api_origin_certificate_arn != null
  }))

  lifecycle {
    precondition {
      condition     = var.aws_region == "ap-south-1"
      error_message = "The supported primary deployment region is ap-south-1 (Mumbai)."
    }

    precondition {
      condition = var.environment != "demo" || (
        var.notification_driver == "demo_log" && !var.external_notifications_enabled
      )
      error_message = "Demo deployments must use demo_log and disable external notifications."
    }

    precondition {
      condition     = var.environment != "demo" || !var.enable_nat_gateway
      error_message = "Demo deployments may not create a NAT gateway or public application egress."
    }

    precondition {
      condition = var.environment != "production" || (
        var.multi_az &&
        var.deletion_protection &&
        var.cross_region_backup_enabled &&
        var.backup_retention_days >= 35 &&
        var.target_rpo_minutes <= 5 &&
        var.target_rto_minutes <= 30 &&
        var.api_origin_certificate_arn != null
      )
      error_message = "Production requires Multi-AZ, deletion protection, cross-region backups, at least 35 days retention, RPO <= 5 minutes, RTO <= 30 minutes, and TLS to the API origin."
    }
  }
}

module "network" {
  source = "./modules/network"

  depends_on = [terraform_data.deployment_guard]

  name                  = local.name
  vpc_cidr              = var.vpc_cidr
  enable_nat_gateway    = var.enable_nat_gateway
  allow_public_egress   = var.environment != "demo"
  allowed_ingress_cidrs = var.allowed_ingress_cidrs
}

module "data" {
  source = "./modules/data"

  providers = {
    aws        = aws
    aws.backup = aws.backup
  }

  name                        = local.name
  environment                 = var.environment
  vpc_id                      = module.network.vpc_id
  private_subnet_ids          = module.network.private_subnet_ids
  data_security_group_id      = module.network.data_security_group_id
  db_instance_class           = var.db_instance_class
  redis_node_type             = var.redis_node_type
  multi_az                    = var.multi_az
  deletion_protection         = var.deletion_protection
  backup_retention_days       = var.backup_retention_days
  cross_region_backup_enabled = var.cross_region_backup_enabled
}

module "identity" {
  source = "./modules/identity"

  depends_on = [terraform_data.deployment_guard]

  name                  = local.name
  cognito_domain_prefix = var.cognito_domain_prefix
  callback_urls         = var.oauth_callback_urls
  logout_urls           = var.oauth_logout_urls
}

module "compute" {
  source = "./modules/compute"

  name                           = local.name
  environment                    = var.environment
  vpc_id                         = module.network.vpc_id
  private_subnet_ids             = module.network.private_subnet_ids
  alb_subnet_ids                 = module.network.public_subnet_ids
  alb_security_group_id          = module.network.alb_security_group_id
  application_security_group_id  = module.network.application_security_group_id
  api_image                      = var.api_image
  worker_image                   = var.worker_image
  tile_image                     = var.tile_image
  api_origin_certificate_arn     = var.api_origin_certificate_arn
  api_desired_count              = var.api_desired_count
  worker_desired_count           = var.worker_desired_count
  runtime_config_ready           = var.runtime_config_ready
  application_secret_arn         = module.data.application_secret_arn
  database_master_secret_arn     = module.data.database_master_secret_arn
  database_host                  = module.data.database_host
  redis_endpoint                 = module.data.redis_endpoint
  jobs_queue_url                 = module.data.jobs_queue_url
  jobs_queue_arn                 = module.data.jobs_queue_arn
  raw_bucket_arn                 = module.data.raw_bucket_arn
  processed_bucket_arn           = module.data.processed_bucket_arn
  audit_bucket_arn               = module.data.audit_bucket_arn
  kms_key_arn                    = module.data.kms_key_arn
  user_pool_id                   = module.identity.user_pool_id
  notification_driver            = var.notification_driver
  external_notifications_enabled = var.external_notifications_enabled
}

module "edge" {
  source = "./modules/edge"

  providers = {
    aws      = aws
    aws.edge = aws.edge
  }

  name             = local.name
  environment      = var.environment
  api_origin_dns   = module.compute.load_balancer_dns_name
  api_origin_id    = module.compute.load_balancer_id
  api_origin_https = var.api_origin_certificate_arn != null
  enable_waf_logs  = var.enable_waf_logging
}
