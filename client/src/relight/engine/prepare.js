import {
  MIN_FPS,
  NETWORKS,
  firstBudget,
  firstNetwork,
  firstTier,
  tunedKernel,
  gpuName,
  loadProfile,
  measuredCosts,
  seedCosts,
  switchNetwork,
  upgradeTier,
} from './adaptiveQuality';
import { RESOLVED } from './RelightBase';
import { createFill, fillStep } from './lightWork';
import { RelightEngine } from './RelightEngine';
import { RelightGPUEngine, requestRelightDevice } from './RelightGPU';
import { loadRelightScene } from './scene';
import { ROOM_MAX_DPR, clamp, isCompact, midLight, throwIfAborted, webglRequested } from './util';

export const NATIVE = 512;
const roomUrl = (network) => `${process.env.PUBLIC_URL}/relight/cornell-${network}`;
const tierSuffix = (tier) => (tier === NATIVE ? '' : `-${tier}`);

const BAND_BYTES = { compact: 16 << 20, full: 32 << 20 };
export const bandBytesFor = (compact) => (compact ? BAND_BYTES.compact : BAND_BYTES.full);
const SPARE_IMAGE_BYTES = { compact: 8 << 20, full: 32 << 20 };
const BYTES_PER_IMAGE_PIXEL = 12;
const MAX_SPARES = 6;

const BENCH_STRIDES = [1, 2, 4];
const COARSE_STRIDE = 8;
const BENCH_MAX_MS = 30;
const BENCH_RUNS = 3;
const BENCH_ATTEMPTS = 16;
const TUNE_MS = 24;
const TUNE_RUNS = { min: 2, max: 8 };
const FILL_STEP_MAX_MS = 8;

export function loadRoom(tier, signal, priority, network = NETWORKS[0]) {
  return loadRelightScene(roomUrl(network), signal, tierSuffix(tier), priority);
}

function imageCount(scene) {
  const spareBytes = isCompact() ? SPARE_IMAGE_BYTES.compact : SPARE_IMAGE_BYTES.full;
  const spares = spareBytes / (scene.width * scene.height * BYTES_PER_IMAGE_PIXEL);
  return RESOLVED + Math.min(MAX_SPARES, Math.floor(spares));
}

export async function createRelightEngine(data, device, bandBytes, signal, kernel = null) {
  let notGPU = null;
  const images = imageCount(data.scene);
  if (device) {
    try {
      return { engine: await RelightGPUEngine.create(device, data, { kernel, images }), notGPU };
    } catch (error) {
      if (signal.aborted) {
        throw error;
      }
      console.warn('Relight backdrop running on WebGL instead of WebGPU:', error);
      notGPU = `WebGPU couldn't build the network (${error.message})`;
    }
  }
  return { engine: new RelightEngine(data, { bandBytes, kernel, images }), notGPU };
}

let preparing = null;
let handedOff = false;

export function prepareRelight() {
  if (preparing || handedOff || navigator.connection?.saveData) {
    return;
  }
  const prep = {
    controller: new AbortController(),
    upgradeController: null,
    device: null,
    engine: null,
    claimed: false,
    settled: false,
    disposed: false,
  };
  prep.claim = new Promise((resolve) => {
    prep.onClaim = resolve;
  });
  prep.result = run(prep)
    .catch((error) => {
      if (prep.controller.signal.aborted) {
        disposePrepared(prep);
        return null;
      }
      return { error };
    })
    .finally(() => {
      prep.settled = true;
    });
  preparing = prep;
}

export function takePreparedRelight() {
  handedOff = true;
  const prep = preparing;
  preparing = null;
  if (!prep) {
    return Promise.resolve(null);
  }
  prep.claimed = true;
  prep.onClaim();
  return prep.result;
}

export function cancelPreparedRelight() {
  handedOff = false;
  const prep = preparing;
  preparing = null;
  if (!prep) {
    return;
  }
  prep.controller.abort();
  prep.upgradeController?.abort();
  if (prep.settled) {
    disposePrepared(prep);
  }
}

function disposePrepared(prep) {
  if (prep.disposed) {
    return;
  }
  prep.disposed = true;
  prep.engine?.dispose();
  prep.device?.then((device) => device.destroy()).catch(() => {});
}

async function run(prep) {
  const { signal } = prep.controller;
  const compact = isCompact();
  const webgl = webglRequested();
  const gpu = probeGpu();
  const profile = gpu ? loadProfile(gpu, MIN_FPS, webgl || !navigator.gpu ? 'webgl' : 'webgpu') : null;
  const bandBytes = bandBytesFor(compact);

  if (!webgl) {
    prep.device = requestRelightDevice();
    prep.device.catch(() => {});
  }
  const [device, { tier, network, data }] = await Promise.all([
    prep.device?.catch(() => null) ?? null,
    loadRoomOrNative(firstTier(profile, compact), firstNetwork(profile), signal),
  ]);
  const kernel = tunedKernel(profile, network, device ? 'webgpu' : 'webgl');
  const built = await createRelightEngine(data, device, bandBytes, signal, kernel);
  prep.engine = built.engine;
  throwIfAborted(signal);
  const { engine } = built;
  engine.tuned = !!kernel && engine.kernelName === kernel;
  seedCosts(engine, profile);
  const result = {
    engine,
    notGPU: built.notGPU,
    device: prep.device,
    tier,
    network,
    timed: false,
    upgrade: null,
    upgradeFailed: false,
  };

  result.timed = await timeAndTune(engine, prep);
  const budget = firstBudget(profile, compact);
  const fillOptions = { signal, budget, claimed: () => prep.claimed, claim: prep.claim };
  result.fill = await prepareFill(result, fillOptions);
  await upgradeUntilClaimed(prep, result, { device, bandBytes, budget, fillOptions });
  return result;
}

async function loadRoomOrNative(tier, network, signal) {
  try {
    return { tier, network, data: await loadRoom(tier, signal, 'low', network) };
  } catch (error) {
    if (error?.name === 'AbortError' || (tier === NATIVE && network === NETWORKS[0])) {
      throw error;
    }
    return { tier: NATIVE, network: NETWORKS[0], data: await loadRoom(NATIVE, signal, 'low') };
  }
}

function nextUpgrade({ engine, tier, network }, budget) {
  const other = switchNetwork(engine, budget);
  if (other) {
    return { tier, network: other };
  }
  const larger = upgradeTier(engine, budget, shownRoomPx());
  return larger ? { tier: larger, network } : null;
}

async function upgradeUntilClaimed(prep, result, { device, bandBytes, budget, fillOptions }) {
  const { signal } = prep.controller;
  let next = result.timed ? nextUpgrade(result, budget) : null;
  while (next && !prep.claimed) {
    const controller = new AbortController();
    prep.upgradeController = controller;
    const pending = loadRoom(next.tier, controller.signal, 'low', next.network);
    pending.catch(() => {});
    const arrived = await Promise.race([pending.then(() => true, () => true), prep.claim.then(() => false)]);
    throwIfAborted(signal);
    if (!arrived) {
      result.upgrade = { ...next, controller, data: pending };
      return;
    }
    prep.upgradeController = null;
    const { engine, tier, network } = result;
    let larger;
    try {
      const kernel = next.network === network && engine.tuned ? engine.kernelName : null;
      larger = await createRelightEngine(
        await pending,
        engine.backend === 'webgpu' ? device : null,
        bandBytes,
        signal,
        kernel
      );
      larger.engine.tuned = !!kernel;
    } catch (error) {
      throwIfAborted(signal);
      console.warn(`Relight backdrop staying at ${tier} px (${network}):`, error);
      result.upgradeFailed = true;
      return;
    }
    seedCosts(larger.engine, measuredCosts(engine));
    engine.dispose();
    prep.engine = larger.engine;
    throwIfAborted(signal);
    Object.assign(result, { engine: larger.engine, tier: next.tier, network: next.network });
    const timed = await timeAndTune(larger.engine, prep);
    result.fill = await prepareFill(result, fillOptions);
    next = timed ? nextUpgrade(result, budget) : null;
  }
}

export async function prepareFill(
  built,
  { signal, budget = FILL_STEP_MAX_MS, claimed = () => false, claim = null, maxMs = Infinity }
) {
  const { engine } = built;
  const fill = createFill(engine);
  built.fill = fill;
  const started = performance.now();
  while (!claimed() && !signal.aborted && fill.done < 1 && performance.now() - started < maxMs) {
    engine.beginFrame();
    let spent;
    try {
      spent = fillStep(engine, fill, Math.min(FILL_STEP_MAX_MS, budget), true);
    } finally {
      engine.endFrame();
    }
    if (!(spent > 0)) break;
    await yieldPreparation(signal, claim);
    engine.pollTiming();
  }
  throwIfAborted(signal);
  return fill;
}

function yieldPreparation(signal, claim) {
  return new Promise((resolve) => {
    let frame;
    const done = () => {
      cancelAnimationFrame(frame);
      signal.removeEventListener('abort', done);
      resolve();
    };
    frame = requestAnimationFrame(done);
    signal.addEventListener('abort', done, { once: true });
    claim?.then(done);
    if (signal.aborted) done();
  });
}

function finestBenchStride(engine) {
  return BENCH_STRIDES.find((stride) => engine.evalCost(stride) <= BENCH_MAX_MS) ?? COARSE_STRIDE;
}

async function timeAndTune(engine, prep) {
  const timed = await benchmark(engine, prep);
  await tuneUnlessClaimed(engine, prep);
  return timed;
}

async function tuneUnlessClaimed(engine, prep) {
  if (!prep.claimed) {
    await tuneEngine(engine, prep.controller.signal);
    throwIfAborted(prep.controller.signal);
  }
}

export async function tuneEngine(engine, signal = null, slot = 0) {
  const cost = engine.evalCost(1);
  if (engine.tuned || cost === null) {
    return;
  }
  const stride = finestBenchStride(engine);
  const runs = clamp(Math.ceil(TUNE_MS / engine.evalCost(stride)), TUNE_RUNS.min, TUNE_RUNS.max);
  await engine.tune(midLight(engine), stride, runs, signal, slot);
  if (!signal?.aborted) {
    engine.tuned = true;
  }
}

export function benchStride(engine) {
  const timedStrides = Object.keys(engine.timing.byStride).map(Number);
  if (!timedStrides.length) {
    return null;
  }
  const finest = finestBenchStride(engine);
  if (engine.timing.seeded) return finest;
  return finest < Math.min(...timedStrides) ? finest : null;
}

async function benchmark(engine, prep) {
  const { signal } = prep.controller;
  const light = midLight(engine);
  let stride = 0;
  let runs = 0;
  for (let i = 0; i < BENCH_ATTEMPTS && !prep.claimed; i += 1) {
    const measurable = !engine.timing.seeded && engine.evalCost(1) !== null;
    const finest = measurable ? finestBenchStride(engine) : COARSE_STRIDE;
    if (finest !== stride) {
      stride = finest;
      runs = 0;
    }
    if (runs >= BENCH_RUNS) {
      return true;
    }
    const before = engine.timing.byStride[stride];
    engine.evaluate(light, 0, stride);
    await awaitTiming(engine, prep);
    throwIfAborted(signal);
    if (!engine.timing.seeded && engine.timing.byStride[stride] !== before) {
      runs += 1;
    }
  }
  return !prep.claimed && !engine.timing.seeded && engine.evalCost(1) !== null;
}

async function awaitTiming(engine, prep) {
  do {
    await new Promise((resolve) => requestAnimationFrame(resolve));
    engine.pollTiming();
  } while (engine.timing.pending && !prep.claimed && !prep.controller.signal.aborted);
}

function probeGpu() {
  try {
    const canvas = document.createElement('canvas');
    const gl = canvas.getContext('webgl2') || canvas.getContext('webgl');
    if (!gl) {
      return null;
    }
    const name = gpuName(gl);
    gl.getExtension('WEBGL_lose_context')?.loseContext();
    return name;
  } catch {
    return null;
  }
}

function shownRoomPx() {
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const size = vw < 640 ? Math.min(vw * 1.2, vh * 0.6) : Math.min(vw * 0.9, vh * 0.86);
  return size * Math.min(window.devicePixelRatio || 1, ROOM_MAX_DPR);
}
