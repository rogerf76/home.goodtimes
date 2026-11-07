'use strict';
// Optional reverse geocoding of event locations via OpenStreetMap Nominatim.
// Only one lookup per event (not per photo), rate-limited to 1/sec and cached on disk.

const fs = require('fs');

const ENDPOINT = 'https://nominatim.openstreetmap.org/reverse';
const USER_AGENT = 'goodtimes/1.0 (personal, non-commercial)';

function loadCache(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return {}; }
}

function placeName(addr) {
  if (!addr) return null;
  const local = addr.city || addr.town || addr.village || addr.hamlet || addr.suburb || addr.municipality || addr.county;
  const region = addr.state || addr.region;
  const parts = [local, local ? null : region, addr.country].filter(Boolean);
  return parts.length ? [...new Set(parts)].join(', ') : null;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Calls onLabel(eventId, place) as names become available. */
async function geocodeEvents(events, cfg, onLabel) {
  const cache = loadCache(cfg.geocoding.cacheFile);
  let dirty = false;
  for (const ev of events) {
    if (ev.lat == null) continue;
    const key = `${ev.lat.toFixed(2)},${ev.lon.toFixed(2)}`;
    if (!(key in cache)) {
      try {
        const url = `${ENDPOINT}?format=jsonv2&zoom=14&lat=${ev.lat}&lon=${ev.lon}&accept-language=${encodeURIComponent(cfg.geocoding.language)}`;
        const res = await fetch(url, { headers: { 'User-Agent': USER_AGENT } });
        cache[key] = res.ok ? placeName((await res.json()).address) : null;
        dirty = true;
      } catch (e) {
        console.warn(`Geocoding failed: ${e.message}`);
        break; // offline – try again on next rescan
      }
      await sleep(1100);
    }
    if (cache[key]) onLabel(ev.id, cache[key]);
  }
  if (dirty) {
    try { fs.writeFileSync(cfg.geocoding.cacheFile, JSON.stringify(cache, null, 1)); } catch { /* ignore */ }
  }
}

module.exports = { geocodeEvents };
