'use strict';
// Sorts media by capture time and splits it into "events": runs of photos taken
// close together in time AND place. Layouts only mix photos from the same event.

function haversineKm(a, b) {
  const R = 6371;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}

function groupIntoEvents(items, cfg) {
  const { maxGapHours, maxDistanceKm } = cfg.grouping;
  const sorted = [...items].sort((a, b) => a.date - b.date || a.path.localeCompare(b.path));
  const events = [];
  let cur = null;
  let lastLoc = null;

  for (const it of sorted) {
    const hasLoc = it.lat != null && it.lon != null;
    let split = !cur;
    if (cur) {
      const gapH = (it.date - cur.end) / 3600000;
      if (gapH > maxGapHours) split = true;
      else if (hasLoc && lastLoc && maxDistanceKm > 0 && haversineKm(lastLoc, it) > maxDistanceKm) split = true;
    }
    if (split) {
      cur = { id: events.length, start: it.date, end: it.date, items: [], lat: null, lon: null, place: null };
      events.push(cur);
      lastLoc = null;
    }
    cur.items.push(it);
    cur.end = it.date;
    if (hasLoc) {
      lastLoc = { lat: it.lat, lon: it.lon };
      if (cur.lat == null) { cur.lat = it.lat; cur.lon = it.lon; }
    }
  }
  return events;
}

module.exports = { groupIntoEvents, haversineKm };
