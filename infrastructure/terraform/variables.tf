variable "aws_region" {
  description = "AWS region to deploy to"
  type        = string
  default     = "us-east-1"
}

variable "project_name" {
  description = "Project name for resource naming"
  type        = string
  default     = "riftfound"
}

variable "photon_instance_type" {
  description = "EC2 instance type for Photon"
  type        = string
  default     = "t3.medium" # 2 vCPU, 4GB RAM - needed for worldwide data
}

variable "photon_volume_size" {
  description = "EBS volume size in GB for Photon data"
  type        = number
  default     = 100 # Worldwide data is ~70GB
}

variable "photon_country" {
  description = "Country code for Photon data (empty = worldwide)"
  type        = string
  default     = "" # Empty = worldwide (~70GB), or 'us' for US-only (~8GB)
}

variable "ssh_key_name" {
  description = "Name of existing EC2 key pair for SSH access (optional)"
  type        = string
  default     = ""
}

variable "allowed_ssh_cidr" {
  description = "CIDR block allowed to SSH (set to your IP for security)"
  type        = string
  default     = "0.0.0.0/0" # WARNING: Open to all - restrict in production
}
