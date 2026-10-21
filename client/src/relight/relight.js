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
  profileFor,
  saveProfile,
  seedCosts,
  switchNetwork,
  tunedKernel,
} from './engine/adaptiveQuality.js';
import { easeInOutCubic, easeOutCubic, strikeLevel } from './engine/easing.js';
import { RelightFrameClock } from './engine/frameClock.js';
import { INTRO_FROM, KEY, POINTER_DEPTH, REST, atDepth, keepInRoom } from './engine/keyAim.js';
import { dampedPosition } from './engine/lightMotion.js';
import { MOVE_EPS, atRest, converged, forgetImage, makeLight, needsWork, shownLight, stepLight } from './engine/lightSchedule.js';
import { FILL, fillMatches, fillStep, previewStride, refinementProgress } from './engine/lightWork.js';
import {
  NATIVE,
  bandBytesFor,
  benchStride,
  createRelightEngine,
  loadRoom,
  prepareFill,
  prepareRelight,
  takePreparedRelight,
  tuneEngine,
} from './engine/prepare.js';
import { VIEW_GROW, VIEW_MARGIN, areaOf, covers, grow } from './engine/rect.js';
import { requestRelightDevice } from './engine/RelightGPU.js';
import { GPURoomLayer, RoomLayer } from './engine/roomLayer.js';
import { setRelightStatus } from './engine/status.js';
import { ROOM_MAX_DPR, clamp01, distance, isCompact, webglRequested } from './engine/util.js';


const BENCH_TRIES = 6;
const SCROLL_REST = 0.15;
const SAVE_EVERY = 5;
const PUBLISH_EVERY = 0.5;
const REPORT_AFTER = 10;
const FREE_DAMPING = 4;
const SCROLL_BUDGET_SHARE = 0.7;
const UPGRADE_FILL_MS = 250;
const MAX_DPR = { compact: 1.5, full: 2 };
const HERO_LOOK = { dim: 0.72, saturation: 0.8, hotKeep: 1, feather: 0.14, glow: 0.9 };

// Starts fetching, building and timing the room before mountRelight, while the
// page does other things (engine/prepare)
export function preloadRelight() {
  prepareRelight();
}

export function mountRelight(host, options = {}) {
  if (new URLSearchParams(window.location.search).get('relight') === 'bench') {
    import('./engine/bench.js').then((m) => m.installBench());
    return { update() {}, dispose() {} };
  }
  if (options.interactive !== false) {
    host.style.touchAction = 'none';
  }
  // read each frame, so changing them doesn't rebuild the network
  const live = { current: options };
  const room = new RelightRoom(host, live);
  return {
    update(next) {
      live.current = { ...live.current, ...next };
    },
    dispose: () => room.dispose(),
  };
}

// ─── The room ──────────────────────────────────────────────────────────────

class RelightRoom {
  constructor(host, live) {
    this.host = host;
    this.live = live;
    // the room layers put their canvas in front of this
    this.marker = document.createElement('span');
    host.appendChild(this.marker);

    const media = (query, fallback) => window.matchMedia?.(query).matches ?? fallback;
    this.canHover = media('(hover: hover) and (pointer: fine)', true);
    this.reduceMotion = media('(prefers-reduced-motion: reduce)', false);
    const compact = isCompact();
    this.webgl = webglRequested();

    try {
      this.layer = placeLayer(new RoomLayer(this.marker));
    } catch (error) {
      this.fail(error);
      return;
    }
    const gpu = gpuName(this.layer.gl);
    const fps = MIN_FPS;
    const profile = loadProfile(gpu, fps, this.webgl || !navigator.gpu ? 'webgl' : 'webgpu');
    const device = window.devicePixelRatio || 1;
    Object.assign(this, {
      engine: null,
      built: null,
      gpuLayerFailed: false,
      device: null,
      notGPU: null,
      publishedAt: -Infinity,
      bandBytes: bandBytesFor(compact),
      readyAt: null,
      reported: false,
      box: { left: 0, top: 0, size: 1 },
      rect: null,
      view: [0, 1, 0, 1],
      drawn: null,
      pointer: null,
      key: makeLight(INTRO_FROM, KEY, 0),
      fill: makeLight(FILL.pos, FILL, 1),
      lastLevels: null,
      scrolledAt: -Infinity,
      gpu,
      fps,
      lightingUpdates: 0,
      refinementUpdates: 0,
      fillPrepared: false,
      profile,
      fromProfile: !!profile,
      savedAt: 0,
      tier: firstTier(profile, compact),
      network: firstNetwork(profile),
      prepared: null,
      upgrading: null,
      tuning: false,
      benching: false,
      tuneController: new AbortController(),
      controller: null,
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
      // what engine/roomLayer draws with: box is left, top, size (px), edge
      // feather (uv); glowAt is x, y, radius (px)
      uniforms: {
        texSize: { value: vec(1, 1) },
        box: { value: vec(0, 0, 1, 0.1) },
        ready: { value: 0 },
        dim: { value: 1 },
        saturation: { value: 1 },
        hotKeep: { value: 1 },
        glowAt: { value: vec() },
        glowColor: { value: vec() },
      },
      // the room updates at MIN_FPS, as on the portfolio
      clock: new RelightFrameClock(fps),
      t0: null,
      raf: 0,
      disposed: false,
    });
    live.current.onDpr?.(this.quality.dpr);

    this.onPageHide = () => this.save();
    window.addEventListener('pagehide', this.onPageHide);
    // The light follows the pointer. Its image position is fixed when it
    // moves, so scrolling alone leaves the light where it is.
    this.onPointer = (event) => {
      if (this.live.current.interactive === false) {
        return;
      }
      const touch = event.pointerType === 'touch' || !this.canHover;
      // a finger moves it only over the room, while down
      if (touch && (event.currentTarget === window || !event.buttons)) {
        return;
      }
      const r = this.host.getBoundingClientRect();
      const { left, top, size } = this.box;
      this.pointer = [(event.clientX - r.left - left) / size, (event.clientY - r.top - top) / size];
    };
    window.addEventListener('pointermove', this.onPointer, { passive: true });
    host.addEventListener('pointerdown', this.onPointer);
    host.addEventListener('pointermove', this.onPointer);

    this.start();
    this.raf = requestAnimationFrame(this.frame);
  }

  // ─── Building the network ──────────────────────────────────────────────

  // The WebGPU device, asked for once and kept across image sizes. A device
  // that's lost (a GPU reset, a driver update) hands over to WebGL.
  deviceFor(requested = null) {
    if (!this.device) {
      this.device = (requested || requestRelightDevice())
        .catch((error) => {
          this.notGPU = error.message;
          return null;
        })
        .then((device) => {
          device?.lost.then((info) => {
            if (info.reason !== 'destroyed' && !this.disposed) {
              console.warn('Relight lost its WebGPU device:', info.message);
              this.notGPU = `its WebGPU device was lost (${info.message || info.reason})`;
              this.webgl = true;
              this.start();
            }
          });
          return device;
        });
    }
    return this.device;
  }

  // Takes what preloadRelight readied, else loads the room and builds the
  // network, in place of any running
  start() {
    this.stop();
    const controller = new AbortController();
    this.controller = controller;
    const { signal } = controller;
    setRelightStatus({ phase: 'loading' });
    if (this.webgl && !this.notGPU) {
      this.notGPU = 'the page was asked for WebGL (?relight=webgl)';
    }
    if (navigator.connection?.saveData) {
      this.fail(new Error('data saver is on'));
      return;
    }
    this.run(signal).catch((error) => {
      if (!signal.aborted) {
        this.fail(error);
      }
    });
  }

  async run(signal) {
    const prepared = await takePreparedRelight();
    if (prepared?.error) {
      throw prepared.error;
    }
    if (prepared) {
      if (prepared.device) {
        this.deviceFor(prepared.device);
      }
      this.tier = prepared.tier;
      this.network = prepared.network;
      this.prepared = prepared.timed ? 'timed' : 'built';
      this.upgradeFailed = prepared.upgradeFailed;
    }
    const built = withPresent(prepared || (await this.buildFresh(signal)));
    if (signal.aborted) {
      built.dispose();
      prepared?.upgrade?.controller.abort();
      return;
    }
    if (built.notGPU) {
      this.notGPU = built.notGPU;
    }
    this.install(built);
    this.publish();
    if (prepared?.upgrade) {
      this.startUpgrade(prepared.upgrade, prepared.upgrade);
    }
  }

  async buildFresh(signal) {
    const [device, data] = await Promise.all([
      this.webgl ? null : this.deviceFor(),
      loadRoom(this.tier, signal, undefined, this.network).catch((error) => {
        if (error?.name === 'AbortError' || (this.tier === NATIVE && this.network === NETWORKS[0])) {
          throw error;
        }
        this.tier = NATIVE;
        this.network = NETWORKS[0];
        return loadRoom(NATIVE, signal);
      }),
    ]);
    const kernel = tunedKernel(this.profile, this.network, device ? 'webgpu' : 'webgl');
    const built = await createRelightEngine(data, device, this.bandBytes, signal, kernel);
    built.engine.tuned = !!kernel && built.engine.kernelName === kernel;
    seedCosts(built.engine, this.profile);
    return built;
  }

  // Stops the running network and anything being built
  stop() {
    this.controller?.abort();
    this.tuneController.abort();
    this.upgrading?.abort();
    this.upgrading = null;
    this.save(false);
    this.built?.dispose();
    this.built = null;
    this.engine = null;
    this.readyAt = null;
  }

  fail(error) {
    if (error?.name === 'AbortError' || this.disposed) {
      return;
    }
    console.warn('Relight unavailable:', error);
    const reason = error?.message || String(error);
    setRelightStatus({ phase: 'failed', reason });
    this.live.current.onStatus?.({ phase: 'failed', reason });
    this.live.current.onReport?.({ ...deviceInfo(), phase: 'failed', reason, gpu: this.gpu });
    this.live.current.onFail?.(error);
  }

  // Builds the room at `tier` px with `network` while the current one keeps
  // running, readies its fill light, then swaps it in. `pending`: a fetch of
  // it already on its way ({ controller, data }).
  startUpgrade({ tier, network }, pending = null) {
    const controller = pending?.controller || new AbortController();
    const { signal } = controller;
    this.upgrading = controller;
    const device = this.engine.backend === 'webgpu' ? this.device : null;
    const kernel = network === this.network && this.engine.tuned ? this.engine.kernelName : null;
    const discard = (built) => {
      if (signal.aborted || !this.engine) {
        built.dispose();
        return true;
      }
      return false;
    };
    Promise.all([device, pending?.data || loadRoom(tier, signal, undefined, network)])
      .then(async ([gpu, data]) => withPresent(await createRelightEngine(data, gpu, this.bandBytes, signal, kernel)))
      .then(async (built) => {
        built.engine.tuned = !!kernel;
        if (discard(built)) {
          return;
        }
        seedCosts(built.engine, measuredCosts(this.engine));
        try {
          await prepareFill(built, { signal, budget: this.quality.budget, maxMs: UPGRADE_FILL_MS });
        } catch (error) {
          built.dispose();
          throw error;
        }
        if (discard(built)) {
          return;
        }
        this.install(built);
        this.tier = tier;
        this.network = network;
      })
      .catch((error) => {
        if (error?.name !== 'AbortError') {
          console.warn(`Relight staying at ${this.tier} px (${this.network}):`, error);
          this.upgradeFailed = true;
        }
      })
      .finally(() => {
        if (this.upgrading === controller) {
          this.upgrading = null;
        }
      });
  }

  // Puts a built network in place of the one running (if any), with its
  // fill light if it came with one
  install(built) {
    if (this.engine) {
      this.configChangedAt = this.now;
    }
    this.tuneController.abort();
    this.tuneController = new AbortController();
    this.built?.dispose();
    this.built = built;
    this.engine = built.engine;
    forgetImage(this.key, 0);
    forgetImage(this.fill, 1);
    const fillUsable = fillMatches(built.fill, built.engine);
    if (fillUsable) {
      const preparedFill = { ...built.fill };
      delete preparedFill.engine;
      Object.assign(this.fill, preparedFill);
    }
    this.fillPrepared = fillUsable && !!built.fill.evalPos;
    this.lastLevels = null;
    this.drawn = null;
  }

  // On WebGPU the room is drawn on the network's own device, straight from
  // its image; on WebGL it's handed over as an ImageBitmap
  fitLayer() {
    const { engine, layer } = this;
    const gpu = engine.backend === 'webgpu' && !this.gpuLayerFailed;
    if (gpu && layer.device === engine.device) {
      layer.use(engine);
      return;
    }
    if (!gpu && !layer.device) {
      return;
    }
    let next;
    try {
      next = placeLayer(gpu ? new GPURoomLayer(this.marker, engine) : new RoomLayer(this.marker));
    } catch (error) {
      console.warn('Relight keeps its room layer:', error);
      this.gpuLayerFailed = true;
      return;
    }
    layer.dispose();
    this.layer = next;
  }

  // ─── The frame loop ────────────────────────────────────────────────────

  frame = (timestamp) => {
    this.raf = requestAnimationFrame(this.frame);
    if (document.hidden) {
      this.clock.suspend();
      return;
    }
    const sample = this.clock.step(timestamp);
    if (!sample) {
      return;
    }
    if (this.t0 === null) {
      this.t0 = timestamp;
    }
    this.tick((timestamp - this.t0) / 1000, sample);
  };

  tick(now, sample) {
    this.now = now;
    const delta = sample.deltaMs / 1000;
    const rect = this.host.getBoundingClientRect();
    const vw = Math.max(rect.width, 1);
    const vh = Math.max(rect.height, 1);
    const props = this.live.current;
    const look = { ...HERO_LOOK, ...props.look };
    const u = this.uniforms;

    // ── Where the image sits: framed whole, or filling the box
    const cover = props.fit === 'cover';
    const boxSize = cover ? Math.max(vw, vh) * 1.04 : Math.min(vw, vh);
    this.box = { left: vw / 2 - boxSize / 2, top: vh / 2 - boxSize / 2, size: boxSize };
    this.roomDpr = Math.min(window.devicePixelRatio || 1, ROOM_MAX_DPR);
    this.shownPx = boxSize * this.roomDpr;
    set(u.box.value, this.box.left, this.box.top, boxSize, cover ? Math.min(look.feather, 0.03) : look.feather);
    u.dim.value = look.dim;
    u.saturation.value = look.saturation;
    u.hotKeep.value = look.hotKeep;

    // The page counts as scrolling while the room moves on it
    if (!this.rect || rect.top !== this.rect.top || rect.left !== this.rect.left) {
      this.scrolledAt = now;
    }
    this.rect = rect;
    const scrolling = now - this.scrolledAt < SCROLL_REST;
    // Off screen, nothing runs
    const view = onScreen(this.box, rect);
    if (areaOf(view) === 0) {
      return;
    }

    const { engine, quality } = this;
    const age = engine && this.readyAt !== null ? now - this.readyAt : 0;
    const dpr = quality.frame(delta, age > 1.5, !!this.upgrading || this.tuning || this.benching, sample);
    if (dpr !== null) {
      props.onDpr?.(dpr);
    }
    const draw = () => this.layer.draw(u, vw, vh, this.roomDpr);
    if (!engine) {
      u.ready.value = 0;
      draw();
      return;
    }

    // ── Keep the engine current, and upgrade it when it's due
    engine.pollTiming();
    this.fitLayer();
    if (!engine.timing.pending) {
      this.benching = false;
    }
    if (this.readyAt === null) {
      this.readyAt = now;
    }
    if (now - this.savedAt > SAVE_EVERY) {
      this.savedAt = now;
      this.save(false);
    }
    this.upgradeWhenDue(engine, age);

    // ── Where the light wants to be: where it's held, else under the
    // pointer, else at rest, after dropping in from the ceiling
    const { key, fill } = this;
    let aim = REST;
    if (props.lightPos) {
      aim = props.lightPos;
    } else if (this.pointer) {
      aim = atDepth(engine, this.pointer, POINTER_DEPTH);
    } else if (age < 1.4) {
      const t = easeInOutCubic(clamp01((age - 0.35) / 1.05));
      aim = INTRO_FROM.map((v, i) => v + (REST[i] - v) * t);
    }
    aim = [...aim];
    keepInRoom(engine, aim, key.radius);
    key.pos = this.reduceMotion ? [...aim] : dampedPosition(key.pos, aim, FREE_DAMPING, delta);
    keepInRoom(engine, key.pos, key.radius);

    if (this.calibrating(engine, aim, scrolling, age)) {
      draw();
      return;
    }

    // ── Evaluate what changed and is on screen, within the frame budget
    this.view = view;
    engine.beginFrame();
    const { worked, changed } = this.scheduleWork(engine, view, scrolling, quality.budget);

    // Brightness is free: the key strikes on like a lamp, the fill fades up
    const keyLevel = this.reduceMotion ? clamp01(age / 0.6) : strikeLevel(age);
    const fillLevel = easeOutCubic(clamp01((age - 0.2) / 1.4));
    const levels = `${keyLevel.toFixed(3)} ${fillLevel.toFixed(3)}`;
    const levelsChanged = levels !== this.lastLevels;
    this.lastLevels = levels;
    if (worked) {
      quality.worked();
    }

    // ── Composite the part on screen when it changed, or scrolled past what
    // was drawn
    const dirty = changed || levelsChanged;
    if (dirty || !covers(this.drawn, view)) {
      this.drawn = grow(view, dirty ? VIEW_MARGIN : VIEW_GROW);
      const lights = key.evalPos ? [shownLight(key, KEY.intensity * keyLevel)] : [];
      if (fill.evalPos) {
        lights.push(shownLight(fill, FILL.intensity * fillLevel));
      }
      engine.composite(lights, 1, this.drawn);
      this.built.present(this.layer);
    }

    // A soft bloom around the key light's disc, which the tonemap flattens
    if (key.evalPos) {
      const p = engine.project(key.pos);
      const { left, top, size } = this.box;
      set(u.glowAt.value, left + p.u * size, top + p.v * size, (key.radius / (p.z * 2 * engine.cam.tx)) * size);
      const glow = look.glow * keyLevel;
      set(u.glowColor.value, KEY.color[0] * glow, KEY.color[1] * glow, KEY.color[2] * glow);
    }
    u.ready.value = clamp01(age / 0.5);
    draw();
    engine.endFrame();

    if (now - this.publishedAt > PUBLISH_EVERY) {
      this.publishedAt = now;
      this.publish();
    }
    if (!this.reported && age > REPORT_AFTER) {
      this.reported = true;
      this.report();
    }
  }

  // Once a second, whether the GPU is better served by the other network, else
  // by another image size
  upgradeWhenDue(engine, age) {
    const { now, quality } = this;
    const due =
      !this.upgrading && !this.tuning && age > 2 && now - this.configChangedAt > 15 && now - this.upgradeCheckedAt > 1;
    if (!due) {
      return;
    }
    this.upgradeCheckedAt = now;
    const requested = switchNetwork(engine, quality.budget);
    const network = this.upgradeFailed && requested === NETWORKS[0] ? null : requested;
    const tier = network ? this.tier : quality.nextTier(engine, this.shownPx, now * 1000);
    if (tier && (!this.upgradeFailed || tier < this.tier || network === NETWORKS[1])) {
      this.startUpgrade({ tier, network: network || this.network });
    }
  }

  // Times the network once more, or tunes how it runs on this GPU, while the
  // room rests. True if that took the frame.
  calibrating(engine, aim, scrolling, age) {
    const { key, fill, now } = this;
    if (this.tuning) {
      if (scrolling || !atRest(key) || (key.evalPos && distance(aim, key.evalPos) > MOVE_EPS)) {
        this.tuneController.abort();
      }
      return true;
    }
    const timed = engine.evalCost(1) !== null;
    const bench = timed && !engine.timing.pending && (engine.benchRuns ?? 0) < BENCH_TRIES ? benchStride(engine) : null;
    const settled = !scrolling && atRest(key) && atRest(fill);
    if (bench && age > 2 && settled && now - key.still > 0.5) {
      engine.benchRuns = (engine.benchRuns ?? 0) + 1;
      this.benching = true;
      engine.evaluate({ pos: key.evalPos, radius: key.radius }, fill.slot, bench);
      return true;
    }
    if (!engine.tuned && timed && age > 3 && settled && now - key.still > 1) {
      this.tuning = true;
      tuneEngine(engine, this.tuneController.signal, fill.slot)
        .catch((error) => {
          engine.tuned = true;
          console.warn('Relight tuning failed:', error);
        })
        .finally(() => {
          this.tuning = false;
          if (this.engine === engine) {
            this.publish();
          }
        });
      return true;
    }
    return false;
  }

  // The key light first, the fill gets what it leaves; half each until the
  // fill has an image, and all of it to the fill if the key has one and the
  // fill doesn't
  scheduleWork(engine, view, scrolling, budget) {
    const { key, fill, now } = this;
    const frameBudget = scrolling ? budget * SCROLL_BUDGET_SHARE : budget;
    const bootstrapFill = !fill.evalPos && !!key.evalPos;
    let left = frameBudget;
    let worked = false;
    let keyWorked = false;
    if (!bootstrapFill && needsWork(key, scrolling, view)) {
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
      this.lightingUpdates += 1;
      if (key.refining) {
        this.refinementUpdates += 1;
      }
    }
    return { worked, changed: keyWorked || fillWorked };
  }

  // ─── Readout and what's kept ───────────────────────────────────────────

  publish() {
    const status = this.statusOf();
    if (status) {
      setRelightStatus(status);
      this.live.current.onStatus?.(status);
    }
  }

  // Tells onReport what the room runs on, how many updates held the floor,
  // and the device
  report() {
    const status = this.statusOf();
    if (!status) {
      return;
    }
    const { frames, seconds, late } = this.quality.stats;
    this.live.current.onReport?.({
      ...deviceInfo(),
      ...status,
      frames,
      frameRate: seconds > 0 ? Math.round(frames / seconds) : null,
      latePct: frames ? Math.round((late / frames) * 1000) / 10 : null,
      runningSec: this.readyAt === null ? null : Math.round(seconds),
    });
  }

  // The portfolio's status fields (backdropStatus), less the glass, cards and
  // walk-in
  statusOf() {
    const { engine, quality, key, fill } = this;
    if (!engine) {
      return null;
    }
    const round1 = (x) => (x === null ? null : Number(x.toFixed(1)));
    return {
      phase: 'running',
      backend: engine.backend,
      notGPU: engine.backend === 'webgpu' ? null : this.notGPU,
      half: !!engine.half,
      size: engine.W,
      network: this.network,
      kernel: engine.kernelName ? `${engine.kernelName}${engine.tuned ? '' : ', untuned'}` : null,
      gpu: this.gpu,
      fps: this.fps,
      dpr: quality.dpr,
      budget: round1(quality.budget),
      cost: round1(engine.evalCost(1)),
      seeded: engine.timing.seeded,
      moving: previewStride(engine, quality.budget, areaOf(grow(this.view, VIEW_MARGIN))),
      resting: 1,
      roomDpr: this.roomDpr,
      shownPx: Math.round(this.shownPx),
      refining: refinementProgress(key, engine),
      converged: converged(key) && converged(fill),
      fillPrepared: this.fillPrepared,
      lightingUpdates: this.lightingUpdates,
      refinementUpdates: this.refinementUpdates,
      sceneUpdates: quality.stats.frames,
      missedFrames: quality.stats.late,
      fromProfile: this.fromProfile,
      prepared: this.prepared,
      upgrading: !!this.upgrading,
    };
  }

  // Keeps what this visit learned for the next, and as the page goes, reports
  // how it went (if it ran long enough to have reported once)
  save(going = true) {
    if (!this.quality) {
      return;
    }
    const profile = profileFor(this.gpu, this.fps, this.engine, this.quality);
    if (profile) {
      saveProfile(profile);
    }
    if (going && this.reported) {
      this.report();
    }
  }

  dispose() {
    if (this.disposed) {
      return;
    }
    cancelAnimationFrame(this.raf);
    window.removeEventListener('pagehide', this.onPageHide);
    window.removeEventListener('pointermove', this.onPointer);
    this.host.removeEventListener('pointerdown', this.onPointer);
    this.host.removeEventListener('pointermove', this.onPointer);
    if (this.quality) {
      this.save();
      this.stop();
    }
    this.disposed = true;
    const device = this.device;
    this.device = null;
    device?.then((d) => d?.destroy());
    this.layer?.dispose();
    this.marker.remove();
    setRelightStatus({ phase: 'idle' });
  }
}

// ─── Helpers ───────────────────────────────────────────────────────────────

// A built network ({ engine, notGPU, fill }) with present(layer), to call
// after each composite, and dispose()
function withPresent({ engine, notGPU, fill }) {
  return {
    engine,
    notGPU,
    fill,
    present: (layer) => {
      if (layer.device && layer.device === engine.device) {
        layer.setImage();
        return;
      }
      const image = engine.snapshot();
      layer.setImage(image);
      if (typeof ImageBitmap !== 'undefined' && image instanceof ImageBitmap) {
        image.close();
      }
    },
    dispose: () => engine.dispose(),
  };
}

// engine/roomLayer's canvas is fixed to the viewport on the portfolio; here
// it fills the host
function placeLayer(layer) {
  Object.assign(layer.canvas.style, { position: 'absolute', inset: '0', width: '100%', height: '100%', zIndex: 'auto' });
  return layer;
}

// The part of the image on screen, as image uv (u0, u1, v0, v1): the room is
// drawn in `box` (host CSS px) in a host at `rect` in the viewport
function onScreen(box, rect) {
  const x0 = Math.max(0, -rect.left);
  const x1 = Math.min(rect.width, window.innerWidth - rect.left);
  const y0 = Math.max(0, -rect.top);
  const y1 = Math.min(rect.height, window.innerHeight - rect.top);
  if (x1 <= x0 || y1 <= y0) {
    return [0, 0, 0, 0];
  }
  return [
    clamp01((x0 - box.left) / box.size),
    clamp01((x1 - box.left) / box.size),
    clamp01((y0 - box.top) / box.size),
    clamp01((y1 - box.top) / box.size),
  ];
}

// engine/roomLayer reads vector uniforms as three.js vectors do (x, y, z, w)
function vec(x = 0, y = 0, z = 0, w = 0) {
  return { x, y, z, w };
}

function set(v, x, y, z = 0, w = 0) {
  Object.assign(v, { x, y, z, w });
}

// The device, for onReport: its cores, memory and screen
function deviceInfo() {
  const dpr = window.devicePixelRatio || 1;
  return {
    cores: navigator.hardwareConcurrency,
    memory: navigator.deviceMemory,
    screen: `${window.screen.width}x${window.screen.height}@${Math.round(dpr * 100) / 100}`,
  };
}

function finite(value, fallback) {
  return Number.isFinite(value) && value > 0 ? value : fallback;
}
