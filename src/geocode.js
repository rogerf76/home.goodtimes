'use strict';
// Optional reverse geocoding of event locations via OpenStreetMap Nominatim.
// Only one lookup per event (not per photo), rate-limited to 1/sec and cached on disk.

const fs = require('fs');

const ENDPOINT = 'https://nominatim.openstreetmap.org/reverse';
const USER_AGENT = 'goodtimes/1.0 (personal, non-commercial)';

function loadCache(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return {}; }
}

// "Alameda, California" / "Keswick, England". The country is only shown when
// there's no state or region to go with the place name.
const townName = (a) => a && (a.city || a.town || a.village || a.hamlet || a.suburb || a.municipality);
// Named spots used when a photo wasn't taken in a town (national parks, mountains, beaches...).
const spotName = (a) => a && (a.neighbourhood || a.locality || a.tourism || a.natural || a.leisure
  || a.hamlet || a.suburb || a.isolated_dwelling);

function placeName(addr) {
  if (!addr) return null;
  // Skip bureaucratic names like "Improvement District No. 9" or "Division No. 15".
  const county = addr.county && !/\bNo\.?\s*\d+|unorganized/i.test(addr.county) ? addr.county : null;
  const local = townName(addr) || spotName(addr.detail) || county;
  const region = addr.state || addr.region || addr.province || addr.state_district;
  const parts = [local, region || addr.country].filter(Boolean);
  return parts.length ? [...new Set(parts)].join(', ') : null;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function lookup(ev, zoom, cfg) {
  const url = `${ENDPOINT}?format=jsonv2&zoom=${zoom}&lat=${ev.lat}&lon=${ev.lon}&accept-language=${encodeURIComponent(cfg.geocoding.language)}`;
  const res = await fetch(url, { headers: { 'User-Agent': USER_AGENT } });
  return res.ok ? (await res.json()).address || null : null;
}

/** Calls onLabel(eventId, place) as names become available. */
async function geocodeEvents(events, cfg, onLabel) {
  const cache = loadCache(cfg.geocoding.cacheFile);
  let dirty = false;
  for (const ev of events) {
    if (ev.lat == null) continue;
    const key = `${ev.lat.toFixed(2)},${ev.lon.toFixed(2)}`;
    // The cache keeps the raw address so the display format can change without new lookups.
    // (Older caches stored finished text – those entries are looked up again.)
    if (!(key in cache) || typeof cache[key] === 'string') {
      try {
        const addr = await lookup(ev, 14, cfg);
        if (addr && !townName(addr)) {
          // Out in the countryside: look closer for a named area or landmark.
          await sleep(1100);
          addr.detail = await lookup(ev, 16, cfg);
        }
        cache[key] = addr;
        dirty = true;
      } catch (e) {
        console.warn(`Geocoding failed: ${e.message}`);
        break; // offline – try again on next rescan
      }
      await sleep(1100);
    }
    const name = placeName(cache[key]);
    if (name) onLabel(ev.id, name);
  }
  if (dirty) {
    try { fs.writeFileSync(cfg.geocoding.cacheFile, JSON.stringify(cache, null, 1)); } catch { /* ignore */ }
  }
}

module.exports = { geocodeEvents };
