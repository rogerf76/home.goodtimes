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
  function captionText(item) {
    const c = cfg.captions;
    if (!c.enabled) return '';
    const parts = [];
    if (c.showAlbum && item.event && item.event.album) parts.push(item.event.album);
    if (c.showDate && item.date) parts.push(dateFmt.format(new Date(item.date)));
    if (c.showPlace && item.event && item.event.place) parts.push(item.event.place);
    if (c.showFilename) parts.push(item.name);
    return parts.join('  ·  ');
  }

  // Creates or refreshes the caption inside a media wrapper.
  function updateCaption(wrap, item) {
    const text = captionText(item);
    let el = wrap.querySelector('.caption');
    if (!text) { if (el) el.remove(); return; }
    if (!el) { el = div('caption'); wrap.appendChild(el); }
    el.textContent = text;
  }

  // Each distinct caption appears only once on screen: on the photo carrying it that
  // sits closest to the bottom-left corner. Photos sharing the same album, day and
  // place therefore show a single title between them.
  function refreshCaptions() {
    if (!stage) return;
    const best = new Map(); // caption text -> { slot, dist }
    for (const s of stage.slots) {
      if (!s.current) continue;
      updateCaption(s.current.media.node, s.current.item);
      const text = captionText(s.current.item);
      if (!text) continue;
      const r = s.rect;
      const dist = Math.hypot(r.x, 1 - (r.y + r.h)); // slot's bottom-left to screen's bottom-left
      const prev = best.get(text);
      if (!prev || dist < prev.dist) best.set(text, { slot: s, dist });
    }
    const shown = new Set([...best.values()].map((b) => b.slot));
    for (const s of stage.slots) {
      const el = s.current && s.current.media.node.querySelector('.caption');
      if (el) el.classList.toggle('hidden', !shown.has(s));
    }
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
    let pic = null;
    if (item.type === 'image') {
      // Photos sit in a frame so a slow pan & zoom can move the picture inside it
      // while the frame (and its rounded corners) stays put.
      pic = main;
      pic.className = 'pic';
      pic.style.objectFit = fit;
      main = div('');
      main.appendChild(pic);
    }
    main.className = 'main';
    if (!pic) main.style.objectFit = fit;
    if (fit === 'contain') {
      // Size the element to exactly the visible picture (see .fitted in style.css),
      // so rounded corners land on the photo itself rather than on the black around it.
      main.classList.add('fitted');
      main.style.setProperty('--ar', aspect.toFixed(5));
    }
    // Round the corners of every photo except one that fills the whole screen.
    const fillsScreen = isSingle && (fit === 'cover' || crop < 0.01);
    if (!fillsScreen) main.classList.add('rounded');

    if (fit === 'contain' && cfg.display.blurredBackdrop && item.type === 'image') {
      const bd = new Image();
      bd.src = item.url;
      bd.className = 'backdrop';
      wrap.appendChild(bd);
    }
    wrap.appendChild(main);
    updateCaption(wrap, item);
    return { node: wrap, main, pic, video, item };
  }

  function releaseVideo(v) {
    try { v.pause(); v.removeAttribute('src'); v.load(); } catch { /* ignore */ }
  }
  function releaseMedia(media) {
    if (!media) return;
    if (media === kenBurnsMedia) kenBurnsMedia = null;
    if (media.video) releaseVideo(media.video);
    media.node.remove();
  }

  // Slow pan & zoom: only now and then, only on smaller photos, one at a time.
  let kenBurnsMedia = null;
  function wantsKenBurns(slot, media) {
    const kb = cfg.display.kenBurns;
    if (!kb || !kb.enabled || kb.maxZoom <= 1 || !media.pic) return false;
    if (kenBurnsMedia && kenBurnsMedia.node.isConnected) return false; // one is already moving
    if (slot.area > kb.maxPhotoSize) return false;
    return Math.random() < kb.chance;
  }

  function kenBurns(el) {
    const kb = cfg.display.kenBurns;
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
    } else if (wantsKenBurns(slot, media)) {
      kenBurnsMedia = media;
      kenBurns(media.pic);
    }
    slot.current = { media, item: media.item, shownAt: now, busyUntil };
    if (slot.stage === stage) refreshCaptions();
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
    if (layout.tree === undefined) layout.tree = SS.buildLayoutTree(layout.slots);
    const st = { el, grid, layout, gap: g, slots: [] };
    st.slots = layout.slots.map((r) => {
      const s = div('slot');
      s.style.left = `calc(${r.x * 100}% + ${g / 2}px)`;
      s.style.top = `calc(${r.y * 100}% + ${g / 2}px)`;
      s.style.width = `calc(${r.w * 100}% - ${g}px)`;
      s.style.height = `calc(${r.h * 100}% - ${g}px)`;
      if (layout.slots.length === 1) s.style.borderRadius = '0'; // full-screen photos stay square
      grid.appendChild(s);
      return { rect: r, el: s, stage: st, aspect: 1, area: r.w * r.h, current: null, swapping: false };
    });
    updateAspects(st);
    return st;
  }

  // Resize the layout's rows/columns (by at most display.alignPhotos, e.g. 10%) so the
  // photos' edges line up with their neighbours. Photos are never cropped or distorted.
  // `override` = { slot, aspect } for a photo that is about to replace another one.
  function alignStage(st, override, animateMs) {
    const tree = st.layout.tree;
    const maxScale = cfg.display.alignPhotos;
    if (!tree || tree.leaf !== undefined || !(maxScale > 0)) return;
    const aspects = st.slots.map((s) => {
      if (override && override.slot === s) return override.aspect;
      const it = (s.prepared && s.prepared.item) || (s.current && s.current.item);
      return it && it.aspect ? it.aspect : null;
    });
    const g = st.gap;
    const box = { x: 0, y: 0, w: (root.clientWidth || window.innerWidth) - g, h: (root.clientHeight || window.innerHeight) - g };
    const F = SS.optimiseLayout(tree, st.layout.slots, aspects, box, g, maxScale);
    const boxes = SS.placeTree(tree, F, box);
    st.slots.forEach((s, i) => {
      const b = boxes[i];
      s.el.style.transition = animateMs ? ['left', 'top', 'width', 'height'].map((p) => `${p} ${animateMs}ms ${easing}`).join(', ') : 'none';
      s.el.style.left = `${b.x + g / 2}px`;
      s.el.style.top = `${b.y + g / 2}px`;
      s.el.style.width = `${Math.max(1, b.w - g)}px`;
      s.el.style.height = `${Math.max(1, b.h - g)}px`;
    });
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

  // video.fullScreen: videos never share the screen. When one comes up next it gets
  // this full-screen layout to itself, then the slideshow moves on to a new layout.
  const videoFull = !!cfg.video.fullScreen;
  const VIDEO_LAYOUT = { name: 'video', weight: 0, slots: [{ x: 0, y: 0, w: 1, h: 1 }] };
  const videoIsNext = () => {
    if (!videoFull) return false;
    const next = playlist.peek(1)[0];
    return !!next && next.type === 'video';
  };
  const videosAllowedInTiles = (videosOnScreen) => !videoFull && videosOnScreen < cfg.video.maxOnScreen;

  function usableCount(items) {
    const videos = items.filter((i) => i.type === 'video').length;
    return items.length - videos + (videoFull ? 0 : Math.min(videos, cfg.video.maxOnScreen));
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

    const forVideo = videoIsNext();
    const layout = forVideo ? VIDEO_LAYOUT : chooseLayout();
    const ns = createStage(layout);

    // Assign items, biggest slots first.
    const exclude = new Set();
    let videos = 0;
    const order = [...ns.slots].sort((a, b) => b.area - a.area);
    const jobs = [];
    for (const s of order) {
      const item = forVideo
        ? playlist.take(s.aspect, { only: 'video', exclude })
        : playlist.take(s.aspect, { allowVideo: videosAllowedInTiles(videos), exclude });
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

    alignStage(ns, null, 0);
    root.appendChild(ns.el);
    const old = stage;
    stage = ns;
    if (!forVideo) lastLayoutName = layout.name;
    const albumName = filled[0].prepared.item.event && filled[0].prepared.item.event.album;
    log(`layout ${layout.name}: ${filled.length} item(s)${albumName ? ` from ${albumName}` : ''}`);

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
    // A full-screen video moves on to a new layout as soon as it has finished playing.
    layoutEndsAt = Date.now() + (forVideo ? 0 : rand(cfg.timing.layoutDuration) * 1000);
  }

  // ---------- partial updates ----------
  async function swapSlot(slot, item, type, durMs) {
    try {
      const owner = slot.stage;
      const exclude = new Set(onScreenUrls());
      const media = await prepareFor(slot, item, false, exclude);
      if (!media) return;
      if (stage !== owner) { releaseMedia(media); return; } // layout changed meanwhile
      // Neighbours glide to re-align around the new photo while it transitions in.
      alignStage(owner, { slot, aspect: media.item.aspect }, durMs);
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
      const wantLayout = forceLayout || now >= layoutEndsAt || videoIsNext();

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
        const item = playlist.take(slot.aspect, { allowVideo: videosAllowedInTiles(videos), exclude });
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
  window.addEventListener('resize', () => { if (stage) { updateAspects(stage); alignStage(stage, null, 0); } });

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
    if (!ev) return;
    ev.place = place;
    // Photos from this event that are already on screen get the place name straight away.
    refreshCaptions();
  });

  showStatus('Scanning folders…');
  applyLibrary(await goodtimes.getLibrary());
})();
