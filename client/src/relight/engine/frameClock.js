const JITTER_MS = 0.25;
const RESUME_MS = 250;
const REFRESH_SAMPLES = 60;
const MIN_REFRESH_SAMPLES = 8;

function lowerQuartile(values) {
  const ordered = [...values].sort((a, b) => a - b);
  return ordered[Math.floor(ordered.length / 4)];
}

export class RelightFrameClock {
  constructor(fps = 24) {
    this.interval = 1000 / fps;
    this.deadline = null;
    this.lastCallback = null;
    this.lastDraw = null;
    this.resuming = false;
    this.refreshMs = 1000 / 60;
    this.callbackIntervals = [];
  }

  suspend() {
    this.deadline = null;
    this.lastCallback = null;
    this.lastDraw = null;
    this.resuming = true;
  }

  measureRefresh(gap) {
    this.callbackIntervals.push(gap);
    if (this.callbackIntervals.length > REFRESH_SAMPLES) this.callbackIntervals.shift();
    if (this.callbackIntervals.length >= MIN_REFRESH_SAMPLES) {
      this.refreshMs = lowerQuartile(this.callbackIntervals);
    }
  }

  step(timestamp) {
    if (!Number.isFinite(timestamp)) return null;
    const gap = this.lastCallback === null ? 0 : timestamp - this.lastCallback;
    if (gap < 0 || gap > RESUME_MS) this.suspend();
    if (gap > 0 && gap < RESUME_MS) this.measureRefresh(gap);
    this.lastCallback = timestamp;
    if (this.deadline === null) this.deadline = timestamp;
    if (timestamp + JITTER_MS < this.deadline) return null;

    const latenessMs = Math.max(0, timestamp - this.deadline);
    const missedSlots = Math.floor((latenessMs + JITTER_MS) / this.interval);
    const sample = {
      timestamp,
      deltaMs: this.lastDraw === null ? 0 : timestamp - this.lastDraw,
      latenessMs,
      missedSlots,
      refreshMs: this.refreshMs,
      resumed: this.resuming,
    };
    this.lastDraw = timestamp;
    this.resuming = false;
    const stalled = missedSlots || latenessMs > this.refreshMs + JITTER_MS;
    this.deadline = stalled ? timestamp + this.interval : this.deadline + this.interval;
    return sample;
  }
}
