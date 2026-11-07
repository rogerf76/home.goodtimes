'use strict';
// Loads settings.yaml / settings.json, merges with defaults and normalises values.

const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');

const DEFAULTS = {
  sources: [],
  recursive: true,
  include: {
    images: ['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp', 'avif'],
    videos: ['mp4', 'm4v', 'mov', 'webm'],
  },
  excludeFolders: ['@eaDir', '#recycle', '$RECYCLE.BIN', 'System Volume Information', '.thumbnails'],
  cacheFile: '.goodtimes-cache.json',
  rescanMinutes: 60,

  order: 'chronological', // chronological | reverse | shuffle-events | shuffle
  startAt: 'beginning',    // beginning | random
  grouping: {
    maxGapHours: 4,
    maxDistanceKm: 30,
    keepEventsTogether: true,
    albumVisit: [2, 4],
    mixAlbumDays: true,
  },

  timing: {
    interval: { min: 6, max: 10 },
    layoutDuration: { min: 25, max: 50 },
    stagger: { min: 0.2, max: 1.2 },
  },

  updateMode: { all: 1, some: 2, one: 3 },

  layouts: {
    weights: {
      single: 4, pair: 3, 'pair-uneven': 2, 'triple-columns': 2,
      'big-left-two': 2, 'big-right-two': 2, 'big-left-three': 1,
      quad: 2, 'hero-strip': 1, 'mosaic-5': 1, 'grid-6': 1,
      'portrait-centre': 1, 'pair-stacked': 0,
    },
    custom: {},
    aspectMatchStrength: 2.0,
    lookahead: 8,
  },

  transitions: {
    slot: {
      types: ['fade', 'slide-left', 'slide-right', 'slide-up', 'slide-down', 'zoom-in', 'zoom-out', 'blur', 'wipe-left', 'wipe-right', 'wipe-up', 'wipe-down', 'iris', 'flip'],
      duration: { min: 0.8, max: 1.6 },
    },
    layout: {
      types: ['fade', 'slide-left', 'slide-up', 'zoom-out', 'blur', 'iris'],
      duration: { min: 1.2, max: 2.0 },
      perSlotChance: 0.5,
    },
    easing: 'cubic-bezier(0.65, 0, 0.35, 1)',
  },

  display: {
    screen: 0,
    fullscreen: true,
    background: '#000000',
    gap: 6,
    cornerRadius: 0,
    fitSingle: 'contain',
    maxCrop: 0,
    alignPhotos: 0.1,
    blurredBackdrop: false,
    kenBurns: { enabled: true, chance: 0.3, maxPhotoSize: 0.4, maxZoom: 1.15 },
    preventSleep: true,
  },

  video: {
    enabled: true,
    muted: true,
    volume: 0.6,
    fullScreen: true,
    maxOnScreen: 1,
    playToEnd: true,
    maxSeconds: 60,
  },

  captions: {
    enabled: true,
    showDate: true,
    showPlace: true,
    showAlbum: true,
    showFilename: false,
    dateFormat: { day: 'numeric', month: 'long', year: 'numeric' },
    locale: '',
    fontSize: 18,
  },

  geocoding: {
    enabled: false,
    language: 'en',
    cacheFile: '.goodtimes-geocache.json',
  },
};

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

// Deep merge; arrays and scalars in `over` replace those in `base`.
function merge(base, over) {
  if (!isPlainObject(over)) return over === undefined ? base : over;
  const out = { ...base };
  for (const [k, v] of Object.entries(over)) {
    out[k] = isPlainObject(v) && isPlainObject(base?.[k]) ? merge(base[k], v) : v;
  }
  return out;
}

// Accepts 5, [3, 8], {min: 3, max: 8}  ->  {min, max}
function toRange(v, name) {
  if (typeof v === 'number') return { min: v, max: v };
  if (Array.isArray(v) && v.length === 2) return { min: +v[0], max: +v[1] };
  if (isPlainObject(v) && 'min' in v && 'max' in v) return { min: +v.min, max: +v.max };
  throw new Error(`Setting "${name}" must be a number, [min, max] or {min, max}`);
}

function findSettingsFile(explicit) {
  if (explicit) return path.resolve(explicit);
  const dirs = [process.cwd(), path.join(__dirname, '..')];
  for (const dir of dirs) {
    for (const name of ['settings.yaml', 'settings.yml', 'settings.json']) {
      const p = path.join(dir, name);
      if (fs.existsSync(p)) return p;
    }
  }
  throw new Error('No settings.yaml or settings.json found. Pass one with: npm start -- path/to/settings.yaml');
}

function loadConfig(explicitPath) {
  const file = findSettingsFile(explicitPath);
  const text = fs.readFileSync(file, 'utf8');
  const raw = file.endsWith('.json') ? JSON.parse(text) : yaml.load(text) || {};

  // Custom layouts / weights should not be deep-merged into defaults key by key
  // in a way that prevents disabling built-ins, so weights merge normally (set 0 to disable).
  const cfg = merge(DEFAULTS, raw);
  const baseDir = path.dirname(file);

  if (typeof cfg.sources === 'string') cfg.sources = [cfg.sources];
  if (!Array.isArray(cfg.sources) || cfg.sources.length === 0) {
    throw new Error(`No "sources" folders configured in ${file}`);
  }
  cfg.sources = cfg.sources.map((s) => path.resolve(baseDir, String(s)));
  cfg.cacheFile = cfg.cacheFile ? path.resolve(baseDir, cfg.cacheFile) : null;
  cfg.geocoding.cacheFile = path.resolve(baseDir, cfg.geocoding.cacheFile);

  const av = cfg.grouping.albumVisit;
  cfg.grouping.albumVisit = av == null || av === 0 || av === 'all' ? null : toRange(av, 'grouping.albumVisit');
  cfg.timing.interval = toRange(cfg.timing.interval, 'timing.interval');
  cfg.timing.layoutDuration = toRange(cfg.timing.layoutDuration, 'timing.layoutDuration');
  cfg.timing.stagger = toRange(cfg.timing.stagger, 'timing.stagger');
  cfg.transitions.slot.duration = toRange(cfg.transitions.slot.duration, 'transitions.slot.duration');
  cfg.transitions.layout.duration = toRange(cfg.transitions.layout.duration, 'transitions.layout.duration');

  const lc = (a) => (a || []).map((e) => String(e).toLowerCase().replace(/^\./, ''));
  cfg.include.images = lc(cfg.include.images);
  cfg.include.videos = cfg.video.enabled ? lc(cfg.include.videos) : [];
  cfg.excludeFolders = (cfg.excludeFolders || []).map((s) => String(s).toLowerCase());

  cfg._file = file;
  return cfg;
}

module.exports = { loadConfig, DEFAULTS };
