'use strict';
// Sorts media by capture time and splits it into "events": runs of photos taken
// close together in time AND place. Layouts only mix photos from the same event.
//
// Albums: photos in a first-level subfolder (a trip / holiday) are grouped on their
// own – split into events (days, outings) by the same rules, but never mixed with
// loose photos or other albums, and played back together as one block ("unit").
// Loose photos in the root folder are split into events as usual; each of those
// events is its own unit.
//
// The loosePhotos folder (settings.local.yaml) holds unrelated photos with no rules at
// all: it is one unit whose events are marked `mixed`, and playback shuffles them
// together freely, whatever their dates and places. Its events are still split by
// time and place so each photo keeps its own place name in captions.

function haversineKm(a, b) {
  const R = 6371;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}

function splitByTimeAndPlace(items, cfg) {
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
      cur = { id: -1, start: it.date, end: it.date, items: [], lat: null, lon: null, place: null };
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

function isInLooseFolder(it, cfg) {
  const lp = cfg.loosePhotos;
  if (!lp) return false;
  if (lp.name) return !!it.album && it.album.toLowerCase() === lp.name.toLowerCase();
  const dir = lp.path.replace(/[\\/]+$/, '').toLowerCase();
  const p = it.path.toLowerCase();
  return p.startsWith(`${dir}\\`) || p.startsWith(`${dir}/`);
}

function groupIntoEvents(items, cfg) {
  const albums = new Map(); // albumKey -> items
  const loose = [];
  const mixed = [];
  for (const it of items) {
    if (isInLooseFolder(it, cfg)) {
      mixed.push(it);
    } else if (it.albumKey) {
      if (!albums.has(it.albumKey)) albums.set(it.albumKey, []);
      albums.get(it.albumKey).push(it);
    } else {
      loose.push(it);
    }
  }

  // A unit is played as one uninterrupted block.
  const units = splitByTimeAndPlace(loose, cfg).map((ev) => ({ start: ev.start, album: null, events: [ev] }));
  for (const albumItems of albums.values()) {
    const events = splitByTimeAndPlace(albumItems, cfg);
    if (events.length) units.push({ start: events[0].start, album: albumItems[0].album, events });
  }
  if (mixed.length) {
    const events = splitByTimeAndPlace(mixed, cfg);
    events.forEach((ev) => { ev.mixed = true; });
    units.push({ start: events[0].start, album: null, events });
  }
  units.sort((a, b) => a.start - b.start);

  const out = [];
  units.forEach((u, unitIndex) => {
    for (const ev of u.events) {
      ev.id = out.length;
      ev.unit = unitIndex;
      ev.album = u.album;
      out.push(ev);
    }
  });
  return out;
}

module.exports = { groupIntoEvents, haversineKm };
