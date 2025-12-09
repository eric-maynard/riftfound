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

output "photon_test_command" {
  description = "Command to test Photon API"
  value       = "curl '${aws_eip.photon.public_ip}:2322/api?q=san+francisco&limit=1'"
}

output "ssm_connect_command" {
  description = "Command to connect via SSM (no SSH key needed)"
  value       = "aws ssm start-session --target ${aws_instance.photon.id}"
}
