# Riftfound AWS Infrastructure

Terraform configuration to deploy Riftfound on AWS.

## Architecture

```
                    ┌─────────────────┐
                    │   CloudFront    │
                    │   (CDN + HTTPS) │
                    └────────┬────────┘
                             │
              ┌──────────────┼──────────────┐
              │              │              │
              ▼              ▼              │
        ┌─────────┐    ┌──────────┐         │
        │   S3    │    │   EC2    │         │
        │Frontend │    │ Backend  │         │
        └─────────┘    │ Scraper  │         │
                       │ SQLite   │         │
                       └────┬─────┘         │
                            │               │
                       ┌────▼────┐          │
                       │   EBS   │          │
                       │  (data) │          │
                       └─────────┘          │
```

## What Gets Created

| Resource | Purpose | Est. Cost |
|----------|---------|-----------|
| EC2 t3.small | Backend API + Scraper | ~$15/mo |
| EBS 30GB gp3 | Root volume | ~$3/mo |
| EBS 20GB gp3 | SQLite data (persistent) | ~$2/mo |
| S3 bucket | Frontend static files | ~$1/mo |
| CloudFront | CDN + HTTPS | ~$1/mo |
| ACM Certificate | SSL for custom domain | Free |
| Elastic IP | Stable public IP | Free (while attached) |

**Total: ~$20-25/month**

## Prerequisites

1. **AWS Account** with admin access
2. **AWS CLI** installed and configured:
   ```bash
   aws configure
   # Enter your Access Key ID, Secret Access Key, region (us-west-2)
   ```
3. **Terraform** installed:
   ```bash
   # Download from https://www.terraform.io/downloads
   ```
4. **SSH Key Pair** created in AWS Console (EC2 → Key Pairs)

## Quick Start

```bash
cd infrastructure/terraform

# Create your config
cp terraform.tfvars.example terraform.tfvars
# Edit terraform.tfvars with your values

# Initialize and deploy
terraform init
terraform plan     # Preview changes
terraform apply    # Deploy (type 'yes')
```

After deployment, Terraform outputs:
- CloudFront domain for DNS setup
- EC2 public IP for SSH
- S3 bucket name for frontend uploads
- GoDaddy DNS instructions

## Configuration

Edit `terraform.tfvars`:

```hcl
aws_region       = "us-west-2"
domain_name      = "riftfound.com"
instance_type    = "t3.small"
ssh_key_name     = "your-key-pair-name"
allowed_ssh_cidr = "YOUR_IP/32"        # Your IP for SSH access
ebs_volume_size  = 20
```

## DNS Setup (GoDaddy)

After `terraform apply`, you need to:

1. **Validate SSL Certificate**: Add the CNAME records shown in `acm_validation_records` output
2. **Point www to CloudFront**: Add CNAME record `www` → `<cloudfront-domain>.cloudfront.net`
3. **Root domain**: Either forward to www or use GoDaddy's forwarding feature

## Connecting to the Server

```bash
ssh -i ~/.ssh/your-key.pem ec2-user@<EC2_PUBLIC_IP>

# Check services
pm2 status
pm2 logs
```

## Deploying Updates

Use the deploy script from the project root:

```bash
./deploy.sh frontend   # Build and upload React app
./deploy.sh backend    # Package and deploy backend/scraper
./deploy.sh all        # Both
```

## Destroying Infrastructure

```bash
terraform destroy
```

**Warning**: This deletes everything including the EBS data volume.

## SPA Routing (and why there is no blanket 404 -> 200)

`riftfound.com` is a single-page app, so a request for `/rankings` or
`/events/265658` has no matching object in S3 and has to be answered with
`/index.html` so React Router can take over.

The usual way to do that is a CloudFront `custom_error_response` mapping 404 and
403 to `/index.html` with a 200. **We do not do that, and it must not be added
back.** `custom_error_response` is a *distribution-level* setting — there is no
way to scope it to one cache behavior — so the blanket rule also rewrote every
legitimate error from the API and from S3:

```
GET /api/players/does-not-exist   ->  200 text/html   (should be 404 JSON)
GET /api/events/99999999          ->  200 text/html   (should be 404 JSON)
GET /assets/index-<stale>.js      ->  200 text/html   (should be 403/404)
```

Clients saw `response.ok === true`, tried to parse the app shell as JSON and
failed, so "player not found" surfaced as a generic error instead of an empty
state. A stale deploy turned into a blank page with nothing in the network tab
to explain it.

### What we do instead

`aws_cloudfront_function.spa_router` (code in `spa_router.js`) runs on
**viewer-request of the default cache behavior only** and rewrites the URI to
`/index.html` only when the path is actually a SPA route:

| Request | Result |
|---|---|
| `/`, `/rankings`, `/rankings/players/<uuid>`, `/events/<id>`, `/ranking/*` | rewritten to `/index.html`, query string and fragment preserved |
| `/api/*` | not rewritten — real status, real JSON, 400 and 404 included |
| `/iykyk*` | not rewritten — separate project, separate behavior |
| anything with a file extension (`/assets/*.js`, `/favicon.png`) | not rewritten — a missing file returns 403 from S3 (OAC grants `s3:GetObject` only, so S3 answers AccessDenied rather than NoSuchKey) |

`/api/*` and `/iykyk*` have their own `ordered_cache_behavior` blocks, so those
requests never invoke the function at all. The guards at the top of
`spa_router.js` are belt-and-braces against a future behavior change.

A CloudFront Function rather than Lambda@Edge: it is ~15 lines of string
matching with no I/O, it runs at every edge POP in sub-millisecond time, and it
costs $0.10 per million invocations. Lambda@Edge runs in a regional cache, adds
tens of milliseconds of first-byte latency and costs roughly 15x more per
request plus GB-seconds.

### Changing it

```bash
node spa_router.test.js   # routing table + ES5-only check, no AWS calls
terraform apply           # the function is NOT deployed by ./deploy.sh
```

`./deploy.sh frontend` needs no extra step. Because the rewrite happens at
viewer-request, every SPA route shares the `/index.html` cache key, so the
existing `create-invalidation --paths /index.html /` covers all of them.

To roll back, comment out the `function_association` block in
`default_cache_behavior` and re-add the two `custom_error_response` blocks
(403/404 -> `/index.html`, response code 200), then `terraform apply`. That
restores the old behavior, bug included.

## Troubleshooting

### Certificate stuck in PENDING_VALIDATION
- Verify DNS records are correct in GoDaddy
- Wait up to 30 minutes for DNS propagation
- Check: `aws acm describe-certificate --certificate-arn <ARN> --region us-east-1`

### CloudFront returns 403
- Ensure S3 bucket policy allows CloudFront access
- Check CloudFront origin access control is configured
- For a path with a file extension (`/assets/*.js`, `*.png`) a 403 is the
  *expected* answer when the object is not in the bucket — see "SPA Routing"
  above. Usually it means a stale `index.html` is referencing assets a newer
  `deploy.sh frontend` has already deleted; re-run the frontend deploy.

### A SPA route returns 403 instead of the app
- `aws_cloudfront_function.spa_router` only rewrites *extensionless* paths. A
  route segment containing a dot (an event id with a `.` in it, say) would be
  mistaken for a filename. Add the route to `spa_router.test.js`, then widen the
  guard in `spa_router.js` to an allow-list of real asset extensions.

### Can't SSH to EC2
- Verify your IP in `allowed_ssh_cidr` matches `curl ifconfig.me`
- Check security group allows port 22 from your IP
