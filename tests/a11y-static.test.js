'use strict';
// Design gate for the static panel shell. This file reads web/index.html and
// web/app.js as source text (regex + a tiny tag scanner); it never renders a page.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
function readWeb(file) {
  const full = path.join(ROOT, 'web', file);
  assert.ok(fs.existsSync(full), `web/${file} missing`);
  return fs.readFileSync(full, 'utf8');
}

const VOID = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr']);
const CONTROLS = new Set(['input', 'select', 'textarea']);

function parseAttrs(text) {
  const attrs = {};
  const re = /([^\s"'>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>=]+)))?/g;
  let m;
  while ((m = re.exec(text))) {
    const name = m[1].toLowerCase();
    const value = m[2] !== undefined ? m[2] : m[3] !== undefined ? m[3] : m[4] !== undefined ? m[4] : '';
    if (!(name in attrs)) attrs[name] = value;
  }
  return attrs;
}

// Small tolerant HTML scanner: enough to know nesting and attributes.
function scanHtml(source) {
  const root = { name: '#document', attrs: {}, children: [], line: 1, raw: '' };
  const stack = [root];
  const all = [];
  let i = 0;
  let line = 1;
  const advance = (to) => {
    const end = Math.min(to, source.length);
    for (let k = i; k < end; k++) if (source[k] === '\n') line++;
    i = end;
  };
  while (i < source.length) {
    const lt = source.indexOf('<', i);
    if (lt < 0) break;
    advance(lt);
    if (source.startsWith('<!--', i)) {
      const end = source.indexOf('-->', i + 4);
      advance(end < 0 ? source.length : end + 3);
      continue;
    }
    if (source.startsWith('<![CDATA[', i)) {
      const end = source.indexOf(']]>', i);
      advance(end < 0 ? source.length : end + 3);
      continue;
    }
    const next = source[i + 1] || '';
    if (next === '!' || next === '?') {
      const end = source.indexOf('>', i);
      advance(end < 0 ? source.length : end + 1);
      continue;
    }
    if (next === '/') {
      const end = source.indexOf('>', i);
      const name = source.slice(i + 2, end < 0 ? source.length : end).trim().toLowerCase();
      for (let s = stack.length - 1; s > 0; s--) {
        if (stack[s].name === name) { stack.length = s; break; }
      }
      advance(end < 0 ? source.length : end + 1);
      continue;
    }
    if (!/[A-Za-z]/.test(next)) { advance(i + 1); continue; }
    let j = i + 1;
    let quote = null;
    while (j < source.length) {
      const ch = source[j];
      if (quote) { if (ch === quote) quote = null; }
      else if (ch === '"' || ch === "'") quote = ch;
      else if (ch === '>') break;
      j++;
    }
    const raw = source.slice(i, Math.min(j + 1, source.length));
    const inner = raw.slice(1, raw.endsWith('>') ? -1 : undefined);
    const m = inner.match(/^([A-Za-z][^\s/>]*)/);
    if (!m) { advance(i + 1); continue; }
    const name = m[1].toLowerCase();
    const node = {
      name,
      attrs: parseAttrs(inner.slice(m[1].length)),
      children: [],
      line,
      raw: raw.length > 120 ? raw.slice(0, 117) + '...' : raw,
    };
    node.parent = stack[stack.length - 1];
    node.parent.children.push(node);
    all.push(node);
    const selfClose = /\/\s*$/.test(inner);
    if (!selfClose && !VOID.has(name)) stack.push(node);
    advance(j + 1);
    if (!selfClose && (name === 'script' || name === 'style' || name === 'textarea')) {
      const close = source.slice(i).match(new RegExp('</\\s*' + name + '\\s*>', 'i'));
      if (close) {
        advance(i + close.index + close[0].length);
        if (stack[stack.length - 1] === node) stack.pop();
      }
    }
  }
  return { root, all };
}

function walk(node, visit) {
  for (const child of node.children) { visit(child); walk(child, visit); }
}
const descendants = (node, name) => {
  const out = [];
  walk(node, (n) => { if (n.name === name) out.push(n); });
  return out;
};
const describe = (node) => {
  const first = Object.entries(node.attrs).find(([key, value]) => value !== '' || key === 'id');
  const id = node.attrs.id ? ` id="${node.attrs.id}"` : '';
  const attr = first ? ` ${first[0]}="${first[1]}"` : '';
  return `<${node.name}${id || attr}> (line ${node.line})`;
};
const classes = (node) => String(node.attrs.class || '').split(/\s+/).filter(Boolean);
const labels = new Map();

// Blank out comments and string/template literals while keeping every newline,
// so line numbers in reports stay accurate and prose cannot trip the scan.
function stripJs(src) {
  const out = src.split('');
  const blank = (from, to) => { for (let k = from; k < to; k++) if (out[k] !== '\n') out[k] = ' '; };
  let i = 0;
  while (i < src.length) {
    if (src.startsWith('//', i)) {
      const end = src.indexOf('\n', i);
      const stop = end < 0 ? src.length : end;
      blank(i, stop); i = stop;
    } else if (src.startsWith('/*', i)) {
      const end = src.indexOf('*/', i + 2);
      const stop = end < 0 ? src.length : end + 2;
      blank(i, stop); i = stop;
    } else if (src[i] === '"' || src[i] === "'" || src[i] === '`') {
      const quote = src[i];
      let j = i + 1;
      while (j < src.length) {
        if (src[j] === '\\') { j += 2; continue; }
        if (src[j] === quote) break;
        j++;
      }
      blank(i + 1, Math.min(j, src.length)); i = j + 1;
    } else i++;
  }
  return out.join('');
}

function extractComments(src) {
  const out = [];
  let i = 0;
  while (i < src.length) {
    if (src.startsWith('//', i)) {
      const end = src.indexOf('\n', i);
      const stop = end < 0 ? src.length : end;
      out.push(src.slice(i + 2, stop)); i = stop;
    } else if (src.startsWith('/*', i)) {
      const end = src.indexOf('*/', i + 2);
      const stop = end < 0 ? src.length : end;
      out.push(src.slice(i + 2, stop)); i = stop + 2;
    } else if (src[i] === '"' || src[i] === "'" || src[i] === '`') {
      const quote = src[i];
      let j = i + 1;
      while (j < src.length) {
        if (src[j] === '\\') { j += 2; continue; }
        if (src[j] === quote) break;
        j++;
      }
      i = j + 1;
    } else i++;
  }
  return out.join('\n');
}

function lineOf(src, index) {
  let line = 1;
  for (let k = 0; k < index; k++) if (src[k] === '\n') line++;
  return line;
}

function html() {
  if (!html.value) html.value = scanHtml(readWeb('index.html'));
  return html.value;
}

test('html-structure: tables captioned, headers scoped, one h1, lang, theme-color, no inline style', () => {
  const { all } = html();
  const problems = [];

  for (const table of all.filter((node) => node.name === 'table')) {
    if (!descendants(table, 'caption').length) problems.push(`<table> without <caption> at line ${table.line}`);
  }

  for (const th of all.filter((node) => node.name === 'th')) {
    if (!/^(col|row)$/i.test(String(th.attrs.scope || '').trim())) {
      problems.push(`<th> without scope="col" or scope="row" at line ${th.line}`);
    }
  }

  const h1s = all.filter((node) => node.name === 'h1');
  if (h1s.length !== 1) problems.push(`expected exactly one <h1>, found ${h1s.length}`);

  const htmlTag = all.find((node) => node.name === 'html');
  const lang = htmlTag ? String(htmlTag.attrs.lang || '') : '';
  if (!/^zh-CN$/i.test(lang)) problems.push(`<html lang="${lang}"> must stay lang="zh-CN"`);

  if (!all.some((node) => node.name === 'meta' && String(node.attrs.name || '').toLowerCase() === 'theme-color')) {
    problems.push('missing <meta name="theme-color">');
  }

  for (const node of all) {
    if ('style' in node.attrs) problems.push(`inline style attribute on ${describe(node)}`);
  }

  assert.deepEqual(problems, [], `index.html structure violations:\n  ${problems.join('\n  ')}`);
});

test('html-labels: every input/select/textarea is labelled', () => {
  const { all } = html();
  labels.clear();
  for (const label of all.filter((node) => node.name === 'label')) {
    const forId = String(label.attrs.for || '').trim();
    if (forId) {
      if (!labels.has(forId)) labels.set(forId, []);
      labels.get(forId).push(label);
    }
  }

  const failures = [];
  for (const control of all.filter((node) => CONTROLS.has(node.name))) {
    const insideLabel = (() => {
      for (let p = control.parent; p && p.name !== '#document'; p = p.parent) {
        if (p.name === 'label') return true;
      }
      return false;
    })();
    const id = String(control.attrs.id || '').trim();
    const aria = String(control.attrs['aria-label'] || '').trim() || String(control.attrs['aria-labelledby'] || '').trim();
    const labelledByFor = id && labels.has(id);
    if (!insideLabel && !labelledByFor && !aria) {
      failures.push(id ? `<${control.name} id="${id}"> (line ${control.line}) has no label` : `${describe(control)} has no label`);
    }
  }

  assert.deepEqual(failures, [], `unlabelled form controls:\n  ${failures.join('\n  ')}`);
});

test('html-navigation: skip link and three-way theme switcher exist', () => {
  const { all } = html();
  const problems = [];

  const skip = all.filter((node) => node.name === 'a' && classes(node).includes('skip-link')
    && /^#.+/.test(String(node.attrs.href || '')));
  if (skip.length === 0) problems.push('missing <a class="skip-link" href="#main">');
  if (skip.length > 1) problems.push(`expected one skip link, found ${skip.length}`);
  for (const node of skip) {
    const target = String(node.attrs.href).slice(1);
    if (!/^main\b/i.test(target)) problems.push(`skip link must target #main (got href="${node.attrs.href}")`);
    else if (!all.some((el) => String(el.attrs.id || '') === target)) problems.push(`skip link target #${target} has no matching element`);
  }

  const switchers = all.filter((node) => classes(node).includes('theme-switch'));
  if (switchers.length !== 1) {
    problems.push(`expected exactly one .theme-switch element, found ${switchers.length}`);
  } else {
    const buttons = descendants(switchers[0], 'button').filter((node) => 'data-theme-choice' in node.attrs);
    const values = buttons.map((node) => String(node.attrs['data-theme-choice']));
    const wanted = ['system', 'light', 'dark'];
    const missing = wanted.filter((value) => !values.includes(value));
    const unexpected = values.filter((value) => !wanted.includes(value));
    if (buttons.length !== 3) problems.push(`.theme-switch needs exactly three buttons with data-theme-choice, found ${buttons.length}`);
    if (missing.length) problems.push(`.theme-switch missing data-theme-choice values: ${missing.join(', ')}`);
    if (unexpected.length) problems.push(`.theme-switch has unexpected data-theme-choice values: ${unexpected.join(', ')}`);
  }

  assert.deepEqual(problems, [], `navigation violations:\n  ${problems.join('\n  ')}`);
});

test('js-no-blocking-dialogs: app.js uses no confirm/alert/prompt', () => {
  const source = readWeb('app.js');
  const code = stripJs(source);
  const hits = [];
  const seen = new Set();
  const record = (call, index) => {
    const line = lineOf(source, index);
    if (seen.has(`${line}:${call}`)) return;
    seen.add(`${line}:${call}`);
    const text = source.split('\n')[line - 1].trim();
    hits.push(`line ${line}: ${call}(  -- ${text.slice(0, 90)}`);
  };
  // Bare global calls plus explicit window/globalThis/self aliases; an
  // object-qualified call such as `MiraModal.confirm(` is the in-page dialog.
  const bare = /(?:^|[^.\w$])(confirm|alert|prompt)\s*\(/g;
  let m;
  while ((m = bare.exec(code))) record(m[1], m.index + m[0].indexOf(m[1]));
  const native = /\b(?:window|globalThis|self|win|rootWin)\s*\.\s*(confirm|alert|prompt)\s*\(/g;
  while ((m = native.exec(code))) record(`${m[0].split('(')[0]}`.trim() + '(', m.index);
  assert.deepEqual(hits, [], `native blocking dialogs must be replaced by the in-page .dialog component:\n  ${hits.join('\n  ')}`);
});

test('js-routing-and-theme: theme is written to the document element, hash routing is live, field errors are associated', () => {
  const source = readWeb('app.js');
  const code = stripJs(source);
  const problems = [];

  // `root` aliases document.documentElement in this codebase, so accept either
  // the direct dataset write or an alias that is itself bound to documentElement.
  const rootAlias = /(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*[^;\n]*document\.documentElement/.exec(code);
  const writesTheme = /documentElement\.dataset\.theme\s*=/.test(code)
    || /documentElement\.setAttribute\(\s*['"`]data-theme/.test(code)
    || (rootAlias && new RegExp('\\b' + rootAlias[1].replace(/[$]/g, '\\$&') + '\\.dataset\\.theme\\s*=').test(code));
  if (!writesTheme) problems.push('app.js never writes document.documentElement.dataset.theme (theme switching is dead code)');

  if (!/['"]hashchange['"]/.test(code) && !/hashchange/.test(source)) problems.push('app.js does not listen for "hashchange"');
  if (!/location\.hash\b/.test(code)) problems.push('app.js never reads location.hash (views are not deep-linkable)');

  const commentText = extractComments(source);
  const markedComment = /form|field|input|label/i.test(commentText)
    && /(aria-invalid|aria-errormessage|aria-describedby|error[- ]?associat|associat\w*\s+(?:each\s+)?(?:field\s+)?error)/i.test(commentText);
  if (!/aria-invalid/.test(code) && !markedComment) {
    problems.push('app.js neither sets aria-invalid nor documents how form field errors are associated');
  }

  assert.deepEqual(problems, [], `app.js a11y/routing violations:\n  ${problems.join('\n  ')}`);
});
