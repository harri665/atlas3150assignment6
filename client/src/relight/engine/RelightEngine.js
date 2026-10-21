import { NO_PHASE, RESOLVED, RelightBase, SLOTS, readNetwork } from './RelightBase';
import { fence } from './util';

export { SLOTS };

const BAND_BYTES = 16 << 20;
const MIN_BAND_HEIGHT = 8;
const OUTPUTS = [1, 2, 4, 8];
const DEFAULT_OUTPUTS = 2;
const MAX_ENCODE_TARGETS = 8;
const MAX_GRID_WIDTH = 4096;
const FENCE_TIMEOUT_MS = 1000;
const FENCE_POLL_MS = 1;
const outputsName = (n) => `o${n}`;

const UNIT = { input: 0, resolved: 1, positions: 2, aux: 4, grid: 6 };
const SAMPLER_UNITS = [
  ['src', UNIT.input],
  ['outT', UNIT.input],
  ['resT', UNIT.resolved],
  ['posT', UNIT.positions],
  ['auxT', UNIT.aux],
  ['gridT', UNIT.grid],
];

const FULL_RES_STRIDE = 0;
const SIDE = { upsampled: 0, kept: 1, evaluated: 2 };
const OUTPUT_STAGE = 'out';
const LAYER0_STAGE = 'l0';
const HIDDEN_STAGE = 'hid';

const FULLSCREEN_VS = `#version 300 es
void main() {
  gl_Position = vec4(gl_VertexID == 1 ? 3.0 : -1.0, gl_VertexID == 2 ? 3.0 : -1.0, 0.0, 1.0);
}`;

const HEADER = `#version 300 es
precision highp float; precision highp int;
precision highp sampler2D; precision highp sampler2DArray; precision highp usampler2D;
`;

const GEOMETRY_GLSL = `
uniform usampler2D posT; uniform sampler2DArray auxT;
uniform vec2 posMap; uniform vec3 camO;
vec4 geomAt(ivec2 px) {
  uvec4 q = texelFetch(posT, px, 0);
  if (q.x == 0u) return vec4(0.0);
  vec3 w = posMap.x + (vec3(q.xyz) - 1.0) * posMap.y;
  return vec4(w, length(w - camO));
}
vec3 normalAt(ivec2 px) {
  return vec3(texelFetch(auxT, ivec3(px, 0), 0).w, texelFetch(auxT, ivec3(px, 1), 0).xy);
}`;

const SOLID_ANGLE_GLSL = `
float solidAngle(float r, float d) {
  float s = min(r / d, 1.0);
  return 6.283185307 * s * s / (1.0 + sqrt(max(1.0 - s * s, 0.0)));
}`;

const TAP_GLSL = `
ivec2 tapCell(int k, ivec2 c0, ivec2 c1) {
  return ivec2((k & 1) == 1 ? c1.x : c0.x, k >= 2 ? c1.y : c0.y);
}
float tapWeight(int k, vec2 t, vec4 g, vec4 q, float sig) {
  float wb = ((k & 1) == 1 ? t.x : 1.0 - t.x) * (k >= 2 ? t.y : 1.0 - t.y);
  vec3 dq = q.xyz - g.xyz;
  float wg = (q.w > 0.0) == (g.w > 0.0) ? exp(-dot(dq, dq) / (2.0 * sig * sig)) : 0.0;
  return wb * (wg + 1e-4);
}`;

const range = (n) => [...Array(n).keys()];
const outputDecls = (n) => range(n).map((j) => `layout(location = ${j}) out vec4 o${j};`).join('\n');

function encodeFS({ W, H, levels, feats, gridRes, gridOff, auxDim, gridWidth, first, count }) {
  const encoded = levels * feats;
  const input = (i) => {
    if (i < encoded) {
      const l = Math.floor(i / feats);
      return `bil(${gridRes[l]}, ${gridOff[l]}, ${i % feats}, uv)`;
    }
    if (i < encoded + auxDim) {
      const j = i - encoded;
      return `a${j >> 2}.${'xyzw'[j & 3]}`;
    }
    return '0.0';
  };
  return `${HEADER}
uniform sampler2D gridT; uniform sampler2DArray auxT;
${outputDecls(count)}
float gridAt(int i) { return texelFetch(gridT, ivec2(i % ${gridWidth}, i / ${gridWidth}), 0).x; }
float bil(int R, int off, int f, vec2 uv) {
  vec2 g = uv * float(R - 1);
  ivec2 c = min(ivec2(floor(g)), ivec2(R - 2));
  vec2 t = g - vec2(c);
  int i00 = off + (c.y * R + c.x) * ${feats} + f;
  int i10 = i00 + R * ${feats};
  float top = mix(gridAt(i00), gridAt(i00 + ${feats}), t.x);
  float bot = mix(gridAt(i10), gridAt(i10 + ${feats}), t.x);
  return mix(top, bot, t.y);
}
void main() {
  ivec2 px = ivec2(gl_FragCoord.xy);
  vec2 uv = (vec2(px) + 0.5) / vec2(${W}.0, ${H}.0);
  vec4 a0 = texelFetch(auxT, ivec3(px, 0), 0), a1 = texelFetch(auxT, ivec3(px, 1), 0);
  ${range(count).map((j) => `o${j} = vec4(${[0, 1, 2, 3].map((c) => input(4 * (first + j) + c)).join(', ')});`).join('\n  ')}
}`;
}

function geoFeaturesGLSL() {
  return `${GEOMETRY_GLSL}
uniform vec3 boxLo, boxHi; uniform vec2 radRange;${SOLID_ANGLE_GLSL}
void geoFeatures(ivec2 px, vec4 L, out vec4 g0, out vec4 g1) {
  vec3 c = boxLo + (L.xyz + 1.0) * 0.5 * (boxHi - boxLo);
  float r = radRange.x + (L.w + 1.0) * 0.5 * (radRange.y - radRange.x);
  vec4 gm = geomAt(px);
  float valid = gm.w > 0.0 ? 1.0 : 0.0;
  vec3 v = c - gm.xyz;
  float d = max(length(v), 1e-4);
  vec3 l = v / d;
  float cosv = dot(normalAt(px), l);
  float omega = solidAngle(r, d);
  g0 = vec4(l, cosv) * valid;
  g1 = vec4(0.5 * log(d), 0.25 * log(omega + 1e-6), 0.0, 0.0) * valid;
}`;
}

function layerFS({ inputVec4s, outputVec4s, relu, stage, pixelVec4s = 0, geo = false }) {
  const J = range(outputVec4s);
  const accumulate = (x, b) =>
    J.map(
      (j) =>
        `a${j} += w[${b} + ${4 * j}] * ${x}.x + w[${b} + ${4 * j + 1}] * ${x}.y + ` +
        `w[${b} + ${4 * j + 2}] * ${x}.z + w[${b} + ${4 * j + 3}] * ${x}.w;`
    ).join('\n    ');
  const first = stage === LAYER0_STAGE;
  const textures = first ? pixelVec4s : inputVec4s;
  const rowBlock = (row) => row * outputVec4s * 4;
  const hiddenPrecision = stage === OUTPUT_STAGE ? '' : 'precision mediump float;';
  return `${HEADER}
uniform sampler2DArray src;
uniform int yOff;
${first ? 'uniform vec4 ln; uniform int stride; uniform ivec2 phase;' : ''}
${first && geo ? geoFeaturesGLSL() : ''}
${hiddenPrecision}
layout(std140) uniform Wt { vec4 w[${inputVec4s * outputVec4s * 4}]; };
uniform vec4 bias[${outputVec4s}];
${outputDecls(outputVec4s)}
void main() {
  ivec2 q = ivec2(gl_FragCoord.xy);
  ${first
    ? 'vec4 L = ln; ivec2 px = min(ivec2(q.x, q.y + yOff) * stride + phase, textureSize(src, 0).xy - 1);'
    : 'ivec2 px = ivec2(q.x, q.y - yOff);'}
  ${J.map((j) => `vec4 a${j} = bias[${j}];`).join(' ')}
  for (int k = 0; k < ${textures}; k++) {
    vec4 x = texelFetch(src, ivec3(px, k), 0);
    int b = k * ${outputVec4s * 4};
    ${accumulate('x', 'b')}
  }
  ${first ? accumulate('L', rowBlock(pixelVec4s)) : ''}
  ${first && geo ? `vec4 g0, g1;
  geoFeatures(px, ln, g0, g1);
  ${accumulate('g0', rowBlock(pixelVec4s + 1))}
  ${accumulate('g1', rowBlock(pixelVec4s + 2))}` : ''}
  ${J.map((j) => `o${j} = ${relu ? `max(a${j}, vec4(0.0))` : `a${j}`};`).join('\n  ')}
}`;
}

function readNetGLSL(texture, cell, mul) {
  return mul
    ? `vec4 v0 = texelFetch(${texture}, ivec3(${cell}, 2 * slot), 0), v1 = texelFetch(${texture}, ivec3(${cell}, 2 * slot + 1), 0);
  a = v0.xyz; b = vec3(v0.w, v1.xy);`
    : `a = texelFetch(${texture}, ivec3(${cell}, slot), 0).xyz; b = vec3(0.0);`;
}

const compositeFS = (W, H, mul) => `${HEADER}
uniform sampler2DArray outT; uniform sampler2DArray resT;
${GEOMETRY_GLSL}${SOLID_ANGLE_GLSL}${TAP_GLSL}
uniform vec3 camX, camY, camZ; uniform vec2 tanxy;
uniform float exposure; uniform int nLights;
uniform vec4 lPR[${SLOTS}]; uniform vec3 lE[${SLOTS}]; uniform ivec3 lInfo[${SLOTS}];
layout(location = 0) out vec4 disp;
const float W = ${W}.0, H = ${H}.0;

vec3 camDir(vec2 uv) {
  return normalize(camX * ((0.5 - uv.x) * 2.0 * tanxy.x) + camY * ((0.5 - uv.y) * 2.0 * tanxy.y) + camZ);
}
float directCov(ivec2 pix, int l) {
  vec3 c = lPR[l].xyz; float r = lPR[l].w;
  vec4 g = geomAt(pix);
  float surf = g.w > 0.0 ? g.w : 1e9;
  vec3 oc = camO - c;
  float px = float(pix.x), py = float(pix.y);
  vec3 d0 = camDir(vec2((px + 0.5) / W, (py + 0.5) / H));
  float b0 = dot(d0, oc);
  float pixAng = 2.0 * tanxy.x / W * 1.5;
  float dist2 = dot(oc, oc) - b0 * b0;
  float slack = r + pixAng * length(oc);
  if (dist2 > slack * slack || b0 > 0.0) return 0.0;
  float cnt = 0.0;
  for (int sy = 0; sy < 4; sy++) {
    for (int sx = 0; sx < 4; sx++) {
      vec3 d = camDir(vec2((px + (float(sx) + 0.5) / 4.0) / W, (py + (float(sy) + 0.5) / 4.0) / H));
      float b = dot(d, oc);
      float disc = b * b - dot(oc, oc) + r * r;
      if (disc >= 0.0) {
        float t0 = -b - sqrt(disc);
        if (t0 > 0.0 && t0 < surf) cnt += 1.0;
      }
    }
  }
  return cnt / 16.0;
}
void outAt(int slot, ivec2 c, out vec3 a, out vec3 b) {
  ${readNetGLSL('outT', 'c', mul)}
}
void netAt(int slot, int s, ivec2 pix, out vec3 a, out vec3 b) {
  if (s == ${FULL_RES_STRIDE}) {
    ${readNetGLSL('resT', 'pix', mul)}
    return;
  }
  if (s <= 1) {
    outAt(slot, pix, a, b);
    return;
  }
  ivec2 last = ivec2((${W} + s - 1) / s - 1, (${H} + s - 1) / s - 1);
  vec2 f = vec2(pix) / float(s);
  ivec2 c0 = min(ivec2(f), last), c1 = min(c0 + 1, last);
  vec2 t = f - vec2(c0);
  vec4 g = geomAt(pix);
  float sig = 1.5 * float(s) * 2.0 * tanxy.x / W * max(g.w, 1e-3);
  a = vec3(0.0); b = vec3(0.0); float ws = 0.0;
  for (int k = 0; k < 4; k++) {
    ivec2 c = tapCell(k, c0, c1);
    float w = tapWeight(k, t, g, geomAt(c * s), sig);
    vec3 na, nb;
    outAt(slot, c, na, nb);
    a += w * na; b += w * nb;
    ws += w;
  }
  a /= max(ws, 1e-12); b /= max(ws, 1e-12);
}
vec3 lit(int l, ivec2 pix) {
  vec3 a, b;
  netAt(lInfo[l].x, lInfo[l].y, pix, a, b);
  ${mul
    ? `vec4 gm = geomAt(pix);
  if (gm.w <= 0.0) return max(b, 0.0);
  vec3 v = lPR[l].xyz - gm.xyz;
  float d = max(length(v), 1e-4);
  float omega = solidAngle(lPR[l].w, d);
  float G = omega * max(dot(normalAt(pix), v / d), 0.0) / 3.141592654;
  return max(a * G + b, 0.0);`
    : 'return max(a, 0.0);'}
}
vec3 tone(vec3 x) { vec3 y = max(x, 0.0) * exposure; return y / (1.0 + y); }
vec3 srgb(vec3 c) { return mix(1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, 12.92 * c, lessThanEqual(c, vec3(0.0031308))); }
void main() {
  ivec2 pix = ivec2(gl_FragCoord.xy);
  vec3 I = vec3(0.0);
  for (int l = 0; l < ${SLOTS}; l++) {
    if (l >= nLights) break;
    I += lE[l] * (lit(l, pix) + (lInfo[l].z != 0 ? directCov(pix, l) : 0.0));
  }
  disp = vec4(clamp(srgb(tone(I)), 0.0, 1.0), 1.0);
}`;

const resolveFS = (W, H, mul) => {
  const firstLayer = mul ? '2 * slot' : 'slot';
  return `${HEADER}
uniform sampler2DArray outT;
${GEOMETRY_GLSL}${TAP_GLSL}
uniform int slot, s, side; uniform ivec2 phase; uniform float sigK;
uniform ivec4 items, keep;
layout(location = 0) out vec4 o0;
${mul ? 'layout(location = 1) out vec4 o1;' : ''}
void main() {
  ivec2 pix = ivec2(gl_FragCoord.xy);
  ivec2 lo = items.xz;
  ivec2 hi = max(min(items.yw - 1, (ivec2(${W - 1}, ${H - 1}) - phase) / s), lo);
  ivec2 d = pix - phase;
  ivec2 c = max(d, ivec2(0)) / s;
  bool on = all(greaterThanEqual(d, ivec2(0))) && d.x % s == 0 && d.y % s == 0
    && all(greaterThanEqual(c, lo)) && all(lessThanEqual(c, hi));
  if (side == ${SIDE.evaluated}) {
    if (!on) discard;
    o0 = texelFetch(outT, ivec3(c, ${firstLayer}), 0);
    ${mul ? 'o1 = texelFetch(outT, ivec3(c, 2 * slot + 1), 0);' : ''}
    return;
  }
  bool kept = all(greaterThanEqual(pix, keep.xy)) && all(lessThan(pix, keep.zw));
  if (on || kept != (side == ${SIDE.kept})) discard;
  vec2 f = max(vec2(d), 0.0) / float(s);
  ivec2 c0 = clamp(ivec2(f), lo, hi), c1 = min(c0 + 1, hi);
  vec2 t = clamp(f - vec2(c0), 0.0, 1.0);
  vec4 g = geomAt(pix);
  float sig = sigK * float(s) * max(g.w, 1e-3);
  vec4 a = vec4(0.0), b = vec4(0.0); float ws = 0.0;
  for (int k = 0; k < 4; k++) {
    ivec2 cc = tapCell(k, c0, c1);
    float w = tapWeight(k, t, g, geomAt(cc * s + phase), sig);
    a += w * texelFetch(outT, ivec3(cc, ${firstLayer}), 0);
    ${mul ? 'b += w * texelFetch(outT, ivec3(cc, 2 * slot + 1), 0);' : ''}
    ws += w;
  }
  o0 = a / max(ws, 1e-12);
  ${mul ? 'o1 = b / max(ws, 1e-12);' : ''}
}`;
};

function packLayer(layer, inputs, inputVec4s, outputVec4s, columnOf) {
  const outputs = layer.shape[0];
  const passes = Math.ceil(Math.ceil(outputs / 4) / outputVec4s);
  return Array.from({ length: passes }, (_, p) => {
    const w = new Float32Array(inputVec4s * outputVec4s * 16);
    const b = new Float32Array(outputVec4s * 4);
    for (let j = 0; j < outputVec4s; j += 1) {
      for (let r = 0; r < 4; r += 1) {
        const o = 4 * (p * outputVec4s + j) + r;
        if (o >= outputs) {
          continue;
        }
        b[j * 4 + r] = layer.b[o];
        for (let k = 0; k < inputVec4s; k += 1) {
          for (let c = 0; c < 4; c += 1) {
            const i = columnOf(k, c);
            if (i >= 0) {
              w[((k * outputVec4s + j) * 4 + c) * 4 + r] = layer.w[o * inputs + i];
            }
          }
        }
      }
    }
    return { w, b };
  });
}

function createCanvas(width, height) {
  return typeof OffscreenCanvas === 'undefined'
    ? Object.assign(document.createElement('canvas'), { width, height })
    : new OffscreenCanvas(width, height);
}

export class RelightEngine extends RelightBase {
  constructor(
    { scene, layers, grid, gridOff, aux, pos },
    { bandBytes = BAND_BYTES, kernel = null, images = RESOLVED } = {}
  ) {
    super(scene, pos);
    this.images = images;
    this.openContext();
    this.resources = { textures: [], framebuffers: [], programs: [], buffers: [] };
    this.readShape(readNetwork(scene.network, layers), layers);
    this.uploadPixels(aux, pos);
    this.encodeInputs(grid, gridOff);
    this.createImageTargets();
    this.createBands(bandBytes);
    this.passes = new Map();
    const named = this.outputs.find((n) => outputsName(n) === kernel);
    this.setOutputs(named ?? this.outputs.filter((n) => n <= DEFAULT_OUTPUTS).pop() ?? this.outputs[0]);
    const gl = this.gl;
    gl.bindVertexArray(null);
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, null);
    gl.bindTexture(gl.TEXTURE_2D, null);
  }

  openContext() {
    this.canvas = createCanvas(this.W, this.H);
    const gl = this.canvas.getContext('webgl2', {
      alpha: false,
      antialias: false,
      depth: false,
      stencil: false,
      premultipliedAlpha: false,
      powerPreference: 'high-performance',
    });
    if (!gl) {
      throw new Error('WebGL2 is not available');
    }
    this.gl = gl;
    this.backend = 'webgl';
    if (!gl.getExtension('EXT_color_buffer_float') && !gl.getExtension('EXT_color_buffer_half_float')) {
      throw new Error('this GPU cannot render to floating-point textures');
    }
    this.timer = gl.getExtension('EXT_disjoint_timer_query_webgl2');
  }

  readShape(network, layers) {
    const gl = this.gl;
    const groups = network.width / 4;
    this.network = network;
    this.hiddenLayers = network.hiddenLayers;
    const limit = (p) => gl.getParameter(p);
    const maxBlock = limit(gl.MAX_UNIFORM_BLOCK_SIZE);
    this.maxTargets = Math.min(limit(gl.MAX_DRAW_BUFFERS), limit(gl.MAX_COLOR_ATTACHMENTS));
    this.outputs = OUTPUTS.filter((n) => n <= this.maxTargets && groups % n === 0 && groups * 64 * n <= maxBlock);
    this.shape = {
      width: network.width,
      groups,
      pixelVec4s: Math.ceil(network.pixelInputs / 4),
      pixelInputs: network.pixelInputs,
      inputs: network.inputs,
      geo: network.geo,
      mul: network.mul,
      align: limit(gl.UNIFORM_BUFFER_OFFSET_ALIGNMENT),
    };
    this.layers = layers;
  }

  uploadPixels(aux, pos) {
    const gl = this.gl;
    const { W, H } = this;
    this.posMap = [this.posLo, this.posStep];
    this.auxTex = this.texture(gl.TEXTURE_2D_ARRAY, gl.RGBA16F, W, H, 2);
    gl.texSubImage3D(gl.TEXTURE_2D_ARRAY, 0, 0, 0, 0, W, H, 2, gl.RGBA, gl.HALF_FLOAT, aux);
    this.posTex = this.texture(gl.TEXTURE_2D, gl.RGBA16UI, W, H);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, W, H, gl.RGBA_INTEGER, gl.UNSIGNED_SHORT, pos);
    this.vao = gl.createVertexArray();
    this.xTex = this.texture(gl.TEXTURE_2D_ARRAY, gl.RGBA16F, W, H, this.shape.pixelVec4s);
  }

  encodeInputs(grid, gridOff) {
    const gl = this.gl;
    const { W, H } = this;
    const { pixelVec4s } = this.shape;
    const net = this.scene.network;
    const gridWidth = Math.min(MAX_GRID_WIDTH, gl.getParameter(gl.MAX_TEXTURE_SIZE));
    const rows = Math.ceil(grid.length / gridWidth);
    const padded = new Uint16Array(gridWidth * rows);
    padded.set(grid);
    const gridTex = this.texture(gl.TEXTURE_2D, gl.R16F, gridWidth, rows);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, gridWidth, rows, gl.RED, gl.HALF_FLOAT, padded);
    this.bindTexture(UNIT.grid, gl.TEXTURE_2D, gridTex);
    this.bindTexture(UNIT.aux, gl.TEXTURE_2D_ARRAY, this.auxTex);
    gl.bindVertexArray(this.vao);
    gl.viewport(0, 0, W, H);
    const shapes = {
      W,
      H,
      levels: this.network.levels,
      feats: net.feats,
      gridRes: net.grid_res,
      gridOff,
      auxDim: this.network.auxDim,
      gridWidth,
    };
    const perPass = Math.min(this.maxTargets, MAX_ENCODE_TARGETS);
    for (let first = 0; first < pixelVec4s; first += perPass) {
      const count = Math.min(perPass, pixelVec4s - first);
      const { p } = this.program(encodeFS({ ...shapes, first, count }), 'input encoding');
      const fbo = this.framebuffer(Array.from({ length: count }, (_, j) => [this.xTex, first + j]));
      gl.useProgram(p);
      gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, fbo);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    }
    gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, null);
    gl.deleteTexture(gridTex);
    this.resources.textures.splice(this.resources.textures.indexOf(gridTex), 1);
  }

  createImageTargets() {
    const gl = this.gl;
    const { W, H, images } = this;
    const { mul } = this.shape;
    const layersPerImage = mul ? 2 : 1;
    const targets = (texture, count) =>
      Array.from({ length: count }, (_, s) =>
        this.framebuffer(Array.from({ length: layersPerImage }, (__, j) => [texture, s * layersPerImage + j]))
      );
    this.outTex = this.texture(gl.TEXTURE_2D_ARRAY, gl.RGBA16F, W, H, SLOTS * layersPerImage);
    this.outFbos = targets(this.outTex, SLOTS);
    this.resTex = this.texture(gl.TEXTURE_2D_ARRAY, gl.RGBA16F, W, H, images * layersPerImage);
    this.resFbos = targets(this.resTex, images);
    this.pComp = this.program(compositeFS(W, H, mul), 'composite');
    this.pResolve = this.program(resolveFS(W, H, mul), 'resolve');
  }

  createBands(bandBytes) {
    const gl = this.gl;
    const { W, H } = this;
    const { groups, mul } = this.shape;
    const bytesPerRow = W * groups * 8;
    const th = Math.max(MIN_BAND_HEIGHT, Math.min(H, Math.floor(bandBytes / bytesPerRow)));
    this.arrs = [0, 1].map(() => this.texture(gl.TEXTURE_2D_ARRAY, gl.RGBA16F, W, th, groups));
    this.th = th;
    this.pOut = this.program(
      layerFS({ inputVec4s: groups, outputVec4s: mul ? 2 : 1, relu: false, stage: OUTPUT_STAGE }),
      'output layer'
    );
  }

  passesFor(out) {
    if (this.passes.has(out)) {
      return this.passes.get(out);
    }
    const gl = this.gl;
    const { layers } = this;
    const { width, groups, pixelVec4s, pixelInputs, inputs, geo, mul, align } = this.shape;
    const before = { programs: this.resources.programs.length, framebuffers: this.resources.framebuffers.length };
    const blocks = [];
    let uboLen = 0;
    const place = ({ w, b }) => {
      const off = uboLen;
      uboLen += Math.ceil(w.byteLength / align) * align;
      blocks.push([off, w]);
      return { off, size: w.byteLength, b };
    };
    const layer0Vec4s = pixelVec4s + 1 + (geo ? 2 : 0);
    const layer0Column = (k, c) => {
      if (k < pixelVec4s) {
        return 4 * k + c < pixelInputs ? 4 * k + c : -1;
      }
      const i = pixelInputs + 4 * (k - pixelVec4s) + c;
      return i < inputs ? i : -1;
    };
    const denseColumn = (k, c) => 4 * k + c;
    const l0 = packLayer(layers[0], inputs, layer0Vec4s, out, layer0Column);
    const hidden = layers
      .slice(1, this.hiddenLayers + 1)
      .map((L) => packLayer(L, width, groups, out, denseColumn));
    const w = [l0, ...hidden].map((passes) => passes.map(place));
    const wOut = place(packLayer(layers[this.hiddenLayers + 1], width, groups, mul ? 2 : 1, denseColumn)[0]);
    const all = new Float32Array(uboLen / 4);
    blocks.forEach(([off, data]) => all.set(data, off / 4));
    const ubo = gl.createBuffer();
    this.resources.buffers.push(ubo);
    gl.bindBuffer(gl.UNIFORM_BUFFER, ubo);
    gl.bufferData(gl.UNIFORM_BUFFER, all, gl.STATIC_DRAW);
    gl.bindBuffer(gl.UNIFORM_BUFFER, null);
    const passes = {
      out,
      ubo,
      w,
      wOut,
      fbos: this.arrs.map((t) =>
        Array.from({ length: groups / out }, (_, p) =>
          this.framebuffer(Array.from({ length: out }, (_, j) => [t, p * out + j]))
        )
      ),
      l0: this.program(
        layerFS({ inputVec4s: layer0Vec4s, outputVec4s: out, relu: true, stage: LAYER0_STAGE, pixelVec4s, geo }),
        'layer 0'
      ),
      hid: this.program(layerFS({ inputVec4s: groups, outputVec4s: out, relu: true, stage: HIDDEN_STAGE }), 'hidden layer'),
    };
    passes.resources = {
      programs: this.resources.programs.slice(before.programs),
      framebuffers: this.resources.framebuffers.slice(before.framebuffers),
    };
    this.passes.set(out, passes);
    return passes;
  }

  setOutputs(out) {
    this.net = { ...this.passesFor(out), th: this.th, arrs: this.arrs, outLayer: this.pOut };
  }

  get kernelName() {
    return outputsName(this.net.out);
  }

  tuneCandidates() {
    return this.outputs;
  }

  useVariant(out) {
    this.setOutputs(out);
  }

  whenIdle() {
    return fence(this.gl);
  }

  afterTune() {
    this.dropOtherPasses();
  }

  dropOtherPasses() {
    const gl = this.gl;
    this.passes.forEach((passes, out) => {
      if (out === this.net.out) {
        return;
      }
      const drop = (list, items, del) =>
        items.forEach((item) => {
          del(item);
          list.splice(list.indexOf(item), 1);
        });
      drop(this.resources.programs, passes.resources.programs, (p) => gl.deleteProgram(p));
      drop(this.resources.framebuffers, passes.resources.framebuffers, (f) => gl.deleteFramebuffer(f));
      drop(this.resources.buffers, [passes.ubo], (b) => gl.deleteBuffer(b));
      this.passes.delete(out);
    });
  }

  texture(target, format, w, h, layers = 1) {
    const gl = this.gl;
    const t = gl.createTexture();
    this.resources.textures.push(t);
    gl.bindTexture(target, t);
    if (target === gl.TEXTURE_2D_ARRAY) {
      gl.texStorage3D(target, 1, format, w, h, layers);
    } else {
      gl.texStorage2D(target, 1, format, w, h);
    }
    gl.texParameteri(target, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(target, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(target, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(target, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    return t;
  }

  bindTexture(unit, target, texture) {
    const gl = this.gl;
    gl.activeTexture(gl.TEXTURE0 + unit);
    gl.bindTexture(target, texture);
  }

  framebuffer(attach) {
    const gl = this.gl;
    const f = gl.createFramebuffer();
    this.resources.framebuffers.push(f);
    gl.bindFramebuffer(gl.FRAMEBUFFER, f);
    attach.forEach(([t, layer], j) =>
      gl.framebufferTextureLayer(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0 + j, t, 0, layer)
    );
    gl.drawBuffers(attach.map((_, j) => gl.COLOR_ATTACHMENT0 + j));
    const status = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    if (status !== gl.FRAMEBUFFER_COMPLETE) {
      throw new Error(`framebuffer incomplete (0x${status.toString(16)})`);
    }
    return f;
  }

  program(fs, label) {
    const gl = this.gl;
    const shader = (type, src) => {
      const s = gl.createShader(type);
      gl.shaderSource(s, src);
      gl.compileShader(s);
      return s;
    };
    const vs = shader(gl.VERTEX_SHADER, FULLSCREEN_VS);
    const f = shader(gl.FRAGMENT_SHADER, fs);
    const p = gl.createProgram();
    gl.attachShader(p, vs);
    gl.attachShader(p, f);
    gl.linkProgram(p);
    const log = gl.getProgramParameter(p, gl.LINK_STATUS)
      ? null
      : gl.getShaderInfoLog(f) || gl.getShaderInfoLog(vs) || gl.getProgramInfoLog(p);
    gl.deleteShader(vs);
    gl.deleteShader(f);
    if (log !== null) {
      gl.deleteProgram(p);
      throw new Error(`${label} shader: ${log}`);
    }
    this.resources.programs.push(p);
    const u = {};
    for (let i = 0, n = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS); i < n; i += 1) {
      const name = gl.getActiveUniform(p, i).name;
      u[name.replace(/\[0\]$/, '')] = gl.getUniformLocation(p, name);
    }
    const block = gl.getUniformBlockIndex(p, 'Wt');
    if (block !== gl.INVALID_INDEX) {
      gl.uniformBlockBinding(p, block, 0);
    }
    gl.useProgram(p);
    SAMPLER_UNITS.forEach(([name, unit]) => {
      if (u[name]) {
        gl.uniform1i(u[name], unit);
      }
    });
    if (u.posMap) {
      gl.uniform2fv(u.posMap, this.posMap);
      gl.uniform3fv(u.camO, this.cam.O);
    }
    if (u.boxLo) {
      gl.uniform3fv(u.boxLo, this.lo);
      gl.uniform3fv(u.boxHi, this.hi);
      gl.uniform2f(u.radRange, this.rmin, this.rmax);
    }
    gl.useProgram(null);
    return { p, u };
  }

  evaluate(light, slot, stride = 1, r0 = 0, r1 = this.rows(stride), c0 = 0, c1 = this.cols(stride), phase = NO_PHASE) {
    const gl = this.gl;
    const E = this.net;
    r1 = Math.min(r1, this.rows(stride));
    c1 = Math.min(c1, this.cols(stride));
    const gw = c1 - c0;
    if (r1 <= r0 || gw <= 0) {
      return;
    }
    const ln = this.normLight(light);
    const draw = (chunk, P) => {
      gl.bindBufferRange(gl.UNIFORM_BUFFER, 0, E.ubo, chunk.off, chunk.size);
      gl.uniform4fv(P.u.bias, chunk.b);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    };
    const setLight = (P) => {
      gl.uniform4fv(P.u.ln, ln);
      gl.uniform1i(P.u.stride, stride);
      gl.uniform2i(P.u.phase, phase[0], phase[1]);
    };

    this.startTiming(stride, r0, r1, c0, c1);
    gl.bindVertexArray(this.vao);
    this.bindTexture(UNIT.positions, gl.TEXTURE_2D, this.posTex);
    this.bindTexture(UNIT.aux, gl.TEXTURE_2D_ARRAY, this.auxTex);
    for (let y0 = r0; y0 < r1; y0 += E.th) {
      const h = Math.min(E.th, r1 - y0);
      let cur = -1;
      for (let l = 0; l <= this.hiddenLayers; l += 1) {
        const P = l === 0 ? E.l0 : E.hid;
        const dst = l === 0 ? 0 : 1 - cur;
        gl.useProgram(P.p);
        this.bindTexture(UNIT.input, gl.TEXTURE_2D_ARRAY, l === 0 ? this.xTex : E.arrs[cur]);
        gl.uniform1i(P.u.yOff, l === 0 ? y0 : 0);
        if (l === 0) {
          setLight(P);
        }
        gl.viewport(c0, 0, gw, h);
        E.w[l].forEach((chunk, p) => {
          gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, E.fbos[dst][p]);
          draw(chunk, P);
        });
        cur = dst;
      }
      const P = E.outLayer;
      gl.useProgram(P.p);
      this.bindTexture(UNIT.input, gl.TEXTURE_2D_ARRAY, E.arrs[cur]);
      gl.uniform1i(P.u.yOff, y0);
      gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, this.outFbos[slot]);
      gl.viewport(c0, y0, gw, h);
      draw(E.wOut, P);
    }
    this.stopTiming();
  }

  resolve(slot, target, stride, phase, [r0, r1, c0, c1], alpha, keep = null) {
    const gl = this.gl;
    r1 = Math.min(r1, this.rows(stride));
    c1 = Math.min(c1, this.cols(stride));
    const [x0, x1, y0, y1] = this.span(stride, r0, r1, c0, c1);
    if (x1 <= x0 || y1 <= y0) {
      return null;
    }
    const [kx0, kx1, ky0, ky1] = keep && alpha < 1 ? keep : [0, 0, 0, 0];
    const { u, p } = this.pResolve;
    gl.useProgram(p);
    gl.uniform1i(u.slot, slot);
    gl.uniform1i(u.s, stride);
    gl.uniform2i(u.phase, phase[0], phase[1]);
    gl.uniform1f(u.sigK, this.tapSigmaScale());
    gl.uniform4i(u.items, c0, c1, r0, r1);
    gl.uniform4i(u.keep, kx0, ky0, kx1, ky1);
    this.bindTexture(UNIT.input, gl.TEXTURE_2D_ARRAY, this.outTex);
    this.bindTexture(UNIT.positions, gl.TEXTURE_2D, this.posTex);
    gl.bindVertexArray(this.vao);
    gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, this.resFbos[target]);
    gl.viewport(x0, y0, x1 - x0, y1 - y0);
    const draw = (side) => {
      gl.uniform1i(u.side, side);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    };
    if (stride > 1) {
      const keepsAll = kx0 <= x0 && kx1 >= x1 && ky0 <= y0 && ky1 >= y1;
      if (!keepsAll) {
        draw(SIDE.upsampled);
      }
      if (alpha > 0 && kx1 > kx0) {
        gl.enable(gl.BLEND);
        gl.blendColor(0, 0, 0, alpha);
        gl.blendFunc(gl.CONSTANT_ALPHA, gl.ONE_MINUS_CONSTANT_ALPHA);
        draw(SIDE.kept);
        gl.disable(gl.BLEND);
      }
    }
    draw(SIDE.evaluated);
    return [x0, x1, y0, y1];
  }

  composite(lights, exposure = 1, view = null) {
    const gl = this.gl;
    const { u, p } = this.pComp;
    const { X, Y, Z, O, tx, ty } = this.cam;
    gl.useProgram(p);
    gl.uniform3fv(u.camO, O);
    gl.uniform3fv(u.camX, X);
    gl.uniform3fv(u.camY, Y);
    gl.uniform3fv(u.camZ, Z);
    gl.uniform2f(u.tanxy, tx, ty);
    gl.uniform1f(u.exposure, exposure);
    const n = Math.min(lights.length, SLOTS);
    gl.uniform1i(u.nLights, n);
    const spheres = new Float32Array(SLOTS * 4);
    const emission = new Float32Array(SLOTS * 3);
    const info = new Int32Array(SLOTS * 3);
    lights.slice(0, n).forEach((l, i) => {
      spheres.set([...l.pos, l.radius], i * 4);
      emission.set(l.color.map((c) => c * l.intensity), i * 3);
      const resolved = l.resolved != null;
      const source = resolved ? l.resolved : l.slot;
      const stride = resolved ? FULL_RES_STRIDE : l.stride || 1;
      const discShown = l.hidden ? 0 : 1;
      info.set([source, stride, discShown], i * 3);
    });
    gl.uniform4fv(u.lPR, spheres);
    gl.uniform3fv(u.lE, emission);
    gl.uniform3iv(u.lInfo, info);
    this.bindTexture(UNIT.input, gl.TEXTURE_2D_ARRAY, this.outTex);
    this.bindTexture(UNIT.resolved, gl.TEXTURE_2D_ARRAY, this.resTex);
    this.bindTexture(UNIT.positions, gl.TEXTURE_2D, this.posTex);
    this.bindTexture(UNIT.aux, gl.TEXTURE_2D_ARRAY, this.auxTex);
    gl.bindVertexArray(this.vao);
    gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, null);
    gl.viewport(0, 0, this.W, this.H);
    const [x0, x1, y0, y1] = this.drawRect(view);
    gl.enable(gl.SCISSOR_TEST);
    gl.scissor(x0, y0, x1 - x0, y1 - y0);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.disable(gl.SCISSOR_TEST);
  }

  startTiming(stride, r0, r1, c0, c1) {
    const gl = this.gl;
    if (!this.timeable(stride, r0, r1, c0, c1, Boolean(this.timer))) {
      this.timing.skip = true;
      return;
    }
    this.timing.skip = false;
    const pending = { stride, share: this.share(stride, r0, r1, c0, c1), start: performance.now() };
    if (this.timer) {
      pending.query = gl.createQuery();
      gl.beginQuery(this.timer.TIME_ELAPSED_EXT, pending.query);
    } else {
      pending.before = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0);
      gl.flush();
    }
    this.timing.pending = pending;
  }

  stopTiming() {
    const gl = this.gl;
    const pending = this.timing.pending;
    if (this.timing.skip || !pending) {
      return;
    }
    if (pending.query) {
      gl.endQuery(this.timer.TIME_ELAPSED_EXT);
    } else {
      pending.sync = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0);
      gl.flush();
      this.watchFences(pending);
    }
  }

  watchFences(pending) {
    const gl = this.gl;
    const passed = (sync) => gl.clientWaitSync(sync, 0, 0) !== gl.TIMEOUT_EXPIRED;
    const check = () => {
      pending.timer = null;
      if (pending.cancelled) {
        return;
      }
      const now = performance.now();
      if (pending.before && passed(pending.before)) {
        pending.beforeAt = now;
        gl.deleteSync(pending.before);
        pending.before = null;
      }
      if (!pending.before && passed(pending.sync)) {
        pending.ms = now - Math.max(pending.start, pending.beforeAt ?? pending.start);
      } else if (now - pending.start < FENCE_TIMEOUT_MS) {
        pending.timer = setTimeout(check, FENCE_POLL_MS);
        return;
      }
      if (pending.before) {
        gl.deleteSync(pending.before);
        pending.before = null;
      }
      gl.deleteSync(pending.sync);
      pending.sync = null;
      pending.done = true;
    };
    check();
  }

  pollTiming() {
    const gl = this.gl;
    const pending = this.timing.pending;
    if (!pending) {
      return;
    }
    let ms = null;
    if (pending.query) {
      if (!gl.getQueryParameter(pending.query, gl.QUERY_RESULT_AVAILABLE)) {
        return;
      }
      if (!gl.getParameter(this.timer.GPU_DISJOINT_EXT)) {
        ms = gl.getQueryParameter(pending.query, gl.QUERY_RESULT) / 1e6;
      }
      gl.deleteQuery(pending.query);
    } else if (!this.timer) {
      if (!pending.done) {
        return;
      }
      ms = pending.ms ?? null;
    }
    this.timing.pending = null;
    this.recordTiming(pending.stride, pending.share, ms);
  }

  beginFrame() {}

  endFrame() {}

  flush() {}

  snapshot() {
    return this.canvas.transferToImageBitmap ? this.canvas.transferToImageBitmap() : this.canvas;
  }

  dispose() {
    const gl = this.gl;
    if (this.timing.pending?.query) {
      gl.deleteQuery(this.timing.pending.query);
    }
    const pending = this.timing.pending;
    if (pending && !pending.query) {
      pending.cancelled = true;
      clearTimeout(pending.timer);
      [pending.before, pending.sync].forEach((sync) => sync && gl.deleteSync(sync));
    }
    this.resources.textures.forEach((t) => gl.deleteTexture(t));
    this.resources.framebuffers.forEach((f) => gl.deleteFramebuffer(f));
    this.resources.programs.forEach((p) => gl.deleteProgram(p));
    this.resources.buffers.forEach((b) => gl.deleteBuffer(b));
    gl.deleteVertexArray(this.vao);
    gl.getExtension('WEBGL_lose_context')?.loseContext();
  }
}
