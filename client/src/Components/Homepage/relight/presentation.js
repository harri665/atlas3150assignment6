import * as THREE from 'three';

import { createRelightEngine } from './prepare';
import { GPURoomLayer, RoomLayer } from './roomLayer';

export const ROOM_VERTEX = `
  void main() {
    gl_Position = vec4(position.xy, 0.0, 1.0);
  }
`;

function releaseImage(image) {
  if (typeof ImageBitmap !== 'undefined' && image instanceof ImageBitmap) {
    image.close();
  }
}

function unflippedTexture() {
  const texture = new THREE.Texture();
  texture.flipY = false;
  texture.generateMipmaps = false;
  texture.minFilter = THREE.LinearFilter;
  texture.magFilter = THREE.LinearFilter;
  return texture;
}

export function withTexture({ engine, notGPU, fill }) {
  const texture = unflippedTexture();
  const take = (image, texSize) => {
    const previous = texture.image;
    texture.image = image;
    texture.needsUpdate = true;
    texture.userData.copies = (texture.userData.copies || 0) + 1;
    texSize.set(image.width, image.height);
    if (previous !== image) {
      releaseImage(previous);
    }
  };
  return {
    engine,
    notGPU,
    fill,
    texture,
    present: (layer, texSize) => {
      if (layer?.device && layer.device === engine.device) {
        layer.setImage();
        return true;
      }
      const image = engine.snapshot();
      if (!layer) {
        take(image, texSize);
        return false;
      }
      layer.setImage(image);
      if (!engine.halfImage) {
        take(image, texSize);
        return false;
      }
      releaseImage(image);
      return true;
    },
    copyGlass: (texSize) => engine.halfImage((image) => take(image, texSize)),
    dispose: () => {
      releaseImage(texture.image);
      engine.dispose();
      texture.dispose();
    },
  };
}

export async function buildEngine(data, device, bandBytes, signal, kernel) {
  return withTexture(await createRelightEngine(data, device, bandBytes, signal, kernel));
}

export function fitLayer(state) {
  const { engine, layer, host } = state;
  if (!layer || !host) {
    return;
  }
  const gpu = engine.backend === 'webgpu' && !state.gpuLayerFailed;
  if (gpu && layer.device === engine.device) {
    layer.use(engine);
    return;
  }
  if (!gpu && !layer.device) {
    return;
  }
  let next;
  try {
    next = gpu ? new GPURoomLayer(host, engine) : new RoomLayer(host);
  } catch (error) {
    console.warn('Relight backdrop keeps its room layer:', error);
    state.gpuLayerFailed = true;
    return;
  }
  layer.dispose();
  state.layer = next;
}

function glassSignature(uniforms) {
  const copies = uniforms.tRelight.value?.userData?.copies ?? 0;
  const b = uniforms.box.value;
  const g = uniforms.glowAt.value;
  const c = uniforms.glowColor.value;
  const v = uniforms.viewport.value;
  return `${copies}:${uniforms.dpr.value}:${v.x}:${v.y}:${b.x.toFixed(2)}:${b.y.toFixed(2)}:${b.z.toFixed(2)}:${uniforms.ready.value.toFixed(3)}:${uniforms.sharp.value}:${g.x.toFixed(1)}:${g.y.toFixed(1)}:${g.z.toFixed(1)}:${c.x.toFixed(3)}`;
}

export function syncGlassScene(state, uniforms, mesh) {
  if (!mesh) {
    return;
  }
  const sig = glassSignature(uniforms);
  if (sig !== state.uniformSig) {
    state.uniformSig = sig;
    state.sceneVersion += 1;
    mesh.userData.sceneVersion = state.sceneVersion;
  }
}

export function drawRoom(state, uniforms, mesh, vw, vh) {
  state.layer?.draw(uniforms, vw, vh, state.roomDpr);
  syncGlassScene(state, uniforms, mesh);
}
