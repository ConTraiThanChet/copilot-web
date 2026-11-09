// Copilot Web server.
//
// Serves the GitHub Copilot app frontend to regular browsers and connects it to
// the app backend running on this host:
//   /__ws       raw proxy to the backend WebSocket (token injected server-side)
//   /__bridge   browser side of the Tauri IPC bridge
//   /__relay    app side of the Tauri IPC bridge (relay.js in the hidden webview)
//   /__file     local files and app custom-protocol resources
//   /__upload   file picker uploads
import http from 'node:http';
import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';

const here = path.dirname(fileURLToPath(import.meta.url));
const HOST = process.env.COPILOT_WEB_HOST || '0.0.0.0';
const PORT = Number(process.env.COPILOT_WEB_PORT || 8787);
const STATE_DIR = process.env.COPILOT_WEB_STATE || path.join(os.homedir(), '.local', 'share', 'copilot-web');
const DIST = path.resolve(process.env.COPILOT_WEB_DIST || path.join(STATE_DIR, 'web'));
const RUN_DIR = process.env.COPILOT_RUN_DIR || path.join(os.homedir(), '.copilot', 'run');
const PASSWORD = process.env.COPILOT_WEB_PASSWORD || '';
const RELAY_TOKEN = process.env.COPILOT_WEB_RELAY_TOKEN || '';
const UPLOAD_DIR = path.join(STATE_DIR, 'uploads');

if (!RELAY_TOKEN) {
  console.error('COPILOT_WEB_RELAY_TOKEN is required');
  process.exit(2);
}

const log = (...a) => console.log(new Date().toISOString(), ...a);

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png',
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp',
  '.avif': 'image/avif', '.bmp': 'image/bmp', '.ico': 'image/x-icon',
  '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.otf': 'font/otf',
  '.wasm': 'application/wasm', '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.ogg': 'audio/ogg',
  '.mp4': 'video/mp4', '.webm': 'video/webm', '.mov': 'video/quicktime', '.pdf': 'application/pdf',
  '.txt': 'text/plain; charset=utf-8', '.md': 'text/markdown; charset=utf-8', '.log': 'text/plain; charset=utf-8',
};

// ---------------------------------------------------------------------------
// Auth (optional password; codespace port forwarding already requires GitHub auth)
const COOKIE = 'copilot_web';
const cookieValue = crypto.createHmac('sha256', RELAY_TOKEN).update('session:' + PASSWORD).digest('hex');

function cookies(req) {
  const out = {};
  for (const part of (req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}
function authed(req) {
  if (!PASSWORD) return true;
  const c = cookies(req)[COOKIE] || '';
  return c.length === cookieValue.length && crypto.timingSafeEqual(Buffer.from(c), Buffer.from(cookieValue));
}
const LOGIN_PAGE = `<!doctype html><meta charset=utf-8><meta name=viewport content="width=device-width,initial-scale=1">
<title>Copilot Web</title><style>body{background:#0d1117;color:#e6edf3;font:14px system-ui;display:grid;place-items:center;height:100vh;margin:0}
form{display:flex;gap:8px}input,button{font:inherit;padding:8px 12px;border-radius:6px;border:1px solid #30363d;background:#161b22;color:inherit}
button{background:#238636;border-color:#238636;cursor:pointer}</style>
<form method=post action="/__login"><input type=password name=password placeholder="Password" autofocus><button>Sign in</button></form>`;

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (d) => {
      size += d.length;
      if (size > limit) { reject(new Error('body too large')); req.destroy(); return; }
      chunks.push(d);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

async function handleLogin(req, res) {
  const body = (await readBody(req, 4096)).toString();
  const pw = new URLSearchParams(body).get('password') || '';
  const ok = crypto.timingSafeEqual(crypto.createHash('sha256').update(pw).digest(), crypto.createHash('sha256').update(PASSWORD).digest());
  if (ok) {
    const secure = req.headers['x-forwarded-proto'] === 'https' ? '; Secure' : '';
    res.writeHead(303, { 'Set-Cookie': `${COOKIE}=${cookieValue}; Path=/; HttpOnly; SameSite=Lax; Max-Age=2592000${secure}`, Location: '/' });
  } else {
    res.writeHead(303, { Location: '/__login?failed=1' });
  }
  res.end();
}

// ---------------------------------------------------------------------------
// Relay hub
let relay = null;
let relayInfo = null;
const relayWaiters = new Set();
let nextGid = 1;
const pendingInvokes = new Map(); // gid -> { client, id }
const pendingFetches = new Map(); // gid -> { resolve }
const clients = new Map(); // clientId -> ws
let nextClient = 1;

function relayReady() {
  return !!(relay && relay.readyState === 1 && relayInfo);
}
function waitForRelay(ms) {
  if (relayReady()) return Promise.resolve(true);
  return new Promise((resolve) => {
    const done = (v) => { clearTimeout(t); relayWaiters.delete(done); resolve(v); };
    const t = setTimeout(() => done(false), ms);
    relayWaiters.add(done);
  });
}
function relaySend(msg) {
  if (!relay || relay.readyState !== 1) return false;
  relay.send(JSON.stringify(msg));
  return true;
}
function relayInvoke(cmd, args = {}) {
  return new Promise((resolve, reject) => {
    const gid = nextGid++;
    pendingInvokes.set(gid, { local: { resolve, reject } });
    if (!relaySend({ t: 'invoke', id: gid, client: 'server', cmd, args, options: null })) {
      pendingInvokes.delete(gid);
      reject(new Error('relay not connected'));
    }
    setTimeout(() => { if (pendingInvokes.delete(gid)) reject(new Error('relay timeout')); }, 15000);
  });
}
function relayFetch(url) {
  return new Promise((resolve) => {
    const gid = nextGid++;
    pendingFetches.set(gid, resolve);
    if (!relaySend({ t: 'fetch', id: gid, url })) {
      pendingFetches.delete(gid);
      resolve(null);
    }
    setTimeout(() => { if (pendingFetches.delete(gid)) resolve(null); }, 30000);
  });
}

function onRelayMessage(raw) {
  let msg;
  try { msg = JSON.parse(raw); } catch { return; }
  if (msg.t === 'hello') {
    relayInfo = { metadata: msg.metadata, userAgent: msg.userAgent };
    log('relay connected', msg.href);
    for (const w of [...relayWaiters]) w(true);
  } else if (msg.t === 'result') {
    const p = pendingInvokes.get(msg.id);
    if (!p) return;
    pendingInvokes.delete(msg.id);
    if (p.local) {
      if (msg.ok) p.local.resolve(msg.value); else p.local.reject(new Error(String(msg.error)));
      return;
    }
    const c = clients.get(p.client);
    if (c && c.readyState === 1) c.send(JSON.stringify({ t: 'result', id: p.id, ok: msg.ok, value: msg.value, error: msg.error }));
  } else if (msg.t === 'callback') {
    const c = clients.get(msg.client);
    if (c && c.readyState === 1) c.send(JSON.stringify({ t: 'callback', id: msg.id, payload: msg.payload }));
    else if (!c) relaySend({ t: 'release-client', client: msg.client });
  } else if (msg.t === 'fetch-result') {
    const r = pendingFetches.get(msg.id);
    if (r) { pendingFetches.delete(msg.id); r(msg); }
  }
}

// ---------------------------------------------------------------------------
// Backend WebSocket endpoint
function readFirstLine(file) {
  try { return fs.readFileSync(file, 'utf8').split(/\r?\n/)[0].trim(); } catch { return null; }
}
async function backendEndpoint() {
  try {
    const info = await relayInvoke('get_websocket_info');
    if (info && info.port && info.token) return { port: Number(info.port), token: info.token };
  } catch (e) {
    log('get_websocket_info via relay failed:', e.message);
  }
  const port = Number(readFirstLine(path.join(RUN_DIR, 'ws.port')));
  const token = readFirstLine(path.join(RUN_DIR, 'ws.token'));
  return port && token ? { port, token } : null;
}

// ---------------------------------------------------------------------------
// HTTP
function sendFile(req, res, file, { immutable = false } = {}) {
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) { res.writeHead(404); res.end('Not found'); return; }
    const headers = {
      'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
      'Cache-Control': immutable ? 'public, max-age=31536000, immutable' : 'no-cache',
      'Accept-Ranges': 'bytes',
    };
    const m = req.headers.range && /^bytes=(\d*)-(\d*)$/.exec(req.headers.range);
    if (m && (m[1] || m[2])) {
      let start = m[1] ? Number(m[1]) : Math.max(0, st.size - Number(m[2]));
      let end = m[1] && m[2] ? Math.min(Number(m[2]), st.size - 1) : st.size - 1;
      if (start <= end && start < st.size) {
        res.writeHead(206, { ...headers, 'Content-Range': `bytes ${start}-${end}/${st.size}`, 'Content-Length': end - start + 1 });
        fs.createReadStream(file, { start, end }).pipe(res);
        return;
      }
    }
    res.writeHead(200, { ...headers, 'Content-Length': st.size });
    if (req.method === 'HEAD') return res.end();
    fs.createReadStream(file).pipe(res);
  });
}

async function serveFile(req, res, url) {
  const p = url.searchParams.get('path') || '';
  const protocol = url.searchParams.get('protocol');
  if (protocol && protocol !== 'asset') {
    const r = await relayFetch(`${protocol}://localhost/${encodeURIComponent(p)}`);
    if (!r) { res.writeHead(502); return res.end(); }
    const body = Buffer.from(r.body || '', 'base64');
    res.writeHead(r.status || 200, { 'Content-Type': r.type || 'application/octet-stream', 'Content-Length': body.length, 'Cache-Control': 'no-cache' });
    return res.end(body);
  }
  if (!path.isAbsolute(p)) { res.writeHead(400); return res.end(); }
  sendFile(req, res, path.resolve(p));
}

async function handleUpload(req, res, url) {
  const name = path.basename(url.searchParams.get('name') || 'upload').replace(/[\0/\\]/g, '_') || 'upload';
  const dir = path.join(UPLOAD_DIR, crypto.randomUUID());
  fs.mkdirSync(dir, { recursive: true });
  const dest = path.join(dir, name);
  const out = fs.createWriteStream(dest);
  req.pipe(out);
  out.on('finish', () => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ path: dest }));
  });
  out.on('error', (e) => { res.writeHead(500); res.end(String(e.message)); });
}

function serveStatic(req, res, url) {
  let rel;
  try { rel = decodeURIComponent(url.pathname); } catch { res.writeHead(400); return res.end(); }
  if (rel === '/') rel = '/index.html';
  const file = path.resolve(DIST, '.' + rel);
  if (!file.startsWith(DIST + path.sep)) { res.writeHead(403); return res.end(); }
  fs.stat(file, (err, st) => {
    if (!err && st.isFile()) return sendFile(req, res, file, { immutable: rel.startsWith('/assets/') });
    if (!path.extname(rel) || rel.endsWith('.html')) return sendFile(req, res, path.join(DIST, 'index.html'));
    res.writeHead(404); res.end('Not found');
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://local');
  try {
    if (url.pathname === '/__login') {
      if (req.method === 'POST') return await handleLogin(req, res);
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(LOGIN_PAGE);
    }
    if (!authed(req)) {
      res.writeHead(303, { Location: '/__login' });
      return res.end();
    }
    switch (url.pathname) {
      case '/__health':
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ ok: true, relay: relayReady(), clients: clients.size }));
      case '/__native-info': {
        const ready = await waitForRelay(Math.min(Number(url.searchParams.get('wait') || 0), 30000));
        res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
        return res.end(JSON.stringify({ ready, metadata: relayInfo?.metadata || null, home: os.homedir() }));
      }
      case '/__file':
        return await serveFile(req, res, url);
      case '/__upload':
        if (req.method !== 'POST') { res.writeHead(405); return res.end(); }
        return await handleUpload(req, res, url);
      default:
        return serveStatic(req, res, url);
    }
  } catch (e) {
    log('request error', url.pathname, e.message);
    if (!res.headersSent) res.writeHead(500);
    res.end();
  }
});

// ---------------------------------------------------------------------------
// WebSocket endpoints
const wssRelay = new WebSocketServer({ noServer: true, maxPayload: 512 * 1024 * 1024 });
const wssBridge = new WebSocketServer({ noServer: true, maxPayload: 512 * 1024 * 1024, perMessageDeflate: true });

wssRelay.on('connection', (ws) => {
  const replaced = relay !== null;
  if (relay) try { relay.close(); } catch { /* ignore */ }
  relay = ws;
  relayInfo = null;
  ws.on('message', (data) => onRelayMessage(data.toString()));
  ws.on('close', () => {
    if (relay === ws) { relay = null; relayInfo = null; log('relay disconnected'); }
  });
  if (replaced) {
    for (const c of clients.values()) c.send(JSON.stringify({ t: 'relay-restarted' }));
  }
});

wssBridge.on('connection', (ws) => {
  const clientId = 'c' + nextClient++;
  clients.set(clientId, ws);
  ws.on('message', (data) => {
    let msg;
    try { msg = JSON.parse(data.toString()); } catch { return; }
    if (msg.t === 'invoke') {
      const gid = nextGid++;
      pendingInvokes.set(gid, { client: clientId, id: msg.id });
      if (!relaySend({ t: 'invoke', id: gid, client: clientId, cmd: msg.cmd, args: msg.args, options: msg.options })) {
        pendingInvokes.delete(gid);
        ws.send(JSON.stringify({ t: 'result', id: msg.id, ok: false, error: 'Copilot backend is not connected' }));
      }
    } else if (msg.t === 'release-callback') {
      relaySend({ t: 'release-callback', client: clientId, id: msg.id });
    }
  });
  ws.on('close', () => {
    clients.delete(clientId);
    relaySend({ t: 'release-client', client: clientId });
    for (const [gid, p] of pendingInvokes) if (p.client === clientId) pendingInvokes.delete(gid);
  });
});

function isLoopback(req) {
  const a = req.socket.remoteAddress || '';
  return a === '127.0.0.1' || a === '::1' || a === '::ffff:127.0.0.1';
}

async function proxyBackend(req, socket, head, url) {
  const be = await backendEndpoint();
  if (!be) { socket.end('HTTP/1.1 503 Service Unavailable\r\n\r\n'); return; }
  url.searchParams.set('token', be.token);
  const upstream = net.connect(be.port, '127.0.0.1', () => {
    const skip = new Set(['host', 'origin', 'cookie', 'x-forwarded-for', 'x-forwarded-proto', 'x-forwarded-host', 'x-forwarded-port', 'forwarded']);
    let head0 = `GET /?${url.searchParams.toString()} HTTP/1.1\r\nHost: 127.0.0.1:${be.port}\r\n`;
    for (let i = 0; i < req.rawHeaders.length; i += 2) {
      if (!skip.has(req.rawHeaders[i].toLowerCase())) head0 += `${req.rawHeaders[i]}: ${req.rawHeaders[i + 1]}\r\n`;
    }
    upstream.write(head0 + '\r\n');
    if (head?.length) upstream.write(head);
    upstream.pipe(socket);
    socket.pipe(upstream);
  });
  upstream.setNoDelay(true);
  socket.setNoDelay(true);
  const close = () => { upstream.destroy(); socket.destroy(); };
  upstream.on('error', close);
  socket.on('error', close);
  upstream.on('close', close);
  socket.on('close', close);
}

server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url, 'http://local');
  if (url.pathname === '/__relay') {
    const tok = url.searchParams.get('token') || '';
    const ok = isLoopback(req) && tok.length === RELAY_TOKEN.length &&
      crypto.timingSafeEqual(Buffer.from(tok), Buffer.from(RELAY_TOKEN));
    if (!ok) { socket.end('HTTP/1.1 403 Forbidden\r\n\r\n'); return; }
    return wssRelay.handleUpgrade(req, socket, head, (ws) => wssRelay.emit('connection', ws, req));
  }
  if (!authed(req)) { socket.end('HTTP/1.1 403 Forbidden\r\n\r\n'); return; }
  if (url.pathname === '/__bridge') {
    return wssBridge.handleUpgrade(req, socket, head, (ws) => wssBridge.emit('connection', ws, req));
  }
  if (url.pathname === '/__ws') {
    proxyBackend(req, socket, head, url).catch((e) => {
      log('backend proxy error', e.message);
      socket.destroy();
    });
    return;
  }
  socket.end('HTTP/1.1 404 Not Found\r\n\r\n');
});

server.listen(PORT, HOST, () => {
  log(`Copilot Web listening on http://${HOST}:${PORT}`);
  if (!PASSWORD) log('No COPILOT_WEB_PASSWORD set: keep the port private (Codespaces private ports require GitHub sign-in).');
});

for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { server.close(); process.exit(0); });
