const STRIKE_KEYS = [
  [0.3, 0],
  [0.36, 0.75],
  [0.44, 0.12],
  [0.58, 0.9],
  [0.68, 0.45],
  [0.9, 1],
];

export function strikeLevel(t) {
  if (t <= STRIKE_KEYS[0][0]) {
    return 0;
  }
  for (let i = 1; i < STRIKE_KEYS.length; i += 1) {
    if (t < STRIKE_KEYS[i][0]) {
      const [t0, v0] = STRIKE_KEYS[i - 1];
      const [t1, v1] = STRIKE_KEYS[i];
      return v0 + ((v1 - v0) * (t - t0)) / (t1 - t0);
    }
  }
  return 1;
}

export function easeOutCubic(t) {
  return 1 - Math.pow(1 - t, 3);
}

export function easeInOutCubic(t) {
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
}
