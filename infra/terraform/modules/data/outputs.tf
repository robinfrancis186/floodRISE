output "kms_key_arn" { value = aws_kms_key.primary.arn }
output "raw_bucket_arn" { value = aws_s3_bucket.raw.arn }
output "processed_bucket_arn" { value = aws_s3_bucket.processed.arn }
output "audit_bucket_arn" { value = aws_s3_bucket.audit.arn }
output "jobs_queue_url" { value = aws_sqs_queue.jobs.url }
output "jobs_queue_arn" { value = aws_sqs_queue.jobs.arn }
output "database_host" { value = aws_db_instance.postgres.address }
output "database_bootstrap_secret_arn" {
  description = "Database-owner bootstrap credential. It is intentionally not passed to any runtime task."
  value       = aws_db_instance.postgres.master_user_secret[0].secret_arn
  sensitive   = true
}
output "application_secret_arn" { value = aws_secretsmanager_secret.application.arn }
