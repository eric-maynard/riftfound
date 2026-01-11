/**
 * AWS Lambda handler for the Riftfound API
 *
 * This wraps the Express app with serverless-http to run on AWS Lambda
 * behind API Gateway.
 */

import serverless from 'serverless-http';
import app from './app.js';

// Create the serverless handler
export const handler = serverless(app, {
  // Preserve query string parameters
  request: {
    // Ensure API Gateway v2 (HTTP API) compatibility
  },
});
