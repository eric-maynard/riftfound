# Photon outputs
output "photon_public_ip" {
  description = "Public IP address of Photon instance"
  value       = aws_eip.photon.public_ip
}

output "photon_url" {
  description = "URL for Photon geocoder API"
  value       = "http://${aws_eip.photon.public_ip}:2322"
}

output "photon_instance_id" {
  description = "EC2 instance ID (use with SSM Session Manager)"
  value       = aws_instance.photon.id
}

# Backend outputs
output "backend_public_ip" {
  description = "Public IP address of Backend instance"
  value       = aws_eip.backend.public_ip
}

output "backend_url" {
  description = "URL for Backend API"
  value       = "http://${aws_eip.backend.public_ip}:3001"
}

output "backend_instance_id" {
  description = "Backend EC2 instance ID"
  value       = aws_instance.backend.id
}

# Helpful commands
output "test_commands" {
  description = "Commands to test the deployment"
  value = {
    photon  = "curl 'http://${aws_eip.photon.public_ip}:2322/api?q=san+francisco&limit=1'"
    backend = "curl 'http://${aws_eip.backend.public_ip}:3001/api/events'"
  }
}

output "ssm_commands" {
  description = "Commands to connect via SSM (no SSH key needed)"
  value = {
    photon  = "aws ssm start-session --target ${aws_instance.photon.id}"
    backend = "aws ssm start-session --target ${aws_instance.backend.id}"
  }
}

# Frontend outputs
output "cloudfront_url" {
  description = "CloudFront distribution URL"
  value       = "https://${aws_cloudfront_distribution.frontend.domain_name}"
}

output "cloudfront_distribution_id" {
  description = "CloudFront distribution ID (for cache invalidation)"
  value       = aws_cloudfront_distribution.frontend.id
}

output "frontend_bucket" {
  description = "S3 bucket name for frontend files"
  value       = aws_s3_bucket.frontend.id
}

output "frontend_url" {
  description = "Frontend URL (custom domain or CloudFront)"
  value       = var.domain_name != "" ? "https://${var.domain_name}" : "https://${aws_cloudfront_distribution.frontend.domain_name}"
}

# Database outputs
output "database_endpoint" {
  description = "RDS PostgreSQL endpoint"
  value       = aws_db_instance.main.endpoint
}

output "database_name" {
  description = "Database name"
  value       = aws_db_instance.main.db_name
}

output "database_password_ssm" {
  description = "SSM parameter path for database password"
  value       = aws_ssm_parameter.db_password.name
}

# DNS outputs (only if domain configured)
output "nameservers" {
  description = "Route53 nameservers (update your domain registrar with these)"
  value       = var.domain_name != "" ? aws_route53_zone.main[0].name_servers : []
}

# Deployment commands
output "deploy_frontend" {
  description = "Commands to deploy frontend"
  value       = <<-EOT
    # Build and deploy frontend:
    cd frontend && npm run build
    aws s3 sync dist/ s3://${aws_s3_bucket.frontend.id} --delete
    aws cloudfront create-invalidation --distribution-id ${aws_cloudfront_distribution.frontend.id} --paths "/*"
  EOT
}
