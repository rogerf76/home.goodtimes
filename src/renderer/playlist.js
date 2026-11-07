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
      this.pos = this.cfg.startAt === 'random' && this.order.length ? Math.floor(Math.random() * this.order.length) - 1 : -1;
      this.buffer = [];
      this.started = true;
    } else if (prevEventStart != null && this.cfg.order !== 'shuffle' && this.cfg.order !== 'shuffle-events') {
      // Rescan: carry on from roughly the same point in time.
      const idx = this.order.findIndex((i) => this.events[i].start >= prevEventStart);
      this.pos = (idx < 0 ? this.order.length : idx) - 1;
      this.buffer = [];
    } else {
      this.pos = -1;
      this.buffer = [];
    }
  }

  buildOrder() {
    const idx = this.events.map((_, i) => i);
    if (this.cfg.order === 'reverse') idx.reverse();
    if (this.cfg.order === 'shuffle-events') SS.shuffle(idx);
    this.order = idx;
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
        if (this.cfg.order === 'shuffle-events') SS.shuffle(this.order);
      }
      const ev = this.events[this.order[this.pos]];
      if (!ev.items.length) continue;
      this.buffer = ev.virtual ? SS.shuffle([...ev.items]) : [...ev.items];
      return;
    }
    this.buffer = [];
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
   * opts.allowVideo, opts.exclude (Set of urls already on screen).
   * Returns null when the current event is used up (keepTogether) or nothing fits.
   */
  take(slotAspect, opts = {}) {
    if (this.isEmpty) return null;
    if (!this.buffer.length) {
      if (this.keepTogether) return null;
      this.advanceEvent();
    }
    const { allowVideo = true, exclude = null } = opts;
    const look = Math.max(1, this.cfg.layouts.lookahead);
    const ok = (it) => (allowVideo || it.type !== 'video') && !(exclude && exclude.has(it.url));

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
      best = this.buffer.findIndex((it) => allowVideo || it.type !== 'video');
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
