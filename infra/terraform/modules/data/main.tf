data "aws_caller_identity" "current" {}

locals {
  bucket_prefix        = "${var.name}-${data.aws_caller_identity.current.account_id}"
  audit_retention_days = var.environment == "production" ? 2555 : 30
}

resource "aws_kms_key" "primary" {
  description             = "floodRISE ${var.environment} data encryption"
  deletion_window_in_days = var.environment == "production" ? 30 : 7
  enable_key_rotation     = true
  tags                    = { Name = "${var.name}-data" }
}

resource "aws_kms_alias" "primary" {
  name          = "alias/${var.name}-data"
  target_key_id = aws_kms_key.primary.key_id
}

resource "aws_s3_bucket" "raw" {
  bucket        = "${local.bucket_prefix}-raw"
  force_destroy = !var.deletion_protection
}

resource "aws_s3_bucket" "processed" {
  bucket        = "${local.bucket_prefix}-processed"
  force_destroy = !var.deletion_protection
}

resource "aws_s3_bucket" "audit" {
  bucket              = "${local.bucket_prefix}-audit"
  force_destroy       = !var.deletion_protection
  object_lock_enabled = true
}

resource "aws_s3_bucket_public_access_block" "private" {
  for_each = {
    raw       = aws_s3_bucket.raw.id
    processed = aws_s3_bucket.processed.id
    audit     = aws_s3_bucket.audit.id
  }

  bucket                  = each.value
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_versioning" "versioned" {
  for_each = {
    raw       = aws_s3_bucket.raw.id
    processed = aws_s3_bucket.processed.id
    audit     = aws_s3_bucket.audit.id
  }

  bucket = each.value
  versioning_configuration { status = "Enabled" }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "encrypted" {
  for_each = {
    raw       = aws_s3_bucket.raw.id
    processed = aws_s3_bucket.processed.id
    audit     = aws_s3_bucket.audit.id
  }

  bucket = each.value
  rule {
    apply_server_side_encryption_by_default {
      kms_master_key_id = aws_kms_key.primary.arn
      sse_algorithm     = "aws:kms"
    }
    bucket_key_enabled = true
  }
}

resource "aws_s3_bucket_lifecycle_configuration" "raw" {
  bucket = aws_s3_bucket.raw.id

  rule {
    id     = "expire-non-escalated-demo-artifacts"
    status = "Enabled"
    filter {}

    noncurrent_version_expiration {
      noncurrent_days = var.environment == "production" ? 30 : 7
    }
  }
}

resource "aws_s3_bucket_object_lock_configuration" "audit" {
  bucket = aws_s3_bucket.audit.id

  rule {
    default_retention {
      mode = "GOVERNANCE"
      days = local.audit_retention_days
    }
  }
}

resource "aws_sqs_queue" "jobs_dlq" {
  name                      = "${var.name}-jobs-dlq"
  message_retention_seconds = 1209600
  kms_master_key_id         = aws_kms_key.primary.arn
}

resource "aws_sqs_queue" "jobs" {
  name                       = "${var.name}-jobs"
  visibility_timeout_seconds = 120
  message_retention_seconds  = 345600
  receive_wait_time_seconds  = 20
  kms_master_key_id          = aws_kms_key.primary.arn
  redrive_policy = jsonencode({
    deadLetterTargetArn = aws_sqs_queue.jobs_dlq.arn
    maxReceiveCount     = 3
  })
}

resource "aws_db_subnet_group" "this" {
  name       = "${var.name}-database"
  subnet_ids = var.private_subnet_ids
}

resource "aws_iam_role" "rds_monitoring" {
  name = "${var.name}-rds-monitoring"
  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "monitoring.rds.amazonaws.com" }
      Action    = "sts:AssumeRole"
    }]
  })
}

resource "aws_iam_role_policy_attachment" "rds_monitoring" {
  role       = aws_iam_role.rds_monitoring.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AmazonRDSEnhancedMonitoringRole"
}

resource "aws_db_instance" "postgres" {
  identifier = "${var.name}-postgres"

  engine                        = "postgres"
  engine_version                = "16"
  instance_class                = var.db_instance_class
  allocated_storage             = 100
  max_allocated_storage         = 500
  storage_type                  = "gp3"
  storage_encrypted             = true
  kms_key_id                    = aws_kms_key.primary.arn
  db_name                       = "floodrise"
  username                      = "floodrise_admin"
  manage_master_user_password   = true
  master_user_secret_kms_key_id = aws_kms_key.primary.arn
  port                          = 5432
  db_subnet_group_name          = aws_db_subnet_group.this.name
  vpc_security_group_ids        = [var.data_security_group_id]
  publicly_accessible           = false
  multi_az                      = var.multi_az
  backup_retention_period       = var.backup_retention_days
  backup_window                 = "18:00-18:30"
  maintenance_window            = "sun:19:00-sun:20:00"
  auto_minor_version_upgrade    = true
  deletion_protection           = var.deletion_protection
  skip_final_snapshot           = !var.deletion_protection
  final_snapshot_identifier     = var.deletion_protection ? "${var.name}-postgres-final" : null
  performance_insights_enabled  = true
  monitoring_interval           = 60
  monitoring_role_arn           = aws_iam_role.rds_monitoring.arn
  copy_tags_to_snapshot         = true

}

resource "aws_elasticache_subnet_group" "this" {
  name       = "${var.name}-redis"
  subnet_ids = var.private_subnet_ids
}

resource "aws_elasticache_replication_group" "redis" {
  replication_group_id       = "${var.name}-redis"
  description                = "floodRISE cache and SSE fanout only"
  engine                     = "redis"
  engine_version             = "7.1"
  node_type                  = var.redis_node_type
  port                       = 6379
  parameter_group_name       = "default.redis7"
  num_cache_clusters         = var.multi_az ? 2 : 1
  automatic_failover_enabled = var.multi_az
  multi_az_enabled           = var.multi_az
  at_rest_encryption_enabled = true
  transit_encryption_enabled = true
  subnet_group_name          = aws_elasticache_subnet_group.this.name
  security_group_ids         = [var.data_security_group_id]
  snapshot_retention_limit   = var.backup_retention_days
  apply_immediately          = var.environment != "production"
}

# Terraform creates only the secret envelope. Operators populate a structured
# value through the approved secret-management process; no credential is stored
# in source control or a tfvars file.
resource "aws_secretsmanager_secret" "application" {
  name                    = "${var.name}/application"
  description             = "Runtime application configuration; value managed out-of-band"
  kms_key_id              = aws_kms_key.primary.arn
  recovery_window_in_days = var.environment == "production" ? 30 : 7
}

resource "aws_iam_role" "backup" {
  name = "${var.name}-backup"
  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "backup.amazonaws.com" }
      Action    = "sts:AssumeRole"
    }]
  })
}

resource "aws_iam_role_policy_attachment" "backup" {
  role       = aws_iam_role.backup.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSBackupServiceRolePolicyForBackup"
}

resource "aws_backup_vault" "primary" {
  name        = "${var.name}-primary"
  kms_key_arn = aws_kms_key.primary.arn
}

resource "aws_kms_key" "backup" {
  provider = aws.backup
  count    = var.cross_region_backup_enabled ? 1 : 0

  description             = "floodRISE cross-region recovery points"
  deletion_window_in_days = 30
  enable_key_rotation     = true
}

resource "aws_backup_vault" "secondary" {
  provider = aws.backup
  count    = var.cross_region_backup_enabled ? 1 : 0

  name        = "${var.name}-secondary"
  kms_key_arn = aws_kms_key.backup[0].arn
}

resource "aws_backup_plan" "database" {
  name = "${var.name}-database"

  rule {
    rule_name                = "continuous-pitr-and-daily-recovery-point"
    target_vault_name        = aws_backup_vault.primary.name
    schedule                 = "cron(0 18 * * ? *)"
    start_window             = 60
    completion_window        = 180
    enable_continuous_backup = true

    lifecycle {
      delete_after = var.backup_retention_days
    }

    dynamic "copy_action" {
      for_each = var.cross_region_backup_enabled ? [aws_backup_vault.secondary[0].arn] : []
      content {
        destination_vault_arn = copy_action.value
        lifecycle {
          delete_after = var.backup_retention_days
        }
      }
    }
  }
}

resource "aws_backup_selection" "database" {
  name         = "${var.name}-database"
  iam_role_arn = aws_iam_role.backup.arn
  plan_id      = aws_backup_plan.database.id
  resources    = [aws_db_instance.postgres.arn]
}
