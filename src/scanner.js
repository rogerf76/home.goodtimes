'use strict';
// Walks the source folders, extracts date / location / size for every media file,
// and keeps a metadata cache so rescans of large network shares are fast.

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const exifr = require('exifr');
const { imageSizeFromFile } = require('image-size/fromFile');
const { readMp4Meta } = require('./mp4meta');

const CACHE_VERSION = 2;

function loadCache(file) {
  if (!file) return {};
  try {
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    return data.version === CACHE_VERSION ? data.entries : {};
  } catch {
    return {};
  }
}

function saveCache(file, entries) {
  if (!file) return;
  try {
    fs.writeFileSync(file, JSON.stringify({ version: CACHE_VERSION, entries }));
  } catch (e) {
    console.warn(`Could not write cache ${file}: ${e.message}`);
  }
}

async function walk(dir, cfg, out) {
  let entries;
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true });
  } catch (e) {
    console.warn(`Cannot read folder ${dir}: ${e.message}`);
    return;
  }
  const subdirs = [];
  for (const ent of entries) {
    if (ent.name.startsWith('.')) continue;
    const full = path.join(dir, ent.name);
    if (ent.isDirectory()) {
      if (cfg.recursive && !cfg.excludeFolders.includes(ent.name.toLowerCase())) subdirs.push(full);
    } else if (ent.isFile()) {
      const ext = path.extname(ent.name).slice(1).toLowerCase();
      if (cfg.include.images.includes(ext)) out.push({ path: full, type: 'image' });
      else if (cfg.include.videos.includes(ext)) out.push({ path: full, type: 'video' });
    }
  }
  // Walk a few subfolders in parallel – helps a lot over SMB latency.
  await mapLimit(subdirs, 4, (d) => walk(d, cfg, out));
}

async function mapLimit(items, limit, fn) {
  let i = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) {
      const idx = i++;
      await fn(items[idx], idx);
    }
  });
  await Promise.all(workers);
}

// e.g. IMG_20230514_153012.jpg, PXL_20230514_153012345.mp4, 2023-05-14 15.30.12.jpg
const FILENAME_DATE = /(?<!\d)((?:19|20)\d{2})[-_.]?(0[1-9]|1[0-2])[-_.]?(0[1-9]|[12]\d|3[01])(?:[-_ T.]?([01]\d|2[0-3])[-_.]?([0-5]\d)[-_.]?([0-5]\d))?/;

function dateFromFilename(name) {
  const m = FILENAME_DATE.exec(name);
  if (!m) return null;
  const d = new Date(+m[1], +m[2] - 1, +m[3], +(m[4] || 12), +(m[5] || 0), +(m[6] || 0));
  return isNaN(d) ? null : d;
}

function validDate(d) {
  if (!(d instanceof Date) || isNaN(d)) return null;
  const y = d.getFullYear();
  return y >= 1900 && d.getTime() < Date.now() + 86400000 * 2 ? d : null;
}

async function imageMeta(file) {
  const meta = { date: null, lat: null, lon: null, width: null, height: null };
  let orientation = 1;
  try {
    const ex = await exifr.parse(file, {
      tiff: true, exif: true, gps: true, ifd1: false, xmp: false, icc: false, iptc: false,
      translateValues: false, mergeOutput: true,
    });
    if (ex) {
      meta.date = validDate(ex.DateTimeOriginal) || validDate(ex.CreateDate) || null;
      if (isFinite(ex.latitude) && isFinite(ex.longitude) && !(ex.latitude === 0 && ex.longitude === 0)) {
        meta.lat = ex.latitude;
        meta.lon = ex.longitude;
      }
      orientation = ex.Orientation || 1;
    }
  } catch { /* no EXIF – fine */ }
  try {
    const dim = await imageSizeFromFile(file);
    let { width, height } = dim;
    const o = dim.orientation || orientation;
    if (o >= 5 && o <= 8) [width, height] = [height, width];
    meta.width = width;
    meta.height = height;
  } catch { /* unknown size */ }
  return meta;
}

async function videoMeta(file) {
  const meta = { date: null, lat: null, lon: null, width: null, height: null };
  try {
    const m = await readMp4Meta(file);
    meta.date = validDate(m.date);
    if (m.gps) { meta.lat = m.gps.lat; meta.lon = m.gps.lon; }
    meta.width = m.width || null;
    meta.height = m.height || null;
  } catch { /* not an mp4 container, e.g. webm */ }
  return meta;
}

/**
 * Returns [{ path, type, date (ms), lat, lon, width, height, name }]
 */
async function scan(cfg, onProgress = () => {}) {
  const files = [];
  for (const src of cfg.sources) {
    if (!fs.existsSync(src)) console.warn(`Source folder not found: ${src}`);
    else await walk(src, cfg, files);
  }
  onProgress({ phase: 'found', total: files.length });

  const cache = loadCache(cfg.cacheFile);
  const newCache = {};
  let done = 0;
  let dirty = false;
  const results = [];

  await mapLimit(files, 8, async (f) => {
    let st;
    try {
      st = await fsp.stat(f.path);
    } catch {
      return;
    }
    const key = f.path;
    const cached = cache[key];
    let meta;
    if (cached && cached.size === st.size && cached.mtime === st.mtimeMs) {
      meta = cached.meta;
    } else {
      const m = f.type === 'image' ? await imageMeta(f.path) : await videoMeta(f.path);
      const name = path.basename(f.path);
      const date = m.date || dateFromFilename(name) || new Date(Math.min(st.mtimeMs, st.birthtimeMs || Infinity));
      meta = {
        date: date.getTime(),
        dateSource: m.date ? 'metadata' : dateFromFilename(name) ? 'filename' : 'file',
        lat: m.lat, lon: m.lon, width: m.width, height: m.height,
      };
      dirty = true;
    }
    newCache[key] = { size: st.size, mtime: st.mtimeMs, meta };
    results.push({ path: f.path, type: f.type, name: path.basename(f.path), ...meta });
    if (++done % 200 === 0) onProgress({ phase: 'reading', done, total: files.length });
  });

  if (dirty || Object.keys(cache).length !== Object.keys(newCache).length) saveCache(cfg.cacheFile, newCache);
  onProgress({ phase: 'done', total: results.length });
  return results;
}

module.exports = { scan, dateFromFilename };
