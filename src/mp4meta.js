'use strict';
// Minimal MP4 / QuickTime box reader: capture date, GPS location, display size.
// Handles phone videos (Apple keys/ilst metadata, Android ©xyz) and rotation matrices.

const fs = require('fs/promises');

const MAC_EPOCH_OFFSET = 2082844800; // seconds between 1904-01-01 and 1970-01-01

async function readAt(fh, pos, len) {
  const buf = Buffer.alloc(len);
  const { bytesRead } = await fh.read(buf, 0, len, pos);
  return buf.subarray(0, bytesRead);
}

// Iterate boxes inside buf[start, end)
function* boxes(buf, start = 0, end = buf.length) {
  let p = start;
  while (p + 8 <= end) {
    let size = buf.readUInt32BE(p);
    const type = buf.toString('latin1', p + 4, p + 8);
    let header = 8;
    if (size === 1) {
      if (p + 16 > end) return;
      size = Number(buf.readBigUInt64BE(p + 8));
      header = 16;
    } else if (size === 0) {
      size = end - p;
    }
    if (size < header || p + size > end) return;
    yield { type, start: p, dataStart: p + header, end: p + size };
    p += size;
  }
}

function child(buf, box, type) {
  for (const b of boxes(buf, box.dataStart, box.end)) if (b.type === type) return b;
  return null;
}

// ISO 6709 e.g. "+51.5074-000.1278+012.000/"
function parseISO6709(s) {
  const m = /([+-]\d+(?:\.\d+)?)([+-]\d+(?:\.\d+)?)/.exec(s || '');
  if (!m) return null;
  const lat = parseFloat(m[1]);
  const lon = parseFloat(m[2]);
  if (!isFinite(lat) || !isFinite(lon) || (lat === 0 && lon === 0)) return null;
  return { lat, lon };
}

function parseMvhd(buf, b) {
  const ver = buf[b.dataStart];
  const secs = ver === 1 ? Number(buf.readBigUInt64BE(b.dataStart + 4)) : buf.readUInt32BE(b.dataStart + 4);
  if (!secs) return null;
  const unix = secs - MAC_EPOCH_OFFSET;
  if (unix < 0 || unix > Date.now() / 1000 + 86400 * 365) return null;
  return new Date(unix * 1000);
}

function parseTrak(buf, trak) {
  const mdia = child(buf, trak, 'mdia');
  const hdlr = mdia && child(buf, mdia, 'hdlr');
  if (!hdlr || buf.toString('latin1', hdlr.dataStart + 8, hdlr.dataStart + 12) !== 'vide') return null;
  const tkhd = child(buf, trak, 'tkhd');
  if (!tkhd) return null;
  const ver = buf[tkhd.dataStart];
  const matrixOff = tkhd.dataStart + (ver === 1 ? 52 : 40);
  const a = buf.readInt32BE(matrixOff) / 65536;
  const bb = buf.readInt32BE(matrixOff + 4) / 65536;
  const w = buf.readUInt32BE(matrixOff + 36) / 65536;
  const h = buf.readUInt32BE(matrixOff + 40) / 65536;
  if (!w || !h) return null;
  const rotated = Math.abs(a) < 0.01 && Math.abs(Math.abs(bb) - 1) < 0.01;
  return rotated ? { width: h, height: w } : { width: w, height: h };
}

// Apple QuickTime metadata: moov/meta/{keys, ilst}
function parseAppleMeta(buf, meta, out) {
  // QuickTime 'meta' has no version/flags; MP4 'meta' does. Detect by peeking.
  let start = meta.dataStart;
  const peekType = buf.toString('latin1', start + 4, start + 8);
  if (!/^[a-z©]{4}$/i.test(peekType)) start += 4;
  const inner = { dataStart: start, end: meta.end };
  const keysBox = child(buf, inner, 'keys');
  const ilst = child(buf, inner, 'ilst');
  if (!keysBox || !ilst) return;

  const keys = [];
  const count = buf.readUInt32BE(keysBox.dataStart + 4);
  let p = keysBox.dataStart + 8;
  for (let i = 0; i < count && p + 8 <= keysBox.end; i++) {
    const sz = buf.readUInt32BE(p);
    keys.push(buf.toString('utf8', p + 8, p + sz));
    p += sz;
  }
  for (const item of boxes(buf, ilst.dataStart, ilst.end)) {
    const idx = buf.readUInt32BE(item.start + 4) - 1;
    const key = keys[idx];
    if (!key) continue;
    const data = child(buf, item, 'data');
    if (!data) continue;
    const value = buf.toString('utf8', data.dataStart + 8, data.end);
    if (key === 'com.apple.quicktime.location.ISO6709') out.gps = out.gps || parseISO6709(value);
    if (key === 'com.apple.quicktime.creationdate') {
      const d = new Date(value);
      if (!isNaN(d)) out.date = d;
    }
  }
}

function parseUdta(buf, udta, out) {
  for (const b of boxes(buf, udta.dataStart, udta.end)) {
    if (b.type === '©xyz') {
      // 2 bytes length, 2 bytes language, then string
      out.gps = out.gps || parseISO6709(buf.toString('latin1', b.dataStart + 4, b.end));
    } else if (b.type === 'meta') {
      parseAppleMeta(buf, b, out);
    }
  }
}

async function readMp4Meta(file) {
  const fh = await fs.open(file, 'r');
  try {
    const { size } = await fh.stat();
    let pos = 0;
    let moov = null;
    while (pos + 8 <= size) {
      const h = await readAt(fh, pos, 16);
      if (h.length < 8) break;
      let boxSize = h.readUInt32BE(0);
      const type = h.toString('latin1', 4, 8);
      if (boxSize === 1) boxSize = Number(h.readBigUInt64BE(8));
      else if (boxSize === 0) boxSize = size - pos;
      if (boxSize < 8) break;
      if (type === 'moov') {
        if (boxSize > 64 * 1024 * 1024) return {};
        moov = await readAt(fh, pos, boxSize);
        break;
      }
      pos += boxSize;
    }
    if (!moov) return {};

    const out = { date: null, gps: null, width: null, height: null };
    const root = [...boxes(moov)][0];
    let mvhdDate = null;
    for (const b of boxes(moov, root.dataStart, root.end)) {
      if (b.type === 'mvhd') mvhdDate = parseMvhd(moov, b);
      else if (b.type === 'trak' && !out.width) {
        const dims = parseTrak(moov, b);
        if (dims) Object.assign(out, dims);
      } else if (b.type === 'udta') parseUdta(moov, b, out);
      else if (b.type === 'meta') parseAppleMeta(moov, b, out);
    }
    if (!out.date) out.date = mvhdDate;
    return out;
  } finally {
    await fh.close();
  }
}

module.exports = { readMp4Meta };
