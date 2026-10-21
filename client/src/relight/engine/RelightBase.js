export const SLOTS = 4;
export const RESOLVED = 2;
export const NO_PHASE = [0, 0];
export const MIN_BAND_ROWS = 16;
export const LIGHT_INPUTS = 4;
export const GEO_INPUTS = 6;
const MIN_TIMED_SHARE = 0.25;
const WARMUP_SAMPLES = 2;
const SOFTWARE_CALIBRATION_SAMPLES = 3;
const SOFTWARE_TIMING_INTERVAL = 24;
const FIXED_COST_RESERVE = 0.15;
const DRAW_MARGIN = 2;
const POSITION_STEPS = 65534;
const DEFAULT_AUX_DIM = 7;
const BAYER_QUADRANT_RANK = [0, 2, 3, 1];

const PHASE_ORDERS = new Map();

function bayerRank(x, y, n) {
  if (n === 1) {
    return 0;
  }
  const h = n / 2;
  return 4 * bayerRank(x % h, y % h, h) + BAYER_QUADRANT_RANK[(y >= h) * 2 + (x >= h)];
}

export function phaseOrder(stride) {
  if (!PHASE_ORDERS.has(stride)) {
    const cells = [];
    for (let y = 0; y < stride; y += 1) {
      for (let x = 0; x < stride; x += 1) {
        cells.push([x, y]);
      }
    }
    PHASE_ORDERS.set(stride, cells.sort((a, b) => bayerRank(...a, stride) - bayerRank(...b, stride)));
  }
  return PHASE_ORDERS.get(stride);
}

export function readNetwork(net, layers) {
  const auxDim = net.aux_dim ?? DEFAULT_AUX_DIM;
  const geo = !!net.geo;
  const levels = net.grid_res.length;
  const pixelInputs = levels * net.feats + auxDim;
  const inputs = layers[0].shape[1];
  if (inputs !== pixelInputs + LIGHT_INPUTS + (geo ? GEO_INPUTS : 0)) {
    throw new Error(`unexpected first-layer width ${inputs}`);
  }
  return {
    width: net.width,
    hiddenLayers: net.hidden - 1,
    auxDim,
    geo,
    mul: net.head === 'mul',
    levels,
    pixelInputs,
    inputs,
  };
}

function smoothCost(previous, sample) {
  if (!previous) {
    return sample;
  }
  return sample < previous ? 0.5 * previous + 0.5 * sample : 0.9 * previous + 0.1 * sample;
}

export class RelightBase {
  constructor(scene, pos) {
    this.scene = scene;
    this.pos = pos;
    [this.posLo, this.posHi] = scene.pixels.pos.range;
    this.posStep = (this.posHi - this.posLo) / POSITION_STEPS;
    const W = scene.width;
    const H = scene.height;
    this.W = W;
    this.H = H;
    const M = scene.camera.to_world;
    const col = (j) => [M[0][j], M[1][j], M[2][j]];
    const tx = Math.tan((scene.camera.fov * Math.PI) / 360);
    this.cam = { X: col(0), Y: col(1), Z: col(2), O: col(3), tx, ty: (tx * H) / W };
    [this.lo, this.hi] = scene.light_bbox;
    [this.rmin, this.rmax] = scene.radius_range;
    this.timing = { byStride: {}, counts: {}, ticks: 0, samples: 0, pending: null, seeded: false };
  }

  rows(stride = 1) {
    return Math.ceil(this.H / stride);
  }

  cols(stride = 1) {
    return Math.ceil(this.W / stride);
  }

  share(stride, r0, r1, c0, c1) {
    return ((r1 - r0) * (c1 - c0)) / (this.rows(stride) * this.cols(stride));
  }

  span(stride, r0, r1, c0, c1) {
    return [c0 * stride, Math.min(this.W, c1 * stride), r0 * stride, Math.min(this.H, r1 * stride)];
  }

  drawRect(view) {
    if (!view) {
      return [0, this.W, 0, this.H];
    }
    const [u0, u1, v0, v1] = view;
    const { W, H } = this;
    return [
      Math.max(0, Math.floor(u0 * W) - DRAW_MARGIN),
      Math.min(W, Math.ceil(u1 * W) + DRAW_MARGIN),
      Math.max(0, Math.floor(v0 * H) - DRAW_MARGIN),
      Math.min(H, Math.ceil(v1 * H) + DRAW_MARGIN),
    ];
  }

  tapSigmaScale() {
    return (1.5 * 2 * this.cam.tx) / this.W;
  }

  timeable(stride, r0, r1, c0, c1, hardwareTimer = true) {
    const rows = this.rows(stride);
    const least = Math.min(1, Math.max(MIN_BAND_ROWS / rows, MIN_TIMED_SHARE));
    if (this.timing.pending || r1 - r0 < Math.min(rows, MIN_BAND_ROWS) || this.share(stride, r0, r1, c0, c1) < least) {
      return false;
    }
    const calibrated = (this.timing.counts?.[stride] || 0) >= SOFTWARE_CALIBRATION_SAMPLES;
    if (!hardwareTimer && !this.timing.seeded && calibrated) {
      this.timing.ticks = (this.timing.ticks || 0) + 1;
      return this.timing.ticks % SOFTWARE_TIMING_INTERVAL === 0;
    }
    return true;
  }

  recordTiming(stride, share, ms) {
    this.timing.samples += 1;
    if (ms === null || this.timing.samples <= WARMUP_SAMPLES) {
      return;
    }
    const fullGridMs = ms / share;
    if (this.timing.seeded) {
      this.timing.seeded = false;
      this.timing.byStride = {};
      this.timing.counts = {};
    }
    if (!this.timing.counts) {
      this.timing.counts = {};
    }
    this.timing.counts[stride] = (this.timing.counts[stride] || 0) + 1;
    const t = this.timing.byStride;
    t[stride] = smoothCost(t[stride], fullGridMs);
  }

  seedTiming(byStride) {
    const t = {};
    Object.entries(byStride || {}).forEach(([s, ms]) => {
      if (Number(s) >= 1 && Number.isFinite(ms) && ms > 0) {
        t[s] = ms;
      }
    });
    if (Object.keys(t).length) {
      this.timing.byStride = t;
      this.timing.counts = {};
      this.timing.seeded = true;
    }
  }

  evalCost(s) {
    const t = this.timing.byStride;
    if (Number.isFinite(t[s]) && t[s] > 0) {
      return t[s];
    }
    const pixelShare = 1 / (s * s);
    const nearest = Object.entries(t)
      .filter(([stride, ms]) => Number(stride) > 0 && Number.isFinite(ms) && ms > 0)
      .map(([stride, ms]) => ({ x: 1 / (Number(stride) ** 2), ms }))
      .sort((a, b) => Math.abs(a.x - pixelShare) - Math.abs(b.x - pixelShare))
      .slice(0, 2);
    if (!nearest.length) {
      return null;
    }
    const reserve = Math.min(...nearest.map((v) => v.ms)) * FIXED_COST_RESERVE;
    if (nearest.length === 2) {
      const [a, b] = nearest;
      const perPixel = (b.ms - a.ms) / (b.x - a.x);
      const fixed = a.ms - perPixel * a.x;
      if (perPixel < 0) {
        return Math.max(a.ms, b.ms);
      }
      if (Number.isFinite(perPixel) && fixed >= reserve) {
        return fixed + perPixel * pixelShare;
      }
    }
    return reserve + Math.max(...nearest.map((v) => v.ms / v.x)) * pixelShare;
  }

  async tune(light, stride, runs = 3, signal = null, slot = 0) {
    const timing = this.timing;
    this.timing = { ...timing, pending: {} };
    const times = {};
    let best = null;
    try {
      for (const candidate of this.tuneCandidates()) {
        if (signal?.aborted) {
          break;
        }
        const variant = await this.prepareVariant(candidate);
        if (!variant || signal?.aborted) {
          continue;
        }
        this.useVariant(variant);
        this.evaluate(light, slot, stride);
        await this.whenIdle();
        if (signal?.aborted) {
          break;
        }
        const t0 = performance.now();
        for (let i = 0; i < runs; i += 1) {
          this.evaluate(light, slot, stride);
        }
        await this.whenIdle();
        const ms = (performance.now() - t0) / runs;
        times[this.kernelName] = ms;
        if (!best || ms < best.ms) {
          best = { variant, ms };
        }
      }
    } finally {
      this.timing = timing;
    }
    if (best) {
      this.useVariant(best.variant);
    }
    this.afterTune();
    return { kernel: this.kernelName, times };
  }

  prepareVariant(candidate) {
    return candidate;
  }

  afterTune() {}

  normLight(l) {
    const { lo, hi } = this;
    return [0, 1, 2]
      .map((i) => (2 * (l.pos[i] - lo[i])) / (hi[i] - lo[i]) - 1)
      .concat([(2 * (l.radius - this.rmin)) / (this.rmax - this.rmin) - 1]);
  }

  project(p) {
    const { X, Y, Z, O, tx, ty } = this.cam;
    const v = [p[0] - O[0], p[1] - O[1], p[2] - O[2]];
    const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
    const zc = dot(v, Z);
    return { u: 0.5 - dot(v, X) / (zc * 2 * tx), v: 0.5 - dot(v, Y) / (zc * 2 * ty), z: zc };
  }

  unproject(u, v, zc) {
    const { X, Y, Z, O, tx, ty } = this.cam;
    const xc = (0.5 - u) * 2 * tx * zc;
    const yc = (0.5 - v) * 2 * ty * zc;
    return [0, 1, 2].map((i) => O[i] + X[i] * xc + Y[i] * yc + Z[i] * zc);
  }

  surfaceDistance(u, v) {
    const { O } = this.cam;
    const at = (x, y) => {
      const p = (clampInt(y, this.H) * this.W + clampInt(x, this.W)) * 4;
      if (!this.pos[p]) {
        return Infinity;
      }
      const d = [0, 1, 2].map((i) => this.posLo + (this.pos[p + i] - 1) * this.posStep - O[i]);
      return Math.hypot(d[0], d[1], d[2]);
    };
    const fx = u * this.W - 0.5;
    const fy = v * this.H - 0.5;
    const x0 = Math.floor(fx);
    const y0 = Math.floor(fy);
    const a = at(x0, y0);
    const b = at(x0 + 1, y0);
    const c = at(x0, y0 + 1);
    const d = at(x0 + 1, y0 + 1);
    if (![a, b, c, d].every(Number.isFinite)) {
      return at(Math.floor(u * this.W), Math.floor(v * this.H));
    }
    const sx = fx - x0;
    const sy = fy - y0;
    return (a * (1 - sx) + b * sx) * (1 - sy) + (c * (1 - sx) + d * sx) * sy;
  }
}

function clampInt(i, n) {
  return Math.min(n - 1, Math.max(0, i));
}
