/**
 * AWS Secrets Manager integration for production deployments.
 *
 * In production, database credentials are stored in AWS Secrets Manager
 * and fetched at runtime. This keeps credentials out of the codebase
 * and environment variables on the deployment machine.
 *
 * For local development, credentials come from .env file.
 */

interface DatabaseSecrets {
  host: string;
  port: number;
  database: string;
  username: string;
  password: string;
}

// Cache for secrets
let cachedSecrets: DatabaseSecrets | null = null;

/**
 * Fetch database credentials from AWS Secrets Manager.
 *
 * To use this in production:
 * 1. Create a secret in AWS Secrets Manager with your RDS credentials
 * 2. Set AWS_SECRETS_DB_ARN environment variable to the secret ARN
 * 3. Ensure your Lambda/ECS task has IAM permissions to read the secret
 */
export async function getDatabaseSecrets(): Promise<DatabaseSecrets> {
  // Return cached secrets if available
  if (cachedSecrets) {
    return cachedSecrets;
  }

  const secretArn = process.env.AWS_SECRETS_DB_ARN;

  // If no secret ARN, use environment variables (local dev)
  if (!secretArn) {
    return {
      host: process.env.DB_HOST || 'localhost',
      port: parseInt(process.env.DB_PORT || '5432', 10),
      database: process.env.DB_NAME || 'riftfound',
      username: process.env.DB_USER || '',
      password: process.env.DB_PASSWORD || '',
    };
  }

  // In production, fetch from Secrets Manager
  // Import dynamically to avoid requiring AWS SDK in development
  const { SecretsManagerClient, GetSecretValueCommand } = await import(
    '@aws-sdk/client-secrets-manager'
  );

  const client = new SecretsManagerClient({
    region: process.env.AWS_REGION || 'us-east-1',
  });

  const command = new GetSecretValueCommand({ SecretId: secretArn });
  const response = await client.send(command);

  if (!response.SecretString) {
    throw new Error('Secret value is empty');
  }

  const secret = JSON.parse(response.SecretString);

  cachedSecrets = {
    host: secret.host,
    port: secret.port,
    database: secret.dbname || secret.database,
    username: secret.username,
    password: secret.password,
  };

  return cachedSecrets;
}

/**
 * Clear cached secrets (useful for testing or rotation)
 */
export function clearSecretsCache(): void {
  cachedSecrets = null;
}
