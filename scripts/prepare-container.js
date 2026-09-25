#!/usr/bin/env node
'use strict';
// Offline one-time initialization. No admin API requests and no model calls.
const fs = require('node:fs');
const path = require('node:path');
const { newConfig, readConfig, credentialPath } = require('./deployment');
const { loadCredential } = require('../lib/relay');
const { portable } = require('./export-credential');

function prepare(options) {
  const dir = path.resolve(options.dataDir || '/data');
  if (dir === path.parse(dir).root) throw Error('Use a dedicated data directory, not the filesystem root');
  for (const value of [options.uid, options.gid]) {
    if (value !== undefined && (!Number.isInteger(value) || value < 1)) throw Error('uid/gid must be positive integers');
  }
  if ((options.uid === undefined) !== (options.gid === undefined)) throw Error('uid/gid must be specified together');
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const cfgPath = path.join(dir, 'config.json'), loginPath = path.join(dir, 'setting.json');
  const lockPath = path.join(dir, '.setup.lock');
  let lock;
  try { lock = fs.openSync(lockPath, 'wx', 0o600); }
  catch { throw Error('Setup is locked; stop other setup processes before checking .setup.lock'); }
  const secure = (file, mode) => {
    fs.chmodSync(file, mode);
    if (options.uid !== undefined) fs.chownSync(file, options.uid, options.gid);
  };
  try {
    const old = readConfig(dir);
    if (old) {
      if (old.backend !== 'relay') throw Error('This container supports backend=relay only');
      if (!old.bridge_secret) throw Error('Container config requires bridge_secret');
      if (old.listen.host !== (options.hostNetwork ? '127.0.0.1' : '0.0.0.0')) throw Error('Stored config uses a different network topology; stop the service and adjust config explicitly');
      if (credentialPath(dir, dir, old) !== loginPath) throw Error('Container credential file must resolve to /data/setting.json');
      loadCredential(loginPath);
      secure(cfgPath, 0o600); secure(loginPath, 0o600); secure(dir, 0o700);
      return { initialized: false, preserved: true };
    }
    let adminKey;
    try { adminKey = fs.readFileSync(options.adminKeyFile || '/run/secrets/sub2api_admin_key', 'utf8').trim(); }
    catch { throw Error('Cannot read admin key file'); }
    const cfg = newConfig({ dest: dir, url: options.url, name: options.name || 'mirasim-cloud',
      group: options.group, host: options.hostNetwork ? '127.0.0.1' : '0.0.0.0',
      publicUrl: options.publicUrl || (options.hostNetwork ? 'http://127.0.0.1:8787' : 'http://mirasim-bridge:8787'),
      backend: 'relay', adminKey });
    cfg.relay = { setting_json: 'setting.json' };
    cfg.forward = { failure_log: path.join(dir, 'requests.log') };
    // A partial previous setup may have copied a credential whose refresh token
    // has since rotated. Reuse it instead of overwriting it with the upload.
    if (fs.existsSync(loginPath)) loadCredential(loginPath);
    else {
      const source = loadCredential(options.settingFile || '/run/secrets/mirasim_credentials');
      if (!source.refresh) throw Error('Container setup requires a refresh token');
      fs.writeFileSync(loginPath, JSON.stringify(portable(source.raw), null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    }
    secure(loginPath, 0o600);
    // Config is the commit marker, created only after a valid credential exists.
    fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    secure(cfgPath, 0o600); secure(dir, 0o700);
    return { initialized: true, preserved: false };
  } finally { fs.closeSync(lock); fs.unlinkSync(lockPath); }
}

if (require.main === module) {
  try {
    const argv = process.argv.slice(2), options = {};
    const names = { '--data-dir': 'dataDir', '--setting-json': 'settingFile', '--admin-key-file': 'adminKeyFile',
      '--sub2api-url': 'url', '--group-id': 'group', '--account-name': 'name', '--public-base-url': 'publicUrl', '--uid': 'uid', '--gid': 'gid' };
    if (argv.includes('--help')) {
      console.log('prepare-container --sub2api-url URL --group-id ID [--host-network] [--data-dir /data]\nCredentials are read from mounted files. Existing configuration and refreshed tokens are preserved.');
    } else {
      for (let i = 0; i < argv.length; i++) {
        if (argv[i] === '--host-network') { options.hostNetwork = true; continue; }
        const key = names[argv[i]];
        if (!key || !argv[i + 1] || argv[i + 1].startsWith('--')) throw Error('Unknown option or missing value: ' + argv[i]);
        options[key] = ['uid', 'gid'].includes(key) ? Number(argv[++i]) : argv[++i];
      }
      const result = prepare(options);
      console.log(result.preserved ? 'Existing configuration and credentials preserved.' : 'Container data initialized. No upstream accounts were modified.');
    }
  } catch (err) { console.error(err.message); process.exitCode = 1; }
}
module.exports = { prepare };
