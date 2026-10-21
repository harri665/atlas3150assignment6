import { clamp01 } from './util';

export const VIEW_MARGIN = 0.03;
export const VIEW_GROW = 0.15;

export function visibleRect(box, vw, vh) {
  return [
    clamp01(-box.left / box.size),
    clamp01((vw - box.left) / box.size),
    clamp01(-box.top / box.size),
    clamp01((vh - box.top) / box.size),
  ];
}

export function grow([u0, u1, v0, v1], m) {
  return [clamp01(u0 - m), clamp01(u1 + m), clamp01(v0 - m), clamp01(v1 + m)];
}

export function covers(rect, view) {
  return !!rect && rect[0] <= view[0] && rect[1] >= view[1] && rect[2] <= view[2] && rect[3] >= view[3];
}

export function sameRect(a, b) {
  return !!a && !!b && a.every((v, i) => v === b[i]);
}

export function areaOf([u0, u1, v0, v1]) {
  return Math.max(0, u1 - u0) * Math.max(0, v1 - v0);
}
