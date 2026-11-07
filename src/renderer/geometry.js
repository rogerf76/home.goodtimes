'use strict';
// Adjusts a layout's row and column sizes so the photos placed in it line up with
// their neighbours, instead of each floating in its own spot with uneven black bars.
//
// Every layout is cut into rows and columns (a "guillotine" layout). Each cut has a set
// of size fractions. We nudge those fractions to maximise how much of the screen the
// photos cover, under one hard rule: no photo may end up more than `maxScale` (10%)
// bigger or smaller than it would be in the standard layout. Photos are always shown
// whole with their exact proportions; only the spots around them move.

window.SS = window.SS || {};

const EPS = 1e-6;

/** Build a tree of row/column cuts from slot rects (fractions of the screen). Returns null if the layout isn't made of straight cuts. */
SS.buildLayoutTree = function buildLayoutTree(rects) {
  let nextId = 0;
  function build(idxs, box) {
    if (idxs.length === 1) return { leaf: idxs[0] };
    for (const dir of ['h', 'v']) { // h: side by side (cuts along x), v: stacked (cuts along y)
      const lo = (r) => (dir === 'h' ? r.x : r.y);
      const len = (r) => (dir === 'h' ? r.w : r.h);
      const start = dir === 'h' ? box.x : box.y;
      const end = start + (dir === 'h' ? box.w : box.h);
      const cuts = [...new Set(idxs.map((i) => +(lo(rects[i]) + len(rects[i])).toFixed(6)))]
        .filter((c) => c < end - EPS)
        .filter((c) => idxs.every((i) => !(lo(rects[i]) < c - EPS && lo(rects[i]) + len(rects[i]) > c + EPS)))
        .sort((a, b) => a - b);
      if (!cuts.length) continue;
      const edges = [start, ...cuts, end];
      const children = [];
      const fracs = [];
      for (let k = 0; k < edges.length - 1; k++) {
        const a = edges[k];
        const b = edges[k + 1];
        const group = idxs.filter((i) => lo(rects[i]) >= a - EPS && lo(rects[i]) + len(rects[i]) <= b + EPS);
        if (!group.length) return null;
        const sub = dir === 'h' ? { x: a, y: box.y, w: b - a, h: box.h } : { x: box.x, y: a, w: box.w, h: b - a };
        const child = build(group, sub);
        if (!child) return null;
        children.push(child);
        fracs.push((b - a) / (end - start));
      }
      return { id: nextId++, dir, children, fracs };
    }
    return null;
  }
  const tree = build(rects.map((_, i) => i), { x: 0, y: 0, w: 1, h: 1 });
  if (tree) tree.nodeCount = nextId;
  return tree;
};

function nodes(tree, out = []) {
  if (tree.leaf === undefined) { out.push(tree); tree.children.forEach((c) => nodes(c, out)); }
  return out;
}

/** Pixel boxes for every leaf given fractions F (array indexed by node id). */
SS.placeTree = function placeTree(tree, F, box) {
  const out = [];
  (function place(node, b) {
    if (node.leaf !== undefined) { out[node.leaf] = b; return; }
    const fr = F[node.id];
    let pos = node.dir === 'h' ? b.x : b.y;
    node.children.forEach((c, i) => {
      const len = fr[i] * (node.dir === 'h' ? b.w : b.h);
      place(c, node.dir === 'h' ? { x: pos, y: b.y, w: len, h: b.h } : { x: b.x, y: pos, w: b.w, h: len });
      pos += len;
    });
  })(tree, box);
  return out;
};

SS.nominalFractions = (tree) => {
  const F = [];
  for (const n of nodes(tree)) F[n.id] = [...n.fracs];
  return F;
};

/**
 * aspects[i] = photo aspect for slot i (null = empty / unknown).
 * box = available area in px; gap = px between photos (each slot is inset by gap/2).
 * Returns fractions F.
 *
 * "Justified" target: photos side by side get widths in proportion to their aspect
 * ratios so their heights match; stacked photos get heights in proportion so their
 * widths match. We move from the designed layout towards that target as far as the
 * 10% size limit allows (each cut individually, biggest cuts first).
 */
SS.optimiseLayout = function optimiseLayout(tree, rects, aspects, box, gap, maxScale) {
  const F0 = SS.nominalFractions(tree);
  if (tree.leaf !== undefined) return F0;
  const nominalBoxes = SS.placeTree(tree, F0, box);
  const shownW = (a, b) => Math.min(Math.max(1, b.w - gap), Math.max(1, b.h - gap) * a);
  const aspectOf = (i) => aspects[i] || (nominalBoxes[i].w - gap) / (nominalBoxes[i].h - gap);
  const base = nominalBoxes.map((b, i) => (aspects[i] ? shownW(aspects[i], b) : null));

  // Natural aspect of a subtree if its photos were packed edge to edge.
  const natural = (n) => (n.leaf !== undefined ? aspectOf(n.leaf)
    : n.dir === 'h' ? n.children.reduce((s, c) => s + natural(c), 0)
      : 1 / n.children.reduce((s, c) => s + 1 / natural(c), 0));

  // Justified fractions, worked out top-down in pixels so the gaps are accounted for.
  const FJ = [];
  (function justify(n, b) {
    if (n.leaf !== undefined) return;
    const len = n.dir === 'h' ? b.w : b.h;
    const weights = n.children.map((c) => (n.dir === 'h' ? natural(c) : 1 / natural(c)));
    const k = (len - n.children.length * gap) / weights.reduce((x, y) => x + y, 0);
    FJ[n.id] = weights.map((w) => Math.max(0.05, (gap + k * w) / len));
    const sum = FJ[n.id].reduce((x, y) => x + y, 0);
    FJ[n.id] = FJ[n.id].map((f) => f / sum);
    let pos = n.dir === 'h' ? b.x : b.y;
    n.children.forEach((c, i) => {
      const l = FJ[n.id][i] * len;
      justify(c, n.dir === 'h' ? { x: pos, y: b.y, w: l, h: b.h } : { x: b.x, y: pos, w: b.w, h: l });
      pos += l;
    });
  })(tree, box);

  const feasible = (F) => SS.placeTree(tree, F, box).every((b, i) => {
    if (!aspects[i]) return true;
    const r = shownW(aspects[i], b) / base[i];
    return r >= 1 - maxScale - EPS && r <= 1 + maxScale + EPS;
  });

  // Pairs of neighbouring slots and which edge lines they share in the designed layout.
  const pairs = [];
  const near = (a, b) => Math.abs(a - b) < EPS;
  for (let i = 0; i < rects.length; i++) {
    for (let j = i + 1; j < rects.length; j++) {
      if (!aspects[i] || !aspects[j]) continue;
      const A = rects[i];
      const B = rects[j];
      const overlapY = Math.min(A.y + A.h, B.y + B.h) - Math.max(A.y, B.y) > EPS;
      const overlapX = Math.min(A.x + A.w, B.x + B.w) - Math.max(A.x, B.x) > EPS;
      if (overlapY && (near(A.x + A.w, B.x) || near(B.x + B.w, A.x))) {
        pairs.push({ i, j, edges: [near(A.y, B.y) && 'top', near(A.y + A.h, B.y + B.h) && 'bottom'].filter(Boolean) });
      }
      if (overlapX && (near(A.y + A.h, B.y) || near(B.y + B.h, A.y))) {
        pairs.push({ i, j, edges: [near(A.x, B.x) && 'left', near(A.x + A.w, B.x + B.w) && 'right'].filter(Boolean) });
      }
    }
  }

  // Misalignment in px between neighbouring photos' edges, plus a small pull back towards the design.
  function cost(F) {
    const boxes = SS.placeTree(tree, F, box);
    const photo = boxes.map((b, i) => {
      if (!aspects[i]) return null;
      const w = shownW(aspects[i], b);
      const h = w / aspects[i];
      const left = b.x + (b.w - w) / 2;
      const top = b.y + (b.h - h) / 2;
      return { left, top, right: left + w, bottom: top + h, ratio: w / base[i] };
    });
    let c = 0;
    // Rows that don't line up (top/bottom edges) are much more noticeable than columns.
    for (const p of pairs) for (const e of p.edges) c += (e === 'top' || e === 'bottom' ? 2 : 1) * Math.abs(photo[p.i][e] - photo[p.j][e]);
    for (const ph of photo) if (ph) c += 40 * Math.abs(ph.ratio - 1);
    return c;
  }

  function descend(start) {
    const F = start.map((f) => (f ? [...f] : f));
    let best = feasible(F) ? cost(F) : Infinity;
    const list = nodes(tree);
    for (const step of [0.04, 0.02, 0.01, 0.005, 0.0025, 0.001]) {
      for (let pass = 0, improved = true; improved && pass < 40; pass++) {
        improved = false;
        for (const n of list) {
          const fr = F[n.id];
          for (let i = 0; i < fr.length; i++) {
            for (let j = 0; j < fr.length; j++) {
              if (i === j || fr[j] - step < 0.05) continue;
              fr[i] += step; fr[j] -= step;
              const c = feasible(F) ? cost(F) : Infinity;
              if (c < best - EPS) { best = c; improved = true; } else { fr[i] -= step; fr[j] += step; }
            }
          }
        }
      }
    }
    return { F, best };
  }

  // Starting point 2: as far towards the justified layout as the size limit allows.
  const FB = F0.map((f) => (f ? [...f] : f));
  for (const n of nodes(tree)) {
    const from = [...FB[n.id]];
    const at = (t) => from.map((f, i) => f + (FJ[n.id][i] - f) * t);
    let lo = 0;
    let hi = 1;
    FB[n.id] = at(1);
    if (feasible(FB)) continue;
    for (let it = 0; it < 18; it++) {
      const mid = (lo + hi) / 2;
      FB[n.id] = at(mid);
      if (feasible(FB)) lo = mid; else hi = mid;
    }
    FB[n.id] = at(lo);
  }

  const a = descend(F0);
  const b = descend(FB);
  const win = b.best < a.best ? b : a;
  SS.lastLayoutCost = { before: cost(F0), after: win.best };
  return win.F;
};
