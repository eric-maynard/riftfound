# Riftfound AWS Infrastructure

Terraform configuration to deploy Riftfound infrastructure on AWS.

## Prerequisites

1. **AWS Account** with admin access
2. **AWS CLI** installed and configured:
   ```bash
   # Install AWS CLI
   curl "https://awscli.amazonaws.com/awscli-exe-linux-x86_64.zip" -o "awscliv2.zip"
   unzip awscliv2.zip && sudo ./aws/install

   # Configure credentials
   aws configure
   # Enter your AWS Access Key ID, Secret Access Key, region (us-east-1), output format (json)
   ```

3. **Terraform** installed:
   ```bash
   # Ubuntu/Debian
   wget -O- https://apt.releases.hashicorp.com/gpg | sudo gpg --dearmor -o /usr/share/keyrings/hashicorp-archive-keyring.gpg
   echo "deb [signed-by=/usr/share/keyrings/hashicorp-archive-keyring.gpg] https://apt.releases.hashicorp.com $(lsb_release -cs) main" | sudo tee /etc/apt/sources.list.d/hashicorp.list
   sudo apt update && sudo apt install terraform

   # Or download from https://www.terraform.io/downloads
   ```

## Quick Start

```bash
cd infrastructure/terraform

# Initialize Terraform (downloads AWS provider)
terraform init

# Preview what will be created
terraform plan

# Deploy! (type 'yes' when prompted)
terraform apply
```

After ~2 minutes, you'll see outputs like:
```
photon_url = "http://1.2.3.4:2322"
photon_test_command = "curl '1.2.3.4:2322/api?q=san+francisco&limit=1'"
```

**Note**: Photon takes 20-30 minutes to download US data on first boot. Check progress:
```bash
# Connect to instance via SSM (no SSH key needed)
aws ssm start-session --target <instance-id>

# Check Docker logs
sudo docker logs -f photon
```

## What Gets Created

| Resource | Purpose | Est. Cost |
|----------|---------|-----------|
| EC2 t3.medium (Photon) | Runs Photon geocoder | ~$30/mo |
| EC2 t3.medium (Backend) | Runs API + Scraper | ~$30/mo |
| EBS 100GB gp3 | Stores Photon/OSM data | ~$8/mo |
| EBS 20GB gp3 | Backend root volume | ~$2/mo |
| 2x Elastic IP | Stable public IPs | Free (while attached) |

**Total: ~$70/month** (worldwide data)

For US-only Photon data, save ~$20/mo:
```hcl
photon_instance_type = "t3.small"
photon_volume_size   = 20
photon_country       = "us"
```

## Scaling Notes

- **Photon**: t3.medium handles 100+ req/s. Upgrade to t3.large for more headroom.
- **Backend**: t3.medium handles dozens of concurrent users. Upgrade to t3.large/xlarge if needed.

Both scale vertically - just change instance type and `terraform apply`.

## Configuration

Create `terraform.tfvars` to customize:
```hcl
aws_region           = "us-west-2"        # Change region
photon_instance_type = "t3.medium"        # More RAM for larger datasets
photon_volume_size   = 100                # For worldwide data (~70GB)
ssh_key_name         = "my-key"           # Optional: enable SSH
allowed_ssh_cidr     = "1.2.3.4/32"       # Your IP for SSH
```

## Connecting to the Instance

**Option 1: SSM Session Manager (recommended, no SSH key needed)**
```bash
aws ssm start-session --target <instance-id>
```

**Option 2: SSH (requires ssh_key_name variable)**
```bash
ssh -i ~/.ssh/your-key.pem ec2-user@<public-ip>
```

## Updating Photon

```bash
# Connect to instance
aws ssm start-session --target <instance-id>

# Update container
sudo docker pull komoot/photon
sudo docker stop photon
sudo docker rm photon
sudo docker run -d --name photon --restart unless-stopped \
  -p 2322:2322 -v /photon_data:/photon/photon_data \
  -e PHOTON_COUNTRY=us komoot/photon
```

## Destroying Infrastructure

```bash
terraform destroy
```

**Warning**: This will delete the Photon instance. The EBS data volume is preserved by default (delete_on_termination = false), but you'll need to manually delete it if you want to remove everything.

## Next Steps

After Photon is running:
1. Update your app's `PHOTON_URL` environment variable
2. Deploy the backend/frontend (see ../aws-deployment.md)
3. Consider adding RDS for PostgreSQL
