# Serverless infrastructure for Riftfound
# This file defines DynamoDB, Lambda, and API Gateway resources
# for the EC2-less architecture

# ============================================
# DynamoDB Table
# ============================================

resource "aws_dynamodb_table" "riftfound" {
  count        = var.use_dynamodb ? 1 : 0
  name         = "riftfound-${var.environment}"
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "PK"
  range_key    = "SK"

  attribute {
    name = "PK"
    type = "S"
  }

  attribute {
    name = "SK"
    type = "S"
  }

  attribute {
    name = "GSI1PK"
    type = "S"
  }

  attribute {
    name = "GSI1SK"
    type = "S"
  }

  attribute {
    name = "GSI2PK"
    type = "S"
  }

  attribute {
    name = "GSI2SK"
    type = "S"
  }

  attribute {
    name = "GSI3PK"
    type = "S"
  }

  attribute {
    name = "GSI3SK"
    type = "S"
  }

  attribute {
    name = "geohash4"
    type = "S"
  }

  global_secondary_index {
    name            = "GSI1"
    hash_key        = "GSI1PK"
    range_key       = "GSI1SK"
    projection_type = "ALL"
  }

  # GSI2: Shop-based event queries (SHOP#<id> -> events by date)
  global_secondary_index {
    name            = "GSI2"
    hash_key        = "GSI2PK"
    range_key       = "GSI2SK"
    projection_type = "ALL"
  }

  # GSI3: Geocache LRU eviction (GEOCACHE_LRU -> sorted by lastAccessedAt)
  global_secondary_index {
    name            = "GSI3"
    hash_key        = "GSI3PK"
    range_key       = "GSI3SK"
    projection_type = "KEYS_ONLY"
  }

  # GeohashIndex: Spatial queries for shops by geohash4
  global_secondary_index {
    name            = "GeohashIndex"
    hash_key        = "geohash4"
    projection_type = "ALL"
  }

  ttl {
    attribute_name = "ttl"
    enabled        = true
  }

  point_in_time_recovery {
    enabled = true
  }

  tags = {
    Name        = "riftfound-table"
    Environment = var.environment
  }
}

# ============================================
# IAM Role for Lambda Functions
# ============================================

resource "aws_iam_role" "lambda_role" {
  count = var.use_dynamodb ? 1 : 0
  name  = "riftfound-lambda-role-${var.environment}"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Action = "sts:AssumeRole"
      Effect = "Allow"
      Principal = {
        Service = "lambda.amazonaws.com"
      }
    }]
  })

  tags = {
    Name        = "riftfound-lambda-role"
    Environment = var.environment
  }
}

resource "aws_iam_role_policy" "lambda_dynamodb" {
  count = var.use_dynamodb ? 1 : 0
  name  = "dynamodb-access"
  role  = aws_iam_role.lambda_role[0].id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect = "Allow"
        Action = [
          "dynamodb:GetItem",
          "dynamodb:PutItem",
          "dynamodb:UpdateItem",
          "dynamodb:DeleteItem",
          "dynamodb:Query",
          "dynamodb:Scan",
          "dynamodb:BatchWriteItem",
          "dynamodb:BatchGetItem"
        ]
        Resource = [
          aws_dynamodb_table.riftfound[0].arn,
          "${aws_dynamodb_table.riftfound[0].arn}/index/*"
        ]
      }
    ]
  })
}

resource "aws_iam_role_policy_attachment" "lambda_basic" {
  count      = var.use_dynamodb ? 1 : 0
  role       = aws_iam_role.lambda_role[0].name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"
}

# ============================================
# Lambda Function - API
# ============================================

resource "aws_lambda_function" "api" {
  count         = var.use_dynamodb ? 1 : 0
  function_name = "riftfound-api-${var.environment}"
  role          = aws_iam_role.lambda_role[0].arn
  handler       = "lambda.handler"
  runtime       = "nodejs20.x"
  timeout       = 30
  memory_size   = 512

  # Placeholder - actual code deployed separately
  filename         = "${path.module}/placeholder.zip"
  source_code_hash = filebase64sha256("${path.module}/placeholder.zip")

  environment {
    variables = {
      NODE_ENV             = "production"
      DB_TYPE              = "dynamodb"
      DYNAMODB_TABLE_NAME  = aws_dynamodb_table.riftfound[0].name
      PHOTON_ENABLED       = "false"  # No Photon in Lambda, use Google Maps
      GOOGLE_MAPS_API_KEY  = var.google_maps_api_key
      AWS_NODEJS_CONNECTION_REUSE_ENABLED = "1"
    }
  }

  tags = {
    Name        = "riftfound-api"
    Environment = var.environment
  }

  lifecycle {
    ignore_changes = [filename, source_code_hash]
  }
}

# Lambda Function URL (alternative to API Gateway)
resource "aws_lambda_function_url" "api" {
  count              = var.use_dynamodb ? 1 : 0
  function_name      = aws_lambda_function.api[0].function_name
  authorization_type = "NONE"

  cors {
    allow_origins     = ["*"]
    allow_methods     = ["*"]  # Use wildcard to avoid length constraints
    allow_headers     = ["*"]
    expose_headers    = ["*"]
    max_age           = 3600
  }
}

# ============================================
# Lambda Function - Scraper
# ============================================

resource "aws_lambda_function" "scraper" {
  count         = var.use_dynamodb ? 1 : 0
  function_name = "riftfound-scraper-${var.environment}"
  role          = aws_iam_role.lambda_role[0].arn
  handler       = "lambda.handler"
  runtime       = "nodejs20.x"
  timeout       = 900  # 15 minutes max
  memory_size   = 1024

  # Placeholder - actual code deployed separately
  filename         = "${path.module}/placeholder.zip"
  source_code_hash = filebase64sha256("${path.module}/placeholder.zip")

  environment {
    variables = {
      NODE_ENV             = "production"
      DB_TYPE              = "dynamodb"
      DYNAMODB_TABLE_NAME  = aws_dynamodb_table.riftfound[0].name
      PHOTON_ENABLED       = "false"  # No Photon in Lambda, use Google Maps
      GOOGLE_MAPS_API_KEY  = var.google_maps_api_key
      AWS_NODEJS_CONNECTION_REUSE_ENABLED = "1"
    }
  }

  tags = {
    Name        = "riftfound-scraper"
    Environment = var.environment
  }

  lifecycle {
    ignore_changes = [filename, source_code_hash]
  }
}

# ============================================
# EventBridge Rule for Scheduled Scraping
# ============================================

resource "aws_cloudwatch_event_rule" "scraper_schedule" {
  count               = var.use_dynamodb ? 1 : 0
  name                = "riftfound-scraper-schedule-${var.environment}"
  description         = "Trigger Riftfound scraper every hour"
  schedule_expression = "rate(60 minutes)"

  tags = {
    Name        = "riftfound-scraper-schedule"
    Environment = var.environment
  }
}

resource "aws_cloudwatch_event_target" "scraper_lambda" {
  count     = var.use_dynamodb ? 1 : 0
  rule      = aws_cloudwatch_event_rule.scraper_schedule[0].name
  target_id = "scraper-lambda"
  arn       = aws_lambda_function.scraper[0].arn
}

resource "aws_lambda_permission" "scraper_eventbridge" {
  count         = var.use_dynamodb ? 1 : 0
  statement_id  = "AllowEventBridgeInvoke"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.scraper[0].function_name
  principal     = "events.amazonaws.com"
  source_arn    = aws_cloudwatch_event_rule.scraper_schedule[0].arn
}

# ============================================
# API Gateway v2 (HTTP API)
# ============================================

resource "aws_apigatewayv2_api" "main" {
  count         = var.use_dynamodb ? 1 : 0
  name          = "riftfound-api-${var.environment}"
  protocol_type = "HTTP"

  cors_configuration {
    allow_origins     = ["*"]
    allow_methods     = ["GET", "POST", "PUT", "DELETE", "OPTIONS"]
    allow_headers     = ["*"]
    expose_headers    = ["*"]
    max_age           = 3600
  }

  tags = {
    Name        = "riftfound-api-gateway"
    Environment = var.environment
  }
}

resource "aws_apigatewayv2_stage" "default" {
  count       = var.use_dynamodb ? 1 : 0
  api_id      = aws_apigatewayv2_api.main[0].id
  name        = "$default"
  auto_deploy = true

  access_log_settings {
    destination_arn = aws_cloudwatch_log_group.api_gateway[0].arn
    format = jsonencode({
      requestId               = "$context.requestId"
      sourceIp               = "$context.identity.sourceIp"
      requestTime            = "$context.requestTime"
      protocol               = "$context.protocol"
      httpMethod             = "$context.httpMethod"
      resourcePath           = "$context.resourcePath"
      routeKey               = "$context.routeKey"
      status                 = "$context.status"
      responseLength         = "$context.responseLength"
      integrationErrorMessage = "$context.integrationErrorMessage"
    })
  }

  tags = {
    Name        = "riftfound-api-stage"
    Environment = var.environment
  }
}

resource "aws_cloudwatch_log_group" "api_gateway" {
  count             = var.use_dynamodb ? 1 : 0
  name              = "/aws/api-gateway/riftfound-${var.environment}"
  retention_in_days = 14

  tags = {
    Name        = "riftfound-api-gateway-logs"
    Environment = var.environment
  }
}

resource "aws_apigatewayv2_integration" "lambda" {
  count                  = var.use_dynamodb ? 1 : 0
  api_id                 = aws_apigatewayv2_api.main[0].id
  integration_type       = "AWS_PROXY"
  integration_uri        = aws_lambda_function.api[0].invoke_arn
  integration_method     = "POST"
  payload_format_version = "2.0"
}

resource "aws_apigatewayv2_route" "api" {
  count     = var.use_dynamodb ? 1 : 0
  api_id    = aws_apigatewayv2_api.main[0].id
  route_key = "ANY /api/{proxy+}"
  target    = "integrations/${aws_apigatewayv2_integration.lambda[0].id}"
}

resource "aws_lambda_permission" "api_gateway" {
  count         = var.use_dynamodb ? 1 : 0
  statement_id  = "AllowAPIGatewayInvoke"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.api[0].function_name
  principal     = "apigateway.amazonaws.com"
  source_arn    = "${aws_apigatewayv2_api.main[0].execution_arn}/*/*"
}

# ============================================
# Outputs
# ============================================

output "dynamodb_table_name" {
  description = "DynamoDB table name"
  value       = var.use_dynamodb ? aws_dynamodb_table.riftfound[0].name : null
}

output "dynamodb_table_arn" {
  description = "DynamoDB table ARN"
  value       = var.use_dynamodb ? aws_dynamodb_table.riftfound[0].arn : null
}

output "api_lambda_function_name" {
  description = "API Lambda function name"
  value       = var.use_dynamodb ? aws_lambda_function.api[0].function_name : null
}

output "api_lambda_function_url" {
  description = "API Lambda function URL"
  value       = var.use_dynamodb ? aws_lambda_function_url.api[0].function_url : null
}

output "scraper_lambda_function_name" {
  description = "Scraper Lambda function name"
  value       = var.use_dynamodb ? aws_lambda_function.scraper[0].function_name : null
}

output "api_gateway_url" {
  description = "API Gateway URL"
  value       = var.use_dynamodb ? aws_apigatewayv2_api.main[0].api_endpoint : null
}
