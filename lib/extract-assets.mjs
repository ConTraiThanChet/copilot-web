#!/usr/bin/env node
// Extracts the web frontend embedded in the GitHub Copilot desktop (Tauri)
// binary. Tauri stores each asset as a brotli-compressed byte slice in a
// static (path, bytes) table; we locate the table via the "/index.html" entry.
//
// Usage: node extract-assets.mjs <path/to/usr/bin/github> <out-dir>
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

const [bin, outDir] = process.argv.slice(2);
if (!bin || !outDir) {
  console.error('usage: extract-assets.mjs <github-binary> <out-dir>');
  process.exit(2);
}

const data = fs.readFileSync(bin);
if (data.readUInt32BE(0) !== 0x7f454c46 || data[4] !== 2 || data[5] !== 1) {
  throw new Error('expected a little-endian ELF64 binary');
}

const u64 = (off) => Number(data.readBigUInt64LE(off));
// R_<arch>_RELATIVE relocation type for PIE pointers.
const RELATIVE = { 62: 8 /* x86_64 */, 183: 1027 /* aarch64 */ }[data.readUInt16LE(0x12)];
if (!RELATIVE) throw new Error(`unsupported ELF machine ${data.readUInt16LE(0x12)}`);
const phoff = u64(0x20);
const shoff = u64(0x28);
const phentsize = data.readUInt16LE(0x36);
const phnum = data.readUInt16LE(0x38);
const shentsize = data.readUInt16LE(0x3a);
const shnum = data.readUInt16LE(0x3c);

const loads = [];
for (let i = 0; i < phnum; i++) {
  const o = phoff + i * phentsize;
  if (data.readUInt32LE(o) !== 1) continue; // PT_LOAD
  loads.push({ offset: u64(o + 8), vaddr: u64(o + 16), filesz: u64(o + 32) });
}
const v2o = (v) => {
  for (const s of loads) if (v >= s.vaddr && v < s.vaddr + s.filesz) return v - s.vaddr + s.offset;
  return null;
};
const o2v = (o) => {
  for (const s of loads) if (o >= s.offset && o < s.offset + s.filesz) return o - s.offset + s.vaddr;
  return null;
};

// RELATIVE relocations: slot vaddr -> target vaddr (PIE pointers).
const rel = new Map();
const byTarget = new Map();
for (let i = 0; i < shnum; i++) {
  const o = shoff + i * shentsize;
  if (data.readUInt32LE(o + 4) !== 4) continue; // SHT_RELA
  const off = u64(o + 0x18);
  const size = u64(o + 0x20);
  const entsize = u64(o + 0x38) || 24;
  for (let p = off; p + 24 <= off + size; p += entsize) {
    const type = data.readUInt32LE(p + 8);
    if (type !== RELATIVE) continue;
    const slot = u64(p);
    const target = Number(data.readBigInt64LE(p + 16));
    rel.set(slot, target);
    if (!byTarget.has(target)) byTarget.set(target, []);
    byTarget.get(target).push(slot);
  }
}

const ptrAt = (slot) => (rel.has(slot) ? rel.get(slot) : u64(v2o(slot)));
const valAt = (slot) => u64(v2o(slot));

function entry(slot) {
  const so = v2o(slot);
  if (so === null || v2o(slot + 24) === null) return null;
  const sp = ptrAt(slot), sl = valAt(slot + 8), bp = ptrAt(slot + 16), bl = valAt(slot + 24);
  const nameOff = v2o(sp);
  if (nameOff === null || sl === 0 || sl > 512) return null;
  const name = data.subarray(nameOff, nameOff + sl).toString('utf8');
  if (!name.startsWith('/')) return null;
  const blobOff = v2o(bp);
  if (blobOff === null || blobOff + bl > data.length) return null;
  return { name, blob: data.subarray(blobOff, blobOff + bl) };
}

const needle = Buffer.from('/index.html');
let anchor = null;
for (let i = data.indexOf(needle); i >= 0 && anchor === null; i = data.indexOf(needle, i + 1)) {
  const v = o2v(i);
  for (const slot of byTarget.get(v) || []) {
    if (valAt(slot + 8) === needle.length && entry(slot)) { anchor = slot; break; }
  }
}
if (anchor === null) throw new Error('embedded asset table not found');

const STRIDE = 32;
let start = anchor;
while (entry(start - STRIDE)) start -= STRIDE;

const root = path.resolve(outDir);
fs.rmSync(root, { recursive: true, force: true });
let count = 0;
for (let slot = start; ; slot += STRIDE) {
  const e = entry(slot);
  if (!e) break;
  let content;
  try { content = zlib.brotliDecompressSync(e.blob); } catch { content = e.blob; }
  const dest = path.resolve(root, e.name.replace(/^\/+/, ''));
  if (!dest.startsWith(root + path.sep)) continue;
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, content);
  count++;
}
if (!fs.existsSync(path.join(root, 'index.html'))) throw new Error('index.html missing after extraction');
console.log(`extracted ${count} assets to ${root}`);
