'use strict';
const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');
const { DEFAULT_CONFIG, deepMerge, validateConfig } = require('../mirasim-bridge');

function readConfig(dest) {
  const file = path.join(dest, 'config.json');
  if (!fs.existsSync(file)) return null;
  let raw;
  try { raw = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')); }
  catch { throw Error('Existing config.json is not valid JSON; it has not been overwritten'); }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw Error('Existing config must be an object');
  const cfg = deepMerge(deepMerge({}, DEFAULT_CONFIG), raw);
  validateConfig(cfg);
  return cfg;
}

function credentialPath(dest, home, cfg) {
  if (cfg?.backend === 'relay' && cfg.relay.setting_json) return path.resolve(dest, cfg.relay.setting_json);
  return path.join(home, '.mirasim', 'setting.json');
}

function newConfig({ dest, url, name, group, host, publicUrl, backend, adminKey }) {
  const cfg = { backend, listen: { host, port: 8787 },
    sub2api: { base_url: url, admin_api_key: adminKey, account_name: name, group_ids: [Number(group)], concurrency: 2, public_base_url: publicUrl },
    bridge_secret: crypto.randomBytes(32).toString('hex'),
    keepalive: { enabled: backend === 'session', server_cjs: path.join(dest, 'server.cjs') } };
  validateConfig(deepMerge(deepMerge({}, DEFAULT_CONFIG), cfg));
  if (!url || !name || typeof adminKey !== 'string' || !adminKey.trim() || /[\r\n\0]/.test(adminKey)) throw Error('Fresh installation requires valid sub2api URL, account name and admin key');
  return cfg;
}

function renderUnit(template, { user, group, node, home, servicePath, totalTimeout }) {
  for (const value of [user, group]) if (!/^[a-z_][a-z0-9_-]*$/.test(value) || value === 'root') throw Error('Invalid service user/group');
  for (const value of [node, home, servicePath]) if (!/^[a-zA-Z0-9_./:-]+$/.test(value)) throw Error('Use simple system-wide service paths');
  return template.replace(/\r\n/g, '\n')
    .replace(/^User=.*$/m, 'User=' + user).replace(/^Group=.*$/m, 'Group=' + group)
    .replace(/^ExecStart=.*$/m, 'ExecStart=' + node + ' /opt/mirasim-bridge/mirasim-bridge.js serve')
    .replace(/^Environment=HOME=.*$/m, 'Environment=HOME=' + home)
    .replace(/^Environment=PATH=.*$/m, 'Environment=PATH=' + servicePath)
    .replace(/^TimeoutStopSec=.*$/m, 'TimeoutStopSec=' + Math.max(180, totalTimeout + 15));
}

module.exports = { readConfig, credentialPath, newConfig, renderUnit };
