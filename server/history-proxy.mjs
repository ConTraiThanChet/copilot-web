// Backend WebSocket proxy with lazy session history.
//
// The app backend answers `resume_session` + `defer_older_history` with the
// recent tail of a session (`streaming_older: true`), then streams the
// *complete* history. For long sessions that is gigabytes, which a browser on a
// forwarded port cannot download in reasonable time.
//
// This proxy terminates the browser WebSocket and:
//  * forwards the tail, tagged with an `older_cursor`, then tells the browser
//    the rest is deferred (`session_history_deferred`), so the UI shows the
//    session immediately and pages older history only when you scroll up;
//  * captures the complete history (fast, on the same host) into an on-disk
//    cache and answers `load_older_session_history` from it in ~1 MB pages;
//  * acknowledges history frames itself, so the backend never waits on a
//    round trip through the tunnel;
//  * compresses traffic to the browser (permessage-deflate).
import fs from 'node:fs';
import path from 'node:path';
import WebSocket from 'ws';

const CURSOR_PREFIX = 'cw:';
const PAGE_MAX_BYTES = 1024 * 1024;
const PAGE_MAX_EVENTS = 200;

// Older pages carry the main conversation (events without agentId) and
// subagent lifecycle events. Subagent-internal events usually make up almost
// all of a long session; "Load complete history" in the app still loads them.
function isPagedEvent(e) {
  return !!e && (!e.agentId || (typeof e.type === 'string' && e.type.startsWith('subagent.')));
}
const PAGE_WAIT_MS = 25000;

export function createHistoryCache(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  const caches = new Map(); // sessionId -> cache

  function get(sessionId) {
    return caches.get(sessionId) || null;
  }

  // Start (or restart) capturing a session's complete history.
  function begin(sessionId, owner) {
    const old = caches.get(sessionId);
    if (old) {
      try { fs.closeSync(old.fd); } catch { /* ignore */ }
      old.fail();
    }
    const file = path.join(dir, `${sessionId.replace(/[^A-Za-z0-9_-]/g, '_')}.jsonl`);
    const cache = {
      sessionId,
      owner,
      file,
      fd: fs.openSync(file, 'w+'),
      size: 0,
      offsets: [], // [offset, length, paged] per event
      ids: new Map(), // event id -> index
      complete: false,
      failed: false,
      waiters: new Set(),
      append(events) {
        const buf = [];
        for (const e of events) {
          const line = Buffer.from(JSON.stringify(e) + '\n');
          this.offsets.push([this.size, line.length - 1, isPagedEvent(e)]);
          if (e && typeof e.id === 'string') this.ids.set(e.id, this.offsets.length - 1);
          this.size += line.length;
          buf.push(line);
        }
        if (buf.length) fs.writeSync(this.fd, Buffer.concat(buf));
        this.wake();
      },
      finish() { this.complete = true; this.owner = null; this.wake(); },
      fail() { this.failed = true; this.owner = null; this.wake(); },
      wake() { for (const w of [...this.waiters]) w(); },
      has(id) { return this.ids.has(id); },
      // Paged events strictly before the cursor event, newest page first.
      page(cursorId) {
        const end = this.ids.get(cursorId);
        if (end === undefined) return null;
        const picked = [];
        let bytes = 0, i = end;
        while (i > 0 && picked.length < PAGE_MAX_EVENTS) {
          i--;
          const [off, len, paged] = this.offsets[i];
          if (!paged) continue;
          if (picked.length && bytes + len > PAGE_MAX_BYTES) { i++; break; }
          picked.push([off, len]);
          bytes += len;
        }
        picked.reverse();
        const lines = picked.map(([off, len]) => {
          const b = Buffer.alloc(len);
          fs.readSync(this.fd, b, 0, len, off);
          return b.toString('utf8');
        });
        let more = false;
        for (let j = i - 1; j >= 0; j--) if (this.offsets[j][2]) { more = true; break; }
        const olderCursorId = more && lines.length ? JSON.parse(lines[0]).id : null;
        return { events: lines.join(','), olderCursorId, count: lines.length };
      },
      waitFor(cursorId, ms) {
        return new Promise((resolve) => {
          const check = () => {
            if (this.has(cursorId) || this.complete || this.failed) { done(); return true; }
            return false;
          };
          const done = () => { clearTimeout(t); this.waiters.delete(check); resolve(); };
          const t = setTimeout(done, ms);
          if (!check()) this.waiters.add(check);
        });
      },
    };
    caches.set(sessionId, cache);
    return cache;
  }

  function releaseOwner(owner) {
    for (const c of caches.values()) if (c.owner === owner && !c.complete) c.fail();
  }

  return { get, begin, releaseOwner };
}

const TAIL_MAX_BYTES = 3 * 1024 * 1024;
const TAIL_DETAIL_BYTES = 768 * 1024;
const TAIL_WAIT_MS = 45000;

// The backend's recent tail can be tens of MB in busy sessions (subagent tool
// output, screenshots). Keep the newest events within a byte budget: every
// event in the last TAIL_DETAIL_BYTES, then only main-conversation and
// subagent lifecycle events. Older events are served from the cache.
function trimTail(events) {
  const kept = [];
  let bytes = 0, all = 0;
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    const len = JSON.stringify(e).length;
    all += len;
    if (all > TAIL_DETAIL_BYTES && !isPagedEvent(e)) continue;
    if (kept.length && bytes + len > TAIL_MAX_BYTES) {
      if (isPagedEvent(e)) break;
      continue; // skip an oversized subagent event rather than stopping
    }
    kept.push(e);
    bytes += len;
  }
  return kept.reverse();
}

// Connects one browser WebSocket to the backend through the history proxy.
export function bridgeBackend(browser, backendUrl, cache, log) {
  const backend = new WebSocket(backendUrl, {
    headers: { Origin: 'tauri://localhost' },
    perMessageDeflate: false,
    maxPayload: 1024 * 1024 * 1024,
  });
  const owner = Symbol('connection');
  const pendingToBackend = [];
  const deferredResumes = new Map(); // request_id -> { sessionId, firstEventId, tailDone, capturing }
  const finishedRequests = new Set(); // request ids whose remaining traffic is ours
  let parts = [];

  const sendBrowser = (data) => { if (browser.readyState === 1) browser.send(data); };
  const sendBackend = (data) => {
    if (backend.readyState === 1) backend.send(data);
    else if (backend.readyState === 0) pendingToBackend.push(data);
  };

  backend.on('open', () => {
    for (const d of pendingToBackend.splice(0)) backend.send(d);
  });

  // ---- browser -> backend ------------------------------------------------
  browser.on('message', (data, isBinary) => {
    if (isBinary) return sendBackend(data);
    const text = data.toString();
    if (text.startsWith('{"type":"acknowledge_session_history_frame"')) return; // we ack ourselves
    if (text.startsWith('{"type":"load_older_session_history"')) {
      let m;
      try { m = JSON.parse(text); } catch { return sendBackend(text); }
      if (typeof m.cursor === 'string' && m.cursor.startsWith(CURSOR_PREFIX)) {
        serveOlder(m).catch((e) => {
          log('older history page failed:', e.message);
          sendBrowser(JSON.stringify({ type: 'session_older_history_unavailable', session_id: m.session_id, request_id: m.request_id, reason: 'retry' }));
        });
        return;
      }
    } else if (text.startsWith('{"type":"resume_session"') && text.includes('"defer_older_history":true')) {
      try {
        const m = JSON.parse(text);
        if (m.request_id && m.session_id) deferredResumes.set(m.request_id, { sessionId: m.session_id, firstEventId: null, tailDone: false, capturing: null });
      } catch { /* forward unchanged */ }
    }
    sendBackend(text);
  });

  async function serveOlder(m) {
    const cursorId = m.cursor.slice(CURSOR_PREFIX.length);
    const c = cache.get(m.session_id);
    if (!c) throw new Error('no history cache for session');
    if (!c.has(cursorId) && !c.complete && !c.failed) await c.waitFor(cursorId, PAGE_WAIT_MS);
    const page = c.has(cursorId) ? c.page(cursorId) : null;
    if (!page) {
      sendBrowser(JSON.stringify({ type: 'session_older_history_unavailable', session_id: m.session_id, request_id: m.request_id, reason: 'retry' }));
      return;
    }
    const head = { type: 'session_history', session_id: m.session_id, request_id: m.request_id, prepend: true };
    if (page.olderCursorId) head.older_cursor = CURSOR_PREFIX + page.olderCursorId;
    const json = JSON.stringify(head);
    sendBrowser(`${json.slice(0, -1)},"events":[${page.events}]}`);
  }

  // ---- backend -> browser ------------------------------------------------
  backend.on('message', (data, isBinary) => {
    if (isBinary) return sendBrowser(data);
    const text = data.toString();
    if (text.startsWith('{"type":"session_event"')) {
      appendLiveEvent(text);
      return sendBrowser(text);
    }
    if (!text.startsWith('{"type":"session_history') && !text.startsWith('{"type":"error"')) {
      return sendBrowser(text);
    }
    let m;
    try { m = JSON.parse(text); } catch { return sendBrowser(text); }
    if (m.delivery_seq !== undefined) {
      sendBackend(JSON.stringify({ type: 'acknowledge_session_history_frame', sequence: m.delivery_seq }));
      delete m.delivery_seq;
    }
    if (m.type === 'session_history_part') {
      parts.push(m.data);
      if (parts.length < m.count) return;
      const full = parts.join('');
      parts = [];
      let inner;
      try { inner = JSON.parse(full); } catch { return; }
      return handleHistory(inner);
    }
    if (m.type === 'session_history_chunk' || m.type === 'session_history') return handleHistory(m);
    if (m.request_id && finishedRequests.has(m.request_id)) {
      if (process.env.COPILOT_WEB_DEBUG) log('dropped', text.slice(0, 200));
      return; // stray progress/errors after deferral
    }
    sendBrowser(JSON.stringify(m));
  });

  // Keep complete caches current with persisted live events, so a later
  // resume can reuse the cache instead of capturing the history again.
  function appendLiveEvent(text) {
    const sid = /"session_id":"([^"]+)"/.exec(text.slice(0, 200));
    const c = sid && cache.get(sid[1]);
    if (!c || !c.complete || c.failed) return;
    let m;
    try { m = JSON.parse(text); } catch { return; }
    const e = m.event;
    if (!e || e.ephemeral || typeof e.id !== 'string' || c.has(e.id)) return;
    c.append([e]);
  }

  function handleHistory(m) {
    const msg = m.type === 'session_history_chunk' ? m.message : m;
    const req = msg && msg.request_id;
    const state = req ? deferredResumes.get(req) : undefined;
    if (req && finishedRequests.has(req) && !state) return;
    if (!state) return sendBrowser(JSON.stringify(m));

    if (msg.streaming_older === true && !state.tailDone) {
      // Tail of the history: buffer it (it arrives quickly from the local
      // backend), then send the browser a trimmed tail with a cursor.
      const events = Array.isArray(msg.events) ? msg.events : [];
      if (!state.tailEvents) {
        state.tailEvents = [];
        state.tailMeta = { ...msg };
        delete state.tailMeta.events;
      }
      for (const e of events) state.tailEvents.push(e);
      if (m.type !== 'session_history' && m.last !== true) return;
      const trimmed = trimTail(state.tailEvents);
      state.tailEvents = null;
      state.tailDone = true;
      state.pendingTail = { ...state.tailMeta, type: 'session_history', events: trimmed };
      const firstId = trimmed.length && typeof trimmed[0].id === 'string' ? trimmed[0].id : null;
      const existing = cache.get(state.sessionId);
      if (!firstId) {
        sendBackend(JSON.stringify({ type: 'cancel_session_history', session_id: state.sessionId, request_id: req }));
        flushTail(req, state, null);
      } else if (existing && !existing.failed && existing.complete && existing.has(firstId)) {
        sendBackend(JSON.stringify({ type: 'cancel_session_history', session_id: state.sessionId, request_id: req }));
        flushTail(req, state, existing);
      } else {
        // The backend's tail is often all subagent work. Capture the complete
        // history (fast, local) so the first view can include a page of the
        // main conversation; send the tail when it is ready or after a cap.
        state.capturing = cache.begin(state.sessionId, owner);
        log(`capturing history for session ${state.sessionId}`);
        state.tailTimer = setTimeout(() => flushTail(req, state, state.capturing), TAIL_WAIT_MS);
      }
      return;
    }

    // Complete history following the tail: capture it, don't send it.
    if (state.capturing && !state.capturing.failed) {
      const events = Array.isArray(msg.events) ? msg.events : [];
      state.capturing.append(events);
      if (state.pendingTail && state.capturing.has(state.pendingTail.events[0].id)) {
        // The page before the tail is captured once the tail start is reached.
        flushTail(req, state, state.capturing);
      }
      if (m.type === 'session_history' || m.last === true) {
        state.capturing.finish();
        flushTail(req, state, state.capturing);
        log(`history cache ready for session ${state.sessionId} (${state.capturing.offsets.length} events)`);
        deferredResumes.delete(req);
      }
    }
  }

  function flushTail(req, state, c) {
    if (!state.pendingTail) return;
    clearTimeout(state.tailTimer);
    const out = state.pendingTail;
    state.pendingTail = null;
    const firstId = out.events.length ? out.events[0].id : null;
    if (firstId) {
      out.older_cursor = CURSOR_PREFIX + firstId;
      const page = c && !c.failed && c.has(firstId) ? c.page(firstId) : null;
      if (page && page.count > 0) {
        out.events = JSON.parse(`[${page.events}]`).concat(out.events);
        if (page.olderCursorId) out.older_cursor = CURSOR_PREFIX + page.olderCursorId;
        else delete out.older_cursor;
      }
    }
    finishedRequests.add(req);
    sendBrowser(JSON.stringify(out));
    sendBrowser(JSON.stringify({ type: 'session_history_deferred', session_id: state.sessionId, request_id: req }));
    if (!state.capturing) deferredResumes.delete(req);
  }

  // ---- lifecycle ---------------------------------------------------------
  const close = () => {
    cache.releaseOwner(owner);
    try { browser.close(); } catch { /* ignore */ }
    try { backend.close(); } catch { /* ignore */ }
  };
  backend.on('close', close);
  backend.on('error', (e) => { log('backend ws error:', e.message); close(); });
  browser.on('close', close);
  browser.on('error', close);
}
