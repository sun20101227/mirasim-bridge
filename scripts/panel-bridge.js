#!/usr/bin/env node
'use strict';
// Docker exec adapter: no credentials in argv/stdout, no arbitrary destinations.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const http = require('node:http');
async function main() {
  let input = ''; for await (const chunk of process.stdin) { input += chunk; if (Buffer.byteLength(input) > 160000) throw Error('input too large'); }
  const data = JSON.parse(input);
  const file = process.env.MIRASIM_CONFIG || '/data/config.json';
  const cfg = JSON.parse(fs.readFileSync(file, 'utf8'));
  const keyFile = path.join(path.dirname(file), '.panel-key');
  try { fs.writeFileSync(keyFile, crypto.randomBytes(32).toString('hex'), { flag: 'wx', mode: 0o600 }); }
  catch (err) { if (err.code !== 'EEXIST') throw err; }
  const key = fs.readFileSync(keyFile, 'utf8').trim();
  if (data.operation === 'panel-key') { process.stdout.write(JSON.stringify({ status: 200, data: { panel_key: key } })); return; }
  if (!['status', 'summary', 'models', 'model', 'models/family', 'settings', 'test', 'profiles', 'profile/info', 'groups', 'login/start', 'login/complete', 'login/status'].includes(data.operation)) throw Error('unknown operation');
  const body = JSON.stringify(data.data || {});
  const status = data.operation === 'status';
  const host = process.env.MIRASIM_LISTEN_HOST || cfg.listen.host;
  const req = http.request({ host: ['::', '0.0.0.0'].includes(host) ? '127.0.0.1' : host,
    port: Number(process.env.MIRASIM_LISTEN_PORT || cfg.listen.port),
    path: status ? '/__status' : '/__panel/' + data.operation, method: status ? 'GET' : 'POST',
    headers: { 'x-api-key': process.env.MIRASIM_BRIDGE_SECRET || cfg.bridge_secret, 'x-panel-key': key,
      'content-type': 'application/json', 'content-length': status ? 0 : Buffer.byteLength(body) } }, (res) => {
    let out = '';
    res.on('data', (chunk) => { out += chunk; if (Buffer.byteLength(out) > 2 * 1024 * 1024) req.destroy(); });
    res.on('end', () => {
      try { const parsed = JSON.parse(out); process.stdout.write(JSON.stringify({ status: res.statusCode, data: parsed })); }
      catch { process.exitCode = 1; }
      clearTimeout(timer);
    });
  });
  const timer = setTimeout(() => req.destroy(Error('timeout')), 45000);
  req.on('error', () => { clearTimeout(timer); process.exitCode = 1; });
  req.end(status ? undefined : body);
}
if (require.main === module) main().catch(() => { console.error('Bridge management request failed'); process.exitCode = 1; });
