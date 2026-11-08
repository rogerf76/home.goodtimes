'use strict';
// Walks through events in the configured order and hands out items for slots,
// choosing from a small look-ahead window the photo whose shape best fits the slot.

window.SS = window.SS || {};

SS.shuffle = function shuffle(a) {
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
};

const DEFAULT_ASPECT = 1.5;

SS.distanceKm = function distanceKm(a, b) {
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.sqrt(s));
};
SS.aspectCost = (itemAspect, slotAspect) => Math.abs(Math.log((itemAspect || DEFAULT_ASPECT) / slotAspect));

class Playlist {
  constructor(cfg) {
    this.cfg = cfg;
    this.events = [];
    this.order = [];
    this.pos = -1;
    this.buffer = [];
    this.started = false;
  }

  get keepTogether() {
    return this.cfg.grouping.keepEventsTogether && this.cfg.order !== 'shuffle';
  }

  setLibrary(lib) {
    const prevEventStart = this.currentEvent ? this.currentEvent.start : null;
    let events = lib.events.filter((e) => e.items.length);
    events.forEach((ev) => ev.items.forEach((it) => { it.event = ev; }));

    if (this.cfg.order === 'shuffle') {
      // One big shuffled pseudo-event.
      const all = events.flatMap((e) => e.items);
      events = all.length ? [{ id: -1, start: 0, end: 0, place: null, items: all, virtual: true }] : [];
    }
    this.events = events;
    this.buildOrder();

    if (!this.started) {
      // A random start begins at the start of an album / event, never half-way through one.
      const starts = this.unitStarts || [];
      this.pos = this.cfg.startAt === 'random' && starts.length ? starts[Math.floor(Math.random() * starts.length)] - 1 : -1;
      this.buffer = [];
      this.started = true;
    } else if (prevEventStart != null && this.cfg.order !== 'shuffle' && this.cfg.order !== 'shuffle-events') {
      // Rescan: carry on from roughly the same point in time.
      const rev = this.cfg.order === 'reverse';
      const idx = this.order.findIndex((i) => (rev ? this.events[i].start <= prevEventStart : this.events[i].start >= prevEventStart));
      this.pos = (idx < 0 ? this.order.length : idx) - 1;
      this.buffer = [];
    } else {
      this.pos = -1;
      this.buffer = [];
    }
  }

  // Events are played in "units": an album (subfolder) is one unit containing all its
  // events in date order; each loose event in the root folder is a unit of its own.
  // Shuffling moves whole units around. With grouping.albumVisit set, an album is
  // instead cut into runs of a few events (days) that are shuffled separately but
  // still play in date order, so the trip unfolds over several visits.
  buildOrder() {
    let units = [];
    const byUnit = new Map();
    this.events.forEach((ev, i) => {
      const key = ev.unit ?? `e${i}`;
      if (!byUnit.has(key)) {
        const u = [];
        u.key = key;
        byUnit.set(key, u);
        units.push(u);
      }
      byUnit.get(key).push(i);
    });
    if (this.cfg.order === 'reverse') { units.reverse(); units.forEach((u) => u.reverse()); }
    if (this.cfg.order === 'shuffle-events') units = this.shuffleUnits(units);
    this.order = units.flat();
    this.unitStarts = [];
    let p = 0;
    for (const u of units) { this.unitStarts.push(p); p += u.length; }
  }

  shuffleUnits(units) {
    const visit = this.cfg.grouping.albumVisit; // null = whole album at once, else {min, max}
    const looseVisit = this.cfg.grouping.looseVisit; // photos per visit to the loose folder
    const pick = (r) => Math.max(1, Math.round(r.min + Math.random() * (r.max - r.min)));
    const chunks = [];
    let split = false;
    for (const u of units) {
      const first = this.events[u[0]];
      if (first.mixed && looseVisit) {
        // Loose folder: no order to keep, so shuffle its events and cut it into runs
        // of roughly looseVisit photos each.
        const evs = SS.shuffle([...u]);
        for (let i = 0, part = 0; i < evs.length; part++) {
          const want = pick(looseVisit);
          const c = [];
          let n = 0;
          while (i < evs.length && n < want) { c.push(evs[i]); n += this.events[evs[i]].items.length; i++; }
          c.key = u.key;
          c.part = part;
          chunks.push(c);
        }
        split = true;
      } else if (first.album && visit) {
        for (let i = 0, part = 0; i < u.length; part++) {
          const c = u.slice(i, i + pick(visit));
          c.key = u.key;
          c.part = part;
          chunks.push(c);
          i += c.length;
        }
        split = true;
      } else {
        chunks.push(u);
      }
    }
    SS.shuffle(chunks);
    if (split) {
      // Avoid two chunks of the same album back to back (they'd just merge into one long run).
      for (let i = 1; i < chunks.length; i++) {
        if (chunks[i].key !== chunks[i - 1].key) continue;
        const ok = (j) => chunks[j].key !== chunks[i - 1].key
          && (i + 1 >= chunks.length || chunks[j].key !== chunks[i + 1].key)
          && (j === 0 || chunks[j - 1].key !== chunks[i].key)
          && (j + 1 >= chunks.length || chunks[j + 1].key !== chunks[i].key);
        let j = -1;
        for (let k = 0; k < chunks.length; k++) if (Math.abs(k - i) > 1 && ok(k)) { j = k; break; }
        if (j >= 0) [chunks[i], chunks[j]] = [chunks[j], chunks[i]];
      }
      // Put each album's chunks back in date order across the slots they landed in.
      const slots = new Map();
      chunks.forEach((c, pos) => {
        if (!slots.has(c.key)) slots.set(c.key, []);
        slots.get(c.key).push(pos);
      });
      const fixed = [...chunks];
      for (const positions of slots.values()) {
        const ordered = positions.map((p) => chunks[p]).sort((a, b) => (a.part || 0) - (b.part || 0));
        positions.forEach((p, k) => { fixed[p] = ordered[k]; });
      }
      return fixed;
    }
    return chunks;
  }

  get isEmpty() {
    return this.events.length === 0;
  }

  get currentEvent() {
    return this.pos >= 0 && this.pos < this.order.length ? this.events[this.order[this.pos]] : null;
  }

  advanceEvent() {
    if (this.isEmpty) return;
    // Skip events that became empty (all files failed to load).
    for (let tries = 0; tries < this.order.length; tries++) {
      this.pos++;
      if (this.pos >= this.order.length) {
        this.pos = 0;
        if (this.cfg.order === 'shuffle-events') this.buildOrder();
      }
      const ev = this.events[this.order[this.pos]];
      if (!ev.items.length) continue;
      this.buffer = ev.virtual ? SS.shuffle([...ev.items]) : [...ev.items];
      this.joinAlbumDays(ev);
      return;
    }
    this.buffer = [];
  }

  // Within an album the whole trip counts as one event for layouts: the following
  // days of the same album (up to the end of this visit) are queued straight after,
  // so layouts can mix photos from neighbouring days instead of being stuck on
  // single photos when a day only has one or two.
  // Days only join while they're near each other: a trip that moves on (e.g. from
  // Alberta to California) starts a fresh screen rather than mixing the two.
  joinAlbumDays(ev) {
    if (ev.mixed) {
      // Loose folder: everything up to the end of this visit, in any order.
      while (this.pos + 1 < this.order.length && this.events[this.order[this.pos + 1]].unit === ev.unit) {
        this.pos++;
        this.buffer.push(...this.events[this.order[this.pos]].items);
      }
      SS.shuffle(this.buffer);
      return;
    }
    if (!ev.album || !this.cfg.grouping.mixAlbumDays) return;
    const maxKm = this.cfg.grouping.mixAlbumMaxKm;
    let lastLoc = ev.lat != null ? ev : null;
    while (this.pos + 1 < this.order.length) {
      const next = this.events[this.order[this.pos + 1]];
      if (next.unit !== ev.unit) break;
      if (next.lat != null) {
        if (lastLoc && maxKm > 0 && SS.distanceKm(lastLoc, next) > maxKm) break;
        lastLoc = next;
      }
      this.pos++;
      this.buffer.push(...next.items);
    }
  }

  ensureBuffer() {
    if (!this.buffer.length) this.advanceEvent();
  }

  /** Items left in the current event (when events are kept together). */
  remaining() {
    return this.buffer.length;
  }

  peek(n) {
    if (!this.keepTogether && this.buffer.length < n) {
      // Look into the following events too.
      const out = [...this.buffer];
      let p = this.pos;
      while (out.length < n && this.order.length) {
        p = (p + 1) % this.order.length;
        out.push(...this.events[this.order[p]].items);
        if (p === this.pos) break;
      }
      return out.slice(0, n);
    }
    return this.buffer.slice(0, n);
  }

  /**
   * Take the best item for a slot of the given aspect ratio.
   * opts.accept (item => bool, which items may go here), opts.exclude (Set of urls already on screen).
   * Returns null when the current event is used up (keepTogether) or nothing fits.
   */
  take(slotAspect, opts = {}) {
    if (this.isEmpty) return null;
    const { accept = () => true, exclude = null } = opts;
    const look = Math.max(1, this.cfg.layouts.lookahead);
    const ok = (it) => accept(it) && !(exclude && exclude.has(it.url));
    if (!this.buffer.length) {
      if (this.keepTogether) return null;
      this.advanceEvent();
    }

    let best = -1;
    let bestCost = Infinity;
    for (let i = 0; i < Math.min(look, this.buffer.length); i++) {
      const it = this.buffer[i];
      if (!ok(it)) continue;
      // Shape mismatch, plus a small penalty for jumping ahead so order stays roughly chronological.
      const cost = SS.aspectCost(it.aspect, slotAspect) + i * 0.08;
      if (cost < bestCost) { bestCost = cost; best = i; }
    }
    if (best < 0) best = this.buffer.findIndex(ok);
    if (best < 0) {
      // Only excluded items left (e.g. tiny library) – allow repeats of on-screen items rather than stall.
      best = this.buffer.findIndex(accept);
      if (best < 0) return null;
    }
    return this.buffer.splice(best, 1)[0];
  }

  /** Put an item back at the front (e.g. it failed to be used this round). */
  putBack(item) {
    this.buffer.unshift(item);
  }

  /** Drop an item that failed to load from future rounds. */
  markBroken(item) {
    for (const ev of this.events) {
      const i = ev.items.indexOf(item);
      if (i >= 0) { ev.items.splice(i, 1); break; }
    }
  }
}

SS.Playlist = Playlist;
