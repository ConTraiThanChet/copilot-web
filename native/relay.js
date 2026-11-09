// Copilot Web relay. Appended (via relay-inject.so) to the Tauri IPC init script
// of the app's hidden main webview. Executes Tauri IPC calls for browser clients
// connected to the Copilot Web server.
;(function () {
  if (window.__COPILOT_WEB_RELAY__) return
  window.__COPILOT_WEB_RELAY__ = true
  var PORT = __COPILOT_WEB_PORT__
  var TOKEN = __COPILOT_WEB_RELAY_TOKEN__

  function start() {
    var internals = window.__TAURI_INTERNALS__
    if (!internals || !internals.invoke || !internals.metadata || !internals.transformCallback) return setTimeout(start, 100)
    if (window !== window.top) return
    var label = internals.metadata.currentWindow && internals.metadata.currentWindow.label
    if (label !== 'main') return
    if (!/^(tauri:|https?:\/\/tauri\.localhost)/.test(location.href)) return
    connect()
  }

  function toB64(bytes) {
    var s = ''
    for (var i = 0; i < bytes.length; i += 32768) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 32768))
    return btoa(s)
  }
  function fromB64(b64) {
    var s = atob(b64), out = new Uint8Array(s.length)
    for (var i = 0; i < s.length; i++) out[i] = s.charCodeAt(i)
    return out
  }
  function encode(v) {
    if (v instanceof ArrayBuffer) return { __cwb64: toB64(new Uint8Array(v)) }
    if (ArrayBuffer.isView(v)) return { __cwb64: toB64(new Uint8Array(v.buffer, v.byteOffset, v.byteLength)) }
    if (v && typeof v === 'object') {
      if (Array.isArray(v)) return v.map(encode)
      var o = {}
      for (var k in v) if (Object.prototype.hasOwnProperty.call(v, k)) o[k] = encode(v[k])
      return o
    }
    return v
  }
  function decode(v) {
    if (v && typeof v === 'object') {
      if (typeof v.__cwb64 === 'string') return fromB64(v.__cwb64)
      if (Array.isArray(v)) { for (var i = 0; i < v.length; i++) v[i] = decode(v[i]); return v }
      for (var k in v) v[k] = decode(v[k])
    }
    return v
  }

  var ws = null
  var nativeCallbacks = new Map() // "client:remoteId" -> native callback id

  function send(msg) {
    if (ws && ws.readyState === 1) ws.send(JSON.stringify(msg))
  }

  function bridgeCallback(client, remoteId) {
    var key = client + ':' + remoteId
    var existing = nativeCallbacks.get(key)
    if (existing !== undefined) return existing
    var id = window.__TAURI_INTERNALS__.transformCallback(function (payload) {
      send({ t: 'callback', client: client, id: remoteId, payload: encode(payload) })
    })
    nativeCallbacks.set(key, id)
    return id
  }

  // Swap browser-side callback/channel ids for native ones that forward back.
  function mapArgs(client, cmd, args) {
    if (!args || typeof args !== 'object' || ArrayBuffer.isView(args)) return args
    var out = Array.isArray(args) ? [] : {}
    for (var k in args) {
      var v = args[k]
      if (typeof v === 'string' && v.indexOf('__CHANNEL__:') === 0) {
        out[k] = '__CHANNEL__:' + bridgeCallback(client, Number(v.slice(12)))
      } else if (cmd === 'plugin:event|listen' && k === 'handler' && typeof v === 'number') {
        out[k] = bridgeCallback(client, v)
      } else if (v && typeof v === 'object' && !ArrayBuffer.isView(v)) {
        out[k] = mapArgs(client, cmd, v)
      } else {
        out[k] = v
      }
    }
    return out
  }

  function release(prefix) {
    nativeCallbacks.forEach(function (id, key) {
      if (key.indexOf(prefix) === 0) {
        window.__TAURI_INTERNALS__.unregisterCallback(id)
        nativeCallbacks.delete(key)
      }
    })
  }

  function handle(msg) {
    if (msg.t === 'invoke') {
      var p
      try {
        var args = mapArgs(msg.client, msg.cmd, decode(msg.args))
        p = window.__TAURI_INTERNALS__.invoke(msg.cmd, args, msg.options || undefined)
      } catch (e) {
        p = Promise.reject(e)
      }
      Promise.resolve(p).then(
        function (value) { send({ t: 'result', id: msg.id, ok: true, value: encode(value) }) },
        function (err) {
          var e = err instanceof Error ? err.message : err
          send({ t: 'result', id: msg.id, ok: false, error: e === undefined ? null : e })
        })
    } else if (msg.t === 'fetch') {
      fetch(msg.url).then(function (r) {
        return r.arrayBuffer().then(function (buf) {
          send({ t: 'fetch-result', id: msg.id, status: r.status, type: r.headers.get('content-type'), body: toB64(new Uint8Array(buf)) })
        })
      }).catch(function (e) {
        send({ t: 'fetch-result', id: msg.id, status: 502, type: 'text/plain', body: btoa(String(e && e.message || e)) })
      })
    } else if (msg.t === 'release-client') {
      release(msg.client + ':')
    } else if (msg.t === 'release-callback') {
      var key = msg.client + ':' + msg.id
      var nid = nativeCallbacks.get(key)
      if (nid !== undefined) {
        window.__TAURI_INTERNALS__.unregisterCallback(nid)
        nativeCallbacks.delete(key)
      }
    }
  }

  function connect() {
    try {
      ws = new WebSocket('ws://127.0.0.1:' + PORT + '/__relay?token=' + encodeURIComponent(TOKEN))
    } catch (e) {
      return setTimeout(connect, 1000)
    }
    ws.onopen = function () {
      send({ t: 'hello', metadata: window.__TAURI_INTERNALS__.metadata, userAgent: navigator.userAgent, href: location.href })
    }
    ws.onmessage = function (ev) {
      try { handle(JSON.parse(ev.data)) } catch (e) { console.error('[copilot-web relay]', e) }
    }
    ws.onclose = function () {
      release('')
      ws = null
      setTimeout(connect, 1000)
    }
    ws.onerror = function () {}
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start)
  else start()
})();
