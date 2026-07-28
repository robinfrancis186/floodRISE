data "aws_availability_zones" "available" {
  state = "available"
}

data "aws_region" "current" {}

data "aws_ec2_managed_prefix_list" "cloudfront" {
  name = "com.amazonaws.global.cloudfront.origin-facing"
}

locals {
  availability_zones = slice(data.aws_availability_zones.available.names, 0, 2)
  service_security_groups = {
    api    = aws_security_group.api.id
    worker = aws_security_group.worker.id
    tile   = aws_security_group.tile.id
  }
}

resource "aws_vpc" "this" {
  cidr_block           = var.vpc_cidr
  enable_dns_support   = true
  enable_dns_hostnames = true

  tags = { Name = var.name }
}

resource "aws_internet_gateway" "this" {
  vpc_id = aws_vpc.this.id
  tags   = { Name = "${var.name}-igw" }
}

resource "aws_subnet" "public" {
  count = 2

  vpc_id                  = aws_vpc.this.id
  availability_zone       = local.availability_zones[count.index]
  cidr_block              = cidrsubnet(var.vpc_cidr, 4, count.index)
  map_public_ip_on_launch = false
  tags                    = { Name = "${var.name}-public-${count.index + 1}" }
}

resource "aws_subnet" "private" {
  count = 2

  vpc_id            = aws_vpc.this.id
  availability_zone = local.availability_zones[count.index]
  cidr_block        = cidrsubnet(var.vpc_cidr, 4, count.index + 8)
  tags              = { Name = "${var.name}-private-${count.index + 1}" }
}

resource "aws_route_table" "public" {
  vpc_id = aws_vpc.this.id
  tags   = { Name = "${var.name}-public" }
}

resource "aws_route" "public_internet" {
  route_table_id         = aws_route_table.public.id
  destination_cidr_block = "0.0.0.0/0"
  gateway_id             = aws_internet_gateway.this.id
}

resource "aws_route_table_association" "public" {
  count = 2

  subnet_id      = aws_subnet.public[count.index].id
  route_table_id = aws_route_table.public.id
}

resource "aws_eip" "nat" {
  count  = var.enable_nat_gateway ? 1 : 0
  domain = "vpc"
  tags   = { Name = "${var.name}-nat" }
}

resource "aws_nat_gateway" "this" {
  count = var.enable_nat_gateway ? 1 : 0

  allocation_id = aws_eip.nat[0].id
  subnet_id     = aws_subnet.public[0].id
  depends_on    = [aws_internet_gateway.this]
  tags          = { Name = "${var.name}-nat" }
}

resource "aws_route_table" "private" {
  count = 2

  vpc_id = aws_vpc.this.id
  tags   = { Name = "${var.name}-private-${count.index + 1}" }
}

resource "aws_route" "private_egress" {
  count = var.enable_nat_gateway ? 2 : 0

  route_table_id         = aws_route_table.private[count.index].id
  destination_cidr_block = "0.0.0.0/0"
  nat_gateway_id         = aws_nat_gateway.this[0].id
}

resource "aws_route_table_association" "private" {
  count = 2

  subnet_id      = aws_subnet.private[count.index].id
  route_table_id = aws_route_table.private[count.index].id
}

resource "aws_security_group" "alb" {
  name_prefix = "${var.name}-alb-"
  description = "CloudFront-only ingress to the floodRISE API origin"
  vpc_id      = aws_vpc.this.id
  tags        = { Name = "${var.name}-alb" }

  lifecycle { create_before_destroy = true }
}

resource "aws_security_group" "api" {
  name_prefix = "${var.name}-api-"
  description = "API tasks only"
  vpc_id      = aws_vpc.this.id
  tags        = { Name = "${var.name}-api" }

  lifecycle { create_before_destroy = true }
}

resource "aws_security_group" "worker" {
  name_prefix = "${var.name}-worker-"
  description = "Worker tasks only"
  vpc_id      = aws_vpc.this.id
  tags        = { Name = "${var.name}-worker" }

  lifecycle { create_before_destroy = true }
}

resource "aws_security_group" "tile" {
  name_prefix = "${var.name}-tile-"
  description = "Restricted raster tile tasks only"
  vpc_id      = aws_vpc.this.id
  tags        = { Name = "${var.name}-tile" }

  lifecycle { create_before_destroy = true }
}

resource "aws_security_group" "data" {
  name_prefix = "${var.name}-data-"
  description = "PostgreSQL access from API and worker tasks only"
  vpc_id      = aws_vpc.this.id
  tags        = { Name = "${var.name}-data" }

  lifecycle { create_before_destroy = true }
}

resource "aws_security_group" "endpoints" {
  name_prefix = "${var.name}-endpoints-"
  description = "Private AWS service endpoints for scoped application tasks"
  vpc_id      = aws_vpc.this.id
  tags        = { Name = "${var.name}-endpoints" }

  lifecycle { create_before_destroy = true }
}

resource "aws_vpc_security_group_ingress_rule" "alb_cloudfront_http" {
  security_group_id = aws_security_group.alb.id
  prefix_list_id    = data.aws_ec2_managed_prefix_list.cloudfront.id
  from_port         = 80
  to_port           = 80
  ip_protocol       = "tcp"
  description       = "CloudFront origin-facing network for demo HTTP origins"
}

resource "aws_vpc_security_group_ingress_rule" "alb_cloudfront_https" {
  security_group_id = aws_security_group.alb.id
  prefix_list_id    = data.aws_ec2_managed_prefix_list.cloudfront.id
  from_port         = 443
  to_port           = 443
  ip_protocol       = "tcp"
  description       = "CloudFront origin-facing network for TLS origins"
}

resource "aws_vpc_security_group_egress_rule" "alb_to_api" {
  security_group_id            = aws_security_group.alb.id
  referenced_security_group_id = aws_security_group.api.id
  from_port                    = 8787
  to_port                      = 8787
  ip_protocol                  = "tcp"
}

resource "aws_vpc_security_group_ingress_rule" "api_from_alb" {
  security_group_id            = aws_security_group.api.id
  referenced_security_group_id = aws_security_group.alb.id
  from_port                    = 8787
  to_port                      = 8787
  ip_protocol                  = "tcp"
}

resource "aws_vpc_security_group_ingress_rule" "tile_from_api" {
  security_group_id            = aws_security_group.tile.id
  referenced_security_group_id = aws_security_group.api.id
  from_port                    = 8790
  to_port                      = 8790
  ip_protocol                  = "tcp"
  description                  = "API to restricted raster tile tasks"
}

resource "aws_vpc_security_group_egress_rule" "api_to_tile" {
  security_group_id            = aws_security_group.api.id
  referenced_security_group_id = aws_security_group.tile.id
  from_port                    = 8790
  to_port                      = 8790
  ip_protocol                  = "tcp"
}

resource "aws_vpc_security_group_ingress_rule" "data_postgres_from_api" {
  security_group_id            = aws_security_group.data.id
  referenced_security_group_id = aws_security_group.api.id
  from_port                    = 5432
  to_port                      = 5432
  ip_protocol                  = "tcp"
}

resource "aws_vpc_security_group_ingress_rule" "data_postgres_from_worker" {
  security_group_id            = aws_security_group.data.id
  referenced_security_group_id = aws_security_group.worker.id
  from_port                    = 5432
  to_port                      = 5432
  ip_protocol                  = "tcp"
}

resource "aws_vpc_security_group_egress_rule" "api_to_postgres" {
  security_group_id            = aws_security_group.api.id
  referenced_security_group_id = aws_security_group.data.id
  from_port                    = 5432
  to_port                      = 5432
  ip_protocol                  = "tcp"
}

resource "aws_vpc_security_group_egress_rule" "worker_to_postgres" {
  security_group_id            = aws_security_group.worker.id
  referenced_security_group_id = aws_security_group.data.id
  from_port                    = 5432
  to_port                      = 5432
  ip_protocol                  = "tcp"
}

resource "aws_vpc_security_group_ingress_rule" "endpoints_from_service" {
  for_each = local.service_security_groups

  security_group_id            = aws_security_group.endpoints.id
  referenced_security_group_id = each.value
  from_port                    = 443
  to_port                      = 443
  ip_protocol                  = "tcp"
  description                  = "${each.key} task access to private AWS service endpoints"
}

resource "aws_vpc_security_group_egress_rule" "service_to_endpoints" {
  for_each = local.service_security_groups

  security_group_id            = each.value
  referenced_security_group_id = aws_security_group.endpoints.id
  from_port                    = 443
  to_port                      = 443
  ip_protocol                  = "tcp"
  description                  = "${each.key} task PrivateLink access"
}

resource "aws_vpc_endpoint" "interface" {
  for_each = toset([
    "cognito-idp",
    "ecr.api",
    "ecr.dkr",
    "kms",
    "logs",
    "monitoring",
    "secretsmanager",
    "sqs",
    "sts",
  ])

  vpc_id              = aws_vpc.this.id
  service_name        = "com.amazonaws.${data.aws_region.current.region}.${each.value}"
  vpc_endpoint_type   = "Interface"
  subnet_ids          = aws_subnet.private[*].id
  private_dns_enabled = true
  security_group_ids  = [aws_security_group.endpoints.id]

  tags = { Name = "${var.name}-${replace(each.value, ".", "-")}" }
}

resource "aws_vpc_endpoint" "s3" {
  vpc_id            = aws_vpc.this.id
  service_name      = "com.amazonaws.${data.aws_region.current.region}.s3"
  vpc_endpoint_type = "Gateway"
  route_table_ids   = aws_route_table.private[*].id

  tags = { Name = "${var.name}-s3" }
}

resource "aws_vpc_security_group_egress_rule" "service_to_s3" {
  for_each = local.service_security_groups

  security_group_id = each.value
  prefix_list_id    = aws_vpc_endpoint.s3.prefix_list_id
  from_port         = 443
  to_port           = 443
  ip_protocol       = "tcp"
  description       = "${each.key} task access to the private S3 gateway endpoint"
}

resource "aws_vpc_security_group_egress_rule" "worker_to_approved_adapter" {
  for_each = toset(var.approved_adapter_egress_cidrs)

  security_group_id = aws_security_group.worker.id
  cidr_ipv4         = each.value
  from_port         = 443
  to_port           = 443
  ip_protocol       = "tcp"
  description       = "Reviewed source-adapter HTTPS destination"
}
