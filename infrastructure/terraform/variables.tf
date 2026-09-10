variable "aws_region" {
  description = "AWS region"
  type        = string
  default     = "us-west-2"
}

variable "domain_name" {
  description = "Domain name for the application"
  type        = string
  default     = "riftfound.com"
}

variable "instance_type" {
  description = "EC2 instance type"
  type        = string
  default     = "t3.small"
}

variable "ssh_key_name" {
  description = "Name of the SSH key pair in AWS"
  type        = string
}

variable "allowed_ssh_cidr" {
  description = "CIDR block allowed to SSH (your IP)"
  type        = string
  default     = "0.0.0.0/0"
}

variable "ebs_volume_size" {
  description = "Size of EBS volume for data (GB)"
  type        = number
  default     = 20
}

# Serverless infrastructure variables
variable "environment" {
  description = "Environment name (dev/prod)"
  type        = string
  default     = "prod"
}

variable "use_dynamodb" {
  description = "Enable DynamoDB-based serverless infrastructure"
  type        = bool
  default     = false
}

variable "use_ec2" {
  description = "Enable EC2-based infrastructure (set to false when fully migrated to serverless)"
  type        = bool
  default     = true
}

variable "use_route53" {
  description = "Manage riftfound.com DNS in Route53 (apex + www ALIAS to CloudFront, ACM validation records). When enabled, update nameservers at the registrar to the aws_route53_zone.riftfound name servers."
  type        = bool
  default     = false
}

variable "mapbox_access_token" {
  description = "Mapbox access token for geocoding in Lambda functions"
  type        = string
  default     = ""
  sensitive   = true
}

# Optional extra CloudFront origin. Left empty by default so the distribution
# ignores it entirely; set both values in a private tfvars file to route a path
# pattern to a custom HTTP origin (e.g. an EIP DNS name).
variable "extra_origin_eip_name_tag" {
  description = "Name tag of an EIP to add as an additional CloudFront origin (empty = disabled)"
  type        = string
  default     = ""
}

variable "extra_origin_path_pattern" {
  description = "Path pattern routed to the extra origin (empty = disabled). Example: /foo/*"
  type        = string
  default     = ""
}
