#!/usr/bin/env node
// Turns the extracted desktop frontend into the Copilot Web app:
//  - routes the backend WebSocket through the Copilot Web server (/__ws)
//  - loads the browser runtime shim (copilot-web.js) before the app bundle
//
// Usage: node patch-web.mjs <extracted-dir> <out-dir>
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const [src, out] = process.argv.slice(2).map((p) => p && path.resolve(p));
if (!src || !out) {
  console.error('usage: patch-web.mjs <extracted-dir> <out-dir>');
  process.exit(2);
}

fs.rmSync(out, { recursive: true, force: true });
fs.cpSync(src, out, { recursive: true });

const assets = path.join(out, 'assets');
const files = fs.readdirSync(assets).filter((f) => f.endsWith('.js'));
const applied = new Map();

function patch(name, regex, replace) {
  for (const f of files) {
    const p = path.join(assets, f);
    const code = fs.readFileSync(p, 'utf8');
    if (!regex.test(code)) continue;
    fs.writeFileSync(p, code.replace(regex, replace));
    applied.set(name, f);
  }
}

// WebSocket URL resolver: prefer the shim's same-origin bridge.
patch(
  'websocket-url',
  /async function (\w+)\((\w+)\)\{let (\w+)=new URL\(window\.location\.href\)\.searchParams,(\w+)=\3\.get\(`ws_port`\)/,
  (m, fn, arg) => m.replace(`async function ${fn}(${arg}){`,
    `async function ${fn}(${arg}){if(globalThis.__COPILOT_WEB__)return globalThis.__COPILOT_WEB__.wsUrl();`),
);

// Session resync (after lagging behind live events) asks for the complete
// history. Over a remote link that can be gigabytes: defer older history the
// same way a normal resume does, when the backend supports it.
patch(
  'resync-deferred',
  /function (\w+)\(e,\{createRequestId:t,clearResumeTimeout:n,armResumeTimeout:r,pendingHistory:i,setSessionLoading:a,sendMessage:o\}\)\{let s=t\(\);(\$?\w+)\(e,s\);(.{0,200}?)type:`resume_session`,session_id:e,include_history:!0,request_id:s\}/,
  (m, fn, mark, mid) => {
    const defer = /function (\w+)\(e\)\{let t=Q\.getState\(\)\.sessions\.get\(e\);return Af\.deferred/;
    return `function ${fn}(e,{createRequestId:t,clearResumeTimeout:n,armResumeTimeout:r,pendingHistory:i,setSessionLoading:a,sendMessage:o}){let s=t(),cwD=globalThis.__COPILOT_WEB_DEFER__?.(e)===!0;${mark}(e,s,!0,\`resume\`,cwD);${mid}type:\`resume_session\`,session_id:e,include_history:!0,...cwD?{defer_older_history:!0}:{},request_id:s}`;
  },
);
// Expose the app's own "can defer older history" check to the patch above.
patch(
  'defer-check',
  /function (\w+)\(e\)\{let t=Q\.getState\(\)\.sessions\.get\(e\);return Af\.deferred&&\(t\?\.executionLocation\?\?`local`\)===`local`\}/,
  (m, fn) => `${m}globalThis.__COPILOT_WEB_DEFER__=${fn};`,
);

let failed = false;
for (const name of ['websocket-url', 'resync-deferred', 'defer-check']) {
  if (applied.has(name)) console.log(`patched ${name} (${applied.get(name)})`);
  else if (name === 'websocket-url') { console.error(`ERROR: patch "${name}" did not match this app version`); failed = true; }
  else console.warn(`warning: optional patch "${name}" did not match this app version`);
}
// Patched files keep their hashed names; tell the server not to cache them forever.
fs.writeFileSync(path.join(out, '.patched.json'), JSON.stringify([...new Set(applied.values())].map((f) => `/assets/${f}`)));

fs.copyFileSync(path.join(here, '..', 'web', 'copilot-web.js'), path.join(out, 'copilot-web.js'));
const indexPath = path.join(out, 'index.html');
let html = fs.readFileSync(indexPath, 'utf8');
if (!html.includes('/copilot-web.js')) {
  html = html.replace('<head>', '<head>\n    <script src="/copilot-web.js"></script>');
  fs.writeFileSync(indexPath, html);
}
if (failed) process.exit(1);
console.log(`web app written to ${out}`);
