import { throwIfAborted } from './util';

const YIELD_EVERY_MS = 6;
const yieldToPage = () => new Promise((resolve) => setTimeout(resolve, 0));

function halfToFloat(h) {
  const s = h & 0x8000 ? -1 : 1;
  const e = (h >> 10) & 31;
  const m = h & 1023;
  return e === 0 ? s * m * 2 ** -24 : e === 31 ? (m ? NaN : s * Infinity) : s * (1 + m / 1024) * 2 ** (e - 15);
}

function toFloat32(buf, entry) {
  const n = entry.shape.reduce((a, b) => a * b, 1);
  if (entry.dtype === 'float32') {
    return new Float32Array(buf, entry.offset, n);
  }
  return Float32Array.from(new Uint16Array(buf, entry.offset, n), halfToFloat);
}

async function unpackDeltaPlanes(bytes, W, H, channels, texel, out, signal) {
  const NP = W * H;
  let sliceStart = performance.now();
  for (let k = 0; k < channels; k += 1) {
    const lowBytes = k * NP * 2;
    const highBytes = lowBytes + NP;
    for (let y = 0; y < H; y += 1) {
      let v = 0;
      for (let p = y * W, end = p + W; p < end; p += 1) {
        v = (v + (bytes[lowBytes + p] | (bytes[highBytes + p] << 8))) & 0xffff;
        out[texel(p, k)] = v;
      }
      if ((y & 31) === 31 && performance.now() - sliceStart > YIELD_EVERY_MS) {
        await yieldToPage();
        throwIfAborted(signal);
        sliceStart = performance.now();
      }
    }
  }
  return out;
}

export async function loadRelightScene(base, signal, suffix = '', priority = 'auto') {
  const get = async (file) => {
    const response = await fetch(`${base}/${file}`, { signal, priority });
    if (!response.ok) {
      throw new Error(`failed to load ${file} (${response.status})`);
    }
    return response;
  };
  const scene = await (await get(`scene${suffix}.json`)).json();
  if (scene.pixels?.format !== 2) {
    throw new Error('the room needs packing (perf/relight-pack.mjs)');
  }
  if (scene.network.light_grid) {
    throw new Error('light_grid models are not supported');
  }
  const [model, pixels] = await Promise.all(
    ['model.bin', scene.pixels.file ?? `pixels${suffix}.bin`].map(async (file) => (await get(file)).arrayBuffer())
  );
  throwIfAborted(signal);

  let gridLen = 0;
  const gridOff = scene.model.grids.map((g) => {
    if (g.dtype !== 'float16') {
      throw new Error('the grids must be float16');
    }
    const offset = gridLen;
    gridLen += g.shape[0] * g.shape[1] * g.shape[2];
    return offset;
  });
  const grid = new Uint16Array(gridLen);
  scene.model.grids.forEach((g, i) => {
    grid.set(new Uint16Array(model, g.offset, g.shape[0] * g.shape[1] * g.shape[2]), gridOff[i]);
  });
  const layers = scene.model.layers.map((l) => ({
    w: toFloat32(model, l.weight),
    b: toFloat32(model, l.bias),
    shape: l.weight.shape,
  }));

  const W = scene.width;
  const H = scene.height;
  const NP = W * H;
  const plane = (entry) => new Uint8Array(pixels, entry.offset, entry.bytes);
  const auxTexel = (p, k) => ((k >> 2) * NP + p) * 4 + (k & 3);
  const posTexel = (p, k) => p * 4 + k;
  const aux = await unpackDeltaPlanes(
    plane(scene.pixels.aux),
    W,
    H,
    scene.pixels.aux.channels,
    auxTexel,
    new Uint16Array(NP * 8),
    signal
  );
  const pos = await unpackDeltaPlanes(plane(scene.pixels.pos), W, H, 3, posTexel, new Uint16Array(NP * 4), signal);
  throwIfAborted(signal);

  return { scene, layers, grid, gridOff, aux, pos };
}
