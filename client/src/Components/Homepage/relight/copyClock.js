export function advanceCopyClock(now, previous, interval) {
  if (!Number.isFinite(previous)) return now;
  return previous + Math.floor((now - previous + 1e-9) / interval) * interval;
}
