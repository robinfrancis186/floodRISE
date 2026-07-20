output "user_pool_id" { value = aws_cognito_user_pool.staff.id }
output "client_id" { value = aws_cognito_user_pool_client.staff_web.id }
output "issuer" { value = "https://cognito-idp.${data.aws_region.current.region}.amazonaws.com/${aws_cognito_user_pool.staff.id}" }
output "hosted_ui_domain" { value = "https://${aws_cognito_user_pool_domain.staff.domain}.auth.${data.aws_region.current.region}.amazoncognito.com" }
