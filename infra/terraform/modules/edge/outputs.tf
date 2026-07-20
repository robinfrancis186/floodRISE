output "cloudfront_domain_name" { value = aws_cloudfront_distribution.this.domain_name }
output "static_bucket_name" { value = aws_s3_bucket.static.id }
output "web_acl_arn" { value = aws_wafv2_web_acl.edge.arn }
