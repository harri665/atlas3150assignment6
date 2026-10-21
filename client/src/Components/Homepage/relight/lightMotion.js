import { covers } from './rect';
import { distance } from './util';

export const TRUST_DISTANCE = 0.06;
export const MAX_EVAL_MOVE = TRUST_DISTANCE / 2;
export const HANDOFF_DISTANCE = TRUST_DISTANCE * 3;

export function dampedPosition(from, aim, lambda, delta) {
  const t = 1 - Math.exp(-lambda * Math.max(0, delta));
  return from.map((value, i) => value + (aim[i] - value) * t);
}

export function imageBlend(moved) {
  return moved >= TRUST_DISTANCE ? 1 : 1 - Math.exp(-moved / TRUST_DISTANCE);
}

export function readyHandoff(spares, aim, view, trustDistance) {
  let best = null;
  let nearest = trustDistance;
  for (const spare of spares) {
    if (!spare.ready || !spare.pos || !covers(spare.rect, view)) continue;
    const d = distance(spare.pos, aim);
    if (d <= nearest) {
      best = spare;
      nearest = d;
    }
  }
  return best;
}
