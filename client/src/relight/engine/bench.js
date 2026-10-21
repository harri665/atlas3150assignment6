import { bandBytesFor, createRelightEngine, loadRoom } from './prepare';
import { phaseOrder } from './RelightBase';
import { requestRelightDevice } from './RelightGPU';
import { GPURoomLayer } from './roomLayer';
import { ROOM_MAX_DPR, clamp01, distance, fence, midLight } from './util';

const BAND_BYTES = bandBytesFor(false);
const WARM_UP_STRIDE = 8;
const FRAME_BATCH_MS = 100;
const MAX_FRAME_RUNS = 256;
const WALKED_IN_SCALE = 1.04;
const VIEW_MARGIN = 0.03;

let engine = null;
let device = null;
let webglPresenter = null;
let benchRoom = null;

function gpuIdle() {
  if (engine.backend === 'webgpu') {
    return engine.device.queue.onSubmittedWorkDone();
  }
  return fence(engine.gl);
}

function close() {
  benchRoom?.dispose();
  benchRoom = null;
  engine?.dispose();
  engine = null;
}

async function open({ tier = 512, backend = 'webgpu', network, kernel = null, bandBytes = BAND_BYTES } = {}) {
  close();
  const signal = new AbortController().signal;
  if (backend === 'webgpu' && !device) {
    device = await requestRelightDevice();
  }
  const data = await loadRoom(tier, signal, 'auto', network);
  const built = await createRelightEngine(data, backend === 'webgpu' ? device : null, bandBytes, signal, kernel);
  engine = built.engine;
  await warmUpShaders();
  return {
    backend: engine.backend,
    notGPU: built.notGPU,
    size: engine.W,
    half: !!engine.half,
    network: `${engine.scene.network.width}x${engine.scene.network.hidden}`,
    kernel: engine.kernelName,
  };
}

async function warmUpShaders() {
  engine.evaluate(midLight(engine), 0, WARM_UP_STRIDE);
  await gpuIdle();
  engine.pollTiming();
}

async function time({ stride = 1, n = 8, batches = 3, light = midLight(engine) } = {}) {
  const runs = [];
  for (let b = 0; b < batches; b += 1) {
    await gpuIdle();
    const t0 = performance.now();
    for (let i = 0; i < n; i += 1) {
      engine.evaluate(light, i % 2, stride);
    }
    await gpuIdle();
    runs.push((performance.now() - t0) / n);
    engine.pollTiming();
  }
  runs.sort((a, b) => a - b);
  return { ms: runs[runs.length >> 1], runs, items: engine.rows(stride) * Math.ceil(engine.W / stride) };
}

async function render({ lights, stride = 1, exposure = 1, rect = [] }) {
  const shown = lights.map((l, i) => {
    engine.evaluate(l, i, stride, ...rect);
    return { pos: l.pos, radius: l.radius, color: [1, 1, 1], intensity: 1, slot: i, stride, hidden: false };
  });
  engine.composite(shown, exposure);
  return readImage();
}

async function accumulate({ from, to, frames = 16, stride = 8, trust = 0.06, accumulate = true, exposure = 1 }) {
  const all = [0, engine.rows(stride), 0, engine.cols(stride)];
  const order = phaseOrder(stride);
  let kept = null;
  let prev = null;
  for (let i = 0; i < frames; i += 1) {
    const t = frames > 1 ? i / (frames - 1) : 1;
    const light = { pos: from.map((v, k) => v + (to[k] - v) * t), radius: engine.rmin };
    const moved = prev ? distance(light.pos, prev) : Infinity;
    const alpha = accumulate && prev ? 1 - Math.exp(-moved / trust) : 1;
    const phase = accumulate ? order[i % order.length] : [0, 0];
    engine.evaluate(light, 0, stride, ...all, phase);
    kept = engine.resolve(0, 0, stride, phase, all, alpha, kept);
    prev = light.pos;
  }
  const light = { pos: to, radius: engine.rmin, color: [1, 1, 1], intensity: 1, hidden: false };
  engine.composite([{ ...light, resolved: 0 }], exposure);
  const got = await readImage();
  const ref = await render({ lights: [light], stride: 1, exposure });
  return { psnr: psnr(got.rgba, ref.rgba) };
}

async function frame({ stride = 4, n = 4, batches = 3, light = midLight(engine), view = walkedIn() } = {}) {
  const all = [0, engine.rows(stride), 0, engine.cols(stride)];
  const order = phaseOrder(stride);
  const whole = [0, engine.W, 0, engine.H];
  const shown = [{ ...light, color: [1, 1, 1], intensity: 1, resolved: 0, hidden: false }];
  engine.evaluate(light, 0, stride, ...all);
  engine.resolve(0, 0, stride, order[0], all, 1);
  const compositeView = () => engine.composite(shown, 1, view);
  const stages = {
    evaluate: (i) => engine.evaluate(light, 0, stride, ...all, order[i % order.length]),
    resolve: (i) => engine.resolve(0, 0, stride, order[i % order.length], all, 0.5, whole),
    composite: compositeView,
    oneSubmit: (i) => {
      engine.beginFrame();
      stages.evaluate(i);
      stages.resolve(i);
      stages.composite();
      engine.endFrame();
    },
    snapshot: () => {
      compositeView();
      engine.snapshot().close?.();
    },
    ...(engine.backend === 'webgpu' && {
      glass: () => {
        compositeView();
        engine.halfImage(uploadToWebGL);
      },
      room: () => {
        compositeView();
        drawBenchRoom();
      },
    }),
    present: () => {
      compositeView();
      uploadToWebGL(engine.snapshot());
    },
  };
  const usesWebGLPresenter = (name) => name === 'present' || name === 'glass';
  const settle = async (withPresenter) => {
    await gpuIdle();
    if (withPresenter) {
      await fence(webglPresenter.gl);
    }
  };
  const medianBatchMs = async (run, withPresenter, count) => {
    const runs = [];
    for (let b = 0; b < batches; b += 1) {
      await settle(withPresenter);
      const t0 = performance.now();
      for (let i = 0; i < count; i += 1) {
        run(i);
      }
      await settle(withPresenter);
      runs.push(performance.now() - t0);
      engine.pollTiming();
    }
    runs.sort((a, b) => a - b);
    return runs[runs.length >> 1];
  };
  uploadToWebGL(engine.snapshot());
  const emptyBatchMs = {
    engine: await medianBatchMs(() => {}, false, 0),
    both: await medianBatchMs(() => {}, true, 0),
  };
  const ms = {};
  for (const [name, run] of Object.entries(stages)) {
    const withPresenter = usesWebGLPresenter(name);
    const empty = emptyBatchMs[withPresenter ? 'both' : 'engine'];
    let count = n;
    let took = await medianBatchMs(run, withPresenter, count);
    while (took < Math.max(FRAME_BATCH_MS, 10 * empty) && count < MAX_FRAME_RUNS) {
      count *= 2;
      took = await medianBatchMs(run, withPresenter, count);
    }
    ms[name] = Math.max(0, took - empty) / count;
  }
  ms.upload = Math.max(0, ms.present - ms.snapshot);
  ms.snapshot = Math.max(0, ms.snapshot - ms.composite);
  ms.present = ms.snapshot + ms.upload;
  ms.total = ms.evaluate + ms.resolve + ms.composite + ms.present;
  if (ms.glass != null) {
    ms.glass = Math.max(0, ms.glass - ms.composite);
    ms.room = Math.max(0, ms.room - ms.composite);
    ms.direct = ms.evaluate + ms.resolve + ms.composite + ms.glass + ms.room;
  }
  return ms;
}

const walkedInSize = (vw, vh) => Math.max(vw, vh) * WALKED_IN_SCALE;

function drawBenchRoom() {
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  if (!benchRoom) {
    const host = document.body.appendChild(document.createElement('div'));
    benchRoom = new GPURoomLayer(host, engine);
    const size = walkedInSize(vw, vh);
    const value = (x, y = 0, z = 0, w = 0) => ({ value: { x, y, z, w } });
    benchRoom.uniforms = {
      texSize: value(1, 1),
      box: value(vw / 2 - size / 2, vh / 2 - size / 2, size, 0.03),
      ready: { value: 1 },
      dim: { value: 0.4 },
      saturation: { value: 0.55 },
      hotKeep: { value: 0.35 },
      glowAt: value(vw * 0.4, vh * 0.4, 30),
      glowColor: value(0.4, 0.3, 0.2),
    };
  }
  benchRoom.setImage();
  benchRoom.draw(benchRoom.uniforms, vw, vh, Math.min(window.devicePixelRatio || 1, ROOM_MAX_DPR));
}

function walkedIn() {
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const size = walkedInSize(vw, vh);
  const m = VIEW_MARGIN;
  return [
    (size - vw) / 2 / size - m,
    (size + vw) / 2 / size + m,
    (size - vh) / 2 / size - m,
    (size + vh) / 2 / size + m,
  ].map(clamp01);
}

function uploadToWebGL(image) {
  if (!webglPresenter) {
    const gl = document.createElement('canvas').getContext('webgl2', { alpha: false, antialias: false, depth: false });
    const texture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, texture);
    webglPresenter = { gl };
  }
  const { gl } = webglPresenter;
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, image);
  image.close?.();
}

function psnr(a, b) {
  const x = atob(a);
  const y = atob(b);
  let se = 0;
  let n = 0;
  for (let i = 0; i < x.length; i += 4) {
    for (let c = 0; c < 3; c += 1) {
      const d = x.charCodeAt(i + c) - y.charCodeAt(i + c);
      se += d * d;
      n += 1;
    }
  }
  return se ? 10 * Math.log10((255 * 255 * n) / se) : Infinity;
}

async function readImage() {
  const image = engine.snapshot();
  const canvas = new OffscreenCanvas(engine.W, engine.H);
  const ctx = canvas.getContext('2d');
  ctx.drawImage(image, 0, 0);
  image.close?.();
  await gpuIdle();
  engine.pollTiming();
  const bytes = new Uint8Array(ctx.getImageData(0, 0, engine.W, engine.H).data.buffer);
  let text = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    text += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  }
  return { width: engine.W, height: engine.H, rgba: btoa(text) };
}

function tune({ stride = 1, runs = 4 } = {}) {
  return engine.tune(midLight(engine), stride, runs);
}

export function installBench() {
  window.__relightBench = { open, time, frame, render, accumulate, tune, close };
}
