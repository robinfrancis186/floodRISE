data "aws_caller_identity" "current" {}

resource "random_password" "origin_verify" {
  length  = 48
  special = false
}

locals {
  name = "${var.project_name}-${var.environment}"
  live_eligible = (
    var.environment == "production" &&
    var.live_integrations_enabled
  )
  immutable_images = [
    var.api_image,
    var.worker_image,
    var.tile_image,
  ]
  same_account_ecr_digest_pattern = "^${data.aws_caller_identity.current.account_id}\\.dkr\\.ecr\\.${var.aws_region}\\.amazonaws\\.com/[a-z0-9][a-z0-9._/-]*@sha256:[0-9a-f]{64}$"
  common_tags = {
    Project        = "floodRISE"
    Environment    = var.environment
    ManagedBy      = "Terraform"
    DataMode       = var.environment == "demo" ? "SIMULATED" : (local.live_eligible ? "LIVE_ELIGIBLE" : "LIVE_INPUTS_DISABLED")
    NotificationIO = var.external_notifications_enabled ? "REVIEW_REQUIRED" : "DISABLED"
  }
}

resource "terraform_data" "deployment_guard" {
  input = sha256(jsonencode({
    environment     = var.environment
    region          = var.aws_region
    nat_gateway     = var.enable_nat_gateway
    live_adapters   = var.live_integrations_enabled
    adapter_cidrs   = sha256(jsonencode(sort(var.approved_adapter_egress_cidrs)))
    notification_io = var.external_notifications_enabled
    notification    = var.notification_driver
    multi_az        = var.multi_az
    protected       = var.deletion_protection
    cross_region    = var.cross_region_backup_enabled
    retention       = var.backup_retention_days
    target_rpo      = var.target_rpo_minutes
    target_rto      = var.target_rto_minutes
    origin_tls      = var.api_origin_certificate_arn != null
    images          = [for image in local.immutable_images : sha256(image)]
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
      condition = var.environment != "staging" || (
        !var.live_integrations_enabled &&
        !var.external_notifications_enabled &&
        !var.enable_nat_gateway &&
        var.notification_driver == "disabled"
      )
      error_message = "Staging is fail-closed: live integrations, external notifications, and NAT must be disabled and notification_driver must be disabled."
    }

    precondition {
      condition     = !var.live_integrations_enabled || var.environment == "production"
      error_message = "Live integrations may only be enabled in production."
    }

    precondition {
      condition = !var.live_integrations_enabled || (
        var.enable_nat_gateway &&
        length(var.approved_adapter_egress_cidrs) > 0
      )
      error_message = "Live integrations require a NAT gateway and at least one explicitly approved, scoped adapter egress CIDR."
    }

    precondition {
      condition     = var.live_integrations_enabled || length(var.approved_adapter_egress_cidrs) == 0
      error_message = "Adapter egress CIDRs may only be configured when live integrations are explicitly enabled."
    }

    precondition {
      condition     = !var.external_notifications_enabled
      error_message = "External notifications are not activatable from this scaffold; enablement requires a separate authority-reviewed code change."
    }

    precondition {
      condition = (
        (var.environment == "demo" && var.notification_driver == "demo_log") ||
        (var.environment != "demo" && var.notification_driver == "disabled")
      )
      error_message = "Demo must use demo_log; every non-demo deployment must use the disabled notification driver."
    }

    precondition {
      condition = alltrue([
        for image in local.immutable_images :
        can(regex(local.same_account_ecr_digest_pattern, image))
      ])
      error_message = "Every image must be a lowercase SHA-256 digest in ECR in the current AWS account and ap-south-1."
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

  name                          = local.name
  vpc_cidr                      = var.vpc_cidr
  enable_nat_gateway            = var.enable_nat_gateway
  approved_adapter_egress_cidrs = var.approved_adapter_egress_cidrs
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
  api_security_group_id          = module.network.api_security_group_id
  worker_security_group_id       = module.network.worker_security_group_id
  tile_security_group_id         = module.network.tile_security_group_id
  api_image                      = var.api_image
  worker_image                   = var.worker_image
  tile_image                     = var.tile_image
  api_origin_certificate_arn     = var.api_origin_certificate_arn
  api_desired_count              = var.api_desired_count
  worker_desired_count           = var.worker_desired_count
  runtime_config_ready           = var.runtime_config_ready
  live_integrations_enabled      = var.live_integrations_enabled
  application_secret_arn         = module.data.application_secret_arn
  database_host                  = module.data.database_host
  jobs_queue_url                 = module.data.jobs_queue_url
  jobs_queue_arn                 = module.data.jobs_queue_arn
  raw_bucket_arn                 = module.data.raw_bucket_arn
  processed_bucket_arn           = module.data.processed_bucket_arn
  audit_bucket_arn               = module.data.audit_bucket_arn
  kms_key_arn                    = module.data.kms_key_arn
  user_pool_id                   = module.identity.user_pool_id
  notification_driver            = var.notification_driver
  external_notifications_enabled = var.external_notifications_enabled
  origin_verify_header_value     = random_password.origin_verify.result
}

module "edge" {
  source = "./modules/edge"

  providers = {
    aws      = aws
    aws.edge = aws.edge
  }

  name                       = local.name
  environment                = var.environment
  api_origin_dns             = module.compute.load_balancer_dns_name
  origin_verify_header_value = random_password.origin_verify.result
  api_origin_https           = var.api_origin_certificate_arn != null
  enable_waf_logs            = var.enable_waf_logging
}
