(function () {
  'use strict';

  /*
   * MiraModal — non-blocking replacement for window.confirm().
   *
   * Classic script (no modules). Defines window.MiraModal.
   * No dependencies, no innerHTML, no <dialog>/showModal (the test DOM has none).
   * Every DOM call is guarded so the file also loads in a headless or minimal
   * fake-DOM context without throwing.
   *
   *   MiraModal.confirm({
   *     title, message?, confirmLabel?, cancelLabel?, tone?, requireTyped?
   *   }) -> Promise<boolean>
   *   MiraModal.isOpen() -> boolean
   */

  var sequence = 0;
  var built = null;
  var state = null;
  var keyCleanup = null;

  /* ---------------------------------------------------------------- env */

  function doc() {
    return typeof document !== 'undefined' && document ? document : null;
  }

  function bodyNode() {
    var d = doc();
    return d && d.body ? d.body : null;
  }

  function nowMs() {
    return typeof Date !== 'undefined' && Date.now ? Date.now() : 0;
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

  function attrRemove(node, name) {
    if (!node || typeof node.removeAttribute !== 'function') return;
    try { node.removeAttribute(name); } catch (e) { /* noop */ }
  }

  function data(node, key, value) {
    if (!node || !node.dataset) return;
    try { node.dataset[key] = value; } catch (e) { /* noop */ }
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

  function takeFocus(node) {
    if (!node || typeof node.focus !== 'function') return;
    try { node.focus(); } catch (e) { /* noop */ }
  }

  /* --------------------------------------------------------- build once */

  function build() {
    if (built) return built;
    var d = doc();
    if (!d || typeof d.createElement !== 'function') return null;

    var uid = 'mira-modal-' + (++sequence);
    var titleId = uid + '-title';
    var messageId = uid + '-message';
    var typedId = uid + '-typed';

    var backdrop = element('div', 'dialog-backdrop', '');
    var dialog = element('div', 'dialog', '');
    attr(dialog, 'role', 'dialog');
    attr(dialog, 'aria-modal', 'true');
    attr(dialog, 'aria-labelledby', titleId);

    var bodyEl = element('div', 'dialog-body', '');

    var title = element('h2', 'dialog-title', '');
    attr(title, 'id', titleId);

    var message = element('p', 'dialog-message', '');
    attr(message, 'id', messageId);

    /* requireTyped group: label > span + input */
    var typedWrap = element('div', 'dialog-typed', '');
    var typedLabel = element('label', 'dialog-typed-label', '');
    attr(typedLabel, 'for', typedId);
    var typedText = element('span', 'dialog-typed-text', '');
    var typedInput = element('input', 'dialog-typed-input', '');
    setType(typedInput, 'text');
    attr(typedInput, 'id', typedId);
    attr(typedInput, 'autocomplete', 'off');
    attr(typedInput, 'spellcheck', 'false');
    appendTo(typedLabel, [typedText, typedInput]);
    appendTo(typedWrap, [typedLabel]);

    var actions = element('div', 'dialog-actions', '');

    var cancel = element('button', 'secondary', '取消');
    setType(cancel, 'button');
    data(cancel, 'role', 'cancel');

    var confirm = element('button', '', '确定');
    setType(confirm, 'button');
    data(confirm, 'role', 'confirm');

    appendTo(actions, [cancel, confirm]);
    appendTo(bodyEl, [title, message, typedWrap, actions]);
    appendTo(dialog, [bodyEl]);

    if (!backdrop || !dialog || !bodyEl || !title || !message || !cancel || !confirm) {
      return null;
    }

    built = {
      backdrop: backdrop,
      dialog: dialog,
      title: title,
      message: message,
      messageId: messageId,
      typedWrap: typedWrap,
      typedText: typedText,
      typedInput: typedInput,
      actions: actions,
      cancel: cancel,
      confirm: confirm
    };

    /* Persistent per-component listeners. Bound exactly once to the reused
       nodes, so repeated opens cannot accumulate handlers. */
    listen(backdrop, 'click', function () {
      settle(false);
    });
    listen(cancel, 'click', function () {
      settle(false);
    });
    listen(confirm, 'click', function () {
      if (!state || built.confirm.disabled) return;
      settle(true);
    });
    listen(typedInput, 'input', onTypedInput);

    return built;
  }

  function setType(node, value) {
    if (!node) return;
    if (value) attr(node, 'type', value);
    if (value) {
      try { node.type = value; } catch (e) { /* noop */ }
    }
  }

  /* ------------------------------------------------------------ options */

  function normalize(options) {
    var o = options && typeof options === 'object' ? options : {};
    var required = typeof o.requireTyped === 'string' ? o.requireTyped : '';
    return {
      title: o.title == null ? '' : String(o.title),
      message: o.message == null ? '' : String(o.message),
      confirmLabel: o.confirmLabel == null ? '确定' : String(o.confirmLabel),
      cancelLabel: o.cancelLabel == null ? '取消' : String(o.cancelLabel),
      tone: o.tone === 'danger' ? 'danger' : 'default',
      requireTyped: required.length ? required : ''
    };
  }

  function applyOptions(opts) {
    var b = built;
    b.title.textContent = opts.title;

    if (opts.message) {
      b.message.textContent = opts.message;
      b.message.hidden = false;
      if (b.message.style) b.message.style.whiteSpace = 'pre-line';
      attr(b.dialog, 'aria-describedby', b.messageId);
    } else {
      b.message.textContent = '';
      b.message.hidden = true;
      if (b.message.style) b.message.style.whiteSpace = '';
      attrRemove(b.dialog, 'aria-describedby');
    }

    b.cancel.textContent = opts.cancelLabel;
    b.confirm.textContent = opts.confirmLabel;
    b.confirm.className = opts.tone === 'danger' ? 'danger' : '';

    b.typedInput.value = '';
    if (opts.requireTyped) {
      b.typedWrap.hidden = false;
      b.typedText.textContent = '请输入 “' + opts.requireTyped + '” 以确认';
      b.confirm.disabled = true;
    } else {
      b.typedWrap.hidden = true;
      b.typedText.textContent = '';
      b.confirm.disabled = false;
    }
  }

  /* ---------------------------------------------------------- behaviour */

  function onTypedInput() {
    if (!state || !built) return;
    var required = state.opts.requireTyped;
    if (!required) return;
    var typed = built.typedInput.value == null ? '' : String(built.typedInput.value);
    built.confirm.disabled = typed.trim() !== required;
  }

  function focusables() {
    var list = [];
    if (built.typedWrap && !built.typedWrap.hidden) list.push(built.typedInput);
    list.push(built.cancel);
    if (!built.confirm.disabled) list.push(built.confirm);
    return list;
  }

  function onKeyDown(event) {
    if (!state || !event) return;
    var key = event.key;
    if (key === 'Escape' || key === 'Esc') {
      if (typeof event.preventDefault === 'function') event.preventDefault();
      settle(false);
      return;
    }
    if (key !== 'Tab') return;

    var list = focusables();
    if (!list.length) {
      if (typeof event.preventDefault === 'function') event.preventDefault();
      return;
    }
    var d = doc();
    var active = d ? d.activeElement : null;
    var index = list.indexOf(active);
    if (event.shiftKey) {
      if (index <= 0) {
        if (typeof event.preventDefault === 'function') event.preventDefault();
        takeFocus(list[list.length - 1]);
      }
    } else if (index === -1 || index === list.length - 1) {
      if (typeof event.preventDefault === 'function') event.preventDefault();
      takeFocus(list[0]);
    }
  }

  /* Resolve the current dialog exactly once, restore focus and unmount. */
  function settle(value) {
    var current = state;
    if (!current) return;
    state = null;

    if (keyCleanup) {
      keyCleanup();
      keyCleanup = null;
    }
    if (built) {
      detach(built.backdrop);
      detach(built.dialog);
    }
    takeFocus(current.previousFocus);
    current.resolve(value === true);
  }

  function openDialog(opts) {
    return new Promise(function (resolve) {
      /* Never stack dialogs: the previous one resolves false first. */
      if (state) settle(false);

      var d = doc();
      var host = bodyNode();
      if (!d || !host) {
        resolve(false);
        return;
      }
      if (!built) build();
      if (!built) {
        resolve(false);
        return;
      }

      state = { resolve: resolve, previousFocus: d.activeElement || null, opts: opts };
      applyOptions(opts);

      if (!appendTo(host, [built.backdrop, built.dialog])) {
        /* No mount point: fail safe rather than leave a promise pending. */
        state = null;
        resolve(false);
        return;
      }

      keyCleanup = listen(d, 'keydown', onKeyDown);
      /* Never autofocus the destructive action. */
      takeFocus(built.cancel);
    });
  }

  /* ------------------------------------------------------------- export */

  var MiraModal = {
    confirm: function (options) {
      return openDialog(normalize(options));
    },
    isOpen: function () {
      return !!state;
    }
  };

  if (typeof window !== 'undefined' && window) {
    try { window.MiraModal = MiraModal; } catch (e) { /* noop */ }
  }
  if (typeof globalThis !== 'undefined' && globalThis &&
      globalThis !== (typeof window !== 'undefined' ? window : undefined)) {
    try { globalThis.MiraModal = MiraModal; } catch (e) { /* noop */ }
  }
})();
