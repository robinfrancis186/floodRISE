data "aws_region" "current" {}

locals {
  common_environment = [
    { name = "FLOODRISE_ENV", value = var.environment },
    { name = "FLOODRISE_DEMO_MODE", value = tostring(var.environment == "demo") },
    { name = "FLOODRISE_IS_SIMULATED", value = tostring(var.environment == "demo") },
    { name = "FLOODRISE_LIVE_INTEGRATIONS_ENABLED", value = tostring(var.live_integrations_enabled) },
    { name = "FLOODRISE_DEMO_ALERT_SINK", value = var.environment == "demo" ? "fake://notification-sink" : "disabled://requires-reviewed-provider" },
    { name = "FLOODRISE_EXTERNAL_NOTIFICATIONS_ENABLED", value = tostring(var.external_notifications_enabled) },
    { name = "FLOODRISE_NOTIFICATION_DRIVER", value = var.notification_driver },
    { name = "FLOODRISE_DATABASE_HOST", value = var.database_host },
    { name = "FLOODRISE_JOBS_QUEUE_URL", value = var.jobs_queue_url },
    { name = "FLOODRISE_JOBS_QUEUE_NAME", value = "${var.name}-jobs" },
    { name = "FLOODRISE_TILE_API_BASE_URL", value = "http://tile-api:8790" },
    { name = "FLOODRISE_COG_BUCKET_ARN", value = var.processed_bucket_arn },
    { name = "FLOODRISE_COG_PUBLIC_ACCESS", value = "false" },
    { name = "FLOODRISE_COG_ALLOWED_SCHEMES", value = "s3" },
    { name = "FLOODRISE_COG_ALLOWED_BUCKETS", value = trimprefix(var.processed_bucket_arn, "arn:aws:s3:::") },
    { name = "FLOODRISE_COG_ALLOWED_HOSTS", value = "" },
    { name = "FLOODRISE_COG_SIGNED_URLS", value = "false" },
    { name = "FLOODRISE_AWS_REGION", value = data.aws_region.current.region },
    { name = "FLOODRISE_COG_TTL_SECONDS", value = "300" },
    { name = "FLOODRISE_USER_POOL_ID", value = var.user_pool_id }
  ]
  task_services = toset(["api", "worker", "tile-api"])
}

resource "aws_ecs_cluster" "this" {
  name = var.name

  setting {
    name  = "containerInsights"
    value = "enabled"
  }
}

resource "aws_cloudwatch_log_group" "application" {
  name              = "/floodrise/${var.environment}/application"
  retention_in_days = var.environment == "production" ? 365 : 30
}

resource "aws_iam_role" "execution" {
  name = "${var.name}-ecs-execution"
  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "ecs-tasks.amazonaws.com" }
      Action    = "sts:AssumeRole"
    }]
  })
}

resource "aws_iam_role_policy_attachment" "execution" {
  role       = aws_iam_role.execution.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy"
}

resource "aws_iam_role_policy" "execution_application_secret" {
  name = "runtime-application-secret"
  role = aws_iam_role.execution.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect   = "Allow"
        Action   = ["secretsmanager:GetSecretValue"]
        Resource = [var.application_secret_arn]
      },
      {
        Effect   = "Allow"
        Action   = ["kms:Decrypt"]
        Resource = [var.kms_key_arn]
      }
    ]
  })
}

resource "aws_iam_role" "task" {
  for_each = local.task_services

  name = "${var.name}-${each.key}-task"
  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "ecs-tasks.amazonaws.com" }
      Action    = "sts:AssumeRole"
    }]
  })
}

resource "aws_iam_role_policy" "api_task" {
  name = "api-data-plane"
  role = aws_iam_role.task["api"].id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid      = "EvidenceObjects"
        Effect   = "Allow"
        Action   = ["s3:GetObject", "s3:PutObject", "s3:AbortMultipartUpload"]
        Resource = ["${var.raw_bucket_arn}/quarantine/*", "${var.raw_bucket_arn}/raw/*"]
      },
      {
        Sid      = "ReadPublishedArtifacts"
        Effect   = "Allow"
        Action   = ["s3:GetObject"]
        Resource = ["${var.processed_bucket_arn}/*"]
      },
      {
        Sid      = "AppendAuditExports"
        Effect   = "Allow"
        Action   = ["s3:PutObject"]
        Resource = ["${var.audit_bucket_arn}/*"]
      },
      {
        Sid      = "ListScopedBuckets"
        Effect   = "Allow"
        Action   = ["s3:ListBucket"]
        Resource = [var.raw_bucket_arn, var.processed_bucket_arn, var.audit_bucket_arn]
      },
      {
        Sid      = "SubmitJobs"
        Effect   = "Allow"
        Action   = ["sqs:SendMessage", "sqs:GetQueueAttributes"]
        Resource = [var.jobs_queue_arn]
      },
      {
        Sid      = "UseDataKey"
        Effect   = "Allow"
        Action   = ["kms:Decrypt", "kms:Encrypt", "kms:GenerateDataKey"]
        Resource = [var.kms_key_arn]
      }
    ]
  })
}

resource "aws_iam_role_policy" "worker_task" {
  name = "worker-data-plane"
  role = aws_iam_role.task["worker"].id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid      = "ReadEvidenceObjects"
        Effect   = "Allow"
        Action   = ["s3:GetObject"]
        Resource = ["${var.raw_bucket_arn}/quarantine/*", "${var.raw_bucket_arn}/raw/*"]
      },
      {
        Sid      = "PublishArtifacts"
        Effect   = "Allow"
        Action   = ["s3:GetObject", "s3:PutObject", "s3:AbortMultipartUpload"]
        Resource = ["${var.processed_bucket_arn}/*"]
      },
      {
        Sid      = "AppendAuditExports"
        Effect   = "Allow"
        Action   = ["s3:PutObject"]
        Resource = ["${var.audit_bucket_arn}/*"]
      },
      {
        Sid      = "ListScopedBuckets"
        Effect   = "Allow"
        Action   = ["s3:ListBucket"]
        Resource = [var.raw_bucket_arn, var.processed_bucket_arn, var.audit_bucket_arn]
      },
      {
        Sid      = "ConsumeJobs"
        Effect   = "Allow"
        Action   = ["sqs:ReceiveMessage", "sqs:DeleteMessage", "sqs:ChangeMessageVisibility", "sqs:GetQueueAttributes"]
        Resource = [var.jobs_queue_arn]
      },
      {
        Sid      = "UseDataKey"
        Effect   = "Allow"
        Action   = ["kms:Decrypt", "kms:Encrypt", "kms:GenerateDataKey"]
        Resource = [var.kms_key_arn]
      }
    ]
  })
}

resource "aws_iam_role_policy" "tile_task" {
  name = "tile-read-only"
  role = aws_iam_role.task["tile-api"].id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid      = "ReadPublishedArtifacts"
        Effect   = "Allow"
        Action   = ["s3:GetObject"]
        Resource = ["${var.processed_bucket_arn}/*"]
      },
      {
        Sid      = "ListPublishedArtifacts"
        Effect   = "Allow"
        Action   = ["s3:ListBucket"]
        Resource = [var.processed_bucket_arn]
      },
      {
        Sid      = "DecryptPublishedArtifacts"
        Effect   = "Allow"
        Action   = ["kms:Decrypt"]
        Resource = [var.kms_key_arn]
      }
    ]
  })
}

resource "aws_lb" "api" {
  name               = substr("${var.name}-api", 0, 32)
  internal           = false
  load_balancer_type = "application"
  security_groups    = [var.alb_security_group_id]
  subnets            = var.alb_subnet_ids
}

resource "aws_lb_target_group" "api" {
  name        = substr("${var.name}-api", 0, 32)
  port        = 8787
  protocol    = "HTTP"
  target_type = "ip"
  vpc_id      = var.vpc_id

  health_check {
    path                = "/health"
    healthy_threshold   = 2
    unhealthy_threshold = 3
    interval            = 15
    timeout             = 5
    matcher             = "200"
  }
}

resource "aws_lb_listener" "api" {
  load_balancer_arn = aws_lb.api.arn
  port              = var.api_origin_certificate_arn == null ? 80 : 443
  protocol          = var.api_origin_certificate_arn == null ? "HTTP" : "HTTPS"
  certificate_arn   = var.api_origin_certificate_arn
  ssl_policy        = var.api_origin_certificate_arn == null ? null : "ELBSecurityPolicy-TLS13-1-2-2021-06"

  default_action {
    type = "fixed-response"

    fixed_response {
      content_type = "application/json"
      message_body = "{\"detail\":\"origin access denied\"}"
      status_code  = "403"
    }
  }
}

resource "aws_lb_listener_rule" "cloudfront_origin" {
  listener_arn = aws_lb_listener.api.arn
  priority     = 1

  action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.api.arn
  }

  condition {
    http_header {
      http_header_name = "X-FloodRISE-Origin-Verify"
      values           = [var.origin_verify_header_value]
    }
  }
}

resource "aws_service_discovery_private_dns_namespace" "this" {
  name = "${var.environment}.floodrise.internal"
  vpc  = var.vpc_id
}

resource "aws_service_discovery_service" "tile_api" {
  name = "tile-api"
  dns_config {
    namespace_id = aws_service_discovery_private_dns_namespace.this.id
    dns_records {
      ttl  = 10
      type = "A"
    }
    routing_policy = "MULTIVALUE"
  }
  health_check_custom_config {}
}

resource "aws_ecs_task_definition" "api" {
  family                   = "${var.name}-api"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = 1024
  memory                   = 2048
  execution_role_arn       = aws_iam_role.execution.arn
  task_role_arn            = aws_iam_role.task["api"].arn

  container_definitions = jsonencode([{
    name        = "api"
    image       = var.api_image
    essential   = true
    environment = local.common_environment
    secrets = [
      { name = "FLOODRISE_APPLICATION_CONFIG_JSON", valueFrom = var.application_secret_arn }
    ]
    portMappings = [{ containerPort = 8787, hostPort = 8787, protocol = "tcp" }]
    healthCheck = {
      command     = ["CMD-SHELL", "python -c 'import urllib.request; urllib.request.urlopen(\"http://127.0.0.1:8787/health\", timeout=2)' || exit 1"]
      interval    = 15
      timeout     = 5
      retries     = 3
      startPeriod = 30
    }
    logConfiguration = {
      logDriver = "awslogs"
      options = {
        awslogs-group         = aws_cloudwatch_log_group.application.name
        awslogs-region        = data.aws_region.current.region
        awslogs-stream-prefix = "api"
      }
    }
  }])
}

resource "aws_ecs_task_definition" "worker" {
  family                   = "${var.name}-worker"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = 2048
  memory                   = 4096
  execution_role_arn       = aws_iam_role.execution.arn
  task_role_arn            = aws_iam_role.task["worker"].arn

  container_definitions = jsonencode([{
    name        = "worker"
    image       = var.worker_image
    essential   = true
    command     = ["celery", "-A", "app.worker:celery_app", "worker", "--loglevel=INFO"]
    environment = local.common_environment
    secrets = [
      { name = "FLOODRISE_APPLICATION_CONFIG_JSON", valueFrom = var.application_secret_arn }
    ]
    logConfiguration = {
      logDriver = "awslogs"
      options = {
        awslogs-group         = aws_cloudwatch_log_group.application.name
        awslogs-region        = data.aws_region.current.region
        awslogs-stream-prefix = "worker"
      }
    }
  }])
}

resource "aws_ecs_task_definition" "tile_api" {
  family                   = "${var.name}-tile-api"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = 512
  memory                   = 1024
  execution_role_arn       = aws_iam_role.execution.arn
  task_role_arn            = aws_iam_role.task["tile-api"].arn

  container_definitions = jsonencode([{
    name      = "tile-api"
    image     = var.tile_image
    essential = true
    environment = [
      { name = "FLOODRISE_ENV", value = var.environment },
      { name = "FLOODRISE_ALLOWED_BUCKET", value = trimprefix(var.processed_bucket_arn, "arn:aws:s3:::") },
      { name = "FLOODRISE_ACCEPT_ARBITRARY_URLS", value = "false" }
    ]
    portMappings = [{ containerPort = 8790, hostPort = 8790, protocol = "tcp" }]
    logConfiguration = {
      logDriver = "awslogs"
      options = {
        awslogs-group         = aws_cloudwatch_log_group.application.name
        awslogs-region        = data.aws_region.current.region
        awslogs-stream-prefix = "tile-api"
      }
    }
  }])
}

resource "aws_ecs_service" "api" {
  name                               = "${var.name}-api"
  cluster                            = aws_ecs_cluster.this.id
  task_definition                    = aws_ecs_task_definition.api.arn
  desired_count                      = var.runtime_config_ready ? var.api_desired_count : 0
  launch_type                        = "FARGATE"
  deployment_minimum_healthy_percent = 100
  deployment_maximum_percent         = 200
  enable_execute_command             = false

  network_configuration {
    subnets          = var.private_subnet_ids
    security_groups  = [var.api_security_group_id]
    assign_public_ip = false
  }

  load_balancer {
    target_group_arn = aws_lb_target_group.api.arn
    container_name   = "api"
    container_port   = 8787
  }

  depends_on = [aws_lb_listener_rule.cloudfront_origin]
}

resource "aws_ecs_service" "worker" {
  name                   = "${var.name}-worker"
  cluster                = aws_ecs_cluster.this.id
  task_definition        = aws_ecs_task_definition.worker.arn
  desired_count          = var.runtime_config_ready ? var.worker_desired_count : 0
  launch_type            = "FARGATE"
  enable_execute_command = false

  network_configuration {
    subnets          = var.private_subnet_ids
    security_groups  = [var.worker_security_group_id]
    assign_public_ip = false
  }
}

resource "aws_ecs_service" "tile_api" {
  name                   = "${var.name}-tile-api"
  cluster                = aws_ecs_cluster.this.id
  task_definition        = aws_ecs_task_definition.tile_api.arn
  desired_count          = var.runtime_config_ready ? 1 : 0
  launch_type            = "FARGATE"
  enable_execute_command = false

  network_configuration {
    subnets          = var.private_subnet_ids
    security_groups  = [var.tile_security_group_id]
    assign_public_ip = false
  }

  service_registries {
    registry_arn = aws_service_discovery_service.tile_api.arn
  }
}
