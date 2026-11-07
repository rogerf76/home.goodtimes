'use strict';
// Layouts are lists of slots: [x, y, width, height] as fractions of the screen (0..1).
// Each slot's on-screen aspect ratio is used to pick photos that fit it well
// (portrait photos go to tall slots, landscapes to wide ones).

window.SS = window.SS || {};

SS.BUILTIN_LAYOUTS = {
  single: [[0, 0, 1, 1]],
  pair: [[0, 0, 0.5, 1], [0.5, 0, 0.5, 1]],
  'pair-uneven': [[0, 0, 0.62, 1], [0.62, 0, 0.38, 1]],
  'pair-stacked': [[0, 0, 1, 0.5], [0, 0.5, 1, 0.5]],
  'triple-columns': [[0, 0, 1 / 3, 1], [1 / 3, 0, 1 / 3, 1], [2 / 3, 0, 1 / 3, 1]],
  'big-left-two': [[0, 0, 0.62, 1], [0.62, 0, 0.38, 0.5], [0.62, 0.5, 0.38, 0.5]],
  'big-right-two': [[0.38, 0, 0.62, 1], [0, 0, 0.38, 0.5], [0, 0.5, 0.38, 0.5]],
  'big-left-three': [[0, 0, 0.6, 1], [0.6, 0, 0.4, 1 / 3], [0.6, 1 / 3, 0.4, 1 / 3], [0.6, 2 / 3, 0.4, 1 / 3]],
  quad: [[0, 0, 0.5, 0.5], [0.5, 0, 0.5, 0.5], [0, 0.5, 0.5, 0.5], [0.5, 0.5, 0.5, 0.5]],
  'hero-strip': [[0, 0, 1, 0.68], [0, 0.68, 1 / 3, 0.32], [1 / 3, 0.68, 1 / 3, 0.32], [2 / 3, 0.68, 1 / 3, 0.32]],
  'mosaic-5': [[0, 0, 0.5, 1], [0.5, 0, 0.25, 0.5], [0.75, 0, 0.25, 0.5], [0.5, 0.5, 0.25, 0.5], [0.75, 0.5, 0.25, 0.5]],
  'portrait-centre': [[0, 0, 0.3, 1], [0.3, 0, 0.4, 1], [0.7, 0, 0.3, 1]],
  'grid-6': [
    [0, 0, 1 / 3, 0.5], [1 / 3, 0, 1 / 3, 0.5], [2 / 3, 0, 1 / 3, 0.5],
    [0, 0.5, 1 / 3, 0.5], [1 / 3, 0.5, 1 / 3, 0.5], [2 / 3, 0.5, 1 / 3, 0.5],
  ],
};

/** Returns [{ name, weight, slots: [{x, y, w, h}] }] for all layouts with weight > 0. */
SS.buildLayouts = function buildLayouts(cfg) {
  const defs = { ...SS.BUILTIN_LAYOUTS };
  const weights = { ...cfg.layouts.weights };
  for (const [name, def] of Object.entries(cfg.layouts.custom || {})) {
    const slots = Array.isArray(def) ? def : def.slots;
    if (!Array.isArray(slots) || !slots.length) continue;
    defs[name] = slots;
    if (!Array.isArray(def) && def.weight != null) weights[name] = def.weight;
    else if (weights[name] == null) weights[name] = 1;
  }
  const out = [];
  for (const [name, slots] of Object.entries(defs)) {
    const weight = +(weights[name] ?? 0);
    if (weight <= 0) continue;
    out.push({ name, weight, slots: slots.map(([x, y, w, h]) => ({ x, y, w, h })) });
  }
  if (!out.length) out.push({ name: 'single', weight: 1, slots: [{ x: 0, y: 0, w: 1, h: 1 }] });
  return out;
};
