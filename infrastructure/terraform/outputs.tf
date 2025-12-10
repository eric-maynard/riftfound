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
