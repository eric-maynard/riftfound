output "ec2_public_ip" {
  value = aws_eip.riftfound.public_ip
}

output "ec2_public_dns" {
  value = aws_eip.riftfound.public_dns
}

output "cloudfront_domain" {
  value = aws_cloudfront_distribution.main.domain_name
}

output "cloudfront_distribution_id" {
  value = aws_cloudfront_distribution.main.id
}

output "s3_bucket_name" {
  value = aws_s3_bucket.frontend.id
}

output "acm_validation_records" {
  description = "Add these DNS records to GoDaddy for SSL certificate validation"
  value = {
    for dvo in aws_acm_certificate.main.domain_validation_options : dvo.domain_name => {
      name  = dvo.resource_record_name
      type  = dvo.resource_record_type
      value = dvo.resource_record_value
    }
  }
}

output "godaddy_dns_instructions" {
  value = <<-EOT

  ======================================
  GODADDY DNS SETUP FOR riftfound.com
  ======================================

  1. Go to GoDaddy DNS Management

  2. ADD SSL CERTIFICATE VALIDATION RECORDS:
     (See acm_validation_records output above)
     Type: CNAME
     Name: [from output - remove .riftfound.com suffix]
     Value: [from output]

  3. ADD CLOUDFRONT RECORDS:

     Type: CNAME
     Name: www
     Value: ${aws_cloudfront_distribution.main.domain_name}

     For apex (riftfound.com):
     - GoDaddy doesn't support ALIAS records
     - Use forwarding: Forward riftfound.com -> www.riftfound.com
     - Or use a CNAME flattening service

  4. SSH to server:
     ssh -i ~/.ssh/YOUR_KEY.pem ec2-user@${aws_eip.riftfound.public_ip}

  EOT
}
