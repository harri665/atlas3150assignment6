export const ROOM_FRAGMENT = `
  uniform sampler2D tRelight;
  uniform vec2 texSize;
  uniform float dpr;
  uniform vec2 viewport;
  uniform vec4 box;
  uniform float ready;
  uniform float dim;
  uniform float saturation;
  uniform float hotKeep;
  uniform float sharp;
  uniform vec3 glowAt;
  uniform vec3 glowColor;

  vec3 sharpSample(vec2 uv) {
    vec2 pos = uv * texSize;
    vec2 c = floor(pos - 0.5) + 0.5;
    vec2 f = pos - c;
    vec2 w0 = f * (-0.5 + f * (1.0 - 0.5 * f));
    vec2 w1 = 1.0 + f * f * (-2.5 + 1.5 * f);
    vec2 w2 = f * (0.5 + f * (2.0 - 1.5 * f));
    vec2 w3 = f * f * (-0.5 + 0.5 * f);
    vec2 w12 = w1 + w2;
    vec2 t0 = (c - 1.0) / texSize;
    vec2 t3 = (c + 2.0) / texSize;
    vec2 t12 = (c + w2 / w12) / texSize;
    vec3 sum = texture2D(tRelight, vec2(t12.x, t0.y)).rgb * (w12.x * w0.y)
      + texture2D(tRelight, vec2(t0.x, t12.y)).rgb * (w0.x * w12.y)
      + texture2D(tRelight, t12).rgb * (w12.x * w12.y)
      + texture2D(tRelight, vec2(t3.x, t12.y)).rgb * (w3.x * w12.y)
      + texture2D(tRelight, vec2(t12.x, t3.y)).rgb * (w12.x * w3.y);
    float weight = w12.x * w0.y + w0.x * w12.y + w12.x * w12.y + w3.x * w12.y + w12.x * w3.y;
    vec2 a = c / texSize;
    vec2 b = (c + 1.0) / texSize;
    vec3 p00 = texture2D(tRelight, a).rgb;
    vec3 p10 = texture2D(tRelight, vec2(b.x, a.y)).rgb;
    vec3 p01 = texture2D(tRelight, vec2(a.x, b.y)).rgb;
    vec3 p11 = texture2D(tRelight, b).rgb;
    return clamp(sum / weight, min(min(p00, p10), min(p01, p11)), max(max(p00, p10), max(p01, p11)));
  }

  float sdRoundBox(vec2 p, vec2 halfSize, float r) {
    vec2 q = abs(p) - halfSize + r;
    return length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - r;
  }

  void main() {
    vec2 px = vec2(gl_FragCoord.x, viewport.y * dpr - gl_FragCoord.y) / dpr;
    vec3 base = vec3(0.031, 0.035, 0.047);
    vec3 color = base;

    if (ready > 0.0) {
      vec2 uv = (px - box.xy) / box.z;
      float d = sdRoundBox(uv - 0.5, vec2(0.5), 0.05);
      float mask = 1.0 - smoothstep(-box.w, 0.0, d);
      if (mask > 0.0) {
        vec2 sampleUv = vec2(uv.x, 1.0 - uv.y);
        vec3 image = sharp > 0.5 ? sharpSample(sampleUv) : texture2D(tRelight, sampleUv).rgb;
        float luma = dot(image, vec3(0.2126, 0.7152, 0.0722));
        float hot = smoothstep(0.82, 0.97, luma) * hotKeep;
        image = mix(mix(vec3(luma), image, saturation) * dim, image, hot);
        color = mix(base, max(image, base), mask * ready);
      }

      float r = length(px - glowAt.xy);
      float reach = glowAt.z * 2.5 + 26.0;
      color += glowColor * exp(-r / reach) * smoothstep(glowAt.z * 0.6, glowAt.z * 1.6, r) * ready;
    }

    color += (fract(sin(dot(gl_FragCoord.xy, vec2(12.9898, 78.233))) * 43758.5453) - 0.5) / 255.0;
    gl_FragColor = vec4(color, 1.0);
  }
`;

const ROOM_WGSL = `
@group(0) @binding(0) var<uniform> room: array<vec4f, 5>;
@group(0) @binding(1) var tRelight: texture_2d<f32>;
@group(0) @binding(2) var smp: sampler;
fn at(i: u32) -> f32 { return room[i / 4u][i % 4u]; }
fn tex(uv: vec2f) -> vec3f { return textureSampleLevel(tRelight, smp, uv, 0.0).rgb; }

fn sharpSample(uv: vec2f, texSize: vec2f) -> vec3f {
  let pos = uv * texSize;
  let c = floor(pos - 0.5) + 0.5;
  let f = pos - c;
  let w0 = f * (-0.5 + f * (1.0 - 0.5 * f));
  let w1 = 1.0 + f * f * (-2.5 + 1.5 * f);
  let w2 = f * (0.5 + f * (2.0 - 1.5 * f));
  let w3 = f * f * (-0.5 + 0.5 * f);
  let w12 = w1 + w2;
  let t0 = (c - 1.0) / texSize;
  let t3 = (c + 2.0) / texSize;
  let t12 = (c + w2 / w12) / texSize;
  let sum = tex(vec2f(t12.x, t0.y)) * (w12.x * w0.y)
    + tex(vec2f(t0.x, t12.y)) * (w0.x * w12.y)
    + tex(t12) * (w12.x * w12.y)
    + tex(vec2f(t3.x, t12.y)) * (w3.x * w12.y)
    + tex(vec2f(t12.x, t3.y)) * (w12.x * w3.y);
  let weight = w12.x * w0.y + w0.x * w12.y + w12.x * w12.y + w3.x * w12.y + w12.x * w3.y;
  let a = c / texSize;
  let b = (c + 1.0) / texSize;
  let p00 = tex(a);
  let p10 = tex(vec2f(b.x, a.y));
  let p01 = tex(vec2f(a.x, b.y));
  let p11 = tex(b);
  return clamp(sum / weight, min(min(p00, p10), min(p01, p11)), max(max(p00, p10), max(p01, p11)));
}

fn sdRoundBox(p: vec2f, halfSize: vec2f, r: f32) -> f32 {
  let q = abs(p) - halfSize + r;
  return length(max(q, vec2f(0.0))) + min(max(q.x, q.y), 0.0) - r;
}

@vertex fn vs(@builtin(vertex_index) i: u32) -> @builtin(position) vec4f {
  let p = array<vec2f, 3>(vec2f(-1.0, -1.0), vec2f(3.0, -1.0), vec2f(-1.0, 3.0));
  return vec4f(p[i], 0.0, 1.0);
}
@fragment fn fs(@builtin(position) pos: vec4f) -> @location(0) vec4f {
  let texSize = vec2f(at(0u), at(1u));
  let dpr = at(2u);
  let viewport = vec2f(at(3u), at(4u));
  let box = vec4f(at(5u), at(6u), at(7u), at(8u));
  let ready = at(9u);
  let dim = at(10u);
  let saturation = at(11u);
  let hotKeep = at(12u);
  let glowAt = vec3f(at(13u), at(14u), at(15u));
  let glowColor = vec3f(at(16u), at(17u), at(18u));
  let canvasHeight = at(19u);
  let fragCoord = vec2f(pos.x, canvasHeight - pos.y);
  let px = vec2f(fragCoord.x, viewport.y * dpr - fragCoord.y) / dpr;
  let base = vec3f(0.031, 0.035, 0.047);
  var color = base;

  if (ready > 0.0) {
    let uv = (px - box.xy) / box.z;
    let d = sdRoundBox(uv - 0.5, vec2f(0.5), 0.05);
    let mask = 1.0 - smoothstep(-box.w, 0.0, d);
    if (mask > 0.0) {
      var image = sharpSample(vec2f(uv.x, 1.0 - uv.y), texSize);
      let luma = dot(image, vec3f(0.2126, 0.7152, 0.0722));
      let hot = smoothstep(0.82, 0.97, luma) * hotKeep;
      image = mix(mix(vec3f(luma), image, saturation) * dim, image, hot);
      color = mix(base, max(image, base), mask * ready);
    }

    let r = length(px - glowAt.xy);
    let reach = glowAt.z * 2.5 + 26.0;
    color += glowColor * exp(-r / reach) * smoothstep(glowAt.z * 0.6, glowAt.z * 1.6, r) * ready;
  }

  color += (fract(sin(dot(fragCoord, vec2f(12.9898, 78.233))) * 43758.5453) - 0.5) / 255.0;
  return vec4f(color, 1.0);
}
`;

const VERTEX = `
  attribute vec2 position;
  void main() {
    gl_Position = vec4(position, 0.0, 1.0);
  }
`;

const UNIFORMS = [
  ['texSize', 2],
  ['dpr', 1],
  ['viewport', 2],
  ['box', 4],
  ['ready', 1],
  ['dim', 1],
  ['saturation', 1],
  ['hotKeep', 1],
  ['glowAt', 3],
  ['glowColor', 3],
];
const FLOATS = UNIFORMS.reduce((n, [, size]) => n + size, 0);
const GPU_FLOATS = FLOATS + 1;
const CANVAS_HEIGHT_AT = FLOATS;
const COMPONENTS = ['x', 'y', 'z', 'w'];

function layerCanvas() {
  const canvas = document.createElement('canvas');
  canvas.setAttribute('aria-hidden', 'true');
  Object.assign(canvas.style, {
    position: 'fixed',
    left: '0',
    top: '0',
    width: '100%',
    height: '100vh',
    pointerEvents: 'none',
    zIndex: '0',
  });
  canvas.style.height = '100lvh';
  return canvas;
}

function gather(values, uniforms, width, height, dpr) {
  let offset = 0;
  UNIFORMS.forEach(([name, size]) => {
    if (name === 'dpr') {
      values[offset] = dpr;
    } else if (name === 'viewport') {
      values[offset] = width;
      values[offset + 1] = height;
    } else if (size === 1) {
      values[offset] = uniforms[name].value;
    } else {
      const v = uniforms[name].value;
      for (let c = 0; c < size; c += 1) {
        values[offset + c] = v[COMPONENTS[c]];
      }
    }
    offset += size;
  });
}

function same(a, b) {
  return a.every((v, i) => v === b[i]);
}

function fit(canvas, width, height, dpr) {
  const w = Math.max(1, Math.round(width * dpr));
  const h = Math.max(1, Math.round(height * dpr));
  if (canvas.width === w && canvas.height === h) {
    return false;
  }
  canvas.width = w;
  canvas.height = h;
  return true;
}

class FixedLayer {
  constructor(floats) {
    this.canvas = layerCanvas();
    this.values = new Float32Array(floats);
    this.drawnValues = new Float32Array(floats);
    this.drawn = false;
  }

  needsDraw(uniforms, width, height, dpr, texW, texH) {
    const { canvas, values, drawnValues } = this;
    if (fit(canvas, width, height, dpr)) {
      this.drawn = false;
    }
    gather(values, uniforms, width, height, dpr);
    values[0] = texW;
    values[1] = texH;
    if (values.length > CANVAS_HEIGHT_AT) {
      values[CANVAS_HEIGHT_AT] = canvas.height;
    }
    if (this.drawn && same(values, drawnValues)) {
      return false;
    }
    this.drawn = true;
    drawnValues.set(values);
    return true;
  }

  mount(before) {
    before.parentNode.insertBefore(this.canvas, before);
  }
}

function compileRoomProgram(gl) {
  const shader = (type, source) => {
    const s = gl.createShader(type);
    gl.shaderSource(s, source);
    gl.compileShader(s);
    return s;
  };
  const vs = shader(gl.VERTEX_SHADER, VERTEX);
  const fs = shader(gl.FRAGMENT_SHADER, `precision highp float;\n${ROOM_FRAGMENT}`);
  const program = gl.createProgram();
  gl.attachShader(program, vs);
  gl.attachShader(program, fs);
  gl.bindAttribLocation(program, 0, 'position');
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    throw new Error(`room layer shader: ${gl.getShaderInfoLog(fs) || gl.getProgramInfoLog(program)}`);
  }
  gl.deleteShader(vs);
  gl.deleteShader(fs);
  return program;
}

export class RoomLayer extends FixedLayer {
  constructor(before) {
    super(FLOATS);
    const options = { alpha: false, antialias: false, depth: false, stencil: false };
    const gl = this.canvas.getContext('webgl2', options) || this.canvas.getContext('webgl', options);
    if (!gl) {
      throw new Error('WebGL is not available');
    }
    this.gl = gl;

    const program = compileRoomProgram(gl);
    gl.useProgram(program);
    this.locations = UNIFORMS.map(([name]) => gl.getUniformLocation(program, name));
    gl.uniform1i(gl.getUniformLocation(program, 'tRelight'), 0);
    gl.uniform1f(gl.getUniformLocation(program, 'sharp'), 1);

    gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);

    this.texture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, this.texture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array(4));
    this.texW = 1;
    this.texH = 1;
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    gl.pixelStorei(gl.UNPACK_COLORSPACE_CONVERSION_WEBGL, gl.NONE);

    this.mount(before);
  }

  setImage(source) {
    const gl = this.gl;
    if (source.width === this.texW && source.height === this.texH) {
      gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, gl.RGBA, gl.UNSIGNED_BYTE, source);
    } else {
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source);
      this.texW = source.width;
      this.texH = source.height;
    }
    this.drawn = false;
  }

  draw(uniforms, width, height, dpr) {
    if (!this.needsDraw(uniforms, width, height, dpr, this.texW, this.texH)) {
      return;
    }
    const { gl, values } = this;
    let offset = 0;
    UNIFORMS.forEach(([, size], i) => {
      const location = this.locations[i];
      const v = values.subarray(offset, offset + size);
      if (size === 1) {
        gl.uniform1f(location, v[0]);
      } else {
        gl[`uniform${size}fv`](location, v);
      }
      offset += size;
    });
    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  dispose() {
    this.gl.getExtension('WEBGL_lose_context')?.loseContext();
    this.canvas.remove();
  }
}

export class GPURoomLayer extends FixedLayer {
  constructor(before, engine) {
    super(GPU_FLOATS);
    const context = this.canvas.getContext('webgpu');
    if (!context) {
      throw new Error('no WebGPU canvas');
    }
    const dev = engine.device;
    this.context = context;
    this.device = dev;
    this.format = navigator.gpu.getPreferredCanvasFormat();
    this.configure();
    const module = dev.createShaderModule({ code: ROOM_WGSL, label: 'relight room' });
    this.pipeline = dev.createRenderPipeline({
      layout: 'auto',
      vertex: { module, entryPoint: 'vs' },
      fragment: { module, entryPoint: 'fs', targets: [{ format: this.format }] },
      primitive: { topology: 'triangle-list' },
    });
    this.uniformBuf = dev.createBuffer({
      size: GPU_FLOATS * Float32Array.BYTES_PER_ELEMENT,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    this.sampler = dev.createSampler({ magFilter: 'linear', minFilter: 'linear' });
    this.engine = null;
    this.image = null;
    this.use(engine);
    this.mount(before);
  }

  configure() {
    this.context.configure({ device: this.device, format: this.format, alphaMode: 'opaque' });
  }

  currentTexture() {
    try {
      return this.context.getCurrentTexture();
    } catch {
      this.configure();
      return this.context.getCurrentTexture();
    }
  }

  use(engine) {
    if (engine.image === this.image) {
      return;
    }
    this.engine = engine;
    this.image = engine.image;
    this.group = this.device.createBindGroup({
      layout: this.pipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: this.uniformBuf } },
        { binding: 1, resource: engine.imageView },
        { binding: 2, resource: this.sampler },
      ],
    });
    this.drawn = false;
  }

  setImage() {
    this.drawn = false;
  }

  draw(uniforms, width, height, dpr) {
    const { engine } = this;
    const engineDisposed = !this.image || engine.image !== this.image;
    if (engineDisposed || !this.needsDraw(uniforms, width, height, dpr, engine.W, engine.H)) {
      return;
    }
    this.device.queue.writeBuffer(this.uniformBuf, 0, this.values);
    const texture = this.currentTexture();
    const pass = engine.encoder().beginRenderPass({
      colorAttachments: [{ view: texture.createView(), loadOp: 'clear', storeOp: 'store' }],
    });
    pass.setPipeline(this.pipeline);
    pass.setBindGroup(0, this.group);
    pass.draw(3);
    pass.end();
    engine.commit();
  }

  dispose() {
    this.context.unconfigure();
    this.uniformBuf.destroy();
    this.canvas.remove();
  }
}
