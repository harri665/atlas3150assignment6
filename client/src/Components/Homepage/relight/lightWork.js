import { NO_PHASE } from './RelightBase';

export const FILL = { pos: [0.64, 0.72, -0.64], radius: 0.07, color: [0.55, 0.7, 1], intensity: 9, hidden: true, fixed: true };
export const WHOLE = [0, 1, 0, 1];
export const REST_DELAY = 0.15;
export const UNEVALUATED = Object.freeze({ evalPos: null, rect: null, kept: null, stride: 0, phase: 0, done: 0, next: 0 });

export function previewStride(engine, budget, area = 1) {
  if (engine.evalCost(1) === null) return 4;
  return [1, 2, 4, 8].find((s) => engine.evalCost(s) * area <= budget) ?? 16;
}

export function itemRect(engine, [u0, u1, v0, v1], stride) {
  return [
    Math.floor((v0 * engine.H) / stride),
    Math.min(engine.rows(stride), Math.floor((v1 * engine.H) / stride) + 2),
    Math.floor((u0 * engine.W) / stride),
    Math.min(engine.cols(stride), Math.floor((u1 * engine.W) / stride) + 2),
  ];
}

export function evaluateRows(engine, job, rect, budget, least = 0) {
  const [r0, r1, c0, c1] = itemRect(engine, rect, 1);
  const full = engine.evalCost(1);
  if (full === null || !(budget > 0)) return 0;
  const row = (full * (c1 - c0)) / (engine.W * engine.H);
  const from = Math.max(r0, job.next);
  const to = Math.min(r1, from + Math.max(least, Math.floor(budget / Math.max(row, 0.001))));
  if (to <= from) return 0;
  engine.evaluate({ pos: job.evalPos || job.pos, radius: job.radius }, job.slot, 1, from, to, c0, c1, NO_PHASE);
  const span = engine.resolve(job.slot, job.image, 1, NO_PHASE, [from, to, c0, c1], 1);
  job.kept = job.kept && span ? [span[0], span[1], Math.min(job.kept[2], span[2]), span[3]] : span;
  job.next = to;
  return row * (to - from);
}

export function fillStep(engine, light, budget, idle) {
  if (!(budget > 0)) return 0;
  const cost = engine.evalCost(1);
  if (!light.evalPos && (cost === null || cost > budget)) {
    const stride = previewStride(engine, budget);
    const items = [0, engine.rows(stride), 0, engine.cols(stride)];
    engine.evaluate(light, light.slot, stride, ...items, NO_PHASE);
    engine.resolve(light.slot, light.image, stride, NO_PHASE, items, 1);
    Object.assign(light, { evalPos: [...light.pos], rect: WHOLE, stride: 1, done: 0, next: 0 });
    return cost === null ? budget : engine.evalCost(stride);
  }
  const spent = evaluateRows(engine, light, WHOLE, budget, idle ? 1 : 0);
  if (spent > 0) {
    Object.assign(light, { evalPos: [...light.pos], rect: WHOLE, stride: 1, done: light.next >= engine.H ? 1 : 0 });
  }
  return spent;
}

export function createFill(engine) {
  return { ...FILL, pos: [...FILL.pos], engine, image: 1, slot: 1, ...UNEVALUATED };
}

export function fillMatches(fill, engine) {
  return fill?.engine === engine && fill.image === 1 && fill.radius === FILL.radius && fill.pos.every((v, i) => v === FILL.pos[i]);
}

export function refinementProgress(light, engine) {
  if (!light.evalPos) return 0;
  if (light.done >= light.stride ** 2) return 1;
  if (light.refining || light.fixed) {
    const [r0, r1] = itemRect(engine, light.rect || WHOLE, 1);
    return Math.max(0, Math.min(1, (light.next - r0) / Math.max(1, r1 - r0)));
  }
  return light.done / Math.max(1, light.stride ** 2);
}
