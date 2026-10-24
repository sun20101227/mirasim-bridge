/*!
 * MiraToast — non-blocking status toasts with an optional Undo action.
 *
 * Classic script (no modules). Defines window.MiraToast.
 * No dependencies, no innerHTML. Every DOM call is guarded so the file also
 * loads in a minimal fake-DOM or fully headless (no document) context.
 *
 *   MiraToast.show({ text, tone?, timeoutMs? })
 *   MiraToast.undo({ text, undoLabel?, timeoutMs?, onUndo })
 *   MiraToast.dismissAll()
 */
(function () {
  'use strict';

  var MAX_VISIBLE = 4;
  var DEFAULT_UNDO_MS = 8000;
  var DEFAULT_SHOW_MS = 5000;
  var TONES = { ok: 1, warn: 1, bad: 1, info: 1 };

  var stack = null;
  var live = [];

  /* ---------------------------------------------------------------- env */

  function doc() {
    return typeof document !== 'undefined' && document ? document : null;
  }

  function nowMs() {
    return typeof Date !== 'undefined' && Date.now ? Date.now() : 0;
  }

  function timerApi() {
    var g = typeof globalThis !== 'undefined' ? globalThis : null;
    var set = g && typeof g.setTimeout === 'function' ? g.setTimeout : null;
    var clear = g && typeof g.clearTimeout === 'function' ? g.clearTimeout : null;
    if (!set || !clear) {
      /* Bare `setTimeout` may still exist even when globalThis is shimmed. */
      if (typeof setTimeout === 'function') set = setTimeout;
      if (typeof clearTimeout === 'function') clear = clearTimeout;
    }
    return { set: set, clear: clear };
  }

  /* ------------------------------------------------- shared DOM helpers */

  function element(tag, className, text) {
    var d = doc();
    if (!d || typeof d.createElement !== 'function') return null;
    var node = d.createElement(tag);
    if (!node) return null;
    try { node.className = className || ''; } catch (e) { /* noop */ }
    if (text != null) node.textContent = String(text);
    return node;
  }

  function attr(node, name, value) {
    if (!node || typeof node.setAttribute !== 'function') return;
    try { node.setAttribute(name, String(value)); } catch (e) { /* noop */ }
  }

  function listen(target, type, handler) {
    if (!target || typeof target.addEventListener !== 'function') {
      return function () {};
    }
    try { target.addEventListener(type, handler); } catch (e) { return function () {}; }
    return function () {
      if (typeof target.removeEventListener !== 'function') return;
      try { target.removeEventListener(type, handler); } catch (e) { /* noop */ }
    };
  }

  function appendTo(parent, nodes) {
    if (!parent || !nodes || !nodes.length) return false;
    if (typeof parent.append === 'function') {
      try { parent.append.apply(parent, nodes); return true; } catch (e) { /* fall through */ }
    }
    if (typeof parent.appendChild === 'function') {
      try {
        for (var i = 0; i < nodes.length; i++) parent.appendChild(nodes[i]);
        return true;
      } catch (e) { return false; }
    }
    return false;
  }

  function detach(node) {
    if (!node) return;
    if (typeof node.remove === 'function') {
      try { node.remove(); return; } catch (e) { /* fall through */ }
    }
    var parent = node.parentNode;
    if (parent && typeof parent.removeChild === 'function') {
      try { parent.removeChild(node); } catch (e) { /* noop */ }
    }
  }

  /* ---------------------------------------------------------- container */

  function ensureStack() {
    if (stack) return stack;
    var d = doc();
    var host = d && d.body ? d.body : null;
    if (!host) return null;

    var node = element('div', 'toast-stack', '');
    if (!node) return null;
    attr(node, 'aria-live', 'polite');
    attr(node, 'aria-atomic', 'false');
    if (!appendTo(host, [node])) return null;
    stack = node;
    return stack;
  }

  /* --------------------------------------------------------- toast body */

  /* onUndo is null for a plain toast (undo button hidden, not removed). */
  function spawn(opts, onUndo) {
    var host = ensureStack();
    if (!host) return false;

    var node = element('div', 'toast', '');
    if (!node) return false;
    var tone = TONES[opts.tone] ? opts.tone : 'info';
    try { node.className = 'toast toast-' + tone; } catch (e) { /* noop */ }
    attr(node, 'role', 'status');

    var textNode = element('span', 'toast-text', String(opts.text == null ? '' : opts.text));
    var undoBtn = element('button', 'toast-undo', String(opts.undoLabel == null ? '撤销' : opts.undoLabel));    var closeBtn = element('button', 'toast-close', '×');
    if (!textNode || !undoBtn || !closeBtn) return false;

    attr(undoBtn, 'type', 'button');
    attr(closeBtn, 'type', 'button');
    attr(closeBtn, 'aria-label', '关闭');
    /* The button is always present for a stable layout; a plain toast hides
       it, so its text can never imply an action that does not exist. */
    undoBtn.hidden = !onUndo;

    appendTo(node, [textNode, undoBtn, closeBtn]);

    var record = {
      node: node,
      timer: null,
      startedAt: 0,
      remaining: Math.max(0, opts.timeoutMs),
      paused: false,
      closed: false,
      cleanup: []
    };
    live.push(record);

    /* Cap the stack: drop the oldest, without firing its onUndo. */
    while (live.length > MAX_VISIBLE) {
      close(live[0], false);
    }

    record.cleanup.push(listen(closeBtn, 'click', function () { close(record, false); }));
    if (onUndo) {
      record.cleanup.push(listen(undoBtn, 'click', function () {
        if (record.closed) return;
        close(record, false);
        try {
          var result = onUndo();
          if (result && typeof result.then === 'function') {
            result.then(null, function (error) { warn(error); });
          }
        } catch (error) {
          warn(error);
        }
      }));
    }
    /* Pause while the pointer is over the toast, so reaching for Undo does
       not lose it. Both pointer and mouse listeners are idempotent. */
    var pause = function () { pauseTimer(record); };
    var resume = function () { resumeTimer(record); };
    record.cleanup.push(listen(node, 'pointerenter', pause));
    record.cleanup.push(listen(node, 'pointerleave', resume));
    record.cleanup.push(listen(node, 'mouseenter', pause));
    record.cleanup.push(listen(node, 'mouseleave', resume));

    appendTo(host, [node]);
    startTimer(record);
    return true;
  }

  function warn(error) {
    if (typeof console !== 'undefined' && console && typeof console.warn === 'function') {
      try { console.warn('MiraToast: undo handler failed', error); } catch (e) { /* noop */ }
    }
  }

  /* -------------------------------------------------------------- timer */

  function startTimer(record) {
    var api = timerApi();
    if (!api.set || record.closed) return;
    if (record.remaining <= 0) {
      close(record, false);
      return;
    }
    record.paused = false;
    record.startedAt = nowMs();
    record.timer = api.set(function () {
      record.timer = null;
      close(record, false);
    }, record.remaining);
  }

  function clearTimer(record) {
    if (!record.timer) return;
    var api = timerApi();
    if (api.clear) {
      try { api.clear(record.timer); } catch (e) { /* noop */ }
    }
    record.timer = null;
  }

  function pauseTimer(record) {
    if (!record || record.closed || record.paused) return;
    if (!record.timer) return;
    var elapsed = nowMs() - record.startedAt;
    record.remaining = Math.max(0, record.remaining - elapsed);
    clearTimer(record);
    record.paused = true;
  }

  function resumeTimer(record) {
    if (!record || record.closed || !record.paused) return;
    record.paused = false;
    startTimer(record);
  }

  /* -------------------------------------------------------------- close */

  /* runUndo is reserved: timeouts and dismissAll must never run onUndo. */
  function close(record, runUndo) {
    if (!record || record.closed) return;
    record.closed = true;
    clearTimer(record);
    for (var i = 0; i < record.cleanup.length; i++) {
      try { record.cleanup[i](); } catch (e) { /* noop */ }
    }
    record.cleanup.length = 0;
    var index = live.indexOf(record);
    if (index !== -1) live.splice(index, 1);
    detach(record.node);
    if (runUndo) {
      try { runUndo(); } catch (error) { warn(error); }
    }
  }

  /* ------------------------------------------------------------- export */

  function normalizeTimeout(value, fallback) {
    var n = typeof value === 'number' && isFinite(value) ? value : fallback;
    return Math.max(0, n);
  }

  var MiraToast = {
    show: function (options) {
      var o = options && typeof options === 'object' ? options : {};
      spawn({
        text: o.text,
        tone: o.tone,
        undoLabel: null,
        timeoutMs: normalizeTimeout(o.timeoutMs, DEFAULT_SHOW_MS)
      }, null);
    },

    undo: function (options) {
      var o = options && typeof options === 'object' ? options : {};
      var handler = typeof o.onUndo === 'function' ? o.onUndo : null;
      spawn({
        text: o.text,
        tone: o.tone,
        undoLabel: o.undoLabel == null ? '撤销' : String(o.undoLabel),
        timeoutMs: normalizeTimeout(o.timeoutMs, DEFAULT_UNDO_MS)
      }, handler);
    },

    dismissAll: function () {
      var snapshot = live.slice();
      for (var i = 0; i < snapshot.length; i++) close(snapshot[i], false);
    }
  };

  if (typeof window !== 'undefined' && window) {
    try { window.MiraToast = MiraToast; } catch (e) { /* noop */ }
  }
  if (typeof globalThis !== 'undefined' && globalThis &&
      globalThis !== (typeof window !== 'undefined' ? window : undefined)) {
    try { globalThis.MiraToast = MiraToast; } catch (e) { /* noop */ }
  }
})();
