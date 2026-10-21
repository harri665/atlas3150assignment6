import * as THREE from 'three';

import { CARD_SELECTOR } from '../useCardLights';
import { NETWORKS, switchNetwork } from './adaptiveQuality';
import { benchStride, tuneEngine } from './prepare';
import { FILL, fillStep } from './lightWork';
import { HANDOFF_DISTANCE, TRUST_DISTANCE, dampedPosition, imageBlend, readyHandoff } from './lightMotion';
import { advanceCopyClock } from './copyClock';
import { CARD_DEPTH, INTRO_FROM, KEY, POINTER_DEPTH, REST, atDepth, keepInRoom } from './keyAim';
import { MOVE_EPS, atRest, converged, needsWork, shownLight, stepLight } from './lightSchedule';
import { adoptSpare, precomputeSpare, releaseSpare, retargetSpare, takeSpare } from './spares';
import { VIEW_GROW, VIEW_MARGIN, covers, grow, visibleRect } from './rect';
import { drawRoom, fitLayer, syncGlassScene } from './presentation';
import { publishStatus, reportRun, saveState } from './backdropStatus';
import { startUpgrade } from './backdropEngine';
import { PANEL_SELECTOR, coverSize, heroPlacement, walkInProgress } from './walkIn';
import { easeInOutCubic, easeOutCubic, strikeLevel } from './easing';
import { ROOM_MAX_DPR, clamp01, distance } from './util';

export const GLASS_EVERY = 0.05;
const BENCH_TRIES = 6;
const SCROLL_REST = 0.15;
const SAVE_EVERY = 5;
const PUBLISH_EVERY = 0.5;
const REPORT_AFTER = 10;
const FOCUSED_DAMPING = 6;
const FREE_DAMPING = 4;
const SCROLL_BUDGET_SHARE = 0.7;
const SPARE_BUDGET_SHARE = 0.5;
const SPARE_BUDGET_MAX_MS = 8;

export function renderBackdropFrame(input) {
  const { state, clock, size } = input;
  const now = clock.getElapsedTime();
  state.now = now;
  const f = { ...input, now, vw: size.width, vh: Math.max(size.height, 1) };
  const { uniforms, mesh, vw, vh } = f;

  const { progress, scrolling } = trackWalkIn(f);
  const walk = easeInOutCubic(progress);
  placeRoom(f, walk);
  f.updateLights(state.panel || document, size, f.delta);
  const age = adaptQuality(f);

  const { engine } = state;
  if (!engine) {
    uniforms.ready.value = 0;
    drawRoom(state, uniforms, mesh, vw, vh);
    return;
  }
  keepEngineCurrent(f, engine);
  upgradeWhenDue(f, engine, age);

  const aim = aimKey(f, engine, age);
  moveKey(f, engine, aim);
  if (calibrating(f, engine, aim, scrolling, age)) {
    drawRoom(state, uniforms, mesh, vw, vh);
    return;
  }

  const view = visibleRect(state.box, vw, vh);
  state.view = view;
  dropStaleJump(state, aim);
  if (f.reduceMotion) jumpWithoutMotion(f, aim, view);

  const { budget } = state.quality;
  engine.beginFrame();
  const { worked, changed } = scheduleWork(f, engine, aim, view, scrolling, budget);
  if (!worked && sparesWanted(state, scrolling, progress)) {
    precomputeSpare(state, engine, Math.min(budget * SPARE_BUDGET_SHARE, SPARE_BUDGET_MAX_MS), now, view, vw, vh, f.canHover);
  }
  const { keyLevel, fillLevel, levelsChanged } = lightLevels(f, age);
  if (worked) {
    state.quality.worked();
  }
  compositeAndPresent(f, engine, view, changed || levelsChanged, keyLevel, fillLevel);
  copyGlassOnCadence(f);
  placeGlow(f, engine, walk, keyLevel);
  uniforms.ready.value = clamp01(age / 0.5);
  state.layer?.draw(uniforms, vw, vh, state.roomDpr);
  engine.endFrame();
  syncGlassScene(state, uniforms, mesh);
  publishOnCadence(state, now, age);
}

function trackWalkIn({ state, now, delta, vh, onProgress }) {
  if (!state.panel?.isConnected) {
    state.panel = document.querySelector(PANEL_SELECTOR);
  }
  const target = state.panel ? walkInProgress(state.panel, vh) : clamp01(window.scrollY / vh);
  const previous = state.progress;
  let progress = THREE.MathUtils.damp(previous, target, 5, delta);
  if (Math.abs(progress - target) < 0.0005) {
    progress = target;
  }
  state.progress = progress;
  if (onProgress && progress !== previous) {
    onProgress(progress);
  }
  if (window.scrollY !== state.scrollY) {
    state.scrollY = window.scrollY;
    state.scrolledAt = now;
  }
  return { progress, scrolling: now - state.scrolledAt < SCROLL_REST };
}

function placeRoom({ state, uniforms, vw, vh, viewport }, walk) {
  const { lerp } = THREE.MathUtils;
  const [heroSize, heroY] = heroPlacement(state, vw, vh);
  const roomDpr = state.layer ? Math.min(window.devicePixelRatio || 1, ROOM_MAX_DPR) : viewport.dpr;
  state.roomDpr = roomDpr;
  const boxSize = lerp(heroSize, coverSize(vw, vh), walk);
  state.shownPx = boxSize * roomDpr;
  const centerY = lerp(heroY, vh * 0.5, walk);
  state.box = { left: vw / 2 - boxSize / 2, top: centerY - boxSize / 2, size: boxSize };

  uniforms.dpr.value = viewport.dpr;
  uniforms.viewport.value.set(vw, vh);
  uniforms.box.value.set(state.box.left, state.box.top, boxSize, lerp(0.14, 0.03, walk));
  uniforms.dim.value = lerp(0.72, 0.4, walk);
  uniforms.saturation.value = lerp(0.8, 0.55, walk);
  uniforms.hotKeep.value = lerp(1, 0.35, walk);
  uniforms.sharp.value = state.layer ? 0 : 1;
}

function adaptQuality({ state, now, delta, onDpr, frameInfo }) {
  const { engine, quality } = state;
  const age = engine && state.readyAt !== null ? now - state.readyAt : 0;
  const busy = !!state.upgrading || state.tuning || state.benching;
  const dpr = quality.frame(delta, age > 1.5, busy, frameInfo?.current);
  if (dpr !== null) {
    onDpr?.(dpr);
  }
  return age;
}

function keepEngineCurrent({ state, uniforms, now }, engine) {
  engine.pollTiming();
  fitLayer(state);
  uniforms.sharp.value = state.layer ? 0 : 1;
  if (!engine.timing.pending) {
    state.benching = false;
  }
  if (state.readyAt === null) {
    state.readyAt = now;
  }
  if (now - state.savedAt > SAVE_EVERY) {
    state.savedAt = now;
    saveState(state);
  }
}

function upgradeWhenDue({ state, uniforms, now }, engine, age) {
  const due = !state.upgrading && !state.tuning && age > 2 && now - state.configChangedAt > 15 && now - state.upgradeCheckedAt > 1;
  if (!due) {
    return;
  }
  state.upgradeCheckedAt = now;
  const { quality } = state;
  const requestedNetwork = switchNetwork(engine, quality.budget);
  const network = state.upgradeFailed && requestedNetwork === NETWORKS[0] ? null : requestedNetwork;
  const tier = network ? state.tier : quality.nextTier(engine, state.shownPx, now * 1000);
  if (tier && (!state.upgradeFailed || tier < state.tier || network === NETWORKS[1])) {
    startUpgrade(state, uniforms, { tier, network: network || state.network });
  }
}

function trackFocusedCard(state, canHover) {
  const card = state.panel
    ? state.panel.querySelector(canHover ? `${CARD_SELECTOR}:hover` : `${CARD_SELECTOR}[data-focus]`)
    : null;
  if (card === state.card.el) {
    return;
  }
  state.card.el = card;
  state.card.uv = null;
  if (card) {
    const r = card.getBoundingClientRect();
    const { left, top, size } = state.box;
    state.card.uv = [((r.left + r.right) / 2 - left) / size, ((r.top + r.bottom) / 2 - top) / size];
  }
}

function introAim(age) {
  const t = easeInOutCubic(clamp01((age - 0.35) / 1.05));
  return INTRO_FROM.map((v, i) => THREE.MathUtils.lerp(v, REST[i], t));
}

function aimKey({ state, canHover }, engine, age) {
  trackFocusedCard(state, canHover);
  let aim = REST;
  if (state.card.uv) {
    aim = atDepth(engine, state.card.uv, CARD_DEPTH);
  } else if (state.pointer) {
    aim = atDepth(engine, state.pointer, POINTER_DEPTH);
  }
  if (age < 1.4 && !state.pointer && !state.card.uv) {
    aim = introAim(age);
  }
  aim = [...aim];
  keepInRoom(engine, aim, state.key.radius);
  return aim;
}

function moveKey({ state, delta, reduceMotion }, engine, aim) {
  const { key } = state;
  const previousPos = key.pos;
  if (reduceMotion) {
    key.pos = state.pendingJump && key.evalPos ? [...key.evalPos] : [...aim];
  } else {
    key.pos = dampedPosition(key.pos, aim, state.card.uv ? FOCUSED_DAMPING : FREE_DAMPING, delta);
  }
  keepInRoom(engine, key.pos, key.radius);
  state.maxAnimatedStep = Math.max(state.maxAnimatedStep, distance(previousPos, key.pos));
}

function calibrating({ state, now }, engine, aim, scrolling, age) {
  const { key, fill } = state;
  if (state.tuning) {
    if (scrolling || !atRest(key) || (key.evalPos && distance(aim, key.evalPos) > MOVE_EPS)) {
      state.tuneController.abort();
    }
    return true;
  }
  const timed = engine.evalCost(1) !== null;
  const bench = timed && !engine.timing.pending && (engine.benchRuns ?? 0) < BENCH_TRIES ? benchStride(engine) : null;
  const settled = !scrolling && atRest(key) && atRest(fill);
  if (bench && age > 2 && settled && now - key.still > 0.5) {
    engine.benchRuns = (engine.benchRuns ?? 0) + 1;
    state.benching = true;
    engine.evaluate({ pos: key.evalPos, radius: key.radius }, fill.slot, bench);
    return true;
  }
  if (!engine.tuned && timed && age > 3 && settled && now - key.still > 1) {
    startTuning(state, engine);
    return true;
  }
  return false;
}

function startTuning(state, engine) {
  state.tuning = true;
  tuneEngine(engine, state.tuneController.signal, state.fill.slot)
    .catch((error) => {
      engine.tuned = true;
      console.warn('Relight backdrop tuning failed:', error);
    })
    .finally(() => {
      state.tuning = false;
      if (state.engine === engine) {
        publishStatus(state);
      }
    });
}

function dropStaleJump(state, aim) {
  if (state.pendingJump && distance(aim, state.pendingJump.spare.pos) > TRUST_DISTANCE) {
    releaseSpare(state.pendingJump.spare, state.fill.slot);
    state.pendingJump = null;
  }
}

function jumpWithoutMotion({ state, now }, aim, view) {
  const { key, spares } = state;
  const farJump = !state.pendingJump && key.evalPos && distance(aim, key.evalPos) > HANDOFF_DISTANCE;
  if (!farJump) {
    return;
  }
  const spare = readyHandoff(spares, aim, view, TRUST_DISTANCE);
  if (spare) {
    takeSpare(key, spare);
    state.handoffs += 1;
  } else if (spares.length) {
    const target = spares.find((s) => !s.ready) || spares[spares.length - 1];
    retargetSpare(target, [...aim], key.slot, now);
    state.pendingJump = { spare: target };
    key.pos = [...key.evalPos];
  }
}

function finishJump(state, target) {
  const { key } = state;
  target.ready = true;
  takeSpare(key, target);
  key.pos = [...key.evalPos];
  state.pendingJump = null;
  state.handoffs += 1;
}

function recordMotion(state) {
  const { key } = state;
  if (!key.evalPos) {
    return;
  }
  const moved = distance(key.pos, key.evalPos);
  if (moved > MOVE_EPS) {
    state.maxMotionStep = Math.max(state.maxMotionStep, moved);
    state.maxMotionBlend = Math.max(state.maxMotionBlend, imageBlend(moved));
  }
}

function scheduleWork({ state, now }, engine, aim, view, scrolling, budget) {
  const { key, fill } = state;
  const frameBudget = scrolling ? budget * SCROLL_BUDGET_SHARE : budget;
  const bootstrapFill = !fill.evalPos && !!key.evalPos;
  let left = frameBudget;
  let worked = false;
  let keyWorked = false;
  let jumpReady = false;
  if (!bootstrapFill && state.pendingJump) {
    const target = state.pendingJump.spare;
    left -= stepLight(engine, target, now, frameBudget, view, scrolling);
    if (converged(target)) {
      finishJump(state, target);
      jumpReady = true;
    }
    worked = true;
  } else if (!bootstrapFill && needsWork(key, scrolling, view)) {
    if (adoptSpare(key, state.spares, aim, view)) state.handoffs += 1;
    recordMotion(state);
    const keyBudget = fill.evalPos ? frameBudget : frameBudget / 2;
    left -= stepLight(engine, key, now, keyBudget, view, scrolling);
    worked = true;
    keyWorked = true;
  }
  const fillBudget = bootstrapFill ? frameBudget : left;
  const fillWorked = needsWork(fill, scrolling, view) && fillStep(engine, fill, fillBudget, !worked) > 0;
  if (fillWorked) {
    worked = true;
  }
  if (worked) {
    state.lightingUpdates += 1;
    if (key.refining) state.refinementUpdates += 1;
  }
  return { worked, changed: keyWorked || fillWorked || jumpReady };
}

function sparesWanted(state, scrolling, progress) {
  return (
    !state.pendingJump &&
    !scrolling &&
    !state.upgrading &&
    state.quality.lateRate.idle < 0.05 &&
    (progress > 0.3 || state.card.el) &&
    state.panel &&
    state.spares.length
  );
}

function lightLevels({ state, reduceMotion }, age) {
  const keyLevel = reduceMotion ? clamp01(age / 0.6) : strikeLevel(age);
  const fillLevel = easeOutCubic(clamp01((age - 0.2) / 1.4));
  const levels = `${keyLevel.toFixed(3)} ${fillLevel.toFixed(3)}`;
  const levelsChanged = levels !== state.lastLevels;
  if (levelsChanged) {
    state.lastLevels = levels;
  }
  return { keyLevel, fillLevel, levelsChanged };
}

function compositeAndPresent({ state, uniforms }, engine, view, dirty, keyLevel, fillLevel) {
  if (!dirty && covers(state.drawn, view)) {
    return;
  }
  const { key, fill } = state;
  state.drawn = grow(view, dirty ? VIEW_MARGIN : VIEW_GROW);
  const lights = key.evalPos ? [shownLight(key, KEY.intensity * keyLevel)] : [];
  state.maxKeyImages = Math.max(state.maxKeyImages, lights.length);
  if (fill.evalPos) lights.push(shownLight(fill, FILL.intensity * fillLevel));
  engine.composite(lights, 1, state.drawn);
  state.glassStale = state.built.present(state.layer, uniforms.texSize.value);
}

function copyGlassOnCadence({ state, uniforms, now }) {
  if (state.glassStale && now - state.glassAt + 1e-9 >= GLASS_EVERY) {
    state.glassStale = false;
    state.glassAt = advanceCopyClock(now, state.glassAt, GLASS_EVERY);
    state.built.copyGlass(uniforms.texSize.value);
  }
}

function placeGlow({ state, uniforms }, engine, walk, keyLevel) {
  const { key } = state;
  if (!key.evalPos) {
    return;
  }
  const p = engine.project(key.pos);
  const { left, top, size } = state.box;
  uniforms.glowAt.value.set(left + p.u * size, top + p.v * size, (key.radius / (p.z * 2 * engine.cam.tx)) * size);
  const glow = THREE.MathUtils.lerp(0.9, 0.45, walk) * keyLevel;
  uniforms.glowColor.value.set(KEY.color[0] * glow, KEY.color[1] * glow, KEY.color[2] * glow);
}

function publishOnCadence(state, now, age) {
  if (now - state.publishedAt > PUBLISH_EVERY) {
    state.publishedAt = now;
    publishStatus(state);
  }
  if (!state.reported && age > REPORT_AFTER) {
    state.reported = true;
    reportRun(state);
  }
}
