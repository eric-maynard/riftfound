// Routing table for spa_router.js — the CloudFront Function that serves SPA
// deep links. Run it before `terraform apply` whenever you touch that file:
//
//     node infrastructure/terraform/spa_router.test.js
//
// It models the two things that decide what a request gets: which cache
// behavior CloudFront picks (the function is attached to the default behavior
// ONLY, so /api/* never reaches it) and then the function itself.
// No AWS calls, no dependencies, plain `node`.
//
// It also rejects syntax the cloudfront-js runtime does not support — the
// function body has to stay ES5 string operations.

const fs = require('fs');
const src = fs.readFileSync(require('path').join(__dirname, 'spa_router.js'), 'utf8');
// Reject anything the cloudfront-js runtime does not provide (keep to ES5 string ops).
const banned = [/=>/, /\blet\b/, /\bconst\b/, /\bstartsWith\b/, /\bincludes\b/, /`/, /\.\.\./];
banned.forEach(function (re) {
  if (re.test(src.replace(/^\s*\/\/.*$/gm, ''))) throw new Error('non-ES5 construct in function body: ' + re);
});
const handler = new Function(src + '; return handler;')();

// CloudFront picks the behaviour BEFORE the function runs. Only the default
// behaviour has the function attached, so model that too.
function behaviourFor(uri) {
  if (uri === '/api/' || uri.indexOf('/api/') === 0) return 'api';   // path_pattern /api/*
  return 'default';
}

function route(uri, qs) {
  const b = behaviourFor(uri);
  if (b !== 'default') return { behaviour: b, uri: uri, qs: qs || '', ranFunction: false };
  const req = handler({ request: { uri: uri, querystring: qs || '' } });
  return { behaviour: b, uri: req.uri, qs: req.querystring, ranFunction: true };
}

const cases = [
  // [path, querystring, expected behaviour, expected effective uri]
  ['/',                                             '',             'default', '/index.html'],
  ['/rankings',                                     '',             'default', '/index.html'],
  ['/rankings/',                                    '',             'default', '/index.html'],
  ['/rankings/players/8f14e45f-ceea-467a-9a0b-1c2d', '',            'default', '/index.html'],
  ['/events/265658',                                '',             'default', '/index.html'],
  ['/events/prb-117094734752503318',                '',             'default', '/index.html'],
  ['/ranking',                                      '',             'default', '/index.html'],
  ['/ranking/players/abc',                          '',             'default', '/index.html'],
  ['/rankings',                                     'set=OGN&v=2',  'default', '/index.html'],
  ['/some/unknown/spa/path',                        '',             'default', '/index.html'],
  // API namespace: real statuses, untouched URI
  ['/api/players/does-not-exist',                   '',             'api',     '/api/players/does-not-exist'],
  ['/api/events/99999999',                          '',             'api',     '/api/events/99999999'],
  ['/api/events',                                   'lat=37&lng=-1','api',     '/api/events'],
  ['/api/health',                                   '',             'api',     '/api/health'],
  // Real files: must keep their real status, so URI must NOT be rewritten
  ['/assets/index-abc123.js',                       '',             'default', '/assets/index-abc123.js'],
  ['/assets/index-STALE.css',                       '',             'default', '/assets/index-STALE.css'],
  ['/favicon.png',                                  '',             'default', '/favicon.png'],
  ['/logo-ranking-flat.svg',                        '',             'default', '/logo-ranking-flat.svg'],
  ['/index.html',                                   '',             'default', '/index.html'],
  ['/robots.txt',                                   '',             'default', '/robots.txt'],
  ['/nope/missing.js',                              '',             'default', '/nope/missing.js'],
  // The exact path from the bug report, reached without the /api/ prefix guard
  ['/api',                                          '',             'default', '/api'],
];

let fail = 0;
cases.forEach(function (c) {
  const r = route(c[0], c[1]);
  const ok = r.behaviour === c[2] && r.uri === c[3] && r.qs === (c[1] || '');
  if (!ok) fail++;
  console.log((ok ? 'PASS' : 'FAIL') + '  ' + (c[0] + (c[1] ? '?' + c[1] : '')).padEnd(46) +
    ' behaviour=' + r.behaviour.padEnd(8) + ' -> ' + r.uri + (r.qs ? '?' + r.qs : ''));
});
console.log('\n' + (cases.length - fail) + '/' + cases.length + ' passed');
process.exit(fail ? 1 : 0);
