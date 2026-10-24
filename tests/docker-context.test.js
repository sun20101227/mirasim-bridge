'use strict';
// The Docker build context is an ALLOWLIST: `.dockerignore` starts with `**` and
// then re-includes individual files. That is the right default for a repo that
// holds live credentials, but it fails silently in the worst possible way —
// every test passes on the host checkout while the published image is missing a
// module and the container dies on `Cannot find module './lib/roster'`.
//
// This gate reads the real require graph and asserts that every local module the
// entry point can reach is re-included in `.dockerignore`. It is static: no
// Docker daemon needed, so it runs in the normal test pass.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');

/** Every relative module a file requires, resolved to repo-relative paths. */
function requiresOf(rel) {
  const source = read(rel).replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
  const out = [];
  for (const m of source.matchAll(/require\(\s*['"](\.[^'"]*)['"]\s*\)/g)) {
    const from = path.posix.dirname(rel);
    const base = path.posix.normalize(path.posix.join(from, m[1]));
    // Try the file, then the .js sibling, then an index file.
    for (const candidate of [base, base + '.js', base + '/index.js']) {
      const full = path.join(root, candidate);
      if (fs.existsSync(full) && fs.statSync(full).isFile()) { out.push(candidate); break; }
    }
  }
  return out;
}

/** Parse `.dockerignore` into the final allowlist decision for one path. */
function dockerAllows(rel, lines) {
  let allowed = false;
  for (const raw of lines) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const negate = line.startsWith('!');
    const pattern = negate ? line.slice(1) : line;
    if (matches(pattern, rel)) allowed = negate;
  }
  return allowed;
}

/** Docker's pattern subset: `**` (any depth), trailing `/` (subtree), `*` (within a segment). */
function matches(pattern, rel) {
  if (pattern.endsWith('/')) {
    const prefix = pattern.slice(0, -1);
    return rel === prefix || rel.startsWith(prefix + '/');
  }
  if (pattern.endsWith('/**')) return rel.startsWith(pattern.slice(0, -3) + '/');
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*\*/g, '\u0000').replace(/\*/g, '[^/]*').replace(/\u0000/g, '.*');
  return new RegExp('^' + escaped + '$').test(rel);
}

test('.dockerignore re-includes every module the image actually requires', () => {
  const lines = read('.dockerignore').split('\n');
  const entry = 'mirasim-bridge.js';

  // Walk the require graph from the entry point, staying inside the image's reach.
  const seen = new Set([entry]);
  const queue = [entry];
  while (queue.length) {
    const file = queue.shift();
    // Scripts are copied explicitly and are not required by the bridge at boot;
    // follow them anyway so a future import cannot slip through.
    for (const dep of requiresOf(file)) if (!seen.has(dep)) { seen.add(dep); queue.push(dep); }
  }

  const missing = [...seen].filter((rel) => !dockerAllows(rel, lines));
  assert.deepEqual(missing, [],
    'these files are required but excluded from the Docker build context (add !path entries to .dockerignore):\n  ' + missing.join('\n  '));
});

test('every allowlisted lib module exists, so the Dockerfile COPY cannot fail', () => {
  const lines = read('.dockerignore').split('\n');
  const declared = lines.filter((l) => l.startsWith('!lib/') && l.endsWith('.js')).map((l) => l.slice(1));
  const absent = declared.filter((rel) => !fs.existsSync(path.join(root, rel)));
  assert.deepEqual(absent, [], 'allowlisted lib modules that do not exist on disk:\n  ' + absent.join('\n  '));
});

test('the web assets the console loads are all inside the build context', () => {
  const lines = read('.dockerignore').split('\n');
  // index.html is the manifest of what the browser fetches; every /panel/ URL it
  // references must be shipped or the console breaks in the image only.
  const html = read('web/index.html');
  const referenced = [...html.matchAll(/\/panel\/([A-Za-z0-9_.-]+)/g)].map((m) => 'web/' + m[1]);
  const unique = [...new Set(referenced)];
  assert.ok(unique.length >= 5, 'expected the shell to reference several assets');
  const missing = unique.filter((rel) => !dockerAllows(rel, lines) || !fs.existsSync(path.join(root, rel)));
  assert.deepEqual(missing, [], 'assets referenced by web/index.html but not shipped:\n  ' + missing.join('\n  '));
});
