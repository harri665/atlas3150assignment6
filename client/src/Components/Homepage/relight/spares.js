import { CARD_SELECTOR } from '../useCardLights';
import { RESOLVED } from './RelightBase';
import { CARD_DEPTH, KEY, atDepth, keepInRoom } from './keyAim';
import { UNEVALUATED, evaluateRows, itemRect } from './lightWork';
import { MAX_EVAL_MOVE, TRUST_DISTANCE } from './lightMotion';
import { MOVE_EPS, movedSince } from './lightSchedule';
import { VIEW_MARGIN, covers, grow } from './rect';
import { distance } from './util';

export const TARGETS_EVERY = 0.5;

export function createSpares(engine, slot) {
  return Array.from({ length: (engine.images ?? RESOLVED) - RESOLVED }, (_, i) => ({
    image: RESOLVED + i,
    slot,
    radius: KEY.radius,
    pos: null,
    rect: null,
    kept: null,
    next: 0,
    ready: false,
    rank: Infinity,
  }));
}

export function releaseSpare(spare, slot) {
  Object.assign(spare, { pos: null, evalPos: null, slot, ready: false, rank: Infinity });
}

export function retargetSpare(spare, pos, slot, now) {
  Object.assign(spare, UNEVALUATED, { pos, still: now, refining: false, slot, ready: false, rank: Infinity });
}

export function takeSpare(light, spare) {
  [light.image, spare.image] = [spare.image, light.image];
  Object.assign(light, {
    evalPos: spare.pos,
    rect: spare.rect,
    kept: spare.kept,
    stride: 1,
    phase: 0,
    done: 1,
    next: spare.next,
    refining: false,
  });
  Object.assign(spare, UNEVALUATED);
  releaseSpare(spare, 1);
}

export function adoptSpare(light, spares, aim, view) {
  if (movedSince(light) <= MOVE_EPS) {
    return false;
  }
  let best = null;
  spares.forEach((spare) => {
    const d = spare.ready && covers(spare.rect, view) && distance(aim, spare.pos) <= TRUST_DISTANCE
      ? distance(light.pos, spare.pos)
      : Infinity;
    if (d <= MAX_EVAL_MOVE && (!best || d < distance(light.pos, best.pos))) {
      best = spare;
    }
  });
  if (!best) {
    return false;
  }
  takeSpare(light, best);
  return true;
}

export function precomputeSpare(state, engine, budget, now, view, vw, vh, canHover) {
  if (engine.evalCost(1) === null) {
    return 0;
  }
  if (now - state.targetsAt > TARGETS_EVERY) {
    state.targetsAt = now;
    aimSpares(state.spares, likelyTargets(state, engine, vw, vh, canHover), grow(view, VIEW_MARGIN));
  }
  const spare = state.spares.find((s) => s.rank < Infinity && !s.ready);
  if (!spare) {
    return 0;
  }
  const spent = evaluateRows(engine, spare, spare.rect, budget, 1);
  spare.ready = spare.next >= itemRect(engine, spare.rect, 1)[1];
  return spent;
}

export function aimSpares(spares, targets, rect) {
  const at = (spare, pos) => !!spare.pos && distance(spare.pos, pos) <= MOVE_EPS;
  const wanted = targets.slice(0, spares.length);
  const free = spares.filter((s) => !wanted.some((pos) => at(s, pos)));
  spares.forEach((s) => {
    s.rank = Infinity;
  });
  wanted.forEach((pos, rank) => {
    const spare = spares.find((s) => s.rank === Infinity && at(s, pos)) || free.shift();
    if (!spare) {
      return;
    }
    if (!at(spare, pos)) {
      Object.assign(spare, { pos, rect, kept: null, next: 0, ready: false });
    }
    spare.rank = rank;
  });
  spares.sort((a, b) => a.rank - b.rank);
}

function cardCentres(panel) {
  return [...panel.querySelectorAll(CARD_SELECTOR)].map((el) => {
    const r = el.getBoundingClientRect();
    return { el, x: (r.left + r.right) / 2, y: (r.top + r.bottom) / 2 };
  });
}

function nearestToPointer(cards, pointer, box, vw, vh) {
  const { left, top, size } = box;
  const [px, py] = pointer ? [left + pointer[0] * size, top + pointer[1] * size] : [vw / 2, vh / 2];
  return cards
    .filter((c) => c.x > 0 && c.x < vw && c.y > 0 && c.y < vh)
    .sort((a, b) => Math.hypot(a.x - px, a.y - py) - Math.hypot(b.x - px, b.y - py));
}

function touchTakeovers(cards, focused, vh) {
  const picks = [];
  const rows = cards.filter((c, i) => !cards.slice(0, i).some((d) => Math.abs(d.y - c.y) < 1));
  const at = rows.findIndex((c) => c.el === focused);
  for (let k = 1; at >= 0 && k < rows.length; k += 1) {
    [at + k, at - k].forEach((i) => {
      const before = rows[i + (i > at ? -1 : 1)];
      if (rows[i]) {
        picks.push({ x: rows[i].x, y: rows[i].y + vh / 2 - (rows[i].y + before.y) / 2 });
      }
    });
  }
  return picks;
}

export function likelyTargets(state, engine, vw, vh, canHover) {
  const { left, top, size } = state.box;
  const cards = cardCentres(state.panel);
  const picks = canHover
    ? nearestToPointer(cards, state.pointer, state.box, vw, vh)
    : touchTakeovers(cards, state.card.el, vh);
  return picks
    .map(({ x, y }) => {
      const pos = [...atDepth(engine, [(x - left) / size, (y - top) / size], CARD_DEPTH)];
      keepInRoom(engine, pos, KEY.radius);
      return pos;
    })
    .filter((pos) => !state.key.evalPos || distance(pos, state.key.evalPos) > TRUST_DISTANCE);
}
