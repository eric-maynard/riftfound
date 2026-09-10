# ============================================================================
# Route53 DNS for riftfound.com
#
# Toggled via var.use_route53. When enabled:
#   - Creates a hosted zone (change nameservers at the registrar to point here).
#   - Apex + www ALIAS records to CloudFront (path-preserving, unlike GoDaddy
#     apex forwarding).
#   - Recreates the ACM DNS validation CNAMEs so cert auto-renewal keeps working.
# ============================================================================

resource "aws_route53_zone" "riftfound" {
  count = var.use_route53 ? 1 : 0
  name  = var.domain_name
  tags  = { Name = "riftfound-zone" }
}

# Apex: riftfound.com → CloudFront (ALIAS = no CNAME-at-apex problem)
resource "aws_route53_record" "apex_alias" {
  count   = var.use_route53 ? 1 : 0
  zone_id = aws_route53_zone.riftfound[0].zone_id
  name    = var.domain_name
  type    = "A"

  alias {
    name                   = aws_cloudfront_distribution.main.domain_name
    zone_id                = aws_cloudfront_distribution.main.hosted_zone_id
    evaluate_target_health = false
  }
}

resource "aws_route53_record" "apex_alias_ipv6" {
  count   = var.use_route53 ? 1 : 0
  zone_id = aws_route53_zone.riftfound[0].zone_id
  name    = var.domain_name
  type    = "AAAA"

  alias {
    name                   = aws_cloudfront_distribution.main.domain_name
    zone_id                = aws_cloudfront_distribution.main.hosted_zone_id
    evaluate_target_health = false
  }
}

# www.riftfound.com → CloudFront
resource "aws_route53_record" "www_alias" {
  count   = var.use_route53 ? 1 : 0
  zone_id = aws_route53_zone.riftfound[0].zone_id
  name    = "www.${var.domain_name}"
  type    = "A"

  alias {
    name                   = aws_cloudfront_distribution.main.domain_name
    zone_id                = aws_cloudfront_distribution.main.hosted_zone_id
    evaluate_target_health = false
  }
}

resource "aws_route53_record" "www_alias_ipv6" {
  count   = var.use_route53 ? 1 : 0
  zone_id = aws_route53_zone.riftfound[0].zone_id
  name    = "www.${var.domain_name}"
  type    = "AAAA"

  alias {
    name                   = aws_cloudfront_distribution.main.domain_name
    zone_id                = aws_cloudfront_distribution.main.hosted_zone_id
    evaluate_target_health = false
  }
}

# ACM DNS validation records — needed for cert auto-renewal after NS switch.
# Uses for_each over domain_validation_options so it handles both apex and www.
resource "aws_route53_record" "acm_validation" {
  for_each = var.use_route53 ? {
    for dvo in aws_acm_certificate.main.domain_validation_options : dvo.domain_name => {
      name   = dvo.resource_record_name
      record = dvo.resource_record_value
      type   = dvo.resource_record_type
    }
  } : {}

  zone_id         = aws_route53_zone.riftfound[0].zone_id
  name            = each.value.name
  type            = each.value.type
  ttl             = 60
  records         = [each.value.record]
  allow_overwrite = true
}
