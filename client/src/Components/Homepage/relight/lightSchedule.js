import { phaseOrder } from './RelightBase';
import { REST_DELAY, UNEVALUATED, evaluateRows, itemRect, previewStride } from './lightWork';
import { imageBlend } from './lightMotion';
import { VIEW_GROW, VIEW_MARGIN, areaOf, covers, grow, sameRect } from './rect';
import { distance } from './util';

export const MOVE_EPS = 0.004;

export function makeLight(pos, { radius, color, hidden = false, fixed = false }, index) {
  return { pos: [...pos], radius, color, hidden, fixed, slot: index, image: index, ...UNEVALUATED, still: 0 };
}

export function forgetImage(light, image) {
  Object.assign(light, UNEVALUATED, { image, refining: false, lastMove: null, lastAlpha: null });
}

export function movedSince(light) {
  return light.evalPos ? distance(light.pos, light.evalPos) : Infinity;
}

export function converged(light) {
  return light.stride > 0 && light.done >= light.stride ** 2;
}

export function atRest(light) {
  return movedSince(light) <= MOVE_EPS && converged(light);
}

export function needsWork(light, scrolling, view) {
  if (light.fixed) {
    return !light.evalPos || !converged(light);
  }
  return (
    movedSince(light) > MOVE_EPS ||
    !covers(light.rect, view) ||
    (!scrolling && !converged(light))
  );
}

export function stepLight(engine, light, now, budget, view, scrolling = false) {
  const moved = movedSince(light);
  const fresh = moved > MOVE_EPS;
  const rect = fresh || !covers(light.rect, view) ? grow(view, fresh ? VIEW_MARGIN : VIEW_GROW) : light.rect;
  if (fresh || !sameRect(rect, light.rect)) {
    light.refining = false;
    light.next = 0;
  }
  if (!fresh && now - light.still >= REST_DELAY && engine.evalCost(1) !== null) {
    return refineRows(engine, light, rect, budget);
  }
  return evaluatePhases(engine, light, { rect, moved, fresh, now, budget, scrolling });
}

function refineRows(engine, light, rect, budget) {
  light.refining = true;
  light.rect = rect;
  const spent = evaluateRows(engine, light, rect, budget, 1);
  light.stride = 1;
  light.done = light.next >= itemRect(engine, rect, 1)[1] ? 1 : 0;
  return spent;
}

function evaluatePhases(engine, light, { rect, moved, fresh, now, budget, scrolling }) {
  const stride = previewStride(engine, budget, areaOf(rect));
  if (fresh || stride !== light.stride || !sameRect(rect, light.rect)) {
    light.done = 0;
  }
  light.stride = stride;
  let alpha = 0;
  if (fresh) {
    alpha = Number.isFinite(moved) ? imageBlend(moved) : 1;
    light.lastMove = Number.isFinite(moved) ? moved : null;
    light.lastAlpha = alpha;
    light.evalPos = [...light.pos];
    light.still = now;
  }
  const cost = engine.evalCost(stride);
  const each = cost === null ? budget : cost * areaOf(rect);
  const maxPhases = fresh || scrolling ? 1 : 2;
  const phases = Math.max(1, Math.min(maxPhases, Math.floor(budget / Math.max(each, 0.001)), stride ** 2 - light.done));
  const order = phaseOrder(stride);
  const items = itemRect(engine, rect, stride);
  for (let i = 0; i < phases; i += 1) {
    const phase = order[light.phase % order.length];
    light.phase += 1;
    light.done += 1;
    engine.evaluate({ pos: light.evalPos, radius: light.radius }, light.slot, stride, ...items, phase);
    const blend = i === 0 ? alpha : 0;
    light.kept = engine.resolve(light.slot, light.image, stride, phase, items, blend, light.kept);
  }
  light.rect = rect;
  return each * phases;
}

export function shownLight(light, intensity) {
  return {
    pos: light.evalPos,
    radius: light.radius,
    color: light.color,
    intensity,
    resolved: light.image,
    hidden: light.hidden,
  };
}
