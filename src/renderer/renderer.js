'use strict';
/* global SS, goodtimes */

(async function main() {
  const cfg = await goodtimes.getConfig();
  const root = document.getElementById('root');
  const statusEl = document.getElementById('status');
  const toastEl = document.getElementById('toast');

  const css = document.documentElement.style;
  css.setProperty('--bg', cfg.display.background);
  css.setProperty('--radius', `${cfg.display.cornerRadius}px`);
  css.setProperty('--cap-size', `${cfg.captions.fontSize}px`);

  // ---------- helpers ----------
  const rand = (r) => r.min + Math.random() * (r.max - r.min);
  const randInt = (a, b) => a + Math.floor(Math.random() * (b - a + 1));
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const div = (cls) => { const d = document.createElement('div'); d.className = cls; return d; };
  const withTimeout = (p, ms, what) => Promise.race([
    p, new Promise((_, rej) => setTimeout(() => rej(new Error(`timeout loading ${what}`)), ms)),
  ]);
  function weightedPick(weights) {
    const entries = Object.entries(weights).filter(([, w]) => w > 0);
    let r = Math.random() * entries.reduce((s, [, w]) => s + w, 0);
    for (const [k, w] of entries) { if ((r -= w) <= 0) return k; }
    return entries.length ? entries[entries.length - 1][0] : null;
  }
  const easing = cfg.transitions.easing;
  const dateFmt = new Intl.DateTimeFormat(cfg.captions.locale || undefined, cfg.captions.dateFormat);
  const log = (...m) => { console.log(...m); goodtimes.log(...m.map(String)); };

  const layouts = SS.buildLayouts(cfg);
  const playlist = new SS.Playlist(cfg);
  const eventsById = new Map();

  let stage = null;          // { el, grid, layout, slots: [...] }
  let layoutEndsAt = 0;
  let forceLayout = false;
  let timer = null;
  let stepping = false;
  let paused = false;
  let lastLayoutName = null;

  // ---------- image prefetch ----------
  const imgCache = new Map(); // url -> Promise<HTMLImageElement>
  function decodeImage(url) {
    const img = new Image();
    img.decoding = 'async';
    img.src = url;
    return withTimeout(img.decode().then(() => img), 30000, url);
  }
  function loadImage(url) {
    const p = imgCache.get(url);
    if (p) { imgCache.delete(url); return p; }
    return decodeImage(url);
  }
  function prefetch() {
    for (const it of playlist.peek(6)) {
      if (it.type !== 'image' || imgCache.has(it.url)) continue;
      const p = decodeImage(it.url);
      p.catch(() => {});
      imgCache.set(it.url, p);
    }
    while (imgCache.size > 12) imgCache.delete(imgCache.keys().next().value);
  }

  // ---------- media elements ----------
  function captionFor(item) {
    const c = cfg.captions;
    if (!c.enabled) return null;
    const parts = [];
    if (c.showDate && item.date) parts.push(dateFmt.format(new Date(item.date)));
    if (c.showPlace && item.event && item.event.place) parts.push(item.event.place);
    if (c.showFilename) parts.push(item.name);
    if (!parts.length) return null;
    const el = div('caption');
    el.textContent = parts.join('  ·  ');
    return el;
  }

  async function createMedia(item, slot) {
    const wrap = div('media');
    let main;
    let video = null;
    let aspect;
    if (item.type === 'image') {
      main = await loadImage(item.url);
      aspect = main.naturalWidth / main.naturalHeight;
    } else {
      video = document.createElement('video');
      video.muted = cfg.video.muted;
      video.volume = Math.max(0, Math.min(1, cfg.video.volume));
      video.loop = true;
      video.playsInline = true;
      video.preload = 'auto';
      video.src = item.url;
      try {
        await withTimeout(new Promise((res, rej) => {
          video.addEventListener('loadeddata', res, { once: true });
          video.addEventListener('error', () => rej(new Error(`cannot play ${item.name}`)), { once: true });
        }), 30000, item.name);
      } catch (e) {
        releaseVideo(video);
        throw e;
      }
      aspect = video.videoWidth / video.videoHeight;
      main = video;
    }
    if (aspect && isFinite(aspect)) item.aspect = aspect;
    aspect = item.aspect || 1.5;

    const crop = 1 - Math.min(aspect, slot.aspect) / Math.max(aspect, slot.aspect);
    const isSingle = stageOf(slot).slots.length === 1;
    const fit = isSingle ? cfg.display.fitSingle : crop > cfg.display.maxCrop ? 'contain' : 'cover';
    main.className = 'main';
    main.style.objectFit = fit;

    if (fit === 'contain' && cfg.display.blurredBackdrop && item.type === 'image') {
      const bd = new Image();
      bd.src = item.url;
      bd.className = 'backdrop';
      wrap.appendChild(bd);
    }
    wrap.appendChild(main);
    const cap = captionFor(item);
    if (cap) wrap.appendChild(cap);
    return { node: wrap, main, video, item };
  }

  function releaseVideo(v) {
    try { v.pause(); v.removeAttribute('src'); v.load(); } catch { /* ignore */ }
  }
  function releaseMedia(media) {
    if (!media) return;
    if (media.video) releaseVideo(media.video);
    media.node.remove();
  }

  function kenBurns(el) {
    const kb = cfg.display.kenBurns;
    if (!kb || !kb.enabled || kb.maxZoom <= 1) return;
    const z = 1 + (kb.maxZoom - 1) * (0.5 + Math.random() * 0.5);
    const shift = (((z - 1) / 2) * 100) / z;
    const dx = (Math.random() * 2 - 1) * shift;
    const dy = (Math.random() * 2 - 1) * shift;
    const a = 'scale(1) translate(0%, 0%)';
    const b = `scale(${z}) translate(${dx.toFixed(2)}%, ${dy.toFixed(2)}%)`;
    const [from, to] = Math.random() < 0.5 ? [a, b] : [b, a];
    const duration = (cfg.timing.layoutDuration.max + cfg.timing.interval.max) * 1000;
    el.animate([{ transform: from }, { transform: to }], { duration, easing: 'ease-in-out', fill: 'forwards' });
  }

  // Put prepared media into a slot and start it.
  function activate(slot, media) {
    const now = Date.now();
    let busyUntil = 0;
    if (media.video) {
      const p = media.video.play();
      if (p) p.catch(() => {});
      if (paused) media.video.pause();
      const d = media.video.duration;
      if (cfg.video.playToEnd) {
        const secs = isFinite(d) && d > 0 ? Math.min(d, cfg.video.maxSeconds) : cfg.video.maxSeconds;
        busyUntil = now + secs * 1000;
      }
    } else {
      kenBurns(media.main);
    }
    slot.current = { media, item: media.item, shownAt: now, busyUntil };
  }

  // Load media for a slot, replacing items that fail to load.
  async function prepareFor(slot, item, allowVideo, exclude) {
    for (let tries = 0; item && tries < 5; tries++) {
      try {
        return await createMedia(item, slot);
      } catch (e) {
        log(`skipping ${item.name}: ${e.message}`);
        playlist.markBroken(item);
        item = playlist.take(slot.aspect, { allowVideo, exclude });
      }
    }
    return null;
  }

  // ---------- layouts ----------
  function stageOf(slot) { return slot.stage; }

  function createStage(layout) {
    const g = layout.slots.length === 1 ? 0 : cfg.display.gap;
    const el = div('stage');
    const grid = div('grid');
    grid.style.inset = `${g / 2}px`;
    el.appendChild(grid);
    const st = { el, grid, layout, gap: g, slots: [] };
    st.slots = layout.slots.map((r) => {
      const s = div('slot');
      s.style.left = `calc(${r.x * 100}% + ${g / 2}px)`;
      s.style.top = `calc(${r.y * 100}% + ${g / 2}px)`;
      s.style.width = `calc(${r.w * 100}% - ${g}px)`;
      s.style.height = `calc(${r.h * 100}% - ${g}px)`;
      grid.appendChild(s);
      return { rect: r, el: s, stage: st, aspect: 1, area: r.w * r.h, current: null, swapping: false };
    });
    updateAspects(st);
    return st;
  }

  function updateAspects(st) {
    const W = root.clientWidth || window.innerWidth;
    const H = root.clientHeight || window.innerHeight;
    for (const s of st.slots) {
      const w = (W - st.gap) * s.rect.w - st.gap;
      const h = (H - st.gap) * s.rect.h - st.gap;
      s.aspect = Math.max(0.05, w / Math.max(1, h));
    }
  }

  function screenAspectSlots(layout) {
    const W = root.clientWidth || window.innerWidth;
    const H = root.clientHeight || window.innerHeight;
    return layout.slots.map((r) => ({ aspect: (W * r.w) / (H * r.h), area: r.w * r.h }));
  }

  function usableCount(items) {
    const videos = items.filter((i) => i.type === 'video').length;
    return items.length - videos + Math.min(videos, cfg.video.maxOnScreen);
  }

  function chooseLayout() {
    const look = Math.max(1, cfg.layouts.lookahead);
    const maxSlots = Math.max(...layouts.map((l) => l.slots.length));
    const upcoming = playlist.peek(Math.max(look, maxSlots));
    const available = usableCount(playlist.keepTogether ? playlist.peek(1000) : upcoming);
    let candidates = layouts.filter((l) => l.slots.length <= Math.max(1, available));
    if (!candidates.length) candidates = [layouts.reduce((a, b) => (a.slots.length <= b.slots.length ? a : b))];

    const windowItems = upcoming.slice(0, look);
    const scored = candidates.map((l) => {
      // Simulate filling the slots, biggest first, to see how well upcoming photos fit.
      const pool = [...windowItems];
      const slots = screenAspectSlots(l).sort((a, b) => b.area - a.area);
      let cost = 0;
      for (const s of slots) {
        if (!pool.length) { cost += 1; continue; }
        let bi = 0;
        let bc = Infinity;
        pool.forEach((it, i) => { const c = SS.aspectCost(it.aspect, s.aspect); if (c < bc) { bc = c; bi = i; } });
        cost += bc;
        pool.splice(bi, 1);
      }
      const avg = cost / slots.length;
      const repeat = l.name === lastLayoutName ? 0.3 : 1;
      return { l, w: l.weight * Math.exp(-cfg.layouts.aspectMatchStrength * avg) * repeat };
    });
    let r = Math.random() * scored.reduce((s, x) => s + x.w, 0);
    for (const x of scored) { if ((r -= x.w) <= 0) return x.l; }
    return scored[scored.length - 1].l;
  }

  function destroyStage(st) {
    if (!st) return;
    for (const s of st.slots) if (s.current) releaseMedia(s.current.media);
    st.el.remove();
  }

  async function changeLayout() {
    forceLayout = false;
    if (playlist.remaining() === 0) playlist.advanceEvent();
    if (playlist.isEmpty) return;

    const layout = chooseLayout();
    const ns = createStage(layout);

    // Assign items, biggest slots first.
    const exclude = new Set();
    let videos = 0;
    const order = [...ns.slots].sort((a, b) => b.area - a.area);
    const jobs = [];
    for (const s of order) {
      const allowVideo = videos < cfg.video.maxOnScreen;
      const item = playlist.take(s.aspect, { allowVideo, exclude });
      if (!item) break;
      exclude.add(item.url);
      if (item.type === 'video') videos++;
      jobs.push(prepareFor(s, item, false, exclude).then((m) => { s.prepared = m; }));
    }
    await Promise.all(jobs);
    const filled = ns.slots.filter((s) => s.prepared);
    if (!filled.length) {
      if (playlist.isEmpty) showStatus('No playable photos or videos found.');
      return;
    }

    root.appendChild(ns.el);
    const old = stage;
    stage = ns;
    lastLayoutName = layout.name;

    const perSlot = old && ns.slots.length > 1 && Math.random() < cfg.transitions.layout.perSlotChance;
    if (perSlot) {
      // New photos arrive one by one on top of the old layout, then the old one fades away.
      ns.el.classList.add('transparent');
      const anims = [];
      let delay = 0;
      for (const s of SS.shuffle([...filled])) {
        const type = SS.pickTransition(cfg.transitions.slot.types);
        const dur = rand(cfg.transitions.slot.duration) * 1000;
        anims.push(sleep(delay).then(() => {
          s.el.appendChild(s.prepared.node);
          activate(s, s.prepared);
          return SS.runTransition(type, s.prepared.node, null, dur, easing);
        }));
        delay += rand(cfg.timing.stagger) * 1000;
      }
      await Promise.all(anims);
      await SS.runTransition('fade', null, old.el, 600, easing);
      ns.el.classList.remove('transparent');
    } else {
      for (const s of filled) {
        s.el.appendChild(s.prepared.node);
        activate(s, s.prepared);
      }
      const type = old ? SS.pickTransition(cfg.transitions.layout.types) : 'fade';
      await SS.runTransition(type, ns.el, old && old.el, rand(cfg.transitions.layout.duration) * 1000, easing);
    }
    ns.slots.forEach((s) => { delete s.prepared; });
    destroyStage(old);
    layoutEndsAt = Date.now() + rand(cfg.timing.layoutDuration) * 1000;
  }

  // ---------- partial updates ----------
  async function swapSlot(slot, item, type, durMs) {
    try {
      const owner = slot.stage;
      const exclude = new Set(onScreenUrls());
      const media = await prepareFor(slot, item, false, exclude);
      if (!media) return;
      if (stage !== owner) { releaseMedia(media); return; } // layout changed meanwhile
      slot.el.appendChild(media.node);
      const old = slot.current;
      activate(slot, media);
      await SS.runTransition(type, media.node, old && old.media.node, durMs, easing);
      if (old) releaseMedia(old.media);
    } finally {
      slot.swapping = false;
    }
  }

  function onScreenUrls() {
    return stage ? stage.slots.filter((s) => s.current).map((s) => s.current.item.url) : [];
  }

  function schedule(seconds) {
    clearTimeout(timer);
    if (!paused) timer = setTimeout(step, seconds * 1000);
  }

  async function step() {
    clearTimeout(timer);
    if (paused || stepping) return;
    stepping = true;
    let next = rand(cfg.timing.interval);
    try {
      if (!stage) {
        await changeLayout();
        return;
      }
      const now = Date.now();
      const videoBusy = stage.slots.some((s) => s.current && s.current.busyUntil > now);
      const swapping = stage.slots.some((s) => s.swapping);
      const wantLayout = forceLayout || now >= layoutEndsAt;

      if (wantLayout) {
        if (!videoBusy && !swapping) {
          await changeLayout();
          return;
        }
        if (forceLayout) { next = 1; return; } // event used up: wait for videos to finish
      }

      const eligible = stage.slots.filter((s) => !s.swapping && !(s.current && s.current.busyUntil > now));
      if (!eligible.length) { next = 1; return; }

      const mode = stage.slots.length === 1 ? 'all' : weightedPick(cfg.updateMode) || 'all';
      let n;
      if (mode === 'all') n = eligible.length;
      else if (mode === 'one') n = 1;
      else n = eligible.length <= 2 ? 1 : randInt(2, eligible.length - 1);

      const chosen = SS.shuffle([...eligible]).slice(0, n);
      const shared = SS.pickTransition(cfg.transitions.slot.types);
      const exclude = new Set(onScreenUrls());
      const chosenSet = new Set(chosen);
      let videos = stage.slots.filter((s) => !chosenSet.has(s) && s.current && s.current.item.type === 'video').length;
      let delay = 0;

      for (const slot of chosen) {
        const item = playlist.take(slot.aspect, { allowVideo: videos < cfg.video.maxOnScreen, exclude });
        if (!item) {
          if (playlist.keepTogether) { forceLayout = true; next = 0.5; }
          break;
        }
        if (item.type === 'video') videos++;
        exclude.add(item.url);
        const type = mode === 'all' ? shared : SS.pickTransition(cfg.transitions.slot.types);
        const dur = rand(cfg.transitions.slot.duration) * 1000;
        slot.swapping = true;
        setTimeout(() => swapSlot(slot, item, type, dur).catch((e) => log('swap failed', e.message)), delay);
        delay += rand(cfg.timing.stagger) * 1000;
      }
    } catch (e) {
      log('step error', e && e.stack ? e.stack : e);
    } finally {
      stepping = false;
      prefetch();
      schedule(next);
    }
  }

  // ---------- status / keys ----------
  function showStatus(text) {
    statusEl.textContent = text;
    statusEl.style.display = text ? 'flex' : 'none';
  }
  let toastTimer = null;
  function toast(text) {
    toastEl.textContent = text;
    toastEl.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toastEl.classList.remove('show'), 1500);
  }

  function setPaused(p) {
    paused = p;
    document.getAnimations().forEach((a) => (p ? a.pause() : a.play()));
    document.querySelectorAll('video').forEach((v) => (p ? v.pause() : v.play().catch(() => {})));
    if (p) clearTimeout(timer);
    else schedule(1);
    toast(p ? 'Paused' : 'Playing');
  }

  window.addEventListener('keydown', (e) => {
    switch (e.key) {
      case 'Escape': case 'q': case 'Q': goodtimes.quit(); break;
      case ' ': setPaused(!paused); break;
      case 'ArrowRight': case 'n': case 'N': if (!paused) step(); break;
      case 'Enter': case 'l': case 'L':
        if (!paused) { forceLayout = true; layoutEndsAt = 0; step(); }
        break;
      case 'ArrowDown': case 'e': case 'E':
        // skip to the next event
        if (!paused) { playlist.buffer = []; forceLayout = true; step(); }
        break;
      default:
    }
  });
  window.addEventListener('resize', () => { if (stage) updateAspects(stage); });

  // ---------- library ----------
  function applyLibrary(lib) {
    if (!lib) return;
    eventsById.clear();
    lib.events.forEach((ev) => eventsById.set(ev.id, ev));
    playlist.setLibrary(lib);
    if (playlist.isEmpty) {
      if (!stage) showStatus(`No photos or videos found in:\n${cfg.sources.join('\n')}`);
      return;
    }
    if (!stage && !stepping) {
      showStatus('');
      step();
    }
  }

  goodtimes.onStatus((s) => {
    if (stage) return;
    if (s.phase === 'found') showStatus(`Found ${s.total} files – reading dates and locations…`);
    if (s.phase === 'reading') showStatus(`Reading dates and locations… ${s.done} / ${s.total}`);
  });
  goodtimes.onLibrary(applyLibrary);
  goodtimes.onPlace(({ id, place }) => {
    const ev = eventsById.get(id);
    if (ev) ev.place = place;
  });

  showStatus('Scanning folders…');
  applyLibrary(await goodtimes.getLibrary());
})();
