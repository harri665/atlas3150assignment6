import { clamp } from './util';

export const MIN_FPS = 24;
const TIMER_SLACK_MS = 2;
const DELIVERY_SLACK_MS = 1000 / 60 + TIMER_SLACK_MS;
const MAX_GAP_S = 0.25;
const WORK_FRAMES = 2;
const RATE_ALPHA = 0.05;
const BLAME = 0.03;

const BUDGET_MIN = 1;
const BUDGET_SHARE = 0.7;
const DEFAULT_BUDGET_MAX = (1000 / MIN_FPS) * BUDGET_SHARE;
const START_BUDGET = { compact: 7, full: 7 };
const CEILING_SHARE = 0.9;
const GROW = 1.02;
const BACK_OFF = 0.75;
const CREEP = 1.0005;

const DPR_WINDOW_MS = 3000;
const DPR_STEP = 0.25;
const DPR_DROP = 0.2;
const DPR_KEEP = 0.02;
const DPR_GOOD_WINDOWS = 2;
const DPR_SETTLE_MS = 500;

export const TIERS = [384, 512, 768];
export const REFINE_MS = 1500;
const REFINE_UPDATES = (REFINE_MS * MIN_FPS) / 1000;
const UPGRADE_MS = 500;
const UPGRADE_UPDATES = (UPGRADE_MS * MIN_FPS) / 1000;
const LARGEST_TIER_MIN_MEMORY_GB = 4;
const DOWNGRADE_COST_MARGIN = 1.25;
const PRESSURED_LATE_RATE = 0.2;
const TIER_DOWN_MS = 3000;
const TIER_UP_MS = 6000;
const TIER_COOLDOWN_MS = 15000;

export const NETWORKS = ['128x4', '64x4'];
const SMALL_SPEEDUP = 3.3;
const RECLAIM_SHARE = 0.5;

const STORAGE_KEY = 'relight-quality';
export const PROFILE_VERSION = 2;
export const ENGINE_VERSION = 'relight-24-full-refinement-v1';
const MAX_AGE = 30 * 24 * 3600 * 1000;
const VIEWPORT_BUCKET_PX = 200;
const SEEDED_COST_MARGIN = 1.15;
let profileCleared = false;

export class AdaptiveQuality {
  constructor({ budget, dpr, dprRange, failedDpr = Infinity, minFps = MIN_FPS }) {
    this.lateMs = 1000 / minFps + DELIVERY_SLACK_MS;
    this.budgetMax = (1000 / minFps) * BUDGET_SHARE;
    this.frameNo = 0;
    this.lastWork = -Infinity;
    this.budget = clamp(budget, BUDGET_MIN, this.budgetMax);
    this.ceiling = Infinity;
    [this.dprMin, this.dprMax] = dprRange;
    this.dpr = clamp(dpr, this.dprMin, this.dprMax);
    this.failedDpr = failedDpr;
    this.lateRate = { work: 0, idle: 0 };
    this.window = { ms: 0, lateMs: 0, good: 0, settle: 0 };
    this.stats = { frames: 0, seconds: 0, late: 0 };
    this.tierCheck = { key: null, upSince: null, downSince: null, changedAt: -Infinity };
  }

  frame(delta, settled, hold = false, schedule = null) {
    this.frameNo += 1;
    if (!(delta > 0) || delta > MAX_GAP_S || hold || schedule?.resumed) {
      this.resetTierDwell();
      return null;
    }
    const workedRecently = this.frameNo - this.lastWork <= WORK_FRAMES;
    const late = this.isLate(delta, schedule);
    this.stats.frames += 1;
    this.stats.seconds += delta;
    this.stats.late += late ? 1 : 0;
    const rates = this.lateRate;
    const kind = workedRecently ? 'work' : 'idle';
    if (settled) {
      rates[kind] += RATE_ALPHA * ((late ? 1 : 0) - rates[kind]);
    }

    if (workedRecently && late && settled && this.workIsToBlame()) {
      this.ceiling = this.budget * CEILING_SHARE;
      this.budget *= BACK_OFF;
    } else if (workedRecently && !late) {
      this.ceiling *= CREEP;
      this.budget = Math.min(this.ceiling, this.budget * GROW);
    }
    this.budget = clamp(this.budget, BUDGET_MIN, this.budgetMax);

    return settled && (!workedRecently || this.dpr > this.dprMin)
      ? this.judgeDpr(late, delta * 1000, !workedRecently)
      : null;
  }

  isLate(delta, schedule) {
    if (!Number.isFinite(schedule?.missedSlots)) {
      return delta * 1000 > this.lateMs;
    }
    return schedule.missedSlots > 0 || (
      Number.isFinite(schedule.latenessMs) && Number.isFinite(schedule.refreshMs) &&
      schedule.latenessMs > schedule.refreshMs + TIMER_SLACK_MS
    );
  }

  workIsToBlame() {
    return this.lateRate.work > this.lateRate.idle + BLAME;
  }

  worked() {
    this.lastWork = this.frameNo;
  }

  resetTierDwell() {
    this.tierCheck.upSince = null;
    this.tierCheck.downSince = null;
  }

  nextTier(engine, shownPx, nowMs) {
    if (!Number.isFinite(nowMs) || engine.timing.seeded) {
      return null;
    }
    const check = this.tierCheck;
    const key = `${engine.W}:${networkKey(engine)}:${engine.backend}`;
    if (check.key !== key) {
      check.key = key;
      this.resetTierDwell();
    }
    if (nowMs - check.changedAt < TIER_COOLDOWN_MS) {
      return null;
    }
    const cost = engine.evalCost(1);
    if (cost === null) {
      return null;
    }
    const i = TIERS.indexOf(engine.W);
    const tooSlow = i > 0 && cost > this.budget * REFINE_UPDATES * DOWNGRADE_COST_MARGIN;
    const pressured = i > 0 && this.lateRate.work > PRESSURED_LATE_RATE && this.workIsToBlame();
    check.downSince = tooSlow || pressured ? check.downSince ?? nowMs : null;
    const up = upgradeTier(engine, this.budget, shownPx);
    check.upSince = up && !tooSlow && !pressured ? check.upSince ?? nowMs : null;
    const next = check.downSince !== null && nowMs - check.downSince >= TIER_DOWN_MS
      ? TIERS[i - 1]
      : check.upSince !== null && nowMs - check.upSince >= TIER_UP_MS ? up : null;
    if (next) {
      check.changedAt = nowMs;
      this.resetTierDwell();
    }
    return next;
  }

  judgeDpr(late, elapsedMs, allowUp = true) {
    const w = this.window;
    if (w.settle > 0) {
      w.settle -= elapsedMs;
      return null;
    }
    w.ms += elapsedMs;
    w.lateMs += late ? elapsedMs : 0;
    if (w.ms < DPR_WINDOW_MS) {
      return null;
    }
    const rate = w.lateMs / w.ms;
    w.ms = 0;
    w.lateMs = 0;

    let next = this.dpr;
    if (rate > DPR_DROP) {
      w.good = 0;
      if (this.dpr > this.dprMin) {
        this.failedDpr = Math.min(this.failedDpr, this.dpr);
        next = Math.max(this.dprMin, this.dpr - DPR_STEP);
      }
    } else if (allowUp && rate < DPR_KEEP) {
      w.good += 1;
      const up = Math.min(this.dprMax, this.dpr + DPR_STEP);
      if (w.good >= DPR_GOOD_WINDOWS && up > this.dpr && up < this.failedDpr) {
        next = up;
        w.good = 0;
      }
    } else {
      w.good = 0;
    }
    if (next === this.dpr) {
      return null;
    }
    this.dpr = next;
    w.settle = DPR_SETTLE_MS;
    return next;
  }
}

const startBudget = (compact) => (compact ? START_BUDGET.compact : START_BUDGET.full);

export function firstTier(profile, compact) {
  if (TIERS.includes(profile?.tier)) {
    return profile.tier;
  }
  return compact || slowConnection() ? TIERS[0] : TIERS[1];
}

export function firstBudget(profile, compact) {
  const budget = profile?.budget;
  if (Number.isFinite(budget) && budget > 0) {
    return clamp(budget, startBudget(compact), DEFAULT_BUDGET_MAX);
  }
  return startBudget(compact);
}

export function upgradeTier(engine, budget, shownPx) {
  const next = TIERS[TIERS.indexOf(engine.W) + 1];
  const cost = engine.evalCost(1);
  if (!next || cost === null || engine.timing.seeded || slowConnection()) {
    return null;
  }
  if (next > TIERS[1] && navigator.deviceMemory && navigator.deviceMemory < LARGEST_TIER_MIN_MEMORY_GB) {
    return null;
  }
  if (shownPx <= engine.W) {
    return null;
  }
  return cost * (next / engine.W) ** 2 <= budget * UPGRADE_UPDATES ? next : null;
}

export function firstNetwork(profile) {
  return NETWORKS.includes(profile?.network) ? profile.network : NETWORKS[0];
}

export function tunedKernel(profile, network, backend = null) {
  return profile?.network === network && (!backend || profile.backend === backend)
    ? profile.kernel ?? null : null;
}

export function switchNetwork(engine, budget) {
  const cost = engine.evalCost(1);
  const i = NETWORKS.indexOf(networkKey(engine));
  if (cost === null || engine.timing.seeded || i < 0) {
    return null;
  }
  const refinesWithin = (fullCost, share) => fullCost <= budget * REFINE_UPDATES * share;
  if (i === 0 && !refinesWithin(cost, 1)) {
    return NETWORKS[1];
  }
  if (i === 1 && refinesWithin(cost * SMALL_SPEEDUP, RECLAIM_SHARE)) {
    return NETWORKS[0];
  }
  return null;
}

function slowConnection() {
  const c = navigator.connection;
  return !!c && (c.saveData || /(^|-)[23]g$/.test(c.effectiveType || ''));
}

function viewportScale() {
  const w = window.innerWidth || 1;
  const h = window.innerHeight || 1;
  return {
    width: Math.round(w / VIEWPORT_BUCKET_PX),
    height: Math.round(h / VIEWPORT_BUCKET_PX),
    dpr: Math.round((window.devicePixelRatio || 1) * 2) / 2,
  };
}

export function gpuName(gl) {
  const plain = String(gl.getParameter(gl.RENDERER));
  if (!/^webkit/i.test(plain)) {
    return plain;
  }
  const ext = gl.getExtension('WEBGL_debug_renderer_info');
  return ext ? String(gl.getParameter(ext.UNMASKED_RENDERER_WEBGL)) : plain;
}

function networkKey(engine) {
  const net = engine.scene.network;
  return `${net.width}x${net.hidden}`;
}

export function seedCosts(engine, measured) {
  if (
    !measured?.byStride ||
    measured.network !== networkKey(engine) ||
    measured.backend !== engine.backend ||
    !(measured.res > 0)
  ) {
    return;
  }
  const areaScale = (engine.W / measured.res) ** 2;
  const byStride = {};
  Object.entries(measured.byStride).forEach(([stride, ms]) => {
    if (Number.isFinite(ms) && ms > 0) {
      byStride[stride] = ms * Math.max(1, areaScale) * SEEDED_COST_MARGIN;
    }
  });
  engine.seedTiming(byStride);
}

export function measuredCosts(engine) {
  return {
    res: engine.W,
    network: networkKey(engine),
    backend: engine.backend,
    byStride: { ...engine.timing.byStride },
  };
}

export function profileFor(gpu, fps, engine, quality) {
  if (!engine || engine.timing.seeded || !Object.keys(engine.timing.byStride).length) {
    return null;
  }
  return {
    gpu,
    fps,
    version: PROFILE_VERSION,
    engineVersion: ENGINE_VERSION,
    viewport: viewportScale(),
    ...measuredCosts(engine),
    budget: quality.budget,
    dpr: quality.dpr,
    failedDpr: null,
    tier: engine.W,
    kernel: engine.tuned ? engine.kernelName : null,
  };
}

export function loadProfile(gpu, fps, backend = null) {
  if (profileCleared) {
    return null;
  }
  try {
    const profile = JSON.parse(window.localStorage.getItem(STORAGE_KEY));
    const fits = profile?.version === PROFILE_VERSION && profile.engineVersion === ENGINE_VERSION &&
      profile.gpu === gpu && profile.fps === fps &&
      (!backend || profile.backend === backend) &&
      JSON.stringify(profile.viewport) === JSON.stringify(viewportScale());
    const age = Date.now() - profile?.at;
    return fits && age >= 0 && age < MAX_AGE ? profile : null;
  } catch {
    return null;
  }
}

export function saveProfile(profile) {
  if (profileCleared) {
    return;
  }
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify({
      ...profile,
      version: PROFILE_VERSION,
      engineVersion: ENGINE_VERSION,
      viewport: viewportScale(),
      at: Date.now(),
    }));
  } catch {}
}

export function clearProfile() {
  try {
    window.localStorage.removeItem(STORAGE_KEY);
    profileCleared = true;
    return true;
  } catch {
    return false;
  }
}
