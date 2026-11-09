// Copilot Web browser runtime. Loaded before the app bundle.
//
// Provides a browser implementation of the Tauri IPC surface
// (window.__TAURI_INTERNALS__). Commands are executed by the real app backend
// through the Copilot Web relay; a few commands that must act on the user's
// browser (links, file pickers, clipboard, window chrome) are handled here.
(function () {
  'use strict';
  var proto = location.protocol === 'https:' ? 'wss:' : 'ws:';

  // ---------------------------------------------------------------------------
  // Native bootstrap info (window metadata from the relay)
  function fetchNativeInfo() {
    try {
      var xhr = new XMLHttpRequest();
      xhr.open('GET', '/__native-info?wait=20000', false);
      xhr.send();
      if (xhr.status === 200) return JSON.parse(xhr.responseText);
    } catch (e) { /* fallthrough */ }
    return null;
  }
  var info = fetchNativeInfo();
  if (!info || !info.ready) {
    document.addEventListener('DOMContentLoaded', function () {
      document.body.innerHTML = '<div style="font:14px system-ui;color:#e6edf3;background:#0d1117;position:fixed;inset:0;display:grid;place-items:center">' +
        '<div>Copilot backend is starting… this page will retry automatically.</div></div>';
    });
    setTimeout(function () { location.reload(); }, 3000);
    throw new Error('[copilot-web] backend not ready');
  }

  // ---------------------------------------------------------------------------
  // Binary-safe JSON encoding (shared format with relay.js)
  function toB64(bytes) {
    var s = '';
    for (var i = 0; i < bytes.length; i += 32768) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 32768));
    return btoa(s);
  }
  function fromB64(b64) {
    var s = atob(b64), out = new Uint8Array(s.length);
    for (var i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
    return out;
  }
  function encode(v) {
    if (v instanceof ArrayBuffer) return { __cwb64: toB64(new Uint8Array(v)) };
    if (ArrayBuffer.isView(v)) return { __cwb64: toB64(new Uint8Array(v.buffer, v.byteOffset, v.byteLength)) };
    if (v && typeof v === 'object') {
      if (typeof v.toJSON === 'function') return v.toJSON();
      if (typeof v['__TAURI_TO_IPC_KEY__'] === 'function') return encode(v['__TAURI_TO_IPC_KEY__']());
      if (Array.isArray(v)) return v.map(encode);
      var o = {};
      for (var k in v) if (Object.prototype.hasOwnProperty.call(v, k)) o[k] = encode(v[k]);
      return o;
    }
    return v;
  }
  function decode(v) {
    if (v && typeof v === 'object') {
      if (typeof v.__cwb64 === 'string') return fromB64(v.__cwb64).buffer;
      if (Array.isArray(v)) { for (var i = 0; i < v.length; i++) v[i] = decode(v[i]); return v; }
      for (var k in v) v[k] = decode(v[k]);
    }
    return v;
  }

  // ---------------------------------------------------------------------------
  // Bridge socket (browser <-> Copilot Web server <-> relay in the app)
  var bridge = null, bridgeOpen = false, queue = [], nextId = 1, pending = new Map();
  var callbacks = new Map();

  function connectBridge() {
    bridge = new WebSocket(proto + '//' + location.host + '/__bridge');
    bridge.binaryType = 'arraybuffer';
    bridge.onopen = function () {
      bridgeOpen = true;
      var q = queue; queue = [];
      q.forEach(function (m) { bridge.send(m); });
      bridge.send(JSON.stringify({ t: 'viewport', width: window.innerWidth, height: window.innerHeight }));
      if (typeof views !== 'undefined') views.forEach(function (v, label) {
        if (v.watching) bridge.send(JSON.stringify({ t: 'view-watch', label: label, on: true }));
      });
    };
    bridge.onmessage = function (ev) {
      if (ev.data instanceof ArrayBuffer) {
        try { onViewFrame(ev.data); } catch (e) { console.warn('[copilot-web] bad frame', e); }
        return;
      }
      var msg;
      try { msg = JSON.parse(ev.data); } catch (e) { return; }
      if (msg.t === 'result') {
        var p = pending.get(msg.id);
        if (!p) return;
        pending.delete(msg.id);
        if (msg.ok) p.resolve(decode(msg.value));
        else p.reject(msg.error);
      } else if (msg.t === 'callback') {
        var cb = callbacks.get(msg.id);
        if (cb) cb(decode(msg.payload));
      } else if (msg.t === 'relay-restarted') {
        // Native callbacks were lost; reload to re-register listeners and channels.
        setTimeout(function () { location.reload(); }, 500);
      }
    };
    bridge.onclose = function () {
      bridgeOpen = false;
      pending.forEach(function (p) { p.reject('Copilot Web connection lost'); });
      pending.clear();
      setTimeout(connectBridge, 1000);
    };
  }
  connectBridge();

  function remoteInvoke(cmd, args, options) {
    return new Promise(function (resolve, reject) {
      var id = nextId++;
      pending.set(id, { resolve: resolve, reject: reject });
      var msg = JSON.stringify({ t: 'invoke', id: id, cmd: cmd, args: encode(args === undefined ? {} : args), options: options || null });
      if (bridgeOpen) bridge.send(msg); else queue.push(msg);
    });
  }

  // ---------------------------------------------------------------------------
  // Commands handled in the browser
  function openUrl(url) {
    var w = null;
    try { w = window.open(url, '_blank'); } catch (e) { w = null; }
    if (w) {
      try { w.opener = null; } catch (e) { /* ignore */ }
    } else {
      showLinkBanner(url);
    }
    return null;
  }
  // Popup blocked (no user gesture): offer the link instead of leaving the app.
  function showLinkBanner(url) {
    var bar = document.createElement('div');
    bar.style.cssText = 'position:fixed;left:50%;top:16px;transform:translateX(-50%);z-index:2147483600;max-width:80vw;' +
      'background:#161b22;color:#e6edf3;border:1px solid #30363d;border-radius:8px;padding:10px 14px;font:13px system-ui;' +
      'box-shadow:0 8px 24px rgba(0,0,0,.4);display:flex;gap:12px;align-items:center;';
    var a = document.createElement('a');
    a.href = url;
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
    a.textContent = 'Open link: ' + (url.length > 80 ? url.slice(0, 77) + '…' : url);
    a.style.cssText = 'color:#4493f8;word-break:break-all;';
    var close = document.createElement('button');
    close.textContent = '×';
    close.style.cssText = 'background:none;border:0;color:#9198a1;font-size:18px;cursor:pointer;';
    function remove() { bar.remove(); }
    a.addEventListener('click', function () { setTimeout(remove, 0); });
    close.addEventListener('click', remove);
    bar.appendChild(a);
    bar.appendChild(close);
    document.body.appendChild(bar);
    setTimeout(remove, 60000);
  }
  function fileUrl(path) { return '/__file?path=' + encodeURIComponent(path); }

  function pickFiles(opts) {
    opts = opts || {};
    if (opts.directory) {
      var dir = window.prompt((opts.title || 'Folder') + ' — path on the Copilot host:', opts.defaultPath || info.home || '/');
      if (!dir) return Promise.resolve(null);
      return Promise.resolve(opts.multiple ? [dir] : dir);
    }
    return new Promise(function (resolve) {
      var input = document.createElement('input');
      input.type = 'file';
      input.multiple = !!opts.multiple;
      var exts = [];
      (opts.filters || []).forEach(function (f) { (f.extensions || []).forEach(function (e) { if (e !== '*') exts.push('.' + e); }); });
      if (exts.length) input.accept = exts.join(',');
      input.style.display = 'none';
      var done = false;
      function finish(v) { if (done) return; done = true; input.remove(); resolve(v); }
      input.addEventListener('cancel', function () { finish(null); });
      input.addEventListener('change', function () {
        var files = Array.prototype.slice.call(input.files || []);
        if (!files.length) return finish(null);
        Promise.all(files.map(function (f) {
          return fetch('/__upload?name=' + encodeURIComponent(f.name), { method: 'POST', body: f })
            .then(function (r) { if (!r.ok) throw new Error('upload failed'); return r.json(); })
            .then(function (j) { return j.path; });
        })).then(function (paths) { finish(opts.multiple ? paths : paths[0]); }, function (e) {
          console.error('[copilot-web] upload failed', e); finish(null);
        });
      });
      document.body.appendChild(input);
      input.click();
    });
  }

  function readBrowserClipboardImage() {
    if (!navigator.clipboard || !navigator.clipboard.read) return Promise.resolve(null);
    return navigator.clipboard.read().then(function (items) {
      for (var i = 0; i < items.length; i++) {
        var type = items[i].types.find(function (t) { return t.indexOf('image/') === 0; });
        if (type) return items[i].getType(type);
      }
      return null;
    }).catch(function () { return null; });
  }
  function blobToB64(blob) {
    return blob.arrayBuffer().then(function (b) { return toB64(new Uint8Array(b)); });
  }

  var WINDOW_NOOP = /^plugin:window\|(start_dragging|start_resize_dragging|minimize|unminimize|maximize|unmaximize|toggle_maximize|internal_toggle_maximize|set_decorations|set_shadow|set_size|set_min_size|set_max_size|set_size_constraints|set_position|center|set_always_on_top|set_always_on_bottom|set_skip_taskbar|set_resizable|set_maximizable|set_minimizable|set_closable|set_effects|set_title_bar_style|set_visible_on_all_workspaces|set_cursor_grab|set_cursor_visible|set_cursor_icon|set_cursor_position|set_ignore_cursor_events|set_progress_bar|set_badge_count|set_badge_label|set_overlay_icon|set_icon|request_user_attention|show|hide|set_focus|set_focusable|set_enabled|set_content_protected|set_simple_fullscreen|set_background_color)$/;

  var local = {
    'plugin:window|set_title': function (a) { document.title = a.value || a.title || document.title; return null; },
    'plugin:window|close': function () { window.close(); return null; },
    'plugin:window|destroy': function () { window.close(); return null; },
    'plugin:window|set_fullscreen': function (a) {
      if (a.value) document.documentElement.requestFullscreen && document.documentElement.requestFullscreen().catch(function () {});
      else if (document.fullscreenElement) document.exitFullscreen();
      return null;
    },
    'plugin:window|is_fullscreen': function () { return !!document.fullscreenElement; },
    'plugin:window|is_maximized': function () { return true; },
    'plugin:window|is_minimized': function () { return document.hidden; },
    'plugin:window|is_visible': function () { return !document.hidden; },
    'plugin:window|is_focused': function () { return document.hasFocus(); },
    'plugin:window|is_decorated': function () { return true; },
    'plugin:window|scale_factor': function () { return window.devicePixelRatio || 1; },
    'plugin:window|inner_size': function () { var d = window.devicePixelRatio || 1; return { width: Math.round(innerWidth * d), height: Math.round(innerHeight * d) }; },
    'plugin:window|outer_size': function () { var d = window.devicePixelRatio || 1; return { width: Math.round(outerWidth * d), height: Math.round(outerHeight * d) }; },
    'plugin:window|inner_position': function () { return { x: 0, y: 0 }; },
    'plugin:window|outer_position': function () { return { x: 0, y: 0 }; },
    'plugin:webview|set_webview_zoom': function () { return null; },
    'plugin:opener|open_url': function (a) { return openUrl(a.url); },
    'plugin:shell|open': function (a) { return openUrl(a.path || a.url); },
    'open_external_url': function (a) { return openUrl(a.url); },
    'plugin:opener|open_path': function (a) { window.open(fileUrl(a.path), '_blank'); return null; },
    'plugin:opener|reveal_item_in_dir': function () { return null; },
    'open_in_app': function () { return null; },
    'plugin:dialog|open': function (a) { return pickFiles(a.options || a); },
    'plugin:dialog|save': function (a) {
      var o = a.options || a;
      var p = window.prompt((o.title || 'Save as') + ' — path on the Copilot host:', o.defaultPath || '');
      return p || null;
    },
    'plugin:dialog|message': function (a) { window.alert(a.message || ''); return true; },
    'plugin:dialog|ask': function (a) { return window.confirm(a.message || ''); },
    'plugin:dialog|confirm': function (a) { return window.confirm(a.message || ''); },
    'plugin:notification|is_permission_granted': function () { return typeof Notification !== 'undefined' && Notification.permission === 'granted'; },
    'plugin:notification|request_permission': function () {
      return typeof Notification === 'undefined' ? 'denied' : Notification.requestPermission();
    },
    'plugin:notification|notify': function (a) {
      var o = a.options || a;
      try { if (Notification.permission === 'granted') new Notification(o.title || 'GitHub Copilot', { body: o.body || '' }); } catch (e) { /* ignore */ }
      return null;
    },
    'plugin:global-shortcut|register': function () { return null; },
    'plugin:global-shortcut|register_all': function () { return null; },
    'plugin:global-shortcut|unregister': function () { return null; },
    'plugin:global-shortcut|unregister_all': function () { return null; },
    'plugin:global-shortcut|is_registered': function () { return false; },
    'plugin:updater|check': function () { return null; },
    'plugin:process|restart': function () { location.reload(); return null; },
    'plugin:process|exit': function () { return null; },
    'plugin:app|exit': function () { return null; },
    'new_window': function (a) { window.open(a.path || '/', '_blank'); return null; },
    'request_app_exit': function () { return null; },
    'restart_app': function () { location.reload(); return null; },
    'open_web_inspector': function () { return null; },
    'check_for_update': function () { return null; },
    'download_update': function () { return null; },
    'reveal_main_window': function () { window.focus(); return null; },
    'reveal_current_window': function () { window.focus(); return null; },
    'read_clipboard_image_attachment': function (a) {
      return readBrowserClipboardImage().then(function (blob) {
        if (!blob) return null;
        return blobToB64(blob).then(function (data) {
          return remoteInvoke('save_clipboard_image', { data: data, mimeType: blob.type, workspaceId: a.workspaceId });
        });
      });
    },
  };

  function invoke(cmd, args, options) {
    args = args || {};
    try {
      if (Object.prototype.hasOwnProperty.call(local, cmd)) return Promise.resolve(local[cmd](args, options));
      if (WINDOW_NOOP.test(cmd)) return Promise.resolve(null);
    } catch (e) {
      return Promise.reject(e && e.message ? e.message : String(e));
    }
    var p = remoteInvoke(cmd, args, options);
    if (NATIVE_VIEW_COMMANDS[cmd]) {
      p.then(function () { NATIVE_VIEW_COMMANDS[cmd](args); }, function () {});
    }
    return p;
  }

  // ---------------------------------------------------------------------------
  // Native views: the agent browser preview and extension canvases are native
  // webviews on the host. Show them as live images at the bounds the app asks
  // for, and forward mouse/keyboard input to them.
  var views = new Map(); // label -> { el, img, bounds, visible, url }
  var viewLayer = null;
  function layer() {
    if (viewLayer) return viewLayer;
    viewLayer = document.createElement('div');
    viewLayer.id = 'copilot-web-native-views';
    viewLayer.style.cssText = 'position:fixed;inset:0;pointer-events:none;z-index:2147482000;';
    document.body.appendChild(viewLayer);
    return viewLayer;
  }
  function bridgeSend(msg) {
    var s = JSON.stringify(msg);
    if (bridgeOpen) bridge.send(s); else queue.push(s);
  }
  function viewEnsure(label) {
    var v = views.get(label);
    if (v) return v;
    var el = document.createElement('div');
    el.dataset.nativeViewBox = label;
    el.style.cssText = 'position:fixed;display:none;pointer-events:auto;outline:none;overflow:hidden;background:transparent;cursor:default;';
    var img = document.createElement('img');
    img.draggable = false;
    img.alt = '';
    img.style.cssText = 'position:absolute;left:0;top:0;width:100%;height:100%;user-select:none;-webkit-user-drag:none;';
    el.appendChild(img);
    // Hidden textarea receives keyboard focus so typed text and IME input
    // (e.g. Vietnamese Telex) arrive as text events.
    var ta = document.createElement('textarea');
    ta.dataset.nativeView = label;
    ta.setAttribute('autocomplete', 'off');
    ta.setAttribute('autocorrect', 'off');
    ta.setAttribute('autocapitalize', 'off');
    ta.spellcheck = false;
    ta.style.cssText = 'position:absolute;left:0;top:0;width:1px;height:1px;opacity:0;border:0;padding:0;resize:none;pointer-events:none;';
    el.appendChild(ta);
    v = { el: el, img: img, ta: ta, bounds: null, visible: true, watching: false, url: null };
    views.set(label, v);
    attachInput(label, v);
    layer().appendChild(el);
    return v;
  }
  function viewUpdate(label) {
    var v = views.get(label);
    if (!v) return;
    var b = v.bounds;
    var onScreen = !!b && b.width > 1 && b.height > 1 && b.x + b.width > 0 && b.y + b.height > 0 &&
      b.x < window.innerWidth && b.y < window.innerHeight;
    var show = v.visible && onScreen;
    if (b) {
      v.el.style.left = b.x + 'px';
      v.el.style.top = b.y + 'px';
      v.el.style.width = b.width + 'px';
      v.el.style.height = b.height + 'px';
    }
    v.el.style.display = show ? 'block' : 'none';
    if (show !== v.watching) {
      v.watching = show;
      bridgeSend({ t: 'view-watch', label: label, on: show });
    }
  }
  function viewRemove(label) {
    var v = views.get(label);
    if (!v) return;
    if (v.watching) bridgeSend({ t: 'view-watch', label: label, on: false });
    if (v.url) URL.revokeObjectURL(v.url);
    v.el.remove();
    views.delete(label);
  }
  function setBounds(a) {
    var v = viewEnsure(a.label);
    v.bounds = { x: Number(a.x) || 0, y: Number(a.y) || 0, width: Number(a.width) || 0, height: Number(a.height) || 0 };
    viewUpdate(a.label);
  }
  function setVisible(label, visible) {
    if (!label) return;
    viewEnsure(label).visible = visible;
    viewUpdate(label);
  }
  var NATIVE_VIEW_COMMANDS = {
    create_browser_preview: function (a) { viewEnsure(a.label); viewUpdate(a.label); },
    create_extension_canvas_webview: function (a) { viewEnsure(a.label); viewUpdate(a.label); },
    set_browser_preview_bounds: setBounds,
    set_extension_canvas_webview_bounds: setBounds,
    set_browser_preview_visibility: function (a) { setVisible(a.label, !!a.visible); },
    suspend_extension_canvas_webview: function (a) { setVisible(a.label, false); },
    resume_extension_canvas_webview: function (a) { setVisible(a.label, true); },
    'plugin:webview|webview_hide': function (a) { if (views.has(a.label)) setVisible(a.label, false); },
    'plugin:webview|webview_show': function (a) { if (views.has(a.label)) setVisible(a.label, true); },
    'plugin:webview|webview_close': function (a) { viewRemove(a.label); },
    close_browser_preview: function (a) { viewRemove(a.label); },
    close_extension_canvas_webview: function (a) { viewRemove(a.label); },
  };
  window.addEventListener('resize', function () {
    views.forEach(function (_, label) { viewUpdate(label); });
    bridgeSend({ t: 'viewport', width: window.innerWidth, height: window.innerHeight });
  });

  function onViewFrame(buf) {
    // [u32 headerLen][header JSON][u32 metaLen][meta JSON][PNG]
    var dv = new DataView(buf);
    var hlen = dv.getUint32(0, true);
    var header = JSON.parse(new TextDecoder().decode(new Uint8Array(buf, 4, hlen)));
    var v = views.get(header.label);
    if (!v) return;
    var off = 4 + hlen;
    var mlen = dv.getUint32(off, true);
    var png = new Blob([new Uint8Array(buf, off + 4 + mlen)], { type: 'image/png' });
    var url = URL.createObjectURL(png);
    var old = v.url;
    v.url = url;
    v.img.onload = function () { if (old) URL.revokeObjectURL(old); };
    v.img.src = url;
  }

  function attachInput(label, v) {
    var el = v.el;
    var pendingMove = null, moveScheduled = false;
    function pos(e) {
      var r = el.getBoundingClientRect();
      return { x: Math.round(e.clientX - r.left), y: Math.round(e.clientY - r.top) };
    }
    function send(ev) {
      var b = v.bounds || { x: 0, y: 0 };
      bridgeSend({ t: 'view-input', label: label, origin: { x: b.x, y: b.y }, ev: ev });
    }
    var ta = v.ta;
    function sendText(text) { if (text) send({ type: 'text', text: text }); }
    ta.addEventListener('input', function (e) {
      if (e.isComposing) return;
      sendText(ta.value);
      ta.value = '';
    });
    ta.addEventListener('compositionend', function () {
      sendText(ta.value);
      ta.value = '';
    });
    el.addEventListener('pointerdown', function (e) {
      e.preventDefault();
      ta.focus({ preventScroll: true });
      try { el.setPointerCapture(e.pointerId); } catch (x) { /* ignore */ }
      var p = pos(e);
      send({ type: 'down', button: e.button, x: p.x, y: p.y });
    });
    el.addEventListener('pointerup', function (e) {
      e.preventDefault();
      var p = pos(e);
      send({ type: 'up', button: e.button, x: p.x, y: p.y });
    });
    el.addEventListener('pointermove', function (e) {
      pendingMove = pos(e);
      if (moveScheduled) return;
      moveScheduled = true;
      setTimeout(function () {
        moveScheduled = false;
        if (pendingMove) send({ type: 'move', x: pendingMove.x, y: pendingMove.y });
        pendingMove = null;
      }, 33);
    });
    el.addEventListener('wheel', function (e) {
      e.preventDefault();
      var p = pos(e);
      var scale = e.deltaMode === 1 ? 40 : e.deltaMode === 2 ? 400 : 1;
      send({ type: 'wheel', x: p.x, y: p.y, dx: e.deltaX * scale, dy: e.deltaY * scale });
    }, { passive: false });
    el.addEventListener('contextmenu', function (e) { e.preventDefault(); });
    ta.addEventListener('paste', function (e) {
      e.preventDefault();
      sendText(e.clipboardData && e.clipboardData.getData('text/plain'));
    });
  }
  // Keyboard for a focused native view (capture phase, ahead of app shortcuts).
  function activeView() {
    var a = document.activeElement;
    return a && a.dataset && a.dataset.nativeView ? a.dataset.nativeView : null;
  }
  window.addEventListener('keydown', function (e) {
    var label = activeView();
    if (!label) return;
    var paste = (e.ctrlKey || e.metaKey) && !e.altKey && (e.key === 'v' || e.key === 'V');
    e.stopImmediatePropagation();
    if (paste) return; // let the browser fire a paste event with the local clipboard
    if (e.isComposing || e.key === 'Process' || e.keyCode === 229) return; // IME
    var printable = !e.ctrlKey && !e.altKey && !e.metaKey && typeof e.key === 'string' && Array.from(e.key).length === 1;
    if (printable) return; // delivered through the textarea's input event
    e.preventDefault();
    var v = views.get(label), b = v && v.bounds || { x: 0, y: 0 };
    bridgeSend({ t: 'view-input', label: label, origin: { x: b.x, y: b.y }, ev: {
      type: 'key', key: e.key, code: e.code, ctrl: e.ctrlKey, alt: e.altKey, shift: e.shiftKey, meta: e.metaKey,
    } });
  }, true);
  window.addEventListener('keyup', function (e) { if (activeView()) e.stopImmediatePropagation(); }, true);
  window.addEventListener('keypress', function (e) { if (activeView()) e.stopImmediatePropagation(); }, true);

  // ---------------------------------------------------------------------------
  // Tauri internals surface
  function uid() { return window.crypto.getRandomValues(new Uint32Array(1))[0]; }
  function registerCallback(callback, once) {
    var id = uid();
    callbacks.set(id, function (data) {
      if (once) unregisterCallback(id);
      return callback && callback(data);
    });
    return id;
  }
  function unregisterCallback(id) {
    if (callbacks.delete(id) && bridgeOpen) bridge.send(JSON.stringify({ t: 'release-callback', id: id }));
  }
  function runCallback(id, data) {
    var cb = callbacks.get(id);
    if (cb) cb(data);
  }

  var internals = {
    metadata: info.metadata,
    plugins: { path: { sep: '/', delimiter: ':' } },
    invoke: invoke,
    transformCallback: registerCallback,
    unregisterCallback: unregisterCallback,
    runCallback: runCallback,
    callbacks: callbacks,
    convertFileSrc: function (filePath, protocol) {
      var q = '/__file?path=' + encodeURIComponent(filePath);
      if (protocol && protocol !== 'asset') q += '&protocol=' + encodeURIComponent(protocol);
      return q;
    },
  };
  if (info.checksBootstrap) window.__GITHUB_APP_CHECKS_STORAGE_BOOTSTRAP__ = info.checksBootstrap;
  Object.defineProperty(window, '__TAURI_INTERNALS__', { value: internals, configurable: false, writable: false });
  Object.defineProperty(window, '__TAURI_EVENT_PLUGIN_INTERNALS__', { value: { unregisterListener: function () {} } });
  globalThis.isTauri = true;

  // ---------------------------------------------------------------------------
  // Backend WebSocket: serve clipboard requests from the browser's clipboard
  // instead of the (invisible) host display.
  var CLIPBOARD = {
    write_clipboard_text: function (m) { return navigator.clipboard.writeText(m.text || '').then(function () { return null; }); },
    write_clipboard_html: function (m) {
      if (typeof ClipboardItem === 'undefined') return navigator.clipboard.writeText(m.text || '').then(function () { return null; });
      return navigator.clipboard.write([new ClipboardItem({
        'text/html': new Blob([m.html || ''], { type: 'text/html' }),
        'text/plain': new Blob([m.text || ''], { type: 'text/plain' }),
      })]).then(function () { return null; });
    },
    write_clipboard_image: function (m) {
      var blob = new Blob([fromB64(m.data_base64 || '')], { type: 'image/png' });
      return navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]).then(function () { return null; });
    },
    read_clipboard_text: function () { return navigator.clipboard.readText(); },
    read_clipboard_content: function () {
      if (!navigator.clipboard.read) return navigator.clipboard.readText().then(function (t) { return { text: t, html: null }; });
      return navigator.clipboard.read().then(function (items) {
        var text = null, html = null, jobs = [];
        items.forEach(function (it) {
          if (text === null && it.types.indexOf('text/plain') >= 0) jobs.push(it.getType('text/plain').then(function (b) { return b.text(); }).then(function (t) { text = t; }));
          if (html === null && it.types.indexOf('text/html') >= 0) jobs.push(it.getType('text/html').then(function (b) { return b.text(); }).then(function (t) { html = t; }));
        });
        return Promise.all(jobs).then(function () { return { text: text, html: html }; });
      });
    },
    read_primary_selection: function () { return Promise.resolve(null); },
    write_primary_selection: function () { return Promise.resolve(null); },
  };
  var origSend = WebSocket.prototype.send;
  WebSocket.prototype.send = function (data) {
    if (typeof data === 'string' && data.length < 2000000 && /"type":"(write_clipboard_|read_clipboard_|read_primary_selection|write_primary_selection)/.test(data) &&
        this.url.indexOf('/__ws') >= 0) {
      var msg;
      try { msg = JSON.parse(data); } catch (e) { msg = null; }
      var handler = msg && CLIPBOARD[msg.type];
      if (handler) {
        var sock = this;
        Promise.resolve().then(function () { return handler(msg); }).then(
          function (result) { reply(sock, { type: 'command_result', request_id: msg.request_id, data: result === undefined ? null : result }); },
          function (err) { reply(sock, { type: 'command_result', request_id: msg.request_id, data: null, error: String(err && err.message || err) }); });
        return;
      }
    }
    return origSend.call(this, data);
  };
  function reply(sock, payload) {
    sock.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(payload) }));
  }

  globalThis.__COPILOT_WEB__ = {
    wsUrl: function () { return proto + '//' + location.host + '/__ws'; },
    info: info,
  };
  document.documentElement.dataset.copilotWeb = 'true';
})();
