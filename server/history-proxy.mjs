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
      // Work still in progress, keyed by toolCallId -> event index: running
      // background agents (subagent.started without completion) and top-level
      // tool calls without a result. The UI needs their start events to show
      // them (e.g. the "Background" activity list), even when they started
      // long before the visible part of the history.
      openAgents: new Map(),
      openTools: new Map(),
      track(e, index) {
        const id = e && e.data && e.data.toolCallId;
        if (!id) return;
        switch (e.type) {
          case 'subagent.started': this.openAgents.set(id, index); break;
          case 'subagent.completed': case 'subagent.failed': this.openAgents.delete(id); break;
          case 'tool.execution_start':
            if (!e.agentId) this.openTools.set(id, index);
            (this.taskStarts ||= new Map()).set(id, index);
            break;
          case 'tool.execution_complete': if (!e.agentId) this.openTools.delete(id); break;
        }
      },
      // Start events of in-progress work that occur before `beforeIndex`.
      openEvents(beforeIndex) {
        const idx = new Set();
        for (const m of [this.openAgents, this.openTools]) for (const i of m.values()) if (i < beforeIndex) idx.add(i);
        if (this.taskStarts) for (const id of this.openAgents.keys()) {
          const i = this.taskStarts.get(id);
          if (i !== undefined && i < beforeIndex) idx.add(i);
        }
        // Include the task tool call that launched each open agent.
        return [...idx].sort((a, b) => a - b).map((i) => {
          const [off, len] = this.offsets[i];
          const b = Buffer.alloc(len);
          fs.readSync(this.fd, b, 0, len, off);
          return JSON.parse(b.toString('utf8'));
        });
      },
      indexOf(id) { return this.ids.get(id); },
      append(events) {
        const buf = [];
        for (const e of events) {
          const line = Buffer.from(JSON.stringify(e) + '\n');
          this.offsets.push([this.size, line.length - 1, isPagedEvent(e)]);
          if (e && typeof e.id === 'string') this.ids.set(e.id, this.offsets.length - 1);
          this.track(e, this.offsets.length - 1);
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

// In-progress work read from the session's events.jsonl on this host:
// running background agents (subagent.started without completed/failed), the
// task tool calls that launched them, and top-level tool calls without a
// result. The UI rebuilds its "Background" list from these start events, which
// for long-running agents lie far before the visible part of the history.
export function createOpenWorkReader(sessionStateDir) {
  const state = new Map(); // sessionId -> index
  async function scan(sessionId) {
    const file = path.join(sessionStateDir, sessionId, 'events.jsonl');
    let st;
    try { st = fs.statSync(file); } catch { return null; }
    let ix = state.get(sessionId);
    if (!ix || st.size < ix.offset) {
      ix = { offset: 0, rest: '', order: 0, agents: new Map(), tools: new Map(), tasks: new Map(), busy: null };
      state.set(sessionId, ix);
    }
    if (ix.busy) return ix.busy;
    if (st.size === ix.offset) return ix;
    ix.busy = new Promise((resolve) => {
      const stream = fs.createReadStream(file, { start: ix.offset, end: st.size - 1, encoding: 'utf8', highWaterMark: 1 << 20 });
      stream.on('data', (chunk) => {
        const lines = (ix.rest + chunk).split('\n');
        ix.rest = lines.pop();
        for (const line of lines) {
          ix.order++;
          if (!line.startsWith('{"type":"subagent.') && !line.startsWith('{"type":"tool.execution_')) continue;
          let e;
          try { e = JSON.parse(line); } catch { continue; }
          const id = e.data && e.data.toolCallId;
          if (!id) continue;
          const item = { order: ix.order, event: e };
          switch (e.type) {
            case 'subagent.started': ix.agents.set(id, item); break;
            case 'subagent.completed': case 'subagent.failed': ix.agents.delete(id); ix.tasks.delete(id); break;
            case 'tool.execution_start':
              if (!e.agentId) {
                ix.tools.set(id, item);
                if (e.data.toolName === 'task') ix.tasks.set(id, item);
              }
              break;
            case 'tool.execution_complete': if (!e.agentId) ix.tools.delete(id); break;
          }
        }
      });
      const done = () => { ix.offset = st.size; ix.busy = null; resolve(ix); };
      stream.on('end', done);
      stream.on('error', () => { ix.busy = null; resolve(ix); });
    });
    return ix.busy;
  }
  return async function openWork(sessionId) {
    const ix = await scan(sessionId);
    if (!ix) return [];
    const items = new Map();
    for (const [id, it] of ix.agents) {
      items.set(it.event.id, it);
      const t = ix.tasks.get(id);
      if (t) items.set(t.event.id, t);
    }
    for (const it of ix.tools.values()) items.set(it.event.id, it);
    return [...items.values()].sort((a, b) => a.order - b.order).map((it) => it.event);
  };
}

// Connects one browser WebSocket to the backend through the history proxy.
export function bridgeBackend(browser, backendUrl, cache, log, openWork = null) {
  const backend = new WebSocket(backendUrl, {
    headers: { Origin: 'tauri://localhost' },
    perMessageDeflate: false,
    maxPayload: 1024 * 1024 * 1024,
  });
  const owner = Symbol('connection');
  const pendingToBackend = [];
  const deferredResumes = new Map(); // request_id -> { sessionId, firstEventId, tailDone, capturing }
  const finishedRequests = new Set(); // request ids whose remaining traffic is ours
  const sentEarly = new Set(); // ids of older events already sent ahead of their page
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
    } else if (process.env.COPILOT_WEB_DEBUG && text.startsWith('{"type":"resume_session"')) {
      log('resume', text.replace(/"enabled_experiments":\[[^\]]*\],?/, '').slice(0, 220));
    }
    if (text.startsWith('{"type":"resume_session"') && text.includes('"defer_older_history":true')) {
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
    let events = page.events;
    if (sentEarly.size && events) {
      events = JSON.parse(`[${events}]`).filter((e) => !sentEarly.has(e.id)).map((e) => JSON.stringify(e)).join(',');
    }
    const json = JSON.stringify(head);
    sendBrowser(`${json.slice(0, -1)},"events":[${events}]}`);
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
    if (m.type === 'session_history_deferred' && m.request_id) {
      const st = deferredResumes.get(m.request_id);
      if (st && st.capturing && !st.capturing.complete) {
        // No complete history will follow after all.
        st.capturing.fail();
        st.capturing = null;
        flushTail(m.request_id, st, null);
        return;
      }
    }
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
    if (!state) {
      if (msg && msg.prepend && sentEarly.size && Array.isArray(msg.events)) {
        msg.events = msg.events.filter((e) => !sentEarly.has(e.id));
      }
      return sendBrowser(JSON.stringify(m));
    }

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
      if (typeof msg.older_cursor === 'string') state.nativeCursor = msg.older_cursor;
      if (m.type !== 'session_history' && m.last !== true) return;
      const trimmed = trimTail(state.tailEvents);
      state.tailEvents = null;
      state.tailDone = true;
      finishedRequests.add(req);
      state.pendingTail = { ...state.tailMeta, type: 'session_history', events: trimmed };
      delete state.pendingTail.older_cursor;
      if (state.nativeCursor) {
        // The backend pages older history itself (it sends
        // session_history_deferred next): keep its cursor, capture nothing.
        state.native = true;
        flushTail(req, state, null);
        return;
      }
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

  async function flushTail(req, state, c) {
    if (!state.pendingTail) return;
    clearTimeout(state.tailTimer);
    const out = state.pendingTail;
    state.pendingTail = null;
    finishedRequests.add(req);
    const firstId = out.events.length ? out.events[0].id : null;
    let lead = [];
    if (state.native) {
      out.older_cursor = state.nativeCursor;
    } else if (firstId) {
      out.older_cursor = CURSOR_PREFIX + firstId;
      const page = c && !c.failed && c.has(firstId) ? c.page(firstId) : null;
      if (page && page.count > 0) {
        lead = JSON.parse(`[${page.events}]`);
        if (page.olderCursorId) out.older_cursor = CURSOR_PREFIX + page.olderCursorId;
        else delete out.older_cursor;
      }
    }
    if (openWork) {
      try {
        const have = new Set(lead.map((e) => e.id).concat(out.events.map((e) => e.id)));
        const open = (await openWork(state.sessionId)).filter((e) => !have.has(e.id));
        for (const e of open) sentEarly.add(e.id);
        lead = open.concat(lead);
      } catch (e) {
        log('open work scan failed:', e.message);
      }
    }
    out.events = lead.concat(out.events);
    if (process.env.COPILOT_WEB_DEBUG) log(`tail ${state.sessionId} events=${out.events.length} lead=${lead.length} native=${!!state.native}`);
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
