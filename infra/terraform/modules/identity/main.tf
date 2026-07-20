data "aws_region" "current" {}

locals {
  staff_roles = {
    responder              = 70
    verifier               = 60
    engineer               = 50
    shelter_manager        = 40
    incident_commander     = 30
    auditor                = 20
    identity_administrator = 10
  }
  relying_party_id = "${var.cognito_domain_prefix}.auth.${data.aws_region.current.region}.amazoncognito.com"
}

resource "aws_cognito_user_pool" "staff" {
  name = "${var.name}-staff"

  username_attributes      = ["email"]
  auto_verified_attributes = ["email"]
  mfa_configuration        = "ON"
  deletion_protection      = "ACTIVE"

  sign_in_policy {
    allowed_first_auth_factors = ["PASSWORD", "WEB_AUTHN"]
  }

  software_token_mfa_configuration {
    enabled = true
  }

  web_authn_configuration {
    relying_party_id  = local.relying_party_id
    user_verification = "required"
  }

  password_policy {
    minimum_length                   = 14
    require_lowercase                = true
    require_numbers                  = true
    require_symbols                  = true
    require_uppercase                = true
    temporary_password_validity_days = 1
  }

  account_recovery_setting {
    recovery_mechanism {
      name     = "verified_email"
      priority = 1
    }
  }

  user_attribute_update_settings {
    attributes_require_verification_before_update = ["email"]
  }

  admin_create_user_config {
    allow_admin_create_user_only = true
  }
}

resource "aws_cognito_user_pool_client" "staff_web" {
  name         = "${var.name}-staff-web"
  user_pool_id = aws_cognito_user_pool.staff.id

  generate_secret                      = false
  allowed_oauth_flows_user_pool_client = true
  allowed_oauth_flows                  = ["code"]
  allowed_oauth_scopes                 = ["openid", "email", "profile"]
  callback_urls                        = var.callback_urls
  logout_urls                          = var.logout_urls
  supported_identity_providers         = ["COGNITO"]
  prevent_user_existence_errors        = "ENABLED"
  enable_token_revocation              = true
  auth_session_validity                = 3
  access_token_validity                = 15
  id_token_validity                    = 15
  refresh_token_validity               = 1
  explicit_auth_flows                  = ["ALLOW_USER_SRP_AUTH", "ALLOW_REFRESH_TOKEN_AUTH"]

  token_validity_units {
    access_token  = "minutes"
    id_token      = "minutes"
    refresh_token = "days"
  }
}

resource "aws_cognito_user_pool_domain" "staff" {
  domain       = var.cognito_domain_prefix
  user_pool_id = aws_cognito_user_pool.staff.id
}

resource "aws_cognito_user_group" "role" {
  for_each = local.staff_roles

  name         = each.key
  user_pool_id = aws_cognito_user_pool.staff.id
  precedence   = each.value
  description  = "floodRISE ${replace(each.key, "_", " ")} role"
}
