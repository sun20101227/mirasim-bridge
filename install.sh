#!/usr/bin/env bash
# Linux/systemd installer. Never starts the service or replaces existing config.
set -euo pipefail
umask 077
die() { echo "ERROR: $*" >&2; exit 1; }
usage() {
  cat <<'EOF'
Fresh install:
  sudo bash install.sh --setting-json FILE --sub2api-url URL --group-id ID \
    [--admin-key-file FILE] [--backend relay|session] [--account-name mirasim-cloud]
Upgrade (preserves configuration and refreshed credentials):
  sudo systemctl stop mirasim-bridge
  sudo bash install.sh
Options:
  --user mirasim --listen-host 127.0.0.1 --public-base-url URL
  --replace-setting --setting-json FILE  (backup and replace configured credentials)
  --server-cjs FILE  (session only; existing installed file can be reused)
Requires Linux/systemd and Node >=18. Relay needs no Claude CLI/server.cjs.
Existing config wins over CLI options, including backend. Service stays stopped.
EOF
}
SERVER_CJS='' SETTING_JSON='' SUB2API_URL='' GROUP_ID='' KEY_FILE=''
ACCOUNT_NAME='mirasim-cloud' SVC_USER='mirasim' LISTEN_HOST='127.0.0.1'
PUBLIC_BASE_URL='' REPLACE_SETTING=0 BACKEND='relay'
ADMIN_KEY="${ADMIN_KEY:-}"
while (($#)); do
  case "$1" in
    -h|--help) usage; exit 0 ;;
    --replace-setting) REPLACE_SETTING=1; shift; continue ;;
    --backend|--server-cjs|--setting-json|--sub2api-url|--group-id|--admin-key-file|--account-name|--user|--listen-host|--public-base-url)
      (($# >= 2)) && [[ "$2" != --* && -n "$2" ]] || die "Missing value for $1" ;;
    *) die "Unknown option: $1" ;;
  esac
  case "$1" in
    --backend) BACKEND="$2" ;; --server-cjs) SERVER_CJS="$2" ;;
    --setting-json) SETTING_JSON="$2" ;; --sub2api-url) SUB2API_URL="$2" ;;
    --group-id) GROUP_ID="$2" ;; --admin-key-file) KEY_FILE="$2" ;;
    --account-name) ACCOUNT_NAME="$2" ;; --user) SVC_USER="$2" ;;
    --listen-host) LISTEN_HOST="$2" ;; --public-base-url) PUBLIC_BASE_URL="$2" ;;
  esac
  shift 2
done
[[ "$(uname -s)" == Linux && "$EUID" == 0 ]] || die 'Run on Linux with sudo'
[[ "$SVC_USER" =~ ^[a-z_][a-z0-9_-]*$ && "$SVC_USER" != root ]] || die 'Invalid service user'
[[ "$BACKEND" == relay || "$BACKEND" == session ]] || die 'Invalid backend'
for cmd in node systemctl runuser getent install readlink id; do command -v "$cmd" >/dev/null || die "Missing: $cmd"; done
[[ -d /run/systemd/system ]] || die 'systemd is required (not a plain container)'
if systemctl is-active --quiet mirasim-bridge; then die 'Stop mirasim-bridge before upgrading'; fi
NODE_BIN=$(command -v node)
[[ "$(node -p 'Number(process.versions.node.split(".")[0]) >= 18')" == true ]] || die 'Node >=18 required'
SCRIPT_DIR=$(cd -- "$(dirname -- "$0")" && pwd)
DEST=/opt/mirasim-bridge
FILES=(mirasim-bridge.js lib/relay.js lib/responses.js lib/login.js lib/quota.js lib/sse.js lib/usage.js lib/panel.js lib/membership.js lib/window-keeper.js web/index.html web/app.js web/style.css web/icon.png scripts/account-login.js scripts/deployment.js scripts/panel-bridge.js MEMBERSHIP-WINDOWS.md USAGE.md ACCOUNTS.md UPGRADE-0.5.0.md README.md DEPLOY.md DOCKER.md SUB2API-PLUGIN.md MULTI-MODEL.md RELAY.md AUDIT.md CHANGELOG.md DESIGN.md THIRD-PARTY-NOTICES.md licenses/cpa-plugin-mirasim.txt licenses/CLIProxyAPI.txt config.example.json)
for file in "${FILES[@]}" mirasim-bridge.service; do [[ -f "$SCRIPT_DIR/$file" ]] || die "Package incomplete: $file"; done
for file in mirasim-bridge.js lib/relay.js lib/responses.js lib/login.js lib/quota.js lib/sse.js lib/usage.js lib/panel.js lib/membership.js lib/window-keeper.js scripts/account-login.js scripts/deployment.js; do node --check "$SCRIPT_DIR/$file"; done
EXISTING=0
if [[ -f "$DEST/config.json" ]]; then
  EXISTING=1
  BACKEND=$(node - "$SCRIPT_DIR" "$DEST" <<'NODE'
try { process.stdout.write(require(process.argv[2] + '/scripts/deployment').readConfig(process.argv[3]).backend); }
catch (e) { console.error(e.message); process.exit(1); }
NODE
)
else
  [[ "$GROUP_ID" =~ ^[1-9][0-9]*$ && -n "$SUB2API_URL" ]] || die 'Fresh install requires --sub2api-url and --group-id'
  if [[ -n "$KEY_FILE" ]]; then
    [[ -r "$KEY_FILE" ]] || die 'Cannot read admin key file'
    ADMIN_KEY=$(cat -- "$KEY_FILE")
  elif [[ -z "$ADMIN_KEY" ]]; then
    read -r -s -p 'sub2api admin API key: ' ADMIN_KEY </dev/tty
    echo
  fi
  [[ -n "$ADMIN_KEY" ]] || die 'Admin key is empty'
fi
SERVICE_PATH="$(dirname "$NODE_BIN"):/usr/local/bin:/usr/bin:/bin"
if [[ "$BACKEND" == session ]]; then
  SERVER_CJS="${SERVER_CJS:-$DEST/server.cjs}"
  [[ -f "$SERVER_CJS" ]] || die 'Session backend requires --server-cjs FILE'
  node --check "$SERVER_CJS"
  command -v claude >/dev/null || die 'Session backend requires Claude CLI'
  SERVICE_PATH="$(dirname "$(command -v claude)"):$SERVICE_PATH"
fi
if ! id "$SVC_USER" >/dev/null 2>&1; then
  useradd --system --user-group --create-home --home-dir "/var/lib/$SVC_USER" --shell /usr/sbin/nologin "$SVC_USER"
fi
[[ "$(id -u "$SVC_USER")" != 0 ]] || die 'Service account must not have UID 0'
SVC_HOME=$(getent passwd "$SVC_USER" | cut -d: -f6)
SVC_GROUP=$(id -gn "$SVC_USER")
[[ "$SVC_HOME" == /* && "$SVC_HOME" != / && "$SVC_HOME" != /root ]] || die 'Unsafe service home'
for value in "$NODE_BIN" "$SVC_HOME" "$SERVICE_PATH"; do [[ "$value" =~ ^[a-zA-Z0-9_./:-]+$ ]] || die 'Use simple system-wide paths'; done
runuser -u "$SVC_USER" -- env HOME="$SVC_HOME" PATH="$SERVICE_PATH" "$NODE_BIN" --version
if [[ "$BACKEND" == session ]]; then runuser -u "$SVC_USER" -- env HOME="$SVC_HOME" PATH="$SERVICE_PATH" claude --version; fi
SETTING_DEST=$(node - "$SCRIPT_DIR" "$DEST" "$SVC_HOME" <<'NODE'
const d = require(process.argv[2] + '/scripts/deployment');
process.stdout.write(d.credentialPath(process.argv[3], process.argv[4], d.readConfig(process.argv[3])));
NODE
)
[[ "$SETTING_DEST" == /* && "$SETTING_DEST" == *.json && ! -L "$SETTING_DEST" ]] || die 'Credential destination must be an absolute .json path, not a symlink'
COPY_SETTING=0
if [[ ! -f "$SETTING_DEST" || "$REPLACE_SETTING" == 1 ]]; then
  [[ -f "$SETTING_JSON" ]] || die 'Provide --setting-json FILE (export mrs1 credentials on original machine first)'
  COPY_SETTING=1
  CHECK_SETTING="$SETTING_JSON"
else
  CHECK_SETTING="$SETTING_DEST"
fi
node - "$SCRIPT_DIR" "$CHECK_SETTING" "$BACKEND" <<'NODE'
try {
  const [dir, file, backend] = process.argv.slice(2);
  if (backend === 'relay') require(dir + '/lib/relay').loadCredential(file);
  else {
    const s = JSON.parse(require('fs').readFileSync(file, 'utf8'));
    if (!s?.auth?.token || !s?.device?.privateKey) throw Error('Session requires desktop-format setting.json');
  }
} catch (e) { console.error(e.message); process.exit(1); }
NODE
# Validate fresh config before replacing application files.
if [[ "$EXISTING" == 0 ]]; then
  export ADMIN_KEY
  node - "$SCRIPT_DIR" "$DEST" "$SUB2API_URL" "$ACCOUNT_NAME" "$GROUP_ID" "$LISTEN_HOST" "$PUBLIC_BASE_URL" "$BACKEND" <<'NODE'
const [dir, dest, url, name, group, host, publicUrl, backend] = process.argv.slice(2);
require(dir + '/scripts/deployment').newConfig({ dest, url, name, group, host, publicUrl, backend, adminKey: process.env.ADMIN_KEY });
NODE
fi
install -d -m 0750 -o "$SVC_USER" -g "$SVC_GROUP" "$DEST" "$DEST/lib" "$DEST/licenses" "$DEST/scripts"
for file in "${FILES[@]}"; do
  [[ "$(readlink -f "$SCRIPT_DIR/$file")" == "$DEST/$file" ]] || install -m 0644 "$SCRIPT_DIR/$file" "$DEST/$file"
done
if [[ "$BACKEND" == session ]]; then
  [[ "$(readlink -f "$SERVER_CJS")" == "$DEST/server.cjs" ]] || install -m 0644 "$SERVER_CJS" "$DEST/server.cjs"
fi
if [[ "$COPY_SETTING" == 1 ]]; then
  # Leave existing custom parent directory permissions untouched.
  if [[ ! -d "$(dirname "$SETTING_DEST")" ]]; then install -d -m 0700 -o "$SVC_USER" -g "$SVC_GROUP" "$(dirname "$SETTING_DEST")"; fi
  if [[ -f "$SETTING_DEST" ]]; then install -m 0600 -o "$SVC_USER" -g "$SVC_GROUP" "$SETTING_DEST" "$SETTING_DEST.bak.$(date +%s)"; fi
  [[ "$(readlink -f "$SETTING_JSON")" == "$SETTING_DEST" ]] || install -m 0600 -o "$SVC_USER" -g "$SVC_GROUP" "$SETTING_JSON" "$SETTING_DEST"
else
  echo 'Preserving refreshed credentials; --setting-json is ignored without --replace-setting.'
fi
if [[ "$EXISTING" == 0 ]]; then
  node - "$DEST" "$SUB2API_URL" "$ACCOUNT_NAME" "$GROUP_ID" "$LISTEN_HOST" "$PUBLIC_BASE_URL" "$BACKEND" <<'NODE'
const fs = require('fs');
const [dest, url, name, group, host, publicUrl, backend] = process.argv.slice(2);
const cfg = require(dest + '/scripts/deployment').newConfig({ dest, url, name, group, host, publicUrl, backend, adminKey: process.env.ADMIN_KEY });
fs.writeFileSync(dest + '/config.json', JSON.stringify(cfg, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
NODE
else
  echo 'Preserving config.json. CLI flags do not override existing configuration.'
fi
unset ADMIN_KEY
chown "$SVC_USER:$SVC_GROUP" "$DEST/config.json"
chmod 0600 "$DEST/config.json"
runuser -u "$SVC_USER" -- test -r "$SETTING_DEST" || die 'Service user cannot read credentials'
runuser -u "$SVC_USER" -- test -w "$(dirname "$SETTING_DEST")" || die 'Credential directory must be writable for atomic refresh'
node - "$SCRIPT_DIR/mirasim-bridge.service" "$DEST" "$SVC_USER" "$SVC_GROUP" "$NODE_BIN" "$SVC_HOME" "$SERVICE_PATH" <<'NODE'
const fs = require('fs');
const [template, dest, user, group, node, home, servicePath] = process.argv.slice(2);
const d = require(dest + '/scripts/deployment');
const unit = d.renderUnit(fs.readFileSync(template, 'utf8'), { user, group, node, home, servicePath, totalTimeout: d.readConfig(dest).shutdown.total_timeout_sec });
fs.writeFileSync('/etc/systemd/system/mirasim-bridge.service', unit, { mode: 0o644 });
NODE
systemctl daemon-reload
cd "$DEST"
if ! runuser -u "$SVC_USER" -- env HOME="$SVC_HOME" PATH="$SERVICE_PATH" "$NODE_BIN" mirasim-bridge.js doctor; then
  die 'Installed, but doctor failed. Service was NOT started; see DEPLOY.md.'
fi
echo 'Next: sudo systemctl enable --now mirasim-bridge'
echo 'Logs: sudo journalctl -u mirasim-bridge -f'
