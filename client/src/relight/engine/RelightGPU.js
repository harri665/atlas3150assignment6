import { NO_PHASE, RESOLVED, RelightBase, SLOTS, GEO_INPUTS, LIGHT_INPUTS, readNetwork } from './RelightBase';

export const KERNELS = [
  { threads: 256, pixels: 4 },
  { threads: 128, pixels: 4 },
  { threads: 256, pixels: 8 },
  { threads: 128, pixels: 8 },
  { threads: 64, pixels: 8 },
  { threads: 64, pixels: 4 },
  { threads: 64, pixels: 16 },
  { threads: 64, pixels: 8, channels: 2 },
  { threads: 128, pixels: 4, channels: 2 },
  { threads: 32, pixels: 8 },
  { threads: 32, pixels: 8, channels: 2 },
  { threads: 64, pixels: 8, double: true },
  { threads: 128, pixels: 4, double: true },
  { threads: 64, pixels: 8, subgroup: true },
  { threads: 32, pixels: 8, channels: 2, subgroup: true },
];

export const kernelKey = (k) =>
  `${k.threads}x${k.pixels}${k.channels > 1 ? `c${k.channels}` : ''}${k.double ? 'd' : ''}${k.subgroup ? 's' : ''}`;

const QUEUE_GRAIN_MS = 0.1;
const IMAGE_FORMAT = 'rgba16float';
const RING_SLOTS = 64;
const PIXELS_PER_WORKGROUP = 64;
const GEO_FEATURE_BYTES = 32;
const FWD_GRID_WORDS = 8;
const FWD_LIGHT = FWD_GRID_WORDS;
const FWD_HEADER_WORDS = 12;
const FRAME_HEADER_WORDS = 24;
const FRAME_EXPOSURE = 20;
const FRAME_LIGHT_COUNT = 21;
const LIGHT_WORDS = 12;
const LIGHT_EMISSION = 4;
const LIGHT_INFO = 8;
const RESOLVE_WORDS = 20;
const RESOLVE_ALPHA = 17;
const RESOLVE_SIGMA = 18;
const RESOLVE_SPARSE = 19;
const FULL_RES_STRIDE = 1;

const channelsOf = (k) => k.channels ?? 1;
const tileOf = (k, groups) => ((k.threads * channelsOf(k)) / groups) * k.pixels;
const outputCount = (mul) => (mul ? 6 : 3);
const wordsPerPixel = (mul) => (mul ? 3 : 2);
const u32 = (x) => `${x >>> 0}u`;

function workgroupBytes(k, width, half, outputs) {
  const tile = tileOf(k, width / 4);
  const actBytes = tile * width * (half ? 2 : 4) * (k.double ? 2 : 1);
  return actBytes + tile * GEO_FEATURE_BYTES + tile * outputs * 4;
}

export async function requestRelightDevice() {
  if (!navigator.gpu) {
    throw new Error(window.isSecureContext ? 'this browser has no WebGPU' : 'WebGPU needs HTTPS');
  }
  if (typeof OffscreenCanvas === 'undefined') {
    throw new Error('this browser has no OffscreenCanvas');
  }
  const adapter = await navigator.gpu.requestAdapter();
  if (!adapter) {
    throw new Error('the browser offers no WebGPU adapter for this GPU');
  }
  const L = adapter.limits;
  const features = ['timestamp-query', 'shader-f16', 'subgroups'].filter((f) => adapter.features.has(f));
  return adapter.requestDevice({
    requiredFeatures: features,
    requiredLimits: {
      maxComputeWorkgroupStorageSize: L.maxComputeWorkgroupStorageSize,
      maxStorageBufferBindingSize: L.maxStorageBufferBindingSize,
      maxBufferSize: L.maxBufferSize,
    },
  });
}

function toHalf(values) {
  const out = new Uint16Array(values.length);
  const f = new Float32Array(1);
  const bits = new Uint32Array(f.buffer);
  for (let k = 0; k < values.length; k += 1) {
    f[0] = values[k];
    const x = bits[0];
    const sign = (x >>> 16) & 0x8000;
    const e = ((x >>> 23) & 0xff) - 112;
    let m = x & 0x7fffff;
    if (e <= 0) {
      out[k] = e < -10 ? sign : sign | ((m | 0x800000) >> (14 - e));
    } else if (e >= 31) {
      out[k] = sign | 0x7c00;
    } else {
      const rest = m & 0x1fff;
      m >>= 13;
      let h = sign | (e << 10) | m;
      if (rest > 0x1000 || (rest === 0x1000 && m & 1)) {
        h += 1;
      }
      out[k] = h;
    }
  }
  return out;
}

function packWeights(layers, { width, hiddenLayers, pixelInputs, inputs, geo, mul }) {
  const groups = width / 4;
  const off = {};
  let len = 0;
  const alloc = (key, vec4s) => {
    off[key] = len;
    len += vec4s;
  };
  const hiddenVec4s = width * groups + groups;
  alloc('layer0Pixel', Math.ceil(pixelInputs / 4) * 4 * groups);
  alloc('layer0Geo', geo ? GEO_INPUTS * groups : 0);
  alloc('hidden', hiddenLayers * hiddenVec4s);
  alloc('outWeights', outputCount(mul) * groups);
  alloc('outBias', 2);
  const data = new Float32Array(len * 4);
  const w0 = layers[0].w;
  const lightColumn = pixelInputs;
  const geoColumn = pixelInputs + LIGHT_INPUTS;
  for (let c = 0; c < width; c += 1) {
    for (let k = 0; k < pixelInputs; k += 1) {
      data[(off.layer0Pixel + k * groups) * 4 + c] = w0[c * inputs + k];
    }
    for (let j = 0; geo && j < GEO_INPUTS; j += 1) {
      data[(off.layer0Geo + j * groups) * 4 + c] = w0[c * inputs + geoColumn + j];
    }
  }
  for (let l = 0; l < hiddenLayers; l += 1) {
    const { w, b } = layers[l + 1];
    const o = (off.hidden + l * hiddenVec4s) * 4;
    for (let c = 0; c < width; c += 1) {
      for (let k = 0; k < width; k += 1) {
        data[o + k * width + c] = w[c * width + k];
      }
    }
    data.set(b, o + width * width);
  }
  data.set(layers[hiddenLayers + 1].w, off.outWeights * 4);
  data.set(layers[hiddenLayers + 1].b, off.outBias * 4);
  const lightWeights = new Float32Array(width * LIGHT_INPUTS);
  for (let c = 0; c < width; c += 1) {
    for (let j = 0; j < LIGHT_INPUTS; j += 1) {
      lightWeights[c * LIGHT_INPUTS + j] = w0[c * inputs + lightColumn + j];
    }
  }
  return { off, data, bias0: layers[0].b, lightWeights };
}

const SOLID_ANGLE_WGSL = `
const PI = 3.14159265358979;
fn solidAngle(r: f32, d: f32) -> f32 {
  let s = min(r / d, 1.0);
  return 2.0 * PI * s * s / (1.0 + sqrt(max(1.0 - s * s, 0.0)));
}`;

const GEO_WGSL = `${SOLID_ANGLE_WGSL}
struct Geo { f0: vec4f, f1: vec4f };
fn geoFeatures(x: vec4f, n: vec3f, lc: vec4f) -> Geo {
  var o: Geo;
  if (x.w <= 0.0) { return o; }
  let v = lc.xyz - x.xyz;
  let d = max(length(v), 1e-4);
  let l = v / d;
  let cs = dot(n, l);
  let om = solidAngle(lc.w, d);
  o.f0 = vec4f(l, cs);
  o.f1 = vec4f(0.5 * log(d), 0.25 * log(om + 1e-6), om * max(cs, 0.0) / PI, 1.0);
  return o;
}
`;

const POS_WGSL = `
fn posAt(p: u32) -> vec4f { let q = ppos[p]; return vec4f(unpack2x16float(q.x), unpack2x16float(q.y)); }`;
const NRM_WGSL = `
fn nrmAt(p: u32) -> vec3f { let n = pnrm[p]; return vec3f(unpack2x16float(n.x), unpack2x16float(n.y).x); }`;

const TAP_WGSL = `
fn tapWeight(k: u32, t: vec2f, g: vec4f, q: vec4f, sig: f32) -> f32 {
  let wb = select(1.0 - t.x, t.x, (k & 1u) == 1u) * select(1.0 - t.y, t.y, k >= 2u);
  let dq = q.xyz - g.xyz;
  var wgt = exp(-dot(dq, dq) / (2.0 * sig * sig));
  if ((q.w > 0.0) != (g.w > 0.0)) { wgt = 0.0; }
  return wb * (wgt + 1e-4);
}`;

const FULLSCREEN_WGSL = `
fn fullscreenCorner(i: u32) -> vec2f {
  return array<vec2f, 3>(vec2f(-1.0, -1.0), vec2f(3.0, -1.0), vec2f(-1.0, 3.0))[i];
}`;

function precomputeWGSL({ W, H, levels, feats, gridRes, gridOff, auxDim, inputWords, posLo, posStep, camO }) {
  const arr = (a) => `array<u32, ${a.length}>(${a.map(u32).join(', ')})`;
  const f = (x) => (`${x}`.includes('.') || `${x}`.includes('e') ? `${x}` : `${x}.0`);
  return `
@group(0) @binding(0) var<storage, read> grid: array<u32>;
@group(0) @binding(1) var<storage, read> auxB: array<u32>;
@group(0) @binding(2) var<storage, read> posB: array<u32>;
@group(0) @binding(3) var<storage, read_write> X: array<u32>;
@group(0) @binding(4) var<storage, read_write> ppos: array<vec2u>;
@group(0) @binding(5) var<storage, read_write> pnrm: array<vec2u>;
var<private> RES: array<u32, ${levels}> = ${arr(gridRes)};
var<private> GOFF: array<u32, ${levels}> = ${arr(gridOff)};
const W = ${u32(W)}; const H = ${u32(H)}; const F = ${u32(feats)}; const NP = ${u32(W * H)};
const POS_LO = ${f(posLo)}; const POS_STEP = ${f(posStep)};
const CAM_O = vec3f(${camO.map(f).join(', ')});

fn gridAt(i: u32) -> f32 {
  return unpack2x16float(grid[i >> 1u])[i & 1u];
}
fn auxAt(p: u32, j: u32) -> f32 {
  let i = ((j >> 2u) * NP + p) * 4u + (j & 3u);
  return unpack2x16float(auxB[i >> 1u])[i & 1u];
}

@compute @workgroup_size(${PIXELS_PER_WORKGROUP})
fn main(@builtin(global_invocation_id) gid: vec3u) {
  let p = gid.x;
  if (p >= NP) { return; }
  let uu = (f32(p % W) + 0.5) / f32(W);
  let vv = (f32(p / W) + 0.5) / f32(H);
  var x: array<f32, ${inputWords * 2}>;
  for (var l = 0u; l < ${u32(levels)}; l++) {
    let R = RES[l];
    let fx = uu * f32(R - 1u); let fy = vv * f32(R - 1u);
    let x0 = min(u32(floor(fx)), R - 2u); let y0 = min(u32(floor(fy)), R - 2u);
    let tx = fx - f32(x0); let ty = fy - f32(y0);
    let b = GOFF[l];
    for (var f = 0u; f < F; f++) {
      let v00 = gridAt(b + (y0 * R + x0) * F + f);
      let v01 = gridAt(b + (y0 * R + x0 + 1u) * F + f);
      let v10 = gridAt(b + ((y0 + 1u) * R + x0) * F + f);
      let v11 = gridAt(b + ((y0 + 1u) * R + x0 + 1u) * F + f);
      x[l * F + f] = mix(mix(v00, v01, tx), mix(v10, v11, tx), ty);
    }
  }
  for (var j = 0u; j < ${u32(auxDim)}; j++) { x[${u32(levels * feats)} + j] = auxAt(p, j); }
  for (var j = 0u; j < ${u32(inputWords)}; j++) { X[p * ${u32(inputWords)} + j] = pack2x16float(vec2f(x[2u * j], x[2u * j + 1u])); }

  let q0 = posB[2u * p]; let q1 = posB[2u * p + 1u];
  var g = vec4f(0.0);
  if ((q0 & 0xffffu) != 0u) {
    let w = POS_LO + (vec3f(f32(q0 & 0xffffu), f32(q0 >> 16u), f32(q1 & 0xffffu)) - 1.0) * POS_STEP;
    g = vec4f(w, length(w - CAM_O));
  }
  ppos[p] = vec2u(pack2x16float(g.xy), pack2x16float(g.zw));
  pnrm[p] = vec2u(pack2x16float(vec2f(auxAt(p, 3u), auxAt(p, 4u))), pack2x16float(vec2f(auxAt(p, 5u), 0.0)));
}
`;
}

function forwardWGSL({
  W,
  H,
  width,
  hiddenLayers,
  pixelInputs,
  inputWords,
  geo,
  mul,
  threads,
  pixels,
  channels = 1,
  double: doubleBuffer,
  subgroup: shuffle,
  off,
  half,
}) {
  const groups = width / 4;
  const threadsPerPixel = groups / channels;
  const outputs = outputCount(mul);
  const words = wordsPerPixel(mul);
  const teams = threads / threadsPerPixel;
  const tilePixels = teams * pixels;
  const pixelIdx = [...Array(pixels).keys()];
  const channelIdx = [...Array(channels).keys()];
  const hiddenVec4s = width * groups + groups;
  const actVec4s = tilePixels * groups;
  const lastActOffset = doubleBuffer ? ((hiddenLayers + 1) % 2) * actVec4s : 0;
  const inputVec4s = Math.ceil(inputWords / 2);
  const layer0Steps = Math.ceil(pixelInputs / 4);
  const vec4T = half ? 'vec4h' : 'vec4f';
  const joinLines = (list, f) => list.map(f).join('\n      ');
  const accumulate = (acc, x) =>
    joinLines(
      channelIdx.flatMap((c) => pixelIdx.map((q) => [c, q])),
      ([c, q]) => `${acc(c, q)} += ${x(q)}.x * w${c}0 + ${x(q)}.y * w${c}1 + ${x(q)}.z * w${c}2 + ${x(q)}.w * w${c}3;`
    );
  const loadWeights = (at) =>
    channelIdx
      .map((c) =>
        [0, 1, 2, 3].map((j) => `let w${c}${j} = Wv[${at} + ${u32(j * groups + c * threadsPerPixel)}];`).join(' ')
      )
      .join('\n      ');
  const loadActs = (at) => pixelIdx.map((q) => `let x${q} = act[${at(q)}];`).join(' ');
  const hiddenAt = (c, q) =>
    typeof q === 'number' ? `h[${c * pixels + q}]` : `h[${c ? `${u32(c * pixels)} + ` : ''}${q}]`;
  return `
${half ? 'enable f16;' : ''}
${shuffle ? 'enable subgroups;\nrequires subgroup_id;' : ''}
struct Fwd {
  i0: u32, i1: u32, stride: u32, slot: u32, x0: u32, xw: u32, px: u32, py: u32,
  lc: vec4f, add: array<vec4f, ${groups}>,
};
@group(0) @binding(0) var<storage, read> Wv: array<${vec4T}>;
@group(0) @binding(1) var<storage, read> X: array<u32>;
@group(0) @binding(2) var<storage, read> ppos: array<vec2u>;
@group(0) @binding(3) var<uniform> fu: Fwd;
@group(0) @binding(4) var<storage, read_write> outB: array<u32>;
@group(0) @binding(5) var<storage, read> pnrm: array<vec2u>;
var<workgroup> act: array<${vec4T}, ${doubleBuffer ? 2 * actVec4s : actVec4s}>;
var<workgroup> pf: array<vec4f, ${2 * tilePixels}>;
var<workgroup> res: array<f32, ${tilePixels * outputs}>;
${GEO_WGSL}
${POS_WGSL}
${NRM_WGSL}
fn pixelOf(i: u32) -> u32 {
  let s = fu.stride;
  let x = min((fu.x0 + i % fu.xw) * s + fu.px, ${u32(W - 1)});
  let y = min((i / fu.xw) * s + fu.py, ${u32(H - 1)});
  return y * ${u32(W)} + x;
}
fn itemOf(i: u32) -> u32 {
  let cw = (${u32(W)} + fu.stride - 1u) / fu.stride;
  return (i / fu.xw) * cw + fu.x0 + i % fu.xw;
}
fn outRow(o: u32, pl: u32) -> f32 {
  var acc = f32(Wv[${u32(off.outBias)} + o / 4u][o % 4u]);
  let row = ${u32(off.outWeights)} + o * ${u32(groups)};
  for (var k = 0u; k < ${u32(groups)}; k++) {
    acc += f32(dot(Wv[row + k], act[${lastActOffset ? `${u32(lastActOffset)} + ` : ''}pl * ${u32(groups)} + k]));
  }
  return acc;
}

@compute @workgroup_size(${threads})
fn main(@builtin(workgroup_id) wg: vec3u, @builtin(local_invocation_index) t: u32${
    shuffle
      ? `,
    @builtin(subgroup_id) sgi: u32, @builtin(subgroup_size) sgs: u32, @builtin(subgroup_invocation_id) lane: u32`
      : ''
  }) {
  let base = fu.i0 + wg.x * ${u32(tilePixels)};
  ${shuffle
    ? `let tt = sgi * sgs + lane;
  let pg = tt / ${u32(threadsPerPixel)};
  let cg = tt % ${u32(threadsPerPixel)};
  let lane0 = lane - cg;`
    : `let pg = t / ${u32(threadsPerPixel)};
  let cg = t % ${u32(threadsPerPixel)};`}

  for (var e = t; e < ${u32(tilePixels * inputVec4s)}; e += ${u32(threads)}) {
    let pl = e / ${u32(inputVec4s)}; let q = e % ${u32(inputVec4s)};
    var v = vec4f(0.0);
    if (base + pl < fu.i1) {
      let at = pixelOf(base + pl) * ${u32(inputWords)} + 2u * q;
      let hi = ${inputWords % 2 ? `select(vec2f(0.0), unpack2x16float(X[at + 1u]), 2u * q + 1u < ${u32(inputWords)})` : 'unpack2x16float(X[at + 1u])'};
      v = vec4f(unpack2x16float(X[at]), hi);
    }
    act[pl * ${u32(groups)} + q] = ${vec4T}(v);
  }
  if (t < ${u32(tilePixels)}) {
    var g: Geo;
    if (base + t < fu.i1) {
      let p = pixelOf(base + t);
      g = geoFeatures(posAt(p), nrmAt(p), fu.lc);
    }
    pf[2u * t] = g.f0; pf[2u * t + 1u] = g.f1;
  }
  workgroupBarrier();

  ${channelIdx.map((c) => `let add${c} = ${vec4T}(fu.add[cg + ${u32(c * threadsPerPixel)}]);`).join(' ')}
  var h = array<${vec4T}, ${channels * pixels}>(${channelIdx.flatMap((c) => pixelIdx.map(() => `add${c}`)).join(', ')});
  let r0 = pg * ${u32(pixels * groups)};
  for (var k = 0u; k < ${u32(layer0Steps)}; k++) {
    ${loadWeights(`${u32(off.layer0Pixel)} + k * ${u32(4 * groups)} + cg`)}
    ${loadActs((q) => `r0 + ${u32(q * groups)} + k`)}
    ${accumulate(hiddenAt, (q) => `x${q}`)}
  }
  ${geo ? `for (var q = 0u; q < ${u32(pixels)}; q++) {
    let f0 = ${vec4T}(pf[2u * (pg * ${u32(pixels)} + q)]); let f1 = ${vec4T}(pf[2u * (pg * ${u32(pixels)} + q) + 1u]);
    ${channelIdx.map((c) => {
      const g = (j) => `Wv[${u32(off.layer0Geo + j * groups + c * threadsPerPixel)} + cg]`;
      return `${hiddenAt(c, 'q')} += ${g(0)} * f0.x + ${g(1)} * f0.y
          + ${g(2)} * f0.z + ${g(3)} * f0.w
          + ${g(4)} * f1.x + ${g(5)} * f1.y;`;
    }).join('\n    ')}
  }` : ''}
  ${doubleBuffer || shuffle ? '' : 'workgroupBarrier();'}
  for (var q = 0u; q < ${u32(pixels)}; q++) {
    let live = base + pg * ${u32(pixels)} + q < fu.i1;
    ${channelIdx.map((c) =>
      shuffle
        ? `${hiddenAt(c, 'q')} = select(${vec4T}(0.0), max(${hiddenAt(c, 'q')}, ${vec4T}(0.0)), live);`
        : `act[${doubleBuffer ? `${u32(actVec4s)} + ` : ''}r0 + q * ${u32(groups)} + cg + ${u32(c * threadsPerPixel)}] = select(${vec4T}(0.0), max(${hiddenAt(c, 'q')}, ${vec4T}(0.0)), live);`
    ).join('\n    ')}
  }
  ${shuffle ? '' : 'workgroupBarrier();'}

  for (var l = 0u; l < ${u32(hiddenLayers)}; l++) {
    let wo = ${u32(off.hidden)} + l * ${u32(hiddenVec4s)};
    ${channelIdx.map((c) => `let bias${c} = Wv[wo + ${u32(width * groups + c * threadsPerPixel)} + cg];`).join(' ')}
    ${channelIdx.map((c) => pixelIdx.map((q) => `var a${c}_${q} = bias${c};`).join(' ')).join('\n    ')}
    ${shuffle
      ? `${channelIdx.map(
          (s) => `for (var j = 0u; j < ${u32(threadsPerPixel)}; j++) {
      let k = ${s ? `${u32(s * threadsPerPixel)} + ` : ''}j;
      ${loadWeights(`wo + k * ${u32(4 * groups)} + cg`)}
      ${pixelIdx.map((q) => `let x${q} = subgroupShuffle(${hiddenAt(s, q)}, lane0 + j);`).join(' ')}
      ${accumulate((c, q) => `a${c}_${q}`, (q) => `x${q}`)}
    }`
        ).join('\n    ')}
    ${channelIdx.map((c) => pixelIdx.map((q) => `${hiddenAt(c, q)} = max(a${c}_${q}, ${vec4T}(0.0));`).join(' ')).join('\n    ')}
  }
  workgroupBarrier();
  ${channelIdx.map((c) => pixelIdx.map((q) => `act[r0 + ${u32(q * groups + c * threadsPerPixel)} + cg] = ${hiddenAt(c, q)};`).join(' ')).join('\n  ')}
  workgroupBarrier();`
      : `${doubleBuffer ? `let src = select(0u, ${u32(actVec4s)}, (l & 1u) == 0u); let dst = ${u32(actVec4s)} - src;` : ''}
    for (var k = 0u; k < ${u32(groups)}; k++) {
      ${loadWeights(`wo + k * ${u32(4 * groups)} + cg`)}
      ${loadActs((q) => `${doubleBuffer ? 'src + ' : ''}r0 + ${u32(q * groups)} + k`)}
      ${accumulate((c, q) => `a${c}_${q}`, (q) => `x${q}`)}
    }
    ${doubleBuffer ? '' : 'workgroupBarrier();'}
    ${channelIdx.map((c) => pixelIdx.map((q) => `act[${doubleBuffer ? 'dst + ' : ''}r0 + ${u32(q * groups + c * threadsPerPixel)} + cg] = max(a${c}_${q}, ${vec4T}(0.0));`).join('\n    ')).join(
      '\n    '
    )}
    workgroupBarrier();
  }`}

  for (var e = t; e < ${u32(tilePixels * outputs)}; e += ${u32(threads)}) {
    res[e] = outRow(e % ${u32(outputs)}, e / ${u32(outputs)});
  }
  workgroupBarrier();
  if (t < ${u32(tilePixels)} && base + t < fu.i1) {
    let o = (fu.slot * ${u32(W * H)} + itemOf(base + t)) * ${u32(words)};
    let r = t * ${u32(outputs)};
    ${mul
      ? `outB[o] = pack2x16float(vec2f(res[r], res[r + 1u]));
    outB[o + 1u] = pack2x16float(vec2f(res[r + 2u], res[r + 3u]));
    outB[o + 2u] = pack2x16float(vec2f(res[r + 4u], res[r + 5u]));`
      : `outB[o] = pack2x16float(vec2f(res[r], res[r + 1u]));
    outB[o + 1u] = pack2x16float(vec2f(res[r + 2u], 0.0));`}
  }
}
`;
}

function compositeWGSL({ W, H, mul }) {
  const words = wordsPerPixel(mul);
  return `
struct Light { pr: vec4f, e: vec4f, info: vec4u };
struct Frame {
  camO: vec4f, camX: vec4f, camY: vec4f, camZ: vec4f, tanxy: vec4f,
  exposure: f32, nLights: u32, _a: u32, _b: u32,
  lights: array<Light, ${SLOTS}>,
};
@group(0) @binding(0) var<uniform> frame: Frame;
@group(0) @binding(1) var<storage, read> outB: array<u32>;
@group(0) @binding(2) var<storage, read> ppos: array<vec2u>;
${mul ? '@group(0) @binding(3) var<storage, read> pnrm: array<vec2u>;' : ''}
const W = ${u32(W)}; const H = ${u32(H)}; const NP = ${u32(W * H)};
${SOLID_ANGLE_WGSL}
${POS_WGSL}
${mul ? NRM_WGSL : ''}
${TAP_WGSL}
${FULLSCREEN_WGSL}
struct Net { a: vec3f, b: vec3f };

fn camDir(uv: vec2f) -> vec3f {
  return normalize(frame.camX.xyz * ((0.5 - uv.x) * 2.0 * frame.tanxy.x)
    + frame.camY.xyz * ((0.5 - uv.y) * 2.0 * frame.tanxy.y) + frame.camZ.xyz);
}
fn directCov(p: u32, g: vec4f, l: u32) -> f32 {
  let L = frame.lights[l];
  let c = L.pr.xyz; let r = L.pr.w;
  let surf = select(1e9, g.w, g.w > 0.0);
  let oc = frame.camO.xyz - c;
  let px = f32(p % W); let py = f32(p / W);
  let d0 = camDir(vec2f((px + 0.5) / f32(W), (py + 0.5) / f32(H)));
  let b0 = dot(d0, oc);
  let pixAng = 2.0 * frame.tanxy.x / f32(W) * 1.5;
  let dist2 = dot(oc, oc) - b0 * b0;
  let slack = r + pixAng * length(oc);
  if (dist2 > slack * slack || b0 > 0.0) { return 0.0; }
  var cnt = 0.0;
  for (var sy = 0u; sy < 4u; sy++) {
    for (var sx = 0u; sx < 4u; sx++) {
      let d = camDir(vec2f((px + (f32(sx) + 0.5) / 4.0) / f32(W), (py + (f32(sy) + 0.5) / 4.0) / f32(H)));
      let b = dot(d, oc);
      let disc = b * b - dot(oc, oc) + r * r;
      if (disc >= 0.0) {
        let t0 = -b - sqrt(disc);
        if (t0 > 0.0 && t0 < surf) { cnt += 1.0; }
      }
    }
  }
  return cnt / 16.0;
}
fn outAt(i: u32) -> Net {
  let w0 = unpack2x16float(outB[${u32(words)} * i]); let w1 = unpack2x16float(outB[${u32(words)} * i + 1u]);
  ${mul
    ? `let w2 = unpack2x16float(outB[3u * i + 2u]);
  return Net(vec3f(w0, w1.x), vec3f(w1.y, w2));`
    : 'return Net(vec3f(w0, w1.x), vec3f(0.0));'}
}
fn lit(n: Net, g: vec4f, nrm: vec3f, light: vec4f) -> vec3f {
  ${mul
    ? `var G = 0.0;
  if (g.w > 0.0) {
    let v = light.xyz - g.xyz;
    let d = max(length(v), 1e-4);
    let cs = dot(nrm, v / d);
    if (cs > 0.0) {
      let om = solidAngle(light.w, d);
      G = om * cs / PI;
    }
  }
  return max(n.a * G + n.b, vec3f(0.0));`
    : 'return max(n.a, vec3f(0.0));'}
}
fn netAt(slot: u32, s: u32, p: u32, g: vec4f) -> Net {
  let base = slot * NP;
  if (s <= 1u) { return outAt(base + p); }
  let cw = (W + s - 1u) / s; let ch = (H + s - 1u) / s;
  let fx = f32(p % W) / f32(s); let fy = f32(p / W) / f32(s);
  let x0 = min(u32(fx), cw - 1u); let y0 = min(u32(fy), ch - 1u);
  let x1 = min(x0 + 1u, cw - 1u); let y1 = min(y0 + 1u, ch - 1u);
  let tx = fx - f32(x0); let ty = fy - f32(y0);
  let sig = 1.5 * f32(s) * 2.0 * frame.tanxy.x / f32(W) * max(g.w, 1e-3);
  var acc = Net(vec3f(0.0), vec3f(0.0)); var ws = 0.0;
  for (var k = 0u; k < 4u; k++) {
    let cx = select(x0, x1, (k & 1u) == 1u); let cy = select(y0, y1, k >= 2u);
    let w = tapWeight(k, vec2f(tx, ty), g, posAt(cy * s * W + cx * s), sig);
    let n = outAt(base + cy * cw + cx);
    acc.a += w * n.a; acc.b += w * n.b;
    ws += w;
  }
  let iw = 1.0 / max(ws, 1e-12);
  return Net(acc.a * iw, acc.b * iw);
}
fn tone(x: vec3f) -> vec3f { let y = max(x, vec3f(0.0)) * frame.exposure; return y / (1.0 + y); }
fn srgb(c: vec3f) -> vec3f {
  return select(1.055 * pow(c, vec3f(1.0 / 2.4)) - 0.055, 12.92 * c, c <= vec3f(0.0031308));
}

@vertex fn vs(@builtin(vertex_index) i: u32) -> @builtin(position) vec4f {
  return vec4f(fullscreenCorner(i), 0.0, 1.0);
}
@fragment fn fs(@builtin(position) pos: vec4f) -> @location(0) vec4f {
  let p = (H - 1u - min(u32(pos.y), H - 1u)) * W + min(u32(pos.x), W - 1u);
  let g = posAt(p);
  ${mul ? 'let nrm = nrmAt(p);' : 'let nrm = vec3f(0.0);'}
  var I = vec3f(0.0);
  for (var l = 0u; l < frame.nLights; l++) {
    let L = frame.lights[l];
    I += L.e.xyz * (lit(netAt(L.info.x, L.info.y, p, g), g, nrm, L.pr) + select(0.0, directCov(p, g, l), L.info.z != 0u));
  }
  return vec4f(clamp(srgb(tone(I)), vec3f(0.0), vec3f(1.0)), 1.0);
}
`;
}

const BLIT_WGSL = `
@group(0) @binding(0) var image: texture_2d<f32>;
@group(0) @binding(1) var smp: sampler;
struct Out { @builtin(position) pos: vec4f, @location(0) uv: vec2f };
${FULLSCREEN_WGSL}
@vertex fn vs(@builtin(vertex_index) i: u32) -> Out {
  let p = fullscreenCorner(i);
  return Out(vec4f(p, 0.0, 1.0), vec2f(0.5 + 0.5 * p.x, 0.5 - 0.5 * p.y));
}
@fragment fn fs(o: Out) -> @location(0) vec4f {
  return vec4f(textureSampleLevel(image, smp, o.uv, 0.0).rgb, 1.0);
}
`;

function resolveWGSL({ W, H, mul }) {
  const words = wordsPerPixel(mul);
  return `
struct Res {
  s: u32, px: u32, py: u32, raw: u32, dst: u32, c0: u32, c1: u32, r0: u32,
  r1: u32, x0: u32, y0: u32, xw: u32, yh: u32, k0x: u32, k0y: u32, k1x: u32,
  k1y: u32, alpha: f32, sig: f32, sparse: u32,
};
@group(0) @binding(0) var<uniform> ru: Res;
@group(0) @binding(1) var<storage, read_write> outB: array<u32>;
@group(0) @binding(2) var<storage, read> ppos: array<vec2u>;
const W = ${u32(W)}; const H = ${u32(H)}; const NP = ${u32(W * H)};
${POS_WGSL}
${TAP_WGSL}

fn load(i: u32, w: ptr<function, array<vec2f, ${words}>>) {
  for (var k = 0u; k < ${u32(words)}; k++) { (*w)[k] = unpack2x16float(outB[${u32(words)} * i + k]); }
}
fn store(i: u32, w: array<vec2f, ${words}>) {
  for (var k = 0u; k < ${u32(words)}; k++) { outB[${u32(words)} * i + k] = pack2x16float(w[k]); }
}

@compute @workgroup_size(${PIXELS_PER_WORKGROUP})
fn main(@builtin(global_invocation_id) gid: vec3u) {
  let s = ru.s;
  let cw = (W + s - 1u) / s;
  let raw = ru.raw * NP;
  var w: array<vec2f, ${words}>;
  if (ru.sparse != 0u) {
    let gw = ru.c1 - ru.c0;
    let gh = ru.r1 - ru.r0;
    if (gid.x >= gw * gh) { return; }
    let cx = ru.c0 + gid.x % gw;
    let cy = ru.r0 + gid.x / gw;
    let x = cx * s + ru.px;
    let y = cy * s + ru.py;
    if (x >= W || y >= H) { return; }
    load(raw + cy * cw + cx, &w);
    store(ru.dst * NP + y * W + x, w);
    return;
  }
  if (gid.x >= ru.xw * ru.yh) { return; }
  let x = ru.x0 + gid.x % ru.xw; let y = ru.y0 + gid.x / ru.xw;
  let p = y * W + x;
  let dst = ru.dst * NP + p;
  let hx = max(min(ru.c1 - 1u, (W - 1u - ru.px) / s), ru.c0);
  let hy = max(min(ru.r1 - 1u, (H - 1u - ru.py) / s), ru.r0);
  if (x >= ru.px && y >= ru.py) {
    let dx = x - ru.px; let dy = y - ru.py;
    let cx = dx / s; let cy = dy / s;
    if (dx % s == 0u && dy % s == 0u && cx >= ru.c0 && cx <= hx && cy >= ru.r0 && cy <= hy) {
      load(raw + cy * cw + cx, &w);
      store(dst, w);
      return;
    }
  }
  let kept = x >= ru.k0x && x < ru.k1x && y >= ru.k0y && y < ru.k1y;
  let alpha = select(1.0, ru.alpha, kept);
  if (alpha <= 0.0) { return; }

  let fx = max(f32(x) - f32(ru.px), 0.0) / f32(s);
  let fy = max(f32(y) - f32(ru.py), 0.0) / f32(s);
  let x0 = clamp(u32(fx), ru.c0, hx); let y0 = clamp(u32(fy), ru.r0, hy);
  let x1 = min(x0 + 1u, hx); let y1 = min(y0 + 1u, hy);
  let tx = clamp(fx - f32(x0), 0.0, 1.0); let ty = clamp(fy - f32(y0), 0.0, 1.0);
  let g = posAt(p);
  let sig = ru.sig * f32(s) * max(g.w, 1e-3);
  var acc: array<vec2f, ${words}>;
  var ws = 0.0;
  for (var k = 0u; k < 4u; k++) {
    let cx = select(x0, x1, (k & 1u) == 1u); let cy = select(y0, y1, k >= 2u);
    let wt = tapWeight(k, vec2f(tx, ty), g, posAt((cy * s + ru.py) * W + cx * s + ru.px), sig);
    var n: array<vec2f, ${words}>;
    load(raw + cy * cw + cx, &n);
    for (var j = 0u; j < ${u32(words)}; j++) { acc[j] += wt * n[j]; }
    ws += wt;
  }
  let iw = 1.0 / max(ws, 1e-12);
  if (alpha < 1.0) {
    load(dst, &w);
  }
  for (var j = 0u; j < ${u32(words)}; j++) { w[j] = mix(w[j], acc[j] * iw, alpha); }
  store(dst, w);
}
`;
}

export class RelightGPUEngine extends RelightBase {
  static async create(device, data, options = {}) {
    const engine = new RelightGPUEngine(device, data);
    await engine.build(data, options);
    return engine;
  }

  constructor(device, { scene, pos }) {
    super(scene, pos);
    this.device = device;
    this.backend = 'webgpu';
    this.buffers = [];
    this.canvas = new OffscreenCanvas(this.W, this.H);
    this.halfCanvas = new OffscreenCanvas(this.W >> 1, this.H >> 1);
  }

  async build({ scene, layers, grid, gridOff, aux, pos }, { kernel = null, images = RESOLVED } = {}) {
    this.images = images;
    const network = readNetwork(scene.network, layers);
    const inputWords = Math.ceil(network.pixelInputs / 2);
    if (inputWords * 2 > network.width) {
      throw new Error('the pixel inputs are wider than a layer');
    }
    this.half = this.device.features.has('shader-f16');
    this.kernels = this.fittingKernels(network);
    if (!this.kernels.length) {
      throw new Error('not enough workgroup memory for the network');
    }
    const preferred = this.kernels.find((k) => kernelKey(k) === kernel) || this.kernels[0];
    const weights = packWeights(layers, network);
    this.b0 = weights.bias0;
    this.w0Light = weights.lightWeights;
    this.shapes = {
      W: this.W,
      H: this.H,
      width: network.width,
      hiddenLayers: network.hiddenLayers,
      pixelInputs: network.pixelInputs,
      inputWords,
      geo: network.geo,
      mul: network.mul,
      off: weights.off,
      half: this.half,
    };
    const pipelines = await this.createPipelines(network, preferred, gridOff, scene);
    const storage = this.createBuffers(network, weights.data, pipelines);
    await this.precomputeInputs(pipelines.pre, storage, { grid, aux, pos });
    this.context = this.canvas.getContext('webgpu');
    this.halfContext = this.halfCanvas.getContext('webgpu');
    this.configure();
  }

  fittingKernels({ width, mul }) {
    const dev = this.device;
    const limits = dev.limits;
    const groups = width / 4;
    const pixelCount = this.W * this.H;
    const threadsPerPixel = (k) => groups / channelsOf(k);
    const canShuffle = (k) =>
      dev.features.has('subgroups') &&
      navigator.gpu.wgslLanguageFeatures?.has('subgroup_id') &&
      dev.adapterInfo?.subgroupMinSize % threadsPerPixel(k) === 0;
    return KERNELS.filter(
      (k) =>
        (!k.subgroup || canShuffle(k)) &&
        groups % channelsOf(k) === 0 &&
        k.threads % threadsPerPixel(k) === 0 &&
        tileOf(k, groups) <= k.threads &&
        k.threads <= limits.maxComputeInvocationsPerWorkgroup &&
        workgroupBytes(k, width, this.half, outputCount(mul)) <= limits.maxComputeWorkgroupStorageSize &&
        Math.ceil(pixelCount / tileOf(k, groups)) <= limits.maxComputeWorkgroupsPerDimension
    );
  }

  async createPipelines(network, preferred, gridOff, scene) {
    const dev = this.device;
    const { W, H } = this;
    const { mul } = network;
    const module = (code, label) => dev.createShaderModule({ code, label });
    const compositeModule = module(compositeWGSL({ W, H, mul }), 'relight composite');
    const blitModule = module(BLIT_WGSL, 'relight blit');
    this.format = navigator.gpu.getPreferredCanvasFormat();
    const S = GPUShaderStage;
    const layout = (visibility, types) =>
      dev.createPipelineLayout({
        bindGroupLayouts: [
          dev.createBindGroupLayout({
            entries: types.map((type, binding) => ({
              binding,
              visibility,
              buffer: type === 'ring' ? { type: 'uniform', hasDynamicOffset: true } : { type },
            })),
          }),
        ],
      });
    const R = 'read-only-storage';
    this.fwdLayout = layout(S.COMPUTE, [R, R, R, 'ring', 'storage', R]);
    const compositeLayout = layout(S.FRAGMENT, ['ring', R, R, ...(mul ? [R] : [])]);
    const resolveLayout = layout(S.COMPUTE, ['ring', 'storage', R]);
    const fallback = this.kernels[0];
    const [pre, forward, composite, resolve, blit] = await Promise.all([
      dev.createComputePipelineAsync({
        layout: 'auto',
        compute: {
          module: module(
            precomputeWGSL({
              W,
              H,
              levels: network.levels,
              feats: scene.network.feats,
              gridRes: scene.network.grid_res,
              gridOff,
              auxDim: network.auxDim,
              inputWords: this.shapes.inputWords,
              posLo: this.posLo,
              posStep: this.posStep,
              camO: this.cam.O,
            }),
            'relight inputs'
          ),
          entryPoint: 'main',
        },
      }),
      this.forwardPipeline(preferred).then(
        (pipeline) => ({ k: preferred, pipeline }),
        (error) => {
          if (preferred === fallback) {
            throw error;
          }
          return this.forwardPipeline(fallback).then((pipeline) => ({ k: fallback, pipeline }));
        }
      ),
      dev.createRenderPipelineAsync({
        layout: compositeLayout,
        vertex: { module: compositeModule, entryPoint: 'vs' },
        fragment: { module: compositeModule, entryPoint: 'fs', targets: [{ format: IMAGE_FORMAT }] },
        primitive: { topology: 'triangle-list' },
      }),
      dev.createComputePipelineAsync({
        layout: resolveLayout,
        compute: { module: module(resolveWGSL({ W, H, mul }), 'relight resolve'), entryPoint: 'main' },
      }),
      dev.createRenderPipelineAsync({
        layout: 'auto',
        vertex: { module: blitModule, entryPoint: 'vs' },
        fragment: { module: blitModule, entryPoint: 'fs', targets: [{ format: this.format }] },
        primitive: { topology: 'triangle-list' },
      }),
    ]);
    return { pre, forward, composite, resolve, blit };
  }

  buffer(size, usage, data) {
    const b = this.device.createBuffer({
      size: Math.max(16, Math.ceil(size / 16) * 16),
      usage,
      mappedAtCreation: !!data,
    });
    if (data) {
      new data.constructor(b.getMappedRange()).set(data);
      b.unmap();
    }
    this.buffers.push(b);
    return b;
  }

  bindGroup(pipeline, list) {
    return this.device.createBindGroup({
      layout: pipeline.getBindGroupLayout(0),
      entries: list.map((b, i) => ({ binding: i, resource: b.buffer ? b : { buffer: b } })),
    });
  }

  createBuffers({ width, mul }, weightData, { forward, composite, resolve, blit }) {
    const dev = this.device;
    const { W, H, images } = this;
    const pixelCount = W * H;
    const groups = width / 4;
    const U = GPUBufferUsage;
    const wBuf = this.half
      ? this.buffer(weightData.byteLength / 2, U.STORAGE, toHalf(weightData))
      : this.buffer(weightData.byteLength, U.STORAGE, weightData);
    const xBuf = this.buffer(pixelCount * this.shapes.inputWords * 4, U.STORAGE);
    const posBuf = this.buffer(pixelCount * 8, U.STORAGE);
    const nrmBuf = this.buffer(pixelCount * 8, U.STORAGE);
    const outBuf = this.buffer((SLOTS - RESOLVED + images) * pixelCount * wordsPerPixel(mul) * 4, U.STORAGE);
    const fwdBytes = FWD_HEADER_WORDS * 4 + groups * 16;
    const frameBytes = (FRAME_HEADER_WORDS + SLOTS * LIGHT_WORDS) * 4;
    const resolveBytes = RESOLVE_WORDS * 4;
    const align = dev.limits.minUniformBufferOffsetAlignment;
    this.ringStride = Math.ceil(Math.max(fwdBytes, frameBytes, resolveBytes) / align) * align;
    this.ringBuf = this.buffer(RING_SLOTS * this.ringStride, U.UNIFORM | U.COPY_DST);
    this.ring = new Uint8Array(RING_SLOTS * this.ringStride);
    this.ringUsed = 0;
    this.enc = null;
    this.framing = false;
    this.afterSubmit = [];
    const ring = (size) => ({ buffer: this.ringBuf, size });
    this.fwdF32 = new Float32Array(FWD_HEADER_WORDS + width);
    this.fwdU32 = new Uint32Array(this.fwdF32.buffer, 0, FWD_GRID_WORDS);
    this.compositePipeline = composite;
    this.fwdBuffers = [wBuf, xBuf, posBuf, ring(fwdBytes), outBuf, nrmBuf];
    this.setKernel(forward.k, forward.pipeline);
    this.compositeGroup = this.bindGroup(composite, [ring(frameBytes), outBuf, posBuf, ...(mul ? [nrmBuf] : [])]);
    this.resU32 = new Uint32Array(RESOLVE_WORDS);
    this.resF32 = new Float32Array(this.resU32.buffer);
    this.resolvePipeline = resolve;
    this.resolveGroup = this.bindGroup(resolve, [ring(resolveBytes), outBuf, posBuf]);
    this.image = dev.createTexture({
      size: [W, H],
      format: IMAGE_FORMAT,
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
    });
    this.imageView = this.image.createView();
    this.blitPipeline = blit;
    this.blitGroup = dev.createBindGroup({
      layout: blit.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: this.imageView },
        { binding: 1, resource: dev.createSampler({ magFilter: 'linear', minFilter: 'linear' }) },
      ],
    });
    if (dev.features.has('timestamp-query')) {
      this.querySet = dev.createQuerySet({ type: 'timestamp', count: 2 });
      this.queryBuf = this.buffer(16, U.QUERY_RESOLVE | U.COPY_SRC);
      this.readBuf = this.buffer(16, U.MAP_READ | U.COPY_DST);
    }
    return { xBuf, posBuf, nrmBuf };
  }

  async precomputeInputs(pipeline, { xBuf, posBuf, nrmBuf }, { grid, aux, pos }) {
    const dev = this.device;
    const upload = (data) => {
      const b = dev.createBuffer({
        size: Math.ceil(data.byteLength / 16) * 16,
        usage: GPUBufferUsage.STORAGE,
        mappedAtCreation: true,
      });
      new Uint16Array(b.getMappedRange()).set(data);
      b.unmap();
      return b;
    };
    const inputs = [upload(grid), upload(aux), upload(pos)];
    const enc = dev.createCommandEncoder();
    const pass = enc.beginComputePass();
    pass.setPipeline(pipeline);
    pass.setBindGroup(0, this.bindGroup(pipeline, [...inputs, xBuf, posBuf, nrmBuf]));
    pass.dispatchWorkgroups(Math.ceil((this.W * this.H) / PIXELS_PER_WORKGROUP));
    pass.end();
    dev.queue.submit([enc.finish()]);
    await dev.queue.onSubmittedWorkDone();
    inputs.forEach((b) => b.destroy());
  }

  get kernelName() {
    return kernelKey(this.kernel);
  }

  forwardPipeline(k) {
    const code = forwardWGSL({ ...this.shapes, ...k });
    return this.device.createComputePipelineAsync({
      layout: this.fwdLayout,
      compute: { module: this.device.createShaderModule({ code, label: 'relight network' }), entryPoint: 'main' },
    });
  }

  setKernel(k, pipeline) {
    this.kernel = k;
    this.forward = pipeline;
    this.fwdGroup = this.bindGroup(pipeline, this.fwdBuffers);
    this.tile = tileOf(k, this.shapes.width / 4);
  }

  tuneCandidates() {
    return this.kernels;
  }

  async prepareVariant(k) {
    const pipeline =
      kernelKey(k) === kernelKey(this.kernel) ? this.forward : await this.forwardPipeline(k).catch(() => null);
    return pipeline && { k, pipeline };
  }

  useVariant({ k, pipeline }) {
    this.setKernel(k, pipeline);
  }

  whenIdle() {
    return this.device.queue.onSubmittedWorkDone();
  }

  configure() {
    [this.context, this.halfContext].forEach((c) =>
      c.configure({ device: this.device, format: this.format, alphaMode: 'opaque' })
    );
  }

  currentTexture(context = this.context) {
    try {
      return context.getCurrentTexture();
    } catch (error) {
      this.configure();
      return context.getCurrentTexture();
    }
  }

  beginFrame() {
    this.framing = true;
  }

  endFrame() {
    this.framing = false;
    this.flush();
  }

  encoder() {
    if (!this.enc) {
      this.enc = this.device.createCommandEncoder();
    }
    return this.enc;
  }

  commit() {
    if (!this.framing) {
      this.flush();
    }
  }

  flush() {
    if (!this.enc) {
      return;
    }
    const dev = this.device;
    if (this.ringUsed) {
      dev.queue.writeBuffer(this.ringBuf, 0, this.ring, 0, this.ringUsed * this.ringStride);
    }
    dev.queue.submit([this.enc.finish()]);
    this.enc = null;
    this.ringUsed = 0;
    const after = this.afterSubmit;
    this.afterSubmit = [];
    after.forEach((f) => f());
  }

  stage(data) {
    if (this.ringUsed === RING_SLOTS) {
      this.flush();
    }
    const at = this.ringUsed * this.ringStride;
    this.ring.set(new Uint8Array(data.buffer, data.byteOffset, data.byteLength), at);
    this.ringUsed += 1;
    return at;
  }

  writeForwardUniforms(light, slot, stride, i0, i1, c0, xw, phase) {
    const ln = this.normLight(light);
    const { fwdU32, fwdF32 } = this;
    fwdU32.set([i0, i1, stride, slot, c0, xw, phase[0], phase[1]]);
    fwdF32.set(light.pos, FWD_LIGHT);
    fwdF32[FWD_LIGHT + 3] = light.radius;
    const w = this.w0Light;
    for (let c = 0; c < this.b0.length; c += 1) {
      fwdF32[FWD_HEADER_WORDS + c] =
        this.b0[c] + w[c * 4] * ln[0] + w[c * 4 + 1] * ln[1] + w[c * 4 + 2] * ln[2] + w[c * 4 + 3] * ln[3];
    }
  }

  evaluate(light, slot, stride = 1, r0 = 0, r1 = this.rows(stride), c0 = 0, c1 = this.cols(stride), phase = NO_PHASE) {
    r1 = Math.min(r1, this.rows(stride));
    c1 = Math.min(c1, this.cols(stride));
    const xw = c1 - c0;
    const i0 = r0 * xw;
    const i1 = r1 * xw;
    if (i1 <= i0 || xw <= 0) {
      return;
    }
    this.writeForwardUniforms(light, slot, stride, i0, i1, c0, xw, phase);

    const canStamp = Boolean(this.querySet && this.readBuf.mapState === 'unmapped');
    const timed = this.timeable(stride, r0, r1, c0, c1, canStamp);
    const stamped = timed && canStamp;
    const ownSubmit = timed && !stamped;
    if (ownSubmit) {
      this.flush();
    }
    const queued = ownSubmit ? this.queueDone() : null;
    const at = this.stage(this.fwdF32);
    const enc = this.encoder();
    const pass = enc.beginComputePass(
      stamped
        ? { timestampWrites: { querySet: this.querySet, beginningOfPassWriteIndex: 0, endOfPassWriteIndex: 1 } }
        : undefined
    );
    pass.setPipeline(this.forward);
    pass.setBindGroup(0, this.fwdGroup, [at]);
    pass.dispatchWorkgroups(Math.ceil((i1 - i0) / this.tile));
    pass.end();
    if (stamped) {
      enc.resolveQuerySet(this.querySet, 0, 2, this.queryBuf, 0);
      enc.copyBufferToBuffer(this.queryBuf, 0, this.readBuf, 0, 16);
    }
    if (timed) {
      this.time(stride, this.share(stride, r0, r1, c0, c1), stamped, queued);
    }
    if (ownSubmit) {
      this.flush();
    } else {
      this.commit();
    }
  }

  resolve(slot, target, stride, phase, [r0, r1, c0, c1], alpha, keep = null) {
    r1 = Math.min(r1, this.rows(stride));
    c1 = Math.min(c1, this.cols(stride));
    const [x0, x1, y0, y1] = this.span(stride, r0, r1, c0, c1);
    if (x1 <= x0 || y1 <= y0) {
      return null;
    }
    const [kx0, kx1, ky0, ky1] = keep && alpha < 1 ? keep : [0, 0, 0, 0];
    const keepsAll = kx0 <= x0 && kx1 >= x1 && ky0 <= y0 && ky1 >= y1;
    const evaluatedOnly = stride === 1 && phase[0] === 0 && phase[1] === 0;
    const sparse = evaluatedOnly || (alpha <= 0 && keepsAll) ? 1 : 0;
    const image = SLOTS - RESOLVED + target;
    const R = this.resU32;
    R.set([stride, phase[0], phase[1], slot, image, c0, c1, r0, r1, x0, y0, x1 - x0, y1 - y0, kx0, ky0, kx1, ky1]);
    this.resF32[RESOLVE_ALPHA] = alpha;
    this.resF32[RESOLVE_SIGMA] = this.tapSigmaScale();
    R[RESOLVE_SPARSE] = sparse;
    const at = this.stage(R);
    const pass = this.encoder().beginComputePass();
    pass.setPipeline(this.resolvePipeline);
    pass.setBindGroup(0, this.resolveGroup, [at]);
    const items = sparse ? (c1 - c0) * (r1 - r0) : (x1 - x0) * (y1 - y0);
    pass.dispatchWorkgroups(Math.ceil(items / PIXELS_PER_WORKGROUP));
    pass.end();
    this.commit();
    return [x0, x1, y0, y1];
  }

  queueDone() {
    return this.device.queue.onSubmittedWorkDone().then(() => performance.now());
  }

  time(stride, share, stamped, queued) {
    const pending = { stride, share, done: false, ms: null };
    this.timing.pending = pending;
    const settle = (ms) => {
      pending.ms = ms > 0 ? ms : null;
      pending.done = true;
    };
    this.afterSubmit.push(() => this.readTiming(stamped, queued, settle));
  }

  readTiming(stamped, queued, settle) {
    const start = performance.now();
    if (stamped) {
      this.readBuf
        .mapAsync(GPUMapMode.READ)
        .then(() => {
          const t = new BigUint64Array(this.readBuf.getMappedRange());
          const ms = Number(t[1] - t[0]) / 1e6;
          this.readBuf.unmap();
          settle(ms);
        })
        .catch(() => settle(null));
    } else {
      Promise.all([queued, this.queueDone()])
        .then(([before, after]) => {
          const ms = after - Math.max(start, before);
          settle(ms > QUEUE_GRAIN_MS ? ms : after - start);
        })
        .catch(() => settle(null));
    }
  }

  pollTiming() {
    const pending = this.timing.pending;
    if (pending?.done) {
      this.timing.pending = null;
      this.recordTiming(pending.stride, pending.share, pending.ms);
    }
  }

  composite(lights, exposure = 1, view = null) {
    if (!this.frame) {
      this.frame = new Float32Array(FRAME_HEADER_WORDS + SLOTS * LIGHT_WORDS);
      const { X, Y, Z, O, tx, ty } = this.cam;
      [O, X, Y, Z, [tx, ty]].forEach((v, i) => this.frame.set(v, i * 4));
      this.frameU32 = new Uint32Array(this.frame.buffer);
    }
    const F = this.frame;
    const U32 = this.frameU32;
    F[FRAME_EXPOSURE] = exposure;
    const n = Math.min(lights.length, SLOTS);
    U32[FRAME_LIGHT_COUNT] = n;
    for (let i = 0; i < n; i += 1) {
      const l = lights[i];
      const o = FRAME_HEADER_WORDS + i * LIGHT_WORDS;
      F[o] = l.pos[0];
      F[o + 1] = l.pos[1];
      F[o + 2] = l.pos[2];
      F[o + 3] = l.radius;
      for (let c = 0; c < 3; c += 1) {
        F[o + LIGHT_EMISSION + c] = l.color[c] * l.intensity;
      }
      const resolved = l.resolved != null;
      U32[o + LIGHT_INFO] = resolved ? SLOTS - RESOLVED + l.resolved : l.slot;
      U32[o + LIGHT_INFO + 1] = resolved ? FULL_RES_STRIDE : l.stride || 1;
      U32[o + LIGHT_INFO + 2] = l.hidden ? 0 : 1;
    }
    const at = this.stage(F);
    const pass = this.encoder().beginRenderPass({
      colorAttachments: [{ view: this.imageView, loadOp: 'load', storeOp: 'store' }],
    });
    const [x0, x1, y0, y1] = this.drawRect(view);
    pass.setScissorRect(x0, this.H - y1, x1 - x0, y1 - y0);
    pass.setPipeline(this.compositePipeline);
    pass.setBindGroup(0, this.compositeGroup, [at]);
    pass.draw(3);
    pass.end();
    this.commit();
  }

  copyImage(context) {
    const pass = this.encoder().beginRenderPass({
      colorAttachments: [{ view: this.currentTexture(context).createView(), loadOp: 'clear', storeOp: 'store' }],
    });
    pass.setPipeline(this.blitPipeline);
    pass.setBindGroup(0, this.blitGroup);
    pass.draw(3);
    pass.end();
  }

  snapshot() {
    this.copyImage(this.context);
    this.flush();
    return this.canvas.transferToImageBitmap();
  }

  halfImage(done) {
    this.copyImage(this.halfContext);
    this.afterSubmit.push(() => done(this.halfCanvas.transferToImageBitmap()));
    this.commit();
  }

  dispose() {
    this.enc = null;
    this.afterSubmit = [];
    this.image?.destroy();
    this.image = null;
    this.halfContext?.unconfigure();
    this.context?.unconfigure();
    this.querySet?.destroy();
    this.buffers.forEach((b) => b.destroy());
    this.buffers = [];
  }
}
