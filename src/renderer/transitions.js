'use strict';
// Transition = keyframes for the incoming element and (optionally) the outgoing one.
// They are played with the Web Animations API over a randomised duration.

window.SS = window.SS || {};

const slide = (fx, fy) => ({
  in: [{ transform: `translate(${fx * 100}%, ${fy * 100}%)` }, { transform: 'translate(0, 0)' }],
  out: [{ transform: 'translate(0, 0)' }, { transform: `translate(${-fx * 100}%, ${-fy * 100}%)` }],
});

const wipe = (from) => ({
  in: [{ clipPath: from }, { clipPath: 'inset(0 0 0 0)' }],
  out: null, // old content stays put underneath
});

SS.TRANSITIONS = {
  fade: {
    in: [{ opacity: 0 }, { opacity: 1 }],
    out: [{ opacity: 1 }, { opacity: 0 }],
  },
  'slide-left': slide(1, 0),
  'slide-right': slide(-1, 0),
  'slide-up': slide(0, 1),
  'slide-down': slide(0, -1),
  'zoom-in': {
    in: [{ opacity: 0, transform: 'scale(1.25)' }, { opacity: 1, transform: 'scale(1)' }],
    out: [{ opacity: 1, transform: 'scale(1)' }, { opacity: 0, transform: 'scale(0.9)' }],
  },
  'zoom-out': {
    in: [{ opacity: 0, transform: 'scale(0.8)' }, { opacity: 1, transform: 'scale(1)' }],
    out: [{ opacity: 1, transform: 'scale(1)' }, { opacity: 0, transform: 'scale(1.15)' }],
  },
  blur: {
    in: [{ opacity: 0, filter: 'blur(30px)' }, { opacity: 1, filter: 'blur(0px)' }],
    out: [{ opacity: 1, filter: 'blur(0px)' }, { opacity: 0, filter: 'blur(30px)' }],
  },
  'wipe-left': wipe('inset(0 0 0 100%)'),
  'wipe-right': wipe('inset(0 100% 0 0)'),
  'wipe-up': wipe('inset(100% 0 0 0)'),
  'wipe-down': wipe('inset(0 0 100% 0)'),
  iris: {
    in: [{ clipPath: 'circle(0% at 50% 50%)' }, { clipPath: 'circle(75% at 50% 50%)' }],
    out: null,
  },
  flip: {
    in: [
      { transform: 'perspective(1600px) rotateY(-90deg)', offset: 0 },
      { transform: 'perspective(1600px) rotateY(-90deg)', offset: 0.5 },
      { transform: 'perspective(1600px) rotateY(0deg)', offset: 1 },
    ],
    out: [
      { transform: 'perspective(1600px) rotateY(0deg)', offset: 0 },
      { transform: 'perspective(1600px) rotateY(90deg)', offset: 0.5 },
      { transform: 'perspective(1600px) rotateY(90deg)', offset: 1 },
    ],
  },
  cut: { in: null, out: null },
};

/**
 * Animate `incoming` in and `outgoing` out. Resolves when both are done.
 */
SS.runTransition = function runTransition(type, incoming, outgoing, durationMs, easing) {
  const t = SS.TRANSITIONS[type] || SS.TRANSITIONS.fade;
  const opts = { duration: Math.max(1, durationMs), easing, fill: 'forwards' };
  const anims = [];
  if (incoming && t.in) anims.push(incoming.animate(t.in, opts));
  if (outgoing && t.out) anims.push(outgoing.animate(t.out, opts));
  if (!anims.length) return Promise.resolve();
  return Promise.all(anims.map((a) => a.finished.catch(() => {})));
};

SS.pickTransition = function pickTransition(types) {
  const valid = (types || []).filter((t) => SS.TRANSITIONS[t]);
  return valid.length ? valid[Math.floor(Math.random() * valid.length)] : 'fade';
};
