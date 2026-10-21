import { clamp } from './util';

export const KEY = { radius: 0.1, color: [1, 0.83, 0.64], intensity: 26 };
export const REST = [0.42, 0.76, 0.15];
export const INTRO_FROM = [0.1, 0.84, -0.1];
export const POINTER_DEPTH = 0.15;
export const CARD_DEPTH = -0.45;

const WALL_MARGIN = 0.03;

export function atDepth(engine, [u, v], z) {
  return engine.unproject(u, v, engine.cam.O[2] - z);
}

export function keepInRoom(engine, pos, radius) {
  const margin = radius + WALL_MARGIN;
  for (let i = 0; i < 3; i += 1) {
    pos[i] = clamp(pos[i], engine.lo[i] + margin, engine.hi[i] - (i === 2 ? 0 : margin));
  }
  const { O, tx } = engine.cam;
  const p = engine.project(pos);
  if (p.z <= 0) {
    return;
  }
  const r = radius / ((O[2] - engine.hi[2]) * 2 * tx);
  const surface = Math.min(
    engine.surfaceDistance(p.u, p.v),
    engine.surfaceDistance(p.u - r, p.v),
    engine.surfaceDistance(p.u + r, p.v),
    engine.surfaceDistance(p.u, p.v - r),
    engine.surfaceDistance(p.u, p.v + r)
  );
  const offset = pos.map((v, i) => v - O[i]);
  const dist = Math.hypot(...offset);
  const limit = surface - radius * 1.5 - WALL_MARGIN;
  if (dist > limit && limit > 0.5) {
    for (let i = 0; i < 3; i += 1) {
      pos[i] = O[i] + (offset[i] * limit) / dist;
    }
  }
}
