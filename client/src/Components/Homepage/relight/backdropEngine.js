import { visitId } from '../../../utils/visit';

import {
  AdaptiveQuality,
  MIN_FPS,
  NETWORKS,
  firstBudget,
  firstNetwork,
  firstTier,
  gpuName,
  loadProfile,
  measuredCosts,
  seedCosts,
  tunedKernel,
} from './adaptiveQuality';
import { NATIVE, bandBytesFor, createRelightEngine, loadRoom, prepareFill, takePreparedRelight } from './prepare';
import { requestRelightDevice } from './RelightGPU';
import { FILL, fillMatches } from './lightWork';
import { INTRO_FROM, KEY } from './keyAim';
import { forgetImage, makeLight } from './lightSchedule';
import { buildEngine, withTexture } from './presentation';
import { createSpares } from './spares';
import { publishStatus, saveState } from './backdropStatus';
import { reportRelight } from './report';
import { setRelightStatus } from './status';

const MAX_DPR = { compact: 1.5, full: 2 };
const UPGRADE_FILL_MS = 250;

function finite(value, fallback) {
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

export function createBackdropState(renderer, compact, webgl) {
  const gpu = gpuName(renderer.getContext());
  const fps = MIN_FPS;
  const profile = loadProfile(gpu, fps, webgl || !navigator.gpu ? 'webgl' : 'webgpu');
  const device = window.devicePixelRatio || 1;
  return {
    engine: null,
    built: null,
    layer: null,
    host: null,
    gpuLayerFailed: false,
    glassStale: false,
    glassAt: -Infinity,
    device: null,
    notGPU: null,
    publishedAt: -Infinity,
    bandBytes: bandBytesFor(compact),
    readyAt: null,
    reported: false,
    progress: 0,
    box: { left: 0, top: 0, size: 1 },
    view: [0, 1, 0, 1],
    drawn: null,
    pointer: null,
    card: { el: null, uv: null },
    key: makeLight(INTRO_FROM, KEY, 0),
    fill: makeLight(FILL.pos, FILL, 1),
    spares: [],
    pendingJump: null,
    handoffs: 0,
    maxAnimatedStep: 0,
    maxMotionStep: 0,
    maxMotionBlend: 0,
    maxKeyImages: 0,
    targetsAt: -Infinity,
    lastLevels: null,
    panel: null,
    hero: null,
    heroCache: { vw: 0, vh: 0, size: 0, y: 0 },
    uniformSig: '',
    sceneVersion: 0,
    scrollY: 0,
    scrolledAt: -Infinity,
    gpu,
    fps,
    capped: true,
    lightingUpdates: 0,
    refinementUpdates: 0,
    fillPrepared: false,
    profile,
    fromProfile: !!profile,
    savedAt: 0,
    tier: firstTier(profile, compact),
    network: firstNetwork(profile),
    prepared: null,
    visit: visitId(),
    upgrading: null,
    tuning: false,
    benching: false,
    tuneController: new AbortController(),
    upgradeFailed: false,
    upgradeCheckedAt: 0,
    configChangedAt: -Infinity,
    now: 0,
    shownPx: 0,
    roomDpr: 1,
    quality: new AdaptiveQuality({
      budget: firstBudget(profile, compact),
      dpr: finite(profile?.dpr, compact ? 1 : Math.min(device, 1.5)),
      dprRange: [1, Math.max(1, Math.min(device, compact ? MAX_DPR.compact : MAX_DPR.full))],
      failedDpr: finite(profile?.failedDpr, Infinity),
      minFps: fps,
    }),
  };
}

export function deviceFor(state, onLost, requested = null) {
  if (!state.device) {
    state.device = (requested || requestRelightDevice())
      .catch((error) => {
        state.notGPU = error.message;
        return null;
      })
      .then((device) => {
        device?.lost.then((info) => {
          if (info.reason !== 'destroyed') {
            console.warn('Relight backdrop lost its WebGPU device:', info.message);
            state.notGPU = `its WebGPU device was lost (${info.message || info.reason})`;
            onLost();
          }
        });
        return device;
      });
  }
  return state.device;
}

export function releaseDevice(state) {
  const device = state.device;
  state.device = null;
  device?.then((d) => d?.destroy());
}

export function failRelight(state, error, onFail) {
  if (error?.name === 'AbortError') {
    return;
  }
  console.warn('Relight backdrop unavailable:', error);
  setRelightStatus({ phase: 'failed', reason: error?.message || String(error) });
  reportRelight({ phase: 'failed', reason: error?.message || String(error), gpu: state.gpu }, state.visit);
  onFail?.();
}

function loadRoomWithFallback(state, signal) {
  return loadRoom(state.tier, signal, undefined, state.network).catch((error) => {
    if (error?.name === 'AbortError' || (state.tier === NATIVE && state.network === NETWORKS[0])) {
      throw error;
    }
    state.tier = NATIVE;
    state.network = NETWORKS[0];
    return loadRoom(NATIVE, signal);
  });
}

async function buildFresh(state, { webgl, signal, onDeviceLost }) {
  const [device, data] = await Promise.all([
    webgl ? null : deviceFor(state, onDeviceLost),
    loadRoomWithFallback(state, signal),
  ]);
  const kernel = tunedKernel(state.profile, state.network, device ? 'webgpu' : 'webgl');
  const built = await createRelightEngine(data, device, state.bandBytes, signal, kernel);
  built.engine.tuned = !!kernel && built.engine.kernelName === kernel;
  seedCosts(built.engine, state.profile);
  return built;
}

function adoptPrepared(state, prepared, onDeviceLost) {
  if (prepared.device) {
    deviceFor(state, onDeviceLost, prepared.device);
  }
  state.tier = prepared.tier;
  state.network = prepared.network;
  state.prepared = prepared.timed ? 'timed' : 'built';
  state.upgradeFailed = prepared.upgradeFailed;
}

export async function startRelight(state, uniforms, options) {
  const { signal, onDeviceLost } = options;
  const prepared = await takePreparedRelight();
  if (prepared?.error) {
    throw prepared.error;
  }
  if (prepared) {
    adoptPrepared(state, prepared, onDeviceLost);
  }
  const built = withTexture(prepared || (await buildFresh(state, options)));
  if (signal.aborted) {
    built.dispose();
    prepared?.upgrade?.controller.abort();
    return;
  }
  if (built.notGPU) {
    state.notGPU = built.notGPU;
  }
  install(state, built, uniforms);
  publishStatus(state);
  if (prepared?.upgrade) {
    startUpgrade(state, uniforms, prepared.upgrade, prepared.upgrade);
  }
}

export function stopRelight(state, uniforms) {
  state.tuneController.abort();
  state.upgrading?.abort();
  state.upgrading = null;
  saveState(state);
  state.built?.dispose();
  state.built = null;
  state.engine = null;
  state.readyAt = null;
  uniforms.tRelight.value = null;
}

export function startUpgrade(state, uniforms, { tier, network }, pending = null) {
  const controller = pending?.controller || new AbortController();
  const { signal } = controller;
  state.upgrading = controller;
  const device = state.engine.backend === 'webgpu' ? state.device : null;
  const kernel = network === state.network && state.engine.tuned ? state.engine.kernelName : null;
  const discard = (built) => {
    if (signal.aborted || !state.engine) {
      built.dispose();
      return true;
    }
    return false;
  };
  Promise.all([device, pending?.data || loadRoom(tier, signal, undefined, network)])
    .then(([gpu, data]) => buildEngine(data, gpu, state.bandBytes, signal, kernel))
    .then(async (built) => {
      built.engine.tuned = !!kernel;
      if (discard(built)) {
        return;
      }
      seedCosts(built.engine, measuredCosts(state.engine));
      try {
        await prepareFill(built, { signal, budget: state.quality.budget, maxMs: UPGRADE_FILL_MS });
      } catch (error) {
        built.dispose();
        throw error;
      }
      if (discard(built)) {
        return;
      }
      install(state, built, uniforms);
      state.tier = tier;
      state.network = network;
    })
    .catch((error) => {
      if (error?.name !== 'AbortError') {
        console.warn(`Relight backdrop staying at ${state.tier} px (${state.network}):`, error);
        state.upgradeFailed = true;
      }
    })
    .finally(() => {
      if (state.upgrading === controller) {
        state.upgrading = null;
      }
    });
}

export function install(state, built, uniforms) {
  if (state.engine) state.configChangedAt = state.now;
  state.tuneController.abort();
  state.tuneController = new AbortController();
  state.built?.dispose();
  state.built = built;
  state.engine = built.engine;
  uniforms.tRelight.value = built.texture;
  uniforms.texSize.value.set(built.engine.W, built.engine.H);
  forgetImage(state.key, 0);
  forgetImage(state.fill, 1);
  const fillUsable = fillMatches(built.fill, built.engine);
  if (fillUsable) {
    const preparedFill = { ...built.fill };
    delete preparedFill.engine;
    Object.assign(state.fill, preparedFill);
  }
  state.fillPrepared = fillUsable && !!built.fill.evalPos;
  state.spares = createSpares(built.engine, state.fill.slot);
  state.targetsAt = -Infinity;
  state.pendingJump = null;
  state.lastLevels = null;
  state.glassStale = false;
  state.drawn = null;
}
