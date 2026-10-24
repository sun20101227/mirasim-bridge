'use strict';
// Design gate for web/tokens.css. Reads the CSS sources as text - no browser,
// no rendering - and re-implements the WCAG 2.x contrast formula locally.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const readWeb = (file) => {
  const full = path.join(ROOT, 'web', file);
  assert.ok(fs.existsSync(full), `web/${file} missing`);
  return fs.readFileSync(full, 'utf8');
};

// WCAG 2.x relative luminance and contrast ratio.
const lum = (hex) => {
  const c = hex.match(/\w\w/g).map((x) => parseInt(x, 16) / 255)
    .map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
};
const contrast = (a, b) => {
  const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p);
  return (x + 0.05) / (y + 0.05);
};

const TEXT_TOKENS = ['--text', '--muted', '--faint', '--ok', '--warn', '--bad', '--info', '--accent'];
const SURFACE_TOKENS = ['--surface', '--surface-2', '--bg', '--accent-soft', '--ok-soft', '--warn-soft', '--bad-soft', '--info-soft'];
const REQUIRED_TOKENS = [...new Set([...TEXT_TOKENS, ...SURFACE_TOKENS, '--on-accent', '--side', '--side-text', '--side-strong'])];

function matchingBrace(text, open) {
  let depth = 0;
  let quote = null;
  for (let i = open; i < text.length; i++) {
    const ch = text[i];
    if (quote) {
      if (ch === '\\') i++;
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") { quote = ch; continue; }
    if (ch === '{') depth++;
    else if (ch === '}') { depth--; if (depth === 0) return i; }
  }
  return -1;
}

function splitSelectors(prelude) {
  const out = [];
  let start = 0;
  let depth = 0;
  let quote = null;
  for (let i = 0; i < prelude.length; i++) {
    const ch = prelude[i];
    if (quote) { if (ch === '\\') i++; else if (ch === quote) quote = null; continue; }
    if (ch === '"' || ch === "'") { quote = ch; continue; }
    if (ch === '(' || ch === '[') depth++;
    else if (ch === ')' || ch === ']') depth--;
    else if (ch === ',' && depth === 0) { out.push(prelude.slice(start, i).trim()); start = i + 1; }
  }
  out.push(prelude.slice(start).trim());
  return out.filter(Boolean);
}

function parseRules(css, media = [], out = []) {
  const text = css.replace(/\/\*[\s\S]*?\*\//g, '');
  let i = 0;
  while (i < text.length) {
    const open = text.indexOf('{', i);
    if (open < 0) break;
    const prelude = text.slice(i, open).trim();
    const close = matchingBrace(text, open);
    assert.ok(close > open, `web/tokens.css has unbalanced braces near "${prelude.slice(0, 60)}"`);
    const body = text.slice(open + 1, close);
    if (prelude.startsWith('@')) {
      const at = prelude.toLowerCase();
      if (at.startsWith('@media')) parseRules(body, media.concat(prelude.replace(/^@media\s*/i, '')), out);
      else if (at.startsWith('@supports') || at.startsWith('@layer')) parseRules(body, media, out);
    } else if (prelude) {
      out.push({ selectors: splitSelectors(prelude), media, body });
    }
    i = close + 1;
  }
  return out;
}

function declarations(body) {
  const parts = [];
  let start = 0;
  let depth = 0;
  let quote = null;
  for (let i = 0; i < body.length; i++) {
    const ch = body[i];
    if (quote) { if (ch === '\\') i++; else if (ch === quote) quote = null; continue; }
    if (ch === '"' || ch === "'") { quote = ch; continue; }
    if (ch === '(') depth++;
    else if (ch === ')') depth = Math.max(0, depth - 1);
    else if (ch === ';' && depth === 0) { parts.push(body.slice(start, i)); start = i + 1; }
  }
  parts.push(body.slice(start));
  const out = {};
  for (const part of parts) {
    const m = part.match(/^\s*(--[A-Za-z0-9_-]+)\s*:\s*([\s\S]*?)\s*$/);
    if (m) out[m[1]] = m[2];
  }
  return out;
}

function collect(rules, predicate) {
  const map = {};
  for (const rule of rules) if (predicate(rule)) Object.assign(map, declarations(rule.body));
  return map;
}

// Only unconditional top-level blocks define the base palette; contrast and
// forced-colors overrides must not be mistaken for the theme itself.
const isLightSelector = (s) => /^:root$/.test(s.trim());
const isExplicitDarkSelector = (s) => /^:root\s*\[data-theme\s*=\s*["']?dark["']?\s*\]$/i.test(s.trim());
const isMediaDarkRule = (rule) => rule.media.length > 0
  && rule.media.some((m) => /prefers-color-scheme\s*:\s*dark/i.test(m))
  && rule.selectors.some((s) => /^:root\b/.test(s.trim()));

let cache;
function loadTokens() {
  if (cache) return cache;
  const rules = parseRules(readWeb('tokens.css'));
  const topLevel = rules.filter((rule) => rule.media.length === 0);
  const light = collect(topLevel, (r) => r.selectors.some(isLightSelector));
  const explicitDark = collect(topLevel, (r) => r.selectors.some(isExplicitDarkSelector));
  const mediaDark = collect(rules, isMediaDarkRule);
  cache = { light, explicitDark, mediaDark, dark: { ...light, ...mediaDark, ...explicitDark } };
  return cache;
}

function toHex(value) {
  const v = String(value).trim();
  let m = v.match(/^#([0-9a-f]{3})$/i);
  if (m) return m[1].split('').map((c) => c + c).join('').toLowerCase();
  m = v.match(/^#([0-9a-f]{6})(?:[0-9a-f]{2})?$/i);
  if (m) return m[1].toLowerCase();
  m = v.match(/^rgba?\(\s*(\d+)[\s,]+(\d+)[\s,]+(\d+)/i);
  if (m) return [m[1], m[2], m[3]].map((n) => Math.min(255, Number(n)).toString(16).padStart(2, '0')).join('');
  // #rgb8 / #rrggbbaa shorthand handled by the two branches above; named colors
  // are intentionally unsupported so an opaque token cannot slip past the gate.
  return null;
}

function resolveToken(name, theme, base, seen = new Set()) {
  if (seen.has(name)) return { error: `${name} has a circular var() reference` };
  seen.add(name);
  const raw = theme[name] !== undefined ? theme[name] : base[name];
  if (raw === undefined) return { error: `${name} is not defined` };
  const ref = String(raw).trim().match(/^var\(\s*(--[A-Za-z0-9_-]+)/);
  if (ref) return resolveToken(ref[1], theme, base, seen);
  const hex = toHex(raw);
  if (!hex) return { error: `${name} value "${String(raw).trim()}" is not a resolvable color` };
  return { hex };
}

function contrastPairs() {
  const pairs = [];
  for (const fg of TEXT_TOKENS) for (const bg of SURFACE_TOKENS) pairs.push([fg, bg, 4.5]);
  pairs.push(['--on-accent', '--accent', 4.5]);
  pairs.push(['--side-strong', '--side', 4.5]);
  pairs.push(['--side-text', '--side', 4.5]);
  pairs.push(['--accent', '--surface', 3]);
  return pairs;
}

function contrastFailures(label, theme) {
  const { light } = loadTokens();
  const failures = [];
  for (const [fgName, bgName, min] of contrastPairs()) {
    const fg = resolveToken(fgName, theme, light);
    const bg = resolveToken(bgName, theme, light);
    if (fg.error || bg.error) {
      failures.push(`${label}: ${fg.error || bg.error}`);
      continue;
    }
    const ratio = contrast(fg.hex, bg.hex);
    if (!(ratio >= min - 1e-9)) failures.push(`${label}: ${fgName} on ${bgName} = ${ratio.toFixed(2)} (need >= ${min})`);
  }
  return failures;
}

test('tokens-present: tokens.css owns the palette and defines all three theme blocks', () => {
  const css = readWeb('tokens.css');
  assert.ok(css.trim().length > 0, 'web/tokens.css is empty');
  const { light, explicitDark, mediaDark } = loadTokens();
  assert.ok(Object.keys(light).length > 0, 'web/tokens.css has no ":root { --token: ... }" light block');
  const missing = REQUIRED_TOKENS.filter((token) => !(token in light));
  assert.deepEqual(missing, [], `web/tokens.css light :root is missing tokens: ${missing.join(', ')}`);
  assert.ok(Object.keys(explicitDark).length > 0, 'web/tokens.css has no :root[data-theme="dark"] block');
  assert.ok(Object.keys(mediaDark).length > 0, 'web/tokens.css has no @media (prefers-color-scheme: dark) :root block');

  const styleCss = readWeb('style.css');
  const ownTokens = parseRules(styleCss)
    .filter((rule) => rule.selectors.some((s) => /^:root\b/.test(s.trim())) && /--[A-Za-z0-9_-]+\s*:/.test(rule.body));
  assert.deepEqual(ownTokens.map((rule) => rule.selectors.join(', ')), [],
    'web/style.css must not declare design tokens; move them to web/tokens.css');
});

test('contrast-light: light theme text and UI pairs pass WCAG AA', () => {
  const { light } = loadTokens();
  const failures = contrastFailures('light', light);
  assert.deepEqual(failures, [], `light theme contrast failures:\n  ${failures.join('\n  ')}`);
});

test('contrast-dark: dark theme text and UI pairs pass WCAG AA', () => {
  const { dark } = loadTokens();
  const failures = contrastFailures('dark', dark);
  assert.deepEqual(failures, [], `dark theme contrast failures:\n  ${failures.join('\n  ')}`);
});

test('theme-parity: every light token is redefined by both dark blocks', () => {
  const { light, explicitDark, mediaDark } = loadTokens();
  const lightKeys = Object.keys(light);
  assert.ok(lightKeys.length > 0, 'web/tokens.css has no light :root tokens to compare');
  const problems = [];
  const missingExplicit = lightKeys.filter((token) => !(token in explicitDark));
  const missingMedia = lightKeys.filter((token) => !(token in mediaDark));
  if (missingExplicit.length) problems.push(`missing from :root[data-theme="dark"]: ${missingExplicit.join(', ')}`);
  if (missingMedia.length) problems.push(`missing from prefers-color-scheme dark: ${missingMedia.join(', ')}`);
  assert.deepEqual(problems, [], `dark themes must redefine every light token:\n  ${problems.join('\n  ')}`);
});
