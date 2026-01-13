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

variable "google_maps_api_key" {
  description = "Google Maps API key for geocoding in Lambda functions"
  type        = string
  default     = ""
  sensitive   = true
}
