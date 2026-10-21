import { profileFor, saveProfile } from './adaptiveQuality';
import { previewStride, refinementProgress } from './lightWork';
import { converged } from './lightSchedule';
import { VIEW_MARGIN, areaOf, grow } from './rect';
import { reportRelight } from './report';
import { setRelightStatus } from './status';

const EVERY_PIXEL = 1;

const round1 = (x) => (x === null ? null : Number(x.toFixed(1)));
const fixedOrNull = (x, digits) => (x == null ? null : Number(x.toFixed(digits)));

export function statusOf(state) {
  const { engine, quality } = state;
  if (!engine) {
    return null;
  }
  return {
    phase: 'running',
    progress: round1(state.progress),
    backend: engine.backend,
    notGPU: engine.backend === 'webgpu' ? null : state.notGPU,
    half: !!engine.half,
    size: engine.W,
    network: state.network,
    kernel: engine.kernelName ? `${engine.kernelName}${engine.tuned ? '' : ', untuned'}` : null,
    gpu: state.gpu,
    fps: state.fps,
    capped: state.capped,
    dpr: quality.dpr,
    budget: round1(quality.budget),
    cost: round1(engine.evalCost(1)),
    seeded: engine.timing.seeded,
    moving: previewStride(engine, quality.budget, areaOf(grow(state.view, VIEW_MARGIN))),
    resting: EVERY_PIXEL,
    fixedLayer: !!state.layer,
    roomDpr: state.roomDpr,
    shownPx: Math.round(state.shownPx),
    refining: refinementProgress(state.key, engine),
    preparingJump: !!state.pendingJump,
    maxKeyImages: state.maxKeyImages,
    maxAnimatedStep: Number(state.maxAnimatedStep.toFixed(3)),
    motionStep: fixedOrNull(state.key.lastMove, 3),
    motionBlend: fixedOrNull(state.key.lastAlpha, 2),
    maxMotionStep: Number(state.maxMotionStep.toFixed(3)),
    maxMotionBlend: Number(state.maxMotionBlend.toFixed(2)),
    handoffs: state.handoffs,
    sparesReady: state.spares.filter((spare) => spare.ready).length,
    spareCandidates: state.spares.filter((spare) => spare.rank < Infinity).length,
    converged: converged(state.key) && converged(state.fill),
    fillPrepared: state.fillPrepared,
    lightingUpdates: state.lightingUpdates,
    refinementUpdates: state.refinementUpdates,
    sceneUpdates: quality.stats.frames,
    measuredSeconds: quality.stats.seconds,
    missedFrames: quality.stats.late,
    fromProfile: state.fromProfile,
    prepared: state.prepared,
    upgrading: !!state.upgrading,
  };
}

export function publishStatus(state) {
  const status = statusOf(state);
  if (status) {
    setRelightStatus(status);
    if (typeof window.__relightObserve === 'function') window.__relightObserve(status);
  }
}

export function reportRun(state) {
  const status = statusOf(state);
  if (!status) {
    return;
  }
  const { frames, seconds, late } = state.quality.stats;
  reportRelight(
    {
      ...status,
      frames,
      frameRate: seconds > 0 ? Math.round(frames / seconds) : null,
      latePct: frames ? Math.round((late / frames) * 1000) / 10 : null,
      runningSec: state.readyAt === null ? null : Math.round(seconds),
    },
    state.visit
  );
}

export function saveState({ engine, gpu, fps, quality }) {
  const profile = profileFor(gpu, fps, engine, quality);
  if (profile) {
    saveProfile(profile);
  }
}
