provider "aws" {
  region = var.aws_region

  default_tags {
    tags = local.common_tags
  }
}

provider "aws" {
  alias  = "backup"
  region = var.backup_region

  default_tags {
    tags = local.common_tags
  }
}

# CloudFront-scoped WAF resources must be created in us-east-1.
provider "aws" {
  alias  = "edge"
  region = "us-east-1"

  default_tags {
    tags = local.common_tags
  }
}
