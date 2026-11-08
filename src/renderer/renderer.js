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
  const logError = (...m) => { console.error(...m); goodtimes.error(...m.map(String)); };

  // file:///D:/x/y.jpg -> D:\x\y.jpg, file://nas/share/y.jpg -> \\nas\share\y.jpg
  function filePath(url) {
    try {
      const u = new URL(url);
      const p = decodeURIComponent(u.pathname);
      return (u.host ? `//${u.host}${p}` : p.replace(/^\/([A-Za-z]:)/, '$1')).replace(/\//g, '\\');
    } catch { return url; }
  }

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
    return withTimeout(img.decode().then(() => img), 30000, url)
      .catch((e) => { throw new Error(/timeout/.test(e.message) ? 'timed out after 30s' : `can't read or decode the image (${e.message})`); });
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
  // One caption for the whole screen, fixed to the bottom-left corner, describing
  // everything currently shown:
  //   Album · Date · Place
  //   Album · Date · Banff, Canmore, Alberta               (several places, same day)
  //   Album · Date · Alameda, California | Vancouver, British Columbia  (different states)
  //   Album · Date 1 · Place 1 | Date 2 · Place 2          (different days)
  const SEP = '  ·  ';
  const DAY_SEP = '  |  ';

  // "Banff, Alberta" + "Canmore, Alberta" -> "Banff, Canmore, Alberta"
  function joinPlaces(places) {
    const byRegion = new Map();
    for (const p of places) {
      const i = p.indexOf(', ');
      const local = i < 0 ? p : p.slice(0, i);
      const region = i < 0 ? '' : p.slice(i + 2);
      if (!byRegion.has(region)) byRegion.set(region, []);
      if (!byRegion.get(region).includes(local)) byRegion.get(region).push(local);
    }
    // A bare region ("Alberta") adds nothing when a town in that region is also listed.
    const bare = byRegion.get('') || [];
    for (const r of bare.filter((x) => byRegion.has(x))) bare.splice(bare.indexOf(r), 1);
    if (byRegion.has('') && !bare.length) byRegion.delete('');
    return [...byRegion].map(([region, locals]) => [...locals, region].filter(Boolean).join(', ')).join('  |  ');
  }

  function screenCaption(items) {
    const c = cfg.captions;
    if (!c.enabled || !items.length) return '';
    const byAlbum = new Map(); // album -> Map(dayKey -> { date, places[] })
    for (const it of [...items].sort((x, y) => x.date - y.date)) {
      const album = (c.showAlbum && it.event && it.event.album) || '';
      if (!byAlbum.has(album)) byAlbum.set(album, new Map());
      const days = byAlbum.get(album);
      const day = c.showDate && it.date ? dateFmt.format(new Date(it.date)) : '';
      if (!days.has(day)) days.set(day, []);
      const place = c.showPlace && it.event && it.event.place;
      if (place && !days.get(day).includes(place)) days.get(day).push(place);
    }
    const segments = [...byAlbum].map(([album, days]) => {
      const dayTexts = [...days].map(([day, places]) => [day, places.length ? joinPlaces(places) : ''].filter(Boolean).join(SEP)).filter(Boolean);
      return [album, dayTexts.join(DAY_SEP)].filter(Boolean).join(SEP);
    });
    let text = segments.filter(Boolean).join(DAY_SEP);
    if (c.showFilename && items.length === 1) text = [text, items[0].name].filter(Boolean).join(SEP);
    return text;
  }

  const captionEl = document.getElementById('caption');
  let captionTimer = null;
  function refreshCaptions() {
    if (!stage) return;
    const text = screenCaption(stage.slots.filter((s) => s.current).map((s) => s.current.item));
    if (text === captionEl.dataset.text) return;
    captionEl.dataset.text = text;
    // Cross-fade to the new text.
    captionEl.classList.add('hidden');
    clearTimeout(captionTimer);
    captionTimer = setTimeout(() => {
      captionEl.textContent = text;
      captionEl.classList.toggle('hidden', !text);
    }, captionEl.textContent ? 400 : 0);
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
      video.loop = false; // replays are counted in activate()
      video.playsInline = true;
      video.preload = 'auto';
      video.src = item.url;
      try {
        await withTimeout(new Promise((res, rej) => {
          video.addEventListener('loadeddata', res, { once: true });
          video.addEventListener('error', () => rej(new Error(videoError(video))), { once: true });
        }), 30000, item.name).catch((e) => { throw /timeout/.test(e.message) ? new Error('timed out after 30s') : e; });
      } catch (e) {
        releaseVideo(video);
        throw e;
      }
      aspect = video.videoWidth / video.videoHeight;
      main = video;
    }
    if (aspect && isFinite(aspect)) item.aspect = aspect;
    aspect = item.aspect || 1.5;

    // Photos and videos are always shown whole (object-fit: contain), never cropped.
    // The element is sized to exactly the visible picture (see .fitted in style.css),
    // so rounded corners land on the photo itself rather than on the black around it.
    main.className = 'main fitted';
    main.style.objectFit = 'contain';
    main.style.setProperty('--ar', aspect.toFixed(5));

    if (cfg.display.blurredBackdrop && item.type === 'image') {
      const bd = new Image();
      bd.src = item.url;
      bd.className = 'backdrop';
      wrap.appendChild(bd);
    }
    wrap.appendChild(main);
    const media = { node: wrap, main, video, item };
    frameFor(media, slot);
    return media;
  }

  // Round the corners of every photo except one that fills the whole screen.
  function frameFor(media, slot) {
    const aspect = media.item.aspect || 1.5;
    const fillsScreen = stageOf(slot).slots.length === 1 && Math.abs(Math.log(aspect / slot.aspect)) < 0.01;
    media.main.classList.toggle('rounded', !fillsScreen);
  }

  function videoError(v) {
    const err = v.error;
    const why = {
      1: 'loading was aborted',
      2: 'network error while reading the file',
      3: "decoding failed (file damaged, or a codec Chromium can't play)",
      4: 'format or codec not supported (needs H.264, VP9 or AV1, e.g. not HEVC/H.265)',
    }[err && err.code] || 'cannot play';
    return err && err.message ? `${why}: ${err.message}` : why;
  }

  function releaseVideo(v) {
    try { v.pause(); v.removeAttribute('src'); v.load(); } catch { /* ignore */ }
  }
  function releaseMedia(media) {
    if (!media) return;
    clearTimeout(media.cutoff);
    if (media.video) releaseVideo(media.video);
    media.node.remove();
  }

  // Put prepared media into a slot and start it.
  function activate(slot, media) {
    const now = Date.now();
    let busyUntil = 0;
    if (media.video) {
      const v = media.video;
      const p = v.play();
      if (p) p.catch(() => {});
      if (paused) v.pause();
      // Short clips replay a few times; anything longer plays once. Then it's replaced.
      const d = v.duration;
      const known = isFinite(d) && d > 0;
      const plays = known && d <= cfg.video.loopMaxSeconds ? Math.max(1, cfg.video.maxPlays) : 1;
      const secs = known ? Math.min(d * plays, cfg.video.maxSeconds) : cfg.video.maxSeconds;
      if (cfg.video.playToEnd) busyUntil = now + secs * 1000;
      media.played = 1;
      v.addEventListener('ended', () => {
        if (media.played < plays) {
          media.played++;
          v.currentTime = 0;
          v.play().catch(() => {});
        } else videoDone(slot, media);
      });
      if (!known || d * plays > cfg.video.maxSeconds) {
        media.cutoff = setTimeout(() => videoDone(slot, media), cfg.video.maxSeconds * 1000);
      }
    }
    slot.current = { media, item: media.item, shownAt: now, busyUntil };
    lastShown.set(media.item.url, now);
    if (slot.stage === stage) {
      refreshCaptions();
      // Safety check: one layout never shows photos from different folders.
      const folders = new Set(stage.slots.filter((s) => s.current && s.current.item.event).map((s) => s.current.item.event.unit));
      if (folders.size > 1) logError(`photos from different folders on screen: ${stage.slots.filter((s) => s.current).map((s) => s.current.item.name).join(', ')}`);
    }
  }

  const lastShown = new Map(); // url -> when it last went on screen

  // A video has played as often as it's allowed to (or hit video.maxSeconds): stop it
  // and put something else in its place.
  function videoDone(slot, media) {
    if (media.done || !slot.current || slot.current.media !== media) return; // already handled
    clearTimeout(media.cutoff);
    if (paused || stepping || slot.swapping) { // try again in a moment
      media.cutoff = setTimeout(() => videoDone(slot, media), 1000);
      return;
    }
    media.done = true;
    media.video.pause();
    media.video.dataset.done = '1';
    slot.current.busyUntil = 0;
    if (slot.stage !== stage) return;
    if (stage.layout === SOLO_LAYOUT) { schedule(0.3); return; } // full-screen video: next layout
    const secs = Math.round(media.video.currentTime || 0);
    replaceSlot(slot, Date.now(), `${media.item.name} done (${media.played}× ${secs}s), replaced with`);
  }

  // Load media for a slot, replacing items that fail to load.
  async function prepareFor(slot, item, accept, exclude) {
    for (let tries = 0; item && tries < 5; tries++) {
      try {
        return await createMedia(item, slot);
      } catch (e) {
        logError(`failed to load ${item.type === 'video' ? 'video' : 'photo'} ${filePath(item.url)}: ${e.message} (skipping it)`);
        playlist.markBroken(item);
        item = playlist.take(slot.aspect, { accept, exclude });
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

  // Some items never share the screen: videos when video.fullScreen is on, and very wide
  // photos (display.wideFullScreen). When one comes up next it gets this full-screen
  // layout to itself, then the slideshow moves on to a new layout.
  const videoFull = !!cfg.video.fullScreen;
  const wideLimit = Number(cfg.display.wideFullScreen) || 0;
  const isSolo = (it) => (it.type === 'video'
    ? videoFull
    : wideLimit > 0 && !!it.aspect && it.aspect > wideLimit);
  const SOLO_LAYOUT = { name: 'solo', weight: 0, slots: [{ x: 0, y: 0, w: 1, h: 1 }] };
  const soloIsNext = () => {
    const next = playlist.peek(1)[0];
    return !!next && isSolo(next);
  };
  // Portrait photos and videos are never shown full screen on their own, only alongside others.
  const isPortrait = (it) => !!it.aspect && it.aspect < 1;
  // Which items may go into a tile, given how many videos are already on screen and
  // whether the tile is the only one in its layout.
  const tileFilter = (videosOnScreen, alone) => (it) => !isSolo(it)
    && !(alone && isPortrait(it))
    && (it.type !== 'video' || videosOnScreen < cfg.video.maxOnScreen);
  const fallbackFilter = (st) => tileFilter(0, st.slots.length === 1);
  const fitsAlone = tileFilter(0, true);

  function usableCount(items) {
    const tiles = items.filter((i) => !isSolo(i));
    const videos = tiles.filter((i) => i.type === 'video').length;
    return tiles.length - videos + Math.min(videos, cfg.video.maxOnScreen);
  }

  function chooseLayout() {
    const look = Math.max(1, cfg.layouts.lookahead);
    const maxSlots = Math.max(...layouts.map((l) => l.slots.length));
    const upcoming = playlist.peek(Math.max(look, maxSlots));
    const available = usableCount(playlist.keepTogether ? playlist.peek(1000) : upcoming);
    // A one-photo layout needs something in the current event that may be shown alone
    // (not a portrait), otherwise it would end up with a portrait photo full screen.
    const aloneOk = playlist.buffer.some(fitsAlone);
    let candidates = layouts.filter((l) => l.slots.length <= Math.max(1, available) && (l.slots.length > 1 || aloneOk));
    if (!candidates.length) {
      const multi = layouts.filter((l) => l.slots.length > 1);
      const pool = aloneOk || !multi.length ? layouts : multi;
      candidates = [pool.reduce((a, b) => (a.slots.length <= b.slots.length ? a : b))];
    }

    return pickLayout(candidates, upcoming.filter((i) => !isSolo(i)).slice(0, look));
  }

  // Weighted random pick, favouring layouts whose slot shapes suit these items.
  function pickLayout(candidates, windowItems) {
    const scored = candidates.map((l) => {
      // Simulate filling the slots, biggest first, to see how well the photos fit.
      const pool = l.slots.length === 1 ? windowItems.filter(fitsAlone) : [...windowItems];
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

    const solo = soloIsNext();
    let layout = solo ? SOLO_LAYOUT : chooseLayout();
    let ns = createStage(layout);

    // Assign items, biggest slots first.
    const exclude = new Set();
    let videos = 0;
    const order = [...ns.slots].sort((a, b) => b.area - a.area);
    const jobs = [];
    const alone = ns.slots.length === 1;
    const unit = playlist.buffer.length ? playlist.buffer[0].event.unit : null;
    ns.unit = unit;
    for (const s of order) {
      const accept = solo ? isSolo : tileFilter(videos, alone);
      // Every spot gets a photo: if this visit has nothing suitable left, borrow another
      // photo from the same folder rather than leave the spot empty.
      const item = playlist.take(s.aspect, { accept, exclude })
        || borrowFromFolder(unit, s.aspect, accept, exclude);
      if (!item) break;
      exclude.add(item.url);
      if (item.type === 'video') videos++;
      jobs.push(prepareFor(s, item, fallbackFilter(ns), exclude).then((m) => { s.prepared = m; }));
    }
    await Promise.all(jobs);
    let filled = ns.slots.filter((s) => s.prepared);
    if (!filled.length) {
      if (playlist.isEmpty) showStatus('No playable photos or videos found.');
      return;
    }
    if (filled.length < ns.slots.length) {
      // Some photos couldn't be loaded (or the event ran out): rather than leave empty
      // spots, switch to a layout with exactly as many spots as there are photos.
      const ready = filled.map((s) => s.prepared);
      const fits = layouts.filter((l) => l.slots.length === ready.length
        && (ready.length > 1 || fitsAlone(ready[0].item)));
      if (fits.length) {
        const from = layout.name;
        layout = pickLayout(fits, ready.map((m) => m.item));
        ns = createStage(layout);
        const pool = [...ready];
        for (const s of [...ns.slots].sort((a, b) => b.area - a.area)) {
          let bi = 0;
          let bc = Infinity;
          pool.forEach((m, i) => { const c = SS.aspectCost(m.item.aspect, s.aspect); if (c < bc) { bc = c; bi = i; } });
          s.prepared = pool.splice(bi, 1)[0];
          frameFor(s.prepared, s);
        }
        filled = ns.slots;
        log(`layout ${from} only got ${ready.length} item(s), using ${layout.name} instead`);
      }
    }

    alignStage(ns, null, 0);
    root.appendChild(ns.el);
    const old = stage;
    stage = ns;
    if (!solo) lastLayoutName = layout.name;
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
    // A solo item moves on to a new layout as soon as it's done: a video once it has
    // finished playing, a wide photo after one normal interval.
    layoutEndsAt = Date.now() + (solo ? 0 : rand(cfg.timing.layoutDuration) * 1000);
  }

  // ---------- partial updates ----------
  async function swapSlot(slot, item, type, durMs) {
    try {
      const owner = slot.stage;
      const exclude = new Set(onScreenUrls());
      const media = await prepareFor(slot, item, fallbackFilter(slot.stage), exclude);
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

  // ---------- changing photos beside a long video ----------
  let nextVideoSwapAt = 0;
  function longVideoPlaying(now) {
    const min = Number(cfg.video.changePhotosAfter) || 0;
    if (min <= 0) return false;
    return stage.slots.some((s) => {
      const v = s.current && s.current.media.video;
      return v && s.current.busyUntil > now && isFinite(v.duration) && v.duration > min;
    });
  }

  function swapBesideVideo(now) {
    const slots = stage.slots.filter((s) => !s.swapping && s.current && !(s.current.busyUntil > now));
    if (!slots.length) return;
    replaceSlot(slots[Math.floor(Math.random() * slots.length)], now, 'beside video');
  }

  // Photos from different folders (albums, the loose-photos folder, or separate events in
  // the root folder) never share the screen. When a visit runs short, this finds another
  // photo from the same folder: the one shown longest ago (or never), suiting the spot.
  // Videos aren't borrowed, so they don't play again out of turn.
  // Only items from the folder of the layout on screen.
  const sameFolder = (accept) => (it) => accept(it) && (!stage || stage.unit == null || !it.event || it.event.unit === stage.unit);

  function borrowFromFolder(unit, aspect, accept, exclude) {
    if (unit == null) return null;
    const now = Date.now();
    const pool = playlist.events.filter((ev) => ev.unit === unit).flatMap((ev) => ev.items)
      .filter((it) => it.type !== 'video' && accept(it) && !(exclude && exclude.has(it.url)));
    const score = (it) => SS.aspectCost(it.aspect, aspect) - (now - (lastShown.get(it.url) || 0)) / 60000;
    return pool.sort((a, b) => score(a) - score(b))[0] || null;
  }

  // Replace one spot's photo/video outside the normal rhythm. Takes the next suitable item
  // from the playlist; if this visit has none left, re-shows the photo from the on-screen
  // events that was shown longest ago; failing that, borrows from the same folder.
  function replaceSlot(slot, now, why) {
    const otherVideos = stage.slots.filter((s) => s !== slot && s.current && s.current.item.type === 'video').length;
    const accept = sameFolder(tileFilter(otherVideos, stage.slots.length === 1));
    const onScreen = new Set(onScreenUrls());
    let item = playlist.take(slot.aspect, { accept, exclude: onScreen });
    if (!item) {
      const events = new Set(stage.slots.filter((s) => s.current).map((s) => s.current.item.event));
      const pool = [...events].filter(Boolean).flatMap((ev) => ev.items)
        .filter((it) => it.type !== 'video' && accept(it) && !onScreen.has(it.url));
      // Prefer photos not seen for a while, then ones that suit the spot's shape.
      const score = (it) => SS.aspectCost(it.aspect, slot.aspect) - (now - (lastShown.get(it.url) || 0)) / 60000;
      item = pool.sort((a, b) => score(a) - score(b))[0];
    }
    if (!item) item = borrowFromFolder(slot.current && slot.current.item.event.unit, slot.aspect, accept, onScreen);
    if (!item) return;
    log(`${why}: ${item.name}`);
    slot.swapping = true;
    const type = SS.pickTransition(cfg.transitions.slot.types);
    swapSlot(slot, item, type, rand(cfg.transitions.slot.duration) * 1000)
      .catch((e) => logError('swap failed', e.message));
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
      const wantLayout = forceLayout || now >= layoutEndsAt || soloIsNext();

      if (wantLayout) {
        if (!videoBusy && !swapping) {
          await changeLayout();
          return;
        }
        if (forceLayout) {
          // Event used up: wait for videos to finish. Meanwhile, during a long video,
          // change one of the other photos now and then.
          if (!swapping && now >= nextVideoSwapAt && longVideoPlaying(now)) {
            swapBesideVideo(now);
            nextVideoSwapAt = now + rand(cfg.timing.interval) * 1000;
          }
          next = 1;
          return;
        }
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
        const item = playlist.take(slot.aspect, { accept: sameFolder(tileFilter(videos, stage.slots.length === 1)), exclude });
        if (!item) {
          // Event used up, or only portraits left for a full-screen photo: new layout.
          if (playlist.keepTogether || stage.slots.length === 1) { forceLayout = true; next = 0.5; }
          break;
        }
        if (item.type === 'video') videos++;
        exclude.add(item.url);
        const type = mode === 'all' ? shared : SS.pickTransition(cfg.transitions.slot.types);
        const dur = rand(cfg.transitions.slot.duration) * 1000;
        slot.swapping = true;
        setTimeout(() => swapSlot(slot, item, type, dur).catch((e) => logError('swap failed', e.message)), delay);
        delay += rand(cfg.timing.stagger) * 1000;
      }
    } catch (e) {
      logError('step error', e && e.stack ? e.stack : e);
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
    document.querySelectorAll('video').forEach((v) => {
      if (p) v.pause();
      else if (!v.dataset.done) v.play().catch(() => {});
    });
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
