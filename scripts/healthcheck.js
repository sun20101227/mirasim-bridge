#!/usr/bin/env node
'use strict';
const fs = require('node:fs');
const http = require('node:http');

async function check(file = '/data/config.json', { readiness = false, timeoutMs = 3000, env = process.env } = {}) {
  let cfg;
  try { cfg = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')); }
  catch { return false; }
  const host = env.MIRASIM_LISTEN_HOST || cfg?.listen?.host || '127.0.0.1';
  const port = Number(env.MIRASIM_LISTEN_PORT || cfg?.listen?.port || 8787);
  const secret = env.MIRASIM_BRIDGE_SECRET || cfg?.bridge_secret || '';
  if (!secret || !Number.isInteger(port) || port < 1 || port > 65535) return false;
  return new Promise((resolve) => {
    let timer;
    try {
      const req = http.get({ host: ['0.0.0.0', '::'].includes(host) ? '127.0.0.1' : host, port,
        path: readiness ? '/__health' : '/__live', headers: { 'x-api-key': secret }, agent: false }, (res) => {
        res.resume();
        res.once('end', () => { clearTimeout(timer); resolve(res.statusCode === 200); });
        res.once('error', () => { clearTimeout(timer); resolve(false); });
        res.once('aborted', () => { clearTimeout(timer); resolve(false); });
      });
      timer = setTimeout(() => req.destroy(Error('healthcheck timeout')), timeoutMs);
      req.once('error', () => { clearTimeout(timer); resolve(false); });
    } catch { clearTimeout(timer); resolve(false); }
  });
}
if (require.main === module) {
  const readiness = process.argv.includes('--ready');
  check(process.env.MIRASIM_CONFIG || '/data/config.json', { readiness }).then((ok) => {
    if (!ok) console.error(readiness ? 'Bridge not ready' : 'Bridge liveness check failed');
    process.exitCode = ok ? 0 : 1;
  }).catch(() => { console.error('Bridge healthcheck failed'); process.exitCode = 1; });
}
module.exports = { check };
