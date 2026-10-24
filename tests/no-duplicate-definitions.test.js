'use strict';
// A duplicated top-level definition does not always fail loudly: two identical
// function or const declarations in the same file are a SyntaxError, but a
// duplicated *file edit* can also land as a repeated block inside different
// scopes, or as a duplicated key in an object literal where the later one simply
// wins. Both have happened in this repo. This gate parses every shipped source
// file and rejects repeated top-level declarations and repeated object keys at
// the same nesting level — the shapes a repeated edit actually produces.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const FILES = [
  'mirasim-bridge.js', 'lib/panel.js', 'lib/relay.js', 'lib/responses.js', 'lib/roster.js',
  'lib/sse.js', 'lib/usage.js', 'lib/login.js', 'lib/quota.js', 'lib/membership.js',
  'lib/window-keeper.js', 'scripts/panel-bridge.js', 'scripts/account-login.js',
  'scripts/deployment.js', 'scripts/container-config.js', 'scripts/healthcheck.js',
  'scripts/export-credential.js', 'web/app.js', 'web/modal.js', 'web/undo.js',
];

/**
 * Top-level `function name` / `const name` / `let name` / `class name` declarations.
 * Only column-0 declarations count: indented ones belong to a function body and
 * legitimately repeat names across scopes.
 */
function topLevelDeclarations(source) {
  const found = [];
  for (const line of source.split('\n')) {
    const m = line.match(/^(?:async\s+)?(?:function\s+(\w+)|const\s+(\w+)|let\s+(\w+)|class\s+(\w+))/);
    if (m) found.push(m[1] || m[2] || m[3] || m[4]);
  }
  return found;
}

function repeated(names) {
  const seen = new Map();
  for (const name of names) seen.set(name, (seen.get(name) || 0) + 1);
  return [...seen].filter(([, n]) => n > 1).map(([name]) => name).sort();
}

test('no source file declares the same top-level name twice', () => {
  const problems = [];
  for (const rel of FILES) {
    const full = path.join(root, rel);
    if (!fs.existsSync(full)) continue;
    const dupes = repeated(topLevelDeclarations(fs.readFileSync(full, 'utf8')));
    if (dupes.length) problems.push(`${rel}: ${dupes.join(', ')}`);
  }
  assert.deepEqual(problems, [], 'duplicate top-level declarations (usually a doubled edit):\n' + problems.join('\n'));
});

/**
 * Repeated keys in a single object literal. A doubled edit inside an object is
 * silent at runtime — the last value wins — so it needs a static check.
 * This is deliberately narrow: it only looks at consecutive `key:` lines within
 * one brace level, which is exactly what a repeated insertion produces.
 */
function repeatedObjectKeys(source) {
  const problems = [];
  const lines = source.split('\n');
  let depth = 0;          // nesting at the start of the current line
  const stack = [];       // open object literals: { at, depthAtOpen, keys }

  const count = (line) => ({
    opens: (line.match(/[{[(]/g) || []).length,
    closes: (line.match(/[}\])]/g) || []).length,
  });

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const { opens, closes } = count(line);
    const top = stack[stack.length - 1];
    // A key belongs to a literal only when it sits exactly one level inside it and
    // that literal is the innermost open one. Anything deeper is a nested object.
    const m = line.match(/^(\s{2,})([A-Za-z_$][\w$]*)\s*:/);
    if (m && top && depth === top.depthAtOpen) top.keys.set(m[2], (top.keys.get(m[2]) || 0) + 1);

    const next = depth + opens - closes;
    // Close every literal we have dropped back out of.
    while (stack.length && next < stack[stack.length - 1].depthAtOpen) {
      const closed = stack.pop();
      const dupes = [...closed.keys].filter(([, n]) => n > 1).map(([k]) => k).sort();
      if (dupes.length) problems.push(`object opened at line ${closed.at + 1}: ${dupes.join(', ')}`);
    }
    // A fresh literal starts here when the line opens one and ends with `{`.
    if (opens > 0 && /(?:=|\(|,|return|=>)\s*\{$/.test(line.trimEnd())) {
      stack.push({ at: i, depthAtOpen: next, keys: new Map() });
    }
    depth = next;
  }
  return problems;
}

test('no object literal repeats a key', () => {
  const problems = [];
  for (const rel of FILES) {
    const full = path.join(root, rel);
    if (!fs.existsSync(full)) continue;
    for (const problem of repeatedObjectKeys(fs.readFileSync(full, 'utf8'))) problems.push(`${rel} ${problem}`);
  }
  assert.deepEqual(problems, [], 'duplicate object keys (the second value silently wins):\n' + problems.join('\n'));
});
