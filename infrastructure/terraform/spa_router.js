// ============================================================================
// riftfound-spa-router — CloudFront Function, viewer-request
//
// Replaces the old distribution-wide `custom_error_response` rules that mapped
// every 403 and 404 to /index.html with a 200. Those rules are the standard SPA
// deep-link trick, but CloudFront applies them to the WHOLE distribution, so
// they also swallowed legitimate API errors: GET /api/players/does-not-exist
// came back 200 text/html, every client saw response.ok === true and then
// choked parsing the SPA shell as JSON. They hid stale deploys too — a missing
// /assets/index-<hash>.js returned the shell instead of 404.
//
// This function does the rewrite narrowly instead: only extensionless paths
// outside the API namespace become /index.html. Everything else keeps the real
// status its origin produced.
//
// Attached ONLY to the default cache behavior (S3-Frontend). Requests matched
// by the /api/* behaviors never invoke it at all; the guard below is
// belt-and-braces so a future behavior change can't resurrect the bug.
//
// Deployed by Terraform (aws_cloudfront_function.spa_router in main.tf) — it is
// NOT part of ./deploy.sh frontend.
// ============================================================================

function handler(event) {
  var request = event.request;
  var uri = request.uri;

  // The API namespace must always return its real status and its real JSON
  // body, 404 and 400 included.
  if (uri === '/api' || uri.indexOf('/api/') === 0) {
    return request;
  }

  // Anything whose last path segment carries an extension is a real file:
  // /assets/index-abc123.js, /favicon.png, /logo-ranking-flat.svg. If it is
  // missing it has to fail loudly (403 from S3 via OAC, or 404) rather than
  // silently serving HTML — that is how a stale deploy becomes an
  // unexplainable blank page.
  var lastSegment = uri.substring(uri.lastIndexOf('/') + 1);
  if (lastSegment.indexOf('.') !== -1) {
    return request;
  }

  // Everything left is a SPA route: '/', '/rankings',
  // '/rankings/players/<uuid>', '/events/<id>', '/ranking/...' (the legacy
  // redirect, handled client-side), and the react-router catch-all. Serve the
  // app shell and let the router take it from there.
  //
  // request.querystring and the URL fragment are untouched, so
  // /rankings?set=OGN#top still arrives intact at the SPA.
  request.uri = '/index.html';

  return request;
}
