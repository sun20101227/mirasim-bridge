'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const zlib = require('node:zlib');
const b = require('../mirasim-bridge');
const { ensurePanelKey, ASSETS } = require('../lib/panel');

const webDir = path.join(__dirname, '../web');
const listen = (s) => new Promise((r) => s.listen(0, '127.0.0.1', () => r(`http://127.0.0.1:${s.address().port}`)));
const close = (s) => new Promise((r) => { s.close(r); s.closeAllConnections(); });

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mira-panel-assets-'));
  t.after(() => { assert.equal(path.dirname(dir), os.tmpdir()); fs.rmSync(dir, { recursive: true, force: true }); });
  const cfg = b.deepMerge({}, b.DEFAULT_CONFIG);
  cfg.backend = 'relay'; cfg.bridge_secret = 'inference-secret';
  cfg._config_path = path.join(dir, 'config.json');
  fs.writeFileSync(cfg._config_path, JSON.stringify(cfg));
  return { cfg, ctx: { counters: { total: 0, rejected: 0 }, startedAt: Date.now(), inflight: 0, backoffUntil: 0 } };
}

// Raw request: node's fetch transparently inflates gzip and hides the wire headers.
function rawGet(origin, route, headers = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(route, origin);
    const req = http.request({ hostname: url.hostname, port: url.port, path: url.pathname, method: 'GET', headers }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.on('error', reject);
    req.end();
  });
}

async function server(t) {
  const { cfg, ctx } = fixture(t);
  ensurePanelKey(cfg);
  const srv = b.createBridgeServer(cfg, ctx, cfg.bridge_secret, 2);
  t.after(() => close(srv));
  return listen(srv);
}

test('every registered asset resolves to a real file and is served with its mime type', async (t) => {
  const origin = await server(t);
  for (const [route, [file, mime]] of Object.entries(ASSETS)) {
    assert.ok(fs.existsSync(path.join(webDir, file)), `${route} maps to missing web/${file} (also add it to package.ps1)`);
    assert.match(mime, /^(text\/(html|css|javascript)|image\/png)/);
    const res = await rawGet(origin, route);
    assert.equal(res.status, 200, `${route} should be served`);
    assert.equal(res.headers['content-type'], mime);
    assert.deepEqual(res.body, fs.readFileSync(path.join(webDir, file)), `${route} serves web/${file}`);
  }
});

test('style.css is served with an etag and revalidates instead of re-downloading', async (t) => {
  const origin = await server(t);
  const file = fs.readFileSync(path.join(webDir, 'style.css'));
  const first = await rawGet(origin, '/panel/style.css');
  assert.equal(first.status, 200);
  assert.equal(first.headers['cache-control'], 'no-cache');
  assert.match(first.headers.etag, /^"[a-f0-9]{32}"$/);
  assert.equal(first.headers['x-content-type-options'], 'nosniff');
  assert.match(first.headers['content-security-policy'], /frame-ancestors 'none'/);
  assert.deepEqual(first.body, file);

  const second = await rawGet(origin, '/panel/style.css', { 'if-none-match': first.headers.etag });
  assert.equal(second.status, 304);
  assert.equal(second.body.length, 0);
  assert.equal(second.headers.etag, first.headers.etag);
  assert.equal(second.headers['cache-control'], 'no-cache');
  assert.equal(second.headers['content-length'], undefined, '304 must not carry a content-length');
});

test('if-none-match accepts a comma separated list and a wildcard', async (t) => {
  const origin = await server(t);
  const { headers } = await rawGet(origin, '/panel/style.css');
  assert.equal((await rawGet(origin, '/panel/style.css', { 'if-none-match': `"bogus", ${headers.etag}` })).status, 304);
  assert.equal((await rawGet(origin, '/panel/style.css', { 'if-none-match': `"bogus", "also-bogus"` })).status, 200);
  assert.equal((await rawGet(origin, '/panel/style.css', { 'if-none-match': '*' })).status, 304);
});

test('text assets are gzipped on request; the png and the shell are not', async (t) => {
  const origin = await server(t);
  const js = fs.readFileSync(path.join(webDir, 'app.js'));
  const packed = await rawGet(origin, '/panel/app.js', { 'accept-encoding': 'gzip' });
  assert.equal(packed.status, 200);
  assert.equal(packed.headers['content-encoding'], 'gzip');
  assert.equal(packed.headers.vary, 'accept-encoding');
  assert.deepEqual(zlib.gunzipSync(packed.body), js);
  // Second compressed request must be served from the cached gzip buffer, byte for byte.
  const again = await rawGet(origin, '/panel/app.js', { 'accept-encoding': 'gzip' });
  assert.deepEqual(again.body, packed.body);

  const plain = await rawGet(origin, '/panel/app.js', { 'accept-encoding': 'gzip;q=0' });
  assert.equal(plain.headers['content-encoding'], undefined);
  assert.deepEqual(plain.body, js);
  assert.equal((await rawGet(origin, '/panel/app.js', { 'accept-encoding': 'gzip;q=0, *' })).headers['content-encoding'], undefined,
    'an explicit gzip;q=0 wins over the * wildcard');

  const png = await rawGet(origin, '/panel/icon.png', { 'accept-encoding': 'gzip' });
  assert.equal(png.status, 200);
  assert.equal(png.headers['content-encoding'], undefined);
  assert.deepEqual(png.body, fs.readFileSync(path.join(webDir, 'icon.png')));
});

test('the HTML shell stays no-store; an unknown panel asset is a clean 404', async (t) => {
  const origin = await server(t);
  const html = await rawGet(origin, '/panel');
  assert.equal(html.status, 200);
  assert.equal(html.headers['cache-control'], 'no-store');
  assert.match(html.headers['content-security-policy'], /default-src 'none'/);
  assert.ok(html.body.length > 0);

  const missing = await rawGet(origin, '/panel/nope.js');
  assert.equal(missing.status, 404);
  assert.equal(missing.body.length, 0);
});

test('a registered asset whose file vanished returns 404 instead of crashing the handler', async (t) => {
  // Simulates the packaging bug: the route map knows the file, the ZIP does not ship it.
  ASSETS['/panel/__missing__.js'] = ['__missing__.js', 'text/javascript; charset=utf-8'];
  t.after(() => { delete ASSETS['/panel/__missing__.js']; });
  const origin = await server(t);
  const res = await rawGet(origin, '/panel/__missing__.js');
  assert.equal(res.status, 404);
  assert.equal(res.body.length, 0);
  // The server is still alive for normal traffic afterwards.
  assert.equal((await rawGet(origin, '/panel/style.css')).status, 200);
});
