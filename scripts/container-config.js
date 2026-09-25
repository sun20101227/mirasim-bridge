#!/usr/bin/env node
'use strict';
// Run with the service stopped, as the runtime user. Input is JSON on stdin;
// never send credentials on the command line or echo them to container logs.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const b = require('../mirasim-bridge');

function apply(raw, file = '/data/config.json') {
  if (Buffer.byteLength(raw) > 1024 * 1024) throw Error('Configuration is too large');
  let parsed;
  try { parsed = JSON.parse(raw); } catch { throw Error('Invalid JSON configuration'); }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw Error('Configuration must be an object');
  const cfg = b.deepMerge(b.deepMerge({}, b.DEFAULT_CONFIG), parsed);
  b.validateConfig(cfg);
  if (cfg.backend !== 'relay' || !cfg.bridge_secret) throw Error('Container requires relay backend and bridge_secret');
  const dir = path.dirname(path.resolve(file));
  if (!cfg.relay.setting_json || path.resolve(dir, cfg.relay.setting_json) !== path.join(dir, 'setting.json')) throw Error('Keep relay.setting_json pointing to setting.json in the data volume');
  if (!fs.existsSync(file)) throw Error('Initialize the data volume with setup first');
  const temp = file + '.' + crypto.randomBytes(8).toString('hex') + '.tmp';
  try {
    const fd = fs.openSync(temp, 'wx', 0o600);
    try { fs.writeFileSync(fd, JSON.stringify(parsed, null, 2) + '\n'); fs.fsyncSync(fd); }
    finally { fs.closeSync(fd); }
    fs.renameSync(temp, file);
  } finally { try { fs.unlinkSync(temp); } catch { /* no temporary file */ } }
}

if (require.main === module) {
  (async () => {
    const chunks = []; let size = 0;
    for await (const chunk of process.stdin) {
      size += chunk.length;
      if (size > 1024 * 1024) throw Error('Configuration is too large');
      chunks.push(chunk);
    }
    const index = process.argv.indexOf('--config');
    const file = index >= 0 ? process.argv[index + 1] : process.env.MIRASIM_CONFIG || '/data/config.json';
    if (!file || (index >= 0 && !/^\/data\/profiles\/[a-z][a-z0-9_-]{0,39}\/config\.json$/.test(path.posix.normalize(file)))) throw Error('--config must point to /data/profiles/NAME/config.json');
    apply(Buffer.concat(chunks).toString('utf8'), file);
    console.log('Configuration saved. Start bridge and verify status.');
  })().catch((err) => { console.error(err.message); process.exitCode = 1; });
}
module.exports = { apply };
