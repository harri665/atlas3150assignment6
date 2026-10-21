import { useFrame, useThree } from '@react-three/fiber';
import { useEffect, useMemo, useRef } from 'react';
import * as THREE from 'three';

import { apiUrl } from '../../utils/api';

// apple style liquid glass. the scene renders to a texture, then a fullscreen
// pass bends it through the DOM panes and glyphs, with r/g/b split a bit for the prism look

// enough for every gallery card on screen at once
const MAX_PANES = 16;

let mountedPasses = 0;

// shared per frame so the project page's two canvases ripple in sync
const WAVE_FULL_SPEED = 2500; // px/s for the full ripple
const wave = { key: null, y: 0, t: 0, amount: 0 };

function scrollWave() {
  const key = document.timeline?.currentTime ?? performance.now();
  if (key === wave.key) return wave;
  const now = performance.now() / 1000;
  const y = window.scrollY;
  const dt = wave.key === null ? 0 : Math.min(Math.max(now - wave.t, 1 / 240), 0.1);
  const still = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
  const target = still || !dt ? 0 : Math.min(Math.abs(y - wave.y) / dt / WAVE_FULL_SPEED, 1);
  const rate = target > wave.amount ? 12 : 4;
  wave.amount += (target - wave.amount) * (1 - Math.exp(-rate * dt));
  wave.key = key;
  wave.y = y;
  wave.t = now;
  return wave;
}

export default function LiquidGlassPass({
  selector,
  textSelector,
  imageSelector,
  sceneDim = [0.6, 0.7],
  shade = true,
  glassOnly = false,
  frost = 5,
  textFrost = frost,
  textLens = 0,
  textTint = [1, 1, 1],
  haze = 0,
  hover = null,
  blurTaps = 12,
  rimCap = 0,
  adapt = 0,
}) {
  const gl = useThree((state) => state.gl);
  const size = useThree((state) => state.size);
  const dpr = useThree((state) => state.viewport.dpr);

  const mipmaps = Boolean(hover);
  const target = useMemo(
    () =>
      new THREE.WebGLRenderTarget(
        1,
        1,
        mipmaps ? { generateMipmaps: true, minFilter: THREE.LinearMipmapLinearFilter } : undefined
      ),
    [mipmaps]
  );
  const radii = useRef(new WeakMap());
  const paneMeta = useRef(new WeakMap());
  const strengths = useRef(new WeakMap());
  const hovers = useRef(new WeakMap());
  const text = useRef({ els: [], observer: null, texture: null, pad: 0, ready: false });
  const images = useRef(new Map());
  const fits = useRef(new WeakMap());
  const renderedScene = useRef({ version: -1, width: 0, height: 0, hasMips: false });
  const canHover = useMemo(
    () => window.matchMedia?.('(hover: hover) and (pointer: fine)').matches ?? true,
    []
  );

  const pass = useMemo(() => {
    const emptyText = new THREE.DataTexture(new Uint8Array(4), 1, 1);
    emptyText.needsUpdate = true;

    const material = new THREE.ShaderMaterial({
      uniforms: {
        tScene: { value: target.texture },
        viewport: { value: new THREE.Vector2(1, 1) },
        sceneDim: { value: 1 },
        shadeScene: { value: 1 },
        glassOnly: { value: 0 },
        frost: { value: 5 },
        textFrost: { value: 5 },
        textLens: { value: 0 },
        textTint: { value: new THREE.Vector3(1, 1, 1) },
        haze: { value: 0 },
        hoverFrost: { value: 0 },
        hoverSplit: { value: 0 },
        hoverDim: { value: 0 },
        rimCap: { value: 0 },
        adapt: { value: 0 },
        paneHover: { value: new Array(MAX_PANES).fill(0) },
        panes: { value: Array.from({ length: MAX_PANES }, () => new THREE.Vector4()) },
        panesBounds: { value: new THREE.Vector4(0, 0, 0, 0) },
        paneRadii: { value: new Array(MAX_PANES).fill(0) },
        paneOpacity: { value: new Array(MAX_PANES).fill(1) },
        paneStrength: { value: new Array(MAX_PANES).fill(1) },
        paneGlass: { value: Array.from({ length: MAX_PANES }, () => new THREE.Vector2(1, 1)) },
        paneMerge: { value: new Array(MAX_PANES).fill(0) },
        origin: { value: new THREE.Vector2() },
        waveAmount: { value: 0 },
        waveTime: { value: 0 },
        waveScroll: { value: 0 },
        paneTint: { value: new Array(MAX_PANES).fill(0) },
        paneBevel: { value: new Array(MAX_PANES).fill(0) },
        // -1 = use the pass's own frost/haze
        paneFrost: { value: new Array(MAX_PANES).fill(-1) },
        paneHaze: { value: new Array(MAX_PANES).fill(-1) },
        paneCount: { value: 0 },
        tText: { value: emptyText },
        textRect: { value: new THREE.Vector4() },
        textTexel: { value: new THREE.Vector2(1, 1) },
        textSigma: { value: 1 },
        textDomeSigma: { value: 1 },
        textDepth: { value: 0 },
        textOpacity: { value: 0 },
      },
      vertexShader: passVertexShader,
      fragmentShader: passFragmentShader(blurTaps),
      blending: THREE.NoBlending,
      depthTest: false,
      depthWrite: false,
    });
    const scene = new THREE.Scene();
    scene.add(new THREE.Mesh(new THREE.PlaneGeometry(2, 2), material));
    const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    const imageMaterial = new THREE.ShaderMaterial({
      uniforms: {
        tImage: { value: null },
        viewport: { value: new THREE.Vector2(1, 1) },
        imageRect: { value: new THREE.Vector4() },
        imageSize: { value: new THREE.Vector2(1, 1) },
        contain: { value: 0 },
        clipRect: { value: new THREE.Vector4() },
        pane: { value: new THREE.Vector4() },
        paneRadius: { value: 0 },
        opacity: { value: 1 },
      },
      vertexShader: passVertexShader,
      fragmentShader: imageFragmentShader,
      transparent: true,
      depthTest: false,
      depthWrite: false,
    });
    const imageScene = new THREE.Scene();
    imageScene.add(new THREE.Mesh(new THREE.PlaneGeometry(2, 2), imageMaterial));

    return { material, scene, camera, emptyText, imageMaterial, imageScene };
  }, [target, blurTaps]);

  // counted, a page can run two of these
  useEffect(() => {
    const root = document.documentElement;
    mountedPasses += 1;
    root.setAttribute('data-glass-pass', '');
    return () => {
      mountedPasses -= 1;
      if (mountedPasses === 0) root.removeAttribute('data-glass-pass');
    };
  }, []);

  // a mipmapped texture that's never had its mips built reads as black
  const mipsMissing = useRef(true);

  useEffect(() => {
    target.setSize(Math.round(size.width * dpr), Math.round(size.height * dpr));
    mipsMissing.current = true;
    renderedScene.current.version = -1;
    renderedScene.current.hasMips = false;
  }, [target, size.width, size.height, dpr]);

  useEffect(() => {
    const reset = () => {
      radii.current = new WeakMap();
    };
    window.addEventListener('resize', reset);
    return () => window.removeEventListener('resize', reset);
  }, []);

  useEffect(() => {
    const textState = text.current;
    return () => {
      detachText(textState);
      target.dispose();
      pass.material.dispose();
      pass.emptyText.dispose();
      pass.scene.children[0].geometry.dispose();
      pass.imageMaterial.dispose();
      pass.imageScene.children[0].geometry.dispose();
    };
  }, [target, pass]);

  useEffect(() => {
    const cache = images.current;
    return () => {
      cache.forEach((texture) => texture?.dispose());
      cache.clear();
    };
  }, [target, pass]);

  function attachText(els) {
    const textState = text.current;
    detachText(textState);
    textState.els = els;

    const rebuild = () => {
      if (textState.els !== els || !els.every((el) => el.isConnected)) {
        return;
      }
      const glyphs = rasterizeText(els);
      if (!glyphs) {
        return;
      }
      textState.texture?.dispose();
      textState.texture = glyphs.texture;
      textState.pad = glyphs.pad;
      textState.offsets = glyphs.offsets;
      textState.size = glyphs.size;
      textState.ready = true;

      const { uniforms } = pass.material;
      uniforms.tText.value = glyphs.texture;
      uniforms.textTexel.value.set(1 / glyphs.width, 1 / glyphs.height);
      uniforms.textSigma.value = glyphs.sigma;
      uniforms.textDomeSigma.value = glyphs.domeSigma;
      textState.fontSize = glyphs.fontSize;
      uniforms.textDepth.value = glyphs.depth;
    };

    textState.rebuild = rebuild;
    textState.observer = new ResizeObserver(rebuild);
    els.forEach((el) => textState.observer.observe(el));
    document.fonts?.ready.then(rebuild);
  }

  // priority 1 = we take over rendering from r3f
  useFrame(({ scene, camera }, delta) => {
    const canvasRect = gl.domElement.getBoundingClientRect();
    const { uniforms } = pass.material;
    uniforms.viewport.value.set(canvasRect.width, canvasRect.height);
    uniforms.origin.value.set(canvasRect.left, canvasRect.top);
    const ripple = scrollWave();
    uniforms.waveAmount.value = ripple.amount;
    uniforms.waveTime.value = ripple.t;
    uniforms.waveScroll.value = ripple.y;
    uniforms.sceneDim.value = canvasRect.width >= 640 ? sceneDim[1] : sceneDim[0];
    uniforms.shadeScene.value = shade && !glassOnly ? 1 : 0;
    uniforms.glassOnly.value = glassOnly ? 1 : 0;
    uniforms.frost.value = frost;
    uniforms.textFrost.value = textFrost;
    uniforms.textLens.value = textLens * (text.current.fontSize || 0);
    uniforms.textTint.value.set(textTint[0], textTint[1], textTint[2]);
    uniforms.haze.value = haze;
    uniforms.hoverFrost.value = hover?.frost ?? 0;
    uniforms.hoverSplit.value = hover?.split ?? 0;
    uniforms.hoverDim.value = hover?.dim ?? 0;
    uniforms.rimCap.value = rimCap;
    uniforms.adapt.value = adapt;

    let count = 0;
    let anyHover = false;
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    const placed = new Map();
    if (selector) {
      document.querySelectorAll(selector).forEach((el) => {
        if (count >= MAX_PANES) {
          return;
        }
        const rect = el.getBoundingClientRect();
        if (rect.width === 0 || rect.bottom < 0 || rect.top > canvasRect.height) {
          return;
        }
        let radius = radii.current.get(el);
        if (radius === undefined) {
          radius = parseFloat(getComputedStyle(el).borderTopLeftRadius) || 0;
          radii.current.set(el, radius);
        }
        let meta = paneMeta.current.get(el);
        if (meta === undefined) {
          const thick = parseFloat(el.dataset.liquidGlass);
          const split = parseFloat(el.dataset.glassSplit);
          const bezel = parseFloat(el.dataset.glassBezel);
          const merge = parseFloat(el.dataset.glassMerge);
          const tint = parseFloat(el.dataset.glassTint);
          const paneFrost = parseFloat(el.dataset.glassFrost);
          const paneHaze = parseFloat(el.dataset.glassHaze);
          meta = {
            thick,
            hasLens: el.hasAttribute('data-glass-lens'),
            hasHover: el.hasAttribute('data-glass-hover'),
            bevel: el.hasAttribute('data-glass-bevel') ? 1 : 0,
            split: Number.isNaN(split) ? 1 : split,
            bezel: Number.isNaN(bezel) ? 1 : bezel,
            merge: Number.isNaN(merge) ? 0 : merge,
            tint: Number.isNaN(tint) ? 0 : tint,
            frost: Number.isNaN(paneFrost) ? -1 : paneFrost,
            haze: Number.isNaN(paneHaze) ? -1 : paneHaze,
          };
          paneMeta.current.set(el, meta);
        }
        const pxX = rect.left - canvasRect.left;
        const pxY = rect.top - canvasRect.top;
        const pad = meta.merge > 0.5 ? 46 : 2;
        if (pxX - pad < minX) minX = pxX - pad;
        if (pxY - pad < minY) minY = pxY - pad;
        if (pxX + rect.width + pad > maxX) maxX = pxX + rect.width + pad;
        if (pxY + rect.height + pad > maxY) maxY = pxY + rect.height + pad;
        uniforms.panes.value[count].set(
          pxX + rect.width / 2,
          pxY + rect.height / 2,
          rect.width / 2,
          rect.height / 2
        );
        uniforms.paneRadii.value[count] = Math.min(radius, rect.width / 2, rect.height / 2);
        const opacity = parseFloat(el.style.opacity);
        uniforms.paneOpacity.value[count] = Number.isNaN(opacity) ? 1 : opacity;
        placed.set(el, count);
        // data-liquid-glass="1.8" is thicker glass, but only while hovered unless data-glass-lens
        const active = (canHover && el.matches(':hover')) || el.hasAttribute('data-focus');
        const lens = active || meta.hasLens;
        const target = !Number.isNaN(meta.thick) && lens ? meta.thick : 1;
        const current = strengths.current.get(el) ?? 1;
        const strength = current + (target - current) * (1 - Math.exp(-delta * 10));
        strengths.current.set(el, strength);
        uniforms.paneStrength.value[count] = strength;
        if (hover && meta.hasHover) {
          const was = hovers.current.get(el) ?? 0;
          const now = was + ((active ? 1 : 0) - was) * (1 - Math.exp(-delta * 8));
          hovers.current.set(el, now);
          uniforms.paneHover.value[count] = now;
          anyHover = anyHover || now > 0.001;
        } else {
          uniforms.paneHover.value[count] = 0;
        }
        uniforms.paneGlass.value[count].set(meta.split, meta.bezel);
        uniforms.paneMerge.value[count] = meta.merge;
        uniforms.paneTint.value[count] = meta.tint;
        uniforms.paneBevel.value[count] = meta.bevel;
        uniforms.paneFrost.value[count] = meta.frost;
        uniforms.paneHaze.value[count] = meta.haze;
        count += 1;
      });
    }
    uniforms.paneCount.value = count;
    if (count > 0) {
      uniforms.panesBounds.value.set(minX, minY, maxX, maxY);
    } else {
      uniforms.panesBounds.value.set(0, 0, 0, 0);
    }

    const textState = text.current;
    const textAttached = textState.els.length > 0 && textState.els.every((el) => el.isConnected);
    if (textSelector && !textAttached) {
      const els = [...document.querySelectorAll(textSelector)];
      if (els.length) {
        attachText(els);
      }
    }
    if (textState.ready && textAttached) {
      const rects = textState.els.map((el) => el.getBoundingClientRect());
      const { pad, offsets, size } = textState;
      const left = rects[0].left - offsets[0][0];
      const top = rects[0].top - offsets[0][1];
      // the texture holds every element where they sat when it was drawn
      const drifted = rects.some(
        (r, i) => Math.abs(r.left - left - offsets[i][0]) > 0.5 || Math.abs(r.top - top - offsets[i][1]) > 0.5
      );
      const animating = textState.els.some((el) => el.getAnimations?.().some((a) => a.playState === 'running'));
      if (drifted && !animating) {
        textState.rebuild();
      }
      uniforms.textRect.value.set(left - canvasRect.left - pad, top - canvasRect.top - pad, size[0], size[1]);
      const opacity = parseFloat(textState.els[0].style.opacity);
      uniforms.textOpacity.value = Number.isNaN(opacity) ? 1 : opacity;
    } else {
      uniforms.textOpacity.value = 0;
    }

    const sceneVersion =
      scene.children.length === 1 && !imageSelector
        ? scene.children[0].userData?.sceneVersion
        : undefined;
    const rs = renderedScene.current;
    const sameScene =
      sceneVersion !== undefined &&
      rs.version === sceneVersion &&
      rs.width === target.width &&
      rs.height === target.height &&
      !mipsMissing.current &&
      (!mipmaps || !anyHover || rs.hasMips);

    if (!sameScene) {
      // only rebuild mips while something's hovered (or they're missing)
      const buildMips = mipmaps && (anyHover || mipsMissing.current);
      target.texture.generateMipmaps = buildMips;
      if (buildMips) mipsMissing.current = false;
      gl.setRenderTarget(target);
      gl.render(scene, camera);
      if (imageSelector && selector) {
        drawImages(canvasRect, placed);
      }
      rs.version = sceneVersion ?? -1;
      rs.width = target.width;
      rs.height = target.height;
      rs.hasMips = buildMips || (rs.version === sceneVersion && rs.hasMips);
    }
    gl.setRenderTarget(null);
    gl.render(pass.scene, pass.camera);

    if (textState.ready) {
      textState.els.forEach((el) => {
        if (!('glassReady' in el.dataset)) {
          el.dataset.glassReady = '';
        }
      });
    }
  }, 1);

  function drawImages(canvasRect, placed) {
    const { uniforms } = pass.imageMaterial;
    const paneUniforms = pass.material.uniforms;
    uniforms.viewport.value.set(canvasRect.width, canvasRect.height);
    const autoClear = gl.autoClear;
    gl.autoClear = false;

    document.querySelectorAll(imageSelector).forEach((img) => {
      const index = placed.get(img.closest(selector));
      if (index === undefined || !img.src || img.style.display === 'none') {
        return;
      }
      const texture = imageTexture(img.src);
      if (!texture) {
        return;
      }
      let contain = fits.current.get(img);
      if (contain === undefined) {
        contain = getComputedStyle(img).objectFit === 'contain';
        fits.current.set(img, contain);
      }
      const rect = img.getBoundingClientRect();
      const clip = img.parentElement.getBoundingClientRect();
      const { left, top } = canvasRect;
      uniforms.tImage.value = texture;
      uniforms.imageSize.value.set(texture.image.width || 1, texture.image.height || 1);
      uniforms.contain.value = contain ? 1 : 0;
      uniforms.imageRect.value.set(rect.left - left, rect.top - top, rect.width, rect.height);
      uniforms.clipRect.value.set(
        clip.left - left,
        clip.top - top,
        clip.right - left,
        clip.bottom - top
      );
      uniforms.pane.value.copy(paneUniforms.panes.value[index]);
      uniforms.paneRadius.value = paneUniforms.paneRadii.value[index];
      uniforms.opacity.value = paneUniforms.paneOpacity.value[index];
      gl.render(pass.imageScene, pass.camera);
      if (!('glassReady' in img.dataset)) {
        img.dataset.glassReady = '';
      }
    });

    gl.autoClear = autoClear;
  }

  // artstation's cdn has no CORS headers so these go through our proxy
  function imageTexture(src) {
    const cache = images.current;
    if (cache.has(src)) {
      return cache.get(src);
    }
    cache.set(src, null);
    const loader = new THREE.TextureLoader();
    loader.setCrossOrigin('anonymous');
    loader.load(
      apiUrl(`/proxy/image?url=${encodeURIComponent(src)}`),
      (loaded) => {
        if (!cache.has(src)) {
          loaded.dispose();
          return;
        }
        loaded.generateMipmaps = true;
        loaded.minFilter = THREE.LinearMipmapLinearFilter;
        cache.set(src, loaded);
      },
      undefined,
      () => {}
    );
    return null;
  }

  return null;
}

function detachText(textState) {
  textState.observer?.disconnect();
  textState.texture?.dispose();
  textState.els.forEach((el) => {
    delete el.dataset.glassReady;
  });
  textState.els = [];
  textState.observer = null;
  textState.texture = null;
  textState.ready = false;
}

// glyph mask in red, blurred copy in green which acts as the bevel height
// every glass text element goes in one texture. each is blurred at its own size and alpha
// holds its size against the largest, which the shader scales the bevel and lens by
function rasterizeText(els) {
  const boxes = els.map((el) => el.getBoundingClientRect());
  if (boxes.some((box) => box.width === 0 || box.height === 0)) {
    return null;
  }

  const styles = els.map((el) => getComputedStyle(el));
  const sizes = styles.map((style) => parseFloat(style.fontSize) || 16);
  const fontSize = Math.max(...sizes);
  const pad = Math.ceil(fontSize * 0.2);
  const scale = Math.min(window.devicePixelRatio || 1, 2);
  const left = Math.min(...boxes.map((box) => box.left));
  const top = Math.min(...boxes.map((box) => box.top));
  const right = Math.max(...boxes.map((box) => box.right));
  const bottom = Math.max(...boxes.map((box) => box.bottom));
  const size = [right - left + pad * 2, bottom - top + pad * 2];
  const width = Math.ceil(size[0] * scale);
  const height = Math.ceil(size[1] * scale);

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.scale(scale, scale);
  ctx.fillStyle = '#fff';
  ctx.textBaseline = 'alphabetic';

  // word by word so we get the DOM's own line breaks
  const range = document.createRange();
  els.forEach((el, index) => {
    const style = styles[index];
    ctx.font = `${style.fontStyle} ${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
    if ('letterSpacing' in ctx) {
      ctx.letterSpacing = style.letterSpacing === 'normal' ? '0px' : style.letterSpacing;
    }
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const words = /\S+/g;
      let match;
      while ((match = words.exec(node.textContent))) {
        range.setStart(node, match.index);
        range.setEnd(node, match.index + match[0].length);
        const rect = range.getBoundingClientRect();
        const metrics = ctx.measureText(match[0]);
        const ascent = metrics.fontBoundingBoxAscent ?? sizes[index] * 0.92;
        const descent = metrics.fontBoundingBoxDescent ?? sizes[index] * 0.24;
        const baseline = rect.top - top + (rect.height - ascent - descent) / 2 + ascent;
        ctx.fillText(match[0], rect.left - left + pad, baseline + pad);
      }
    }
  });

  const pixels = ctx.getImageData(0, 0, width, height).data;
  const coverage = new Float32Array(width * height);
  for (let i = 0; i < coverage.length; i += 1) {
    coverage[i] = pixels[i * 4 + 3] / 255;
  }

  const bevel = new Float32Array(width * height);
  const dome = new Float32Array(width * height);
  const relative = new Uint8Array(width * height).fill(255);
  let sigma = 1;
  let domeSigma = 1;
  els.forEach((el, index) => {
    const ownPad = Math.ceil(sizes[index] * 0.2);
    const x0 = Math.max(0, Math.floor((boxes[index].left - left + pad - ownPad) * scale));
    const y0 = Math.max(0, Math.floor((boxes[index].top - top + pad - ownPad) * scale));
    const x1 = Math.min(width, Math.ceil((boxes[index].right - left + pad + ownPad) * scale));
    const y1 = Math.min(height, Math.ceil((boxes[index].bottom - top + pad + ownPad) * scale));
    const w = x1 - x0;
    const h = y1 - y0;
    const region = new Float32Array(w * h);
    for (let y = 0; y < h; y += 1) {
      region.set(coverage.subarray((y0 + y) * width + x0, (y0 + y) * width + x1), y * w);
    }

    // 3 box blurs ~= gaussian
    const radius = Math.max(1, Math.round(sizes[index] * 0.022 * scale));
    let ownBevel = region;
    for (let i = 0; i < 3; i += 1) {
      ownBevel = boxBlur(ownBevel, w, h, radius);
    }
    const domeRadius = Math.max(2, Math.round(sizes[index] * 0.05 * scale));
    let ownDome = region;
    for (let i = 0; i < 3; i += 1) {
      ownDome = boxBlur(ownDome, w, h, domeRadius);
    }
    if (sizes[index] === fontSize) {
      sigma = Math.sqrt(((2 * radius + 1) ** 2 - 1) / 4);
      domeSigma = Math.sqrt(((2 * domeRadius + 1) ** 2 - 1) / 4);
    }

    const share = Math.round((sizes[index] / fontSize) * 255);
    for (let y = 0; y < h; y += 1) {
      bevel.set(ownBevel.subarray(y * w, (y + 1) * w), (y0 + y) * width + x0);
      dome.set(ownDome.subarray(y * w, (y + 1) * w), (y0 + y) * width + x0);
      relative.fill(share, (y0 + y) * width + x0, (y0 + y) * width + x1);
    }
  });

  const data = new Uint8Array(width * height * 4);
  for (let i = 0; i < coverage.length; i += 1) {
    data[i * 4] = Math.round(coverage[i] * 255);
    data[i * 4 + 1] = Math.round(bevel[i] * 255);
    data[i * 4 + 2] = Math.round(dome[i] * 255);
    data[i * 4 + 3] = relative[i];
  }
  // rows top to bottom, shader is y-down
  const texture = new THREE.DataTexture(data, width, height);
  texture.minFilter = THREE.LinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.needsUpdate = true;

  const offsets = boxes.map((box) => [box.left - left, box.top - top]);
  return { texture, width, height, pad, size, offsets, sigma, domeSigma, fontSize, depth: fontSize * 0.12 };
}

function boxBlur(source, width, height, radius) {
  const span = radius * 2 + 1;
  const horizontal = new Float32Array(source.length);
  const out = new Float32Array(source.length);

  for (let y = 0; y < height; y += 1) {
    const row = y * width;
    let sum = 0;
    for (let x = -radius; x <= radius; x += 1) {
      sum += source[row + Math.min(Math.max(x, 0), width - 1)];
    }
    for (let x = 0; x < width; x += 1) {
      horizontal[row + x] = sum / span;
      sum +=
        source[row + Math.min(x + radius + 1, width - 1)] -
        source[row + Math.max(x - radius, 0)];
    }
  }

  for (let x = 0; x < width; x += 1) {
    let sum = 0;
    for (let y = -radius; y <= radius; y += 1) {
      sum += horizontal[Math.min(Math.max(y, 0), height - 1) * width + x];
    }
    for (let y = 0; y < height; y += 1) {
      out[y * width + x] = sum / span;
      sum +=
        horizontal[Math.min(y + radius + 1, height - 1) * width + x] -
        horizontal[Math.max(y - radius, 0) * width + x];
    }
  }

  return out;
}

const passVertexShader = `
  varying vec2 vUv;

  void main() {
    vUv = uv;
    gl_Position = vec4(position.xy, 0.0, 1.0);
  }
`;

const imageFragmentShader = `
  uniform sampler2D tImage;
  uniform vec2 viewport;
  uniform vec4 imageRect;
  uniform vec2 imageSize;
  uniform float contain;
  uniform vec4 clipRect;
  uniform vec4 pane;
  uniform float paneRadius;
  uniform float opacity;

  varying vec2 vUv;

  float sdRoundRect(vec2 p, vec2 halfSize, float r) {
    vec2 q = abs(p) - halfSize + r;
    return length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - r;
  }

  void main() {
    vec2 px = vec2(vUv.x, 1.0 - vUv.y) * viewport;
    if (any(lessThan(px, clipRect.xy)) || any(greaterThan(px, clipRect.zw))) discard;
    float d = sdRoundRect(px - pane.xy, pane.zw, paneRadius);
    if (d > 1.0) discard;

    vec2 fit = imageRect.zw / imageSize;
    vec2 shown = imageSize * (contain > 0.5 ? min(fit.x, fit.y) : max(fit.x, fit.y));
    vec2 uv = (px - imageRect.xy - imageRect.zw * 0.5) / shown + 0.5;
    if (any(lessThan(uv, vec2(0.0))) || any(greaterThan(uv, vec2(1.0)))) discard;
    uv.y = 1.0 - uv.y;
    gl_FragColor = vec4(texture2D(tImage, uv).rgb, opacity * (1.0 - smoothstep(-1.0, 1.0, d)));
  }
`;

// all in css px, y down like the DOM
const passFragmentShader = (blurTaps) => `
  #define MAX_PANES ${MAX_PANES}
  // prism split (px)
  #define SPLIT 5.5
  #define EDGE_DISPERSION 0.6
  #define BLUR_TAPS ${blurTaps}
  #define TEXT_FROST 0.18
  #define TEXT_SPECULAR 0.9

  uniform sampler2D tScene;
  uniform vec2 viewport;
  uniform float sceneDim;
  uniform float shadeScene;
  uniform float glassOnly;
  uniform float frost;
  uniform float textFrost;
  uniform float textLens;
  uniform vec3 textTint;
  uniform float haze;
  uniform float hoverFrost;
  uniform float hoverSplit;
  uniform float hoverDim;
  uniform float rimCap;
  uniform float adapt;
  uniform float paneHover[MAX_PANES];
  uniform vec4 panes[MAX_PANES];
  uniform vec4 panesBounds;
  uniform float paneRadii[MAX_PANES];
  uniform float paneOpacity[MAX_PANES];
  uniform float paneStrength[MAX_PANES];
  uniform vec2 paneGlass[MAX_PANES];
  uniform float paneMerge[MAX_PANES];
  uniform vec2 origin;
  uniform float waveAmount;
  uniform float waveTime;
  uniform float waveScroll;
  uniform float paneTint[MAX_PANES];
  uniform float paneBevel[MAX_PANES];
  uniform float paneFrost[MAX_PANES];
  uniform float paneHaze[MAX_PANES];
  uniform int paneCount;

  uniform sampler2D tText;
  uniform vec4 textRect;
  uniform vec2 textTexel;
  uniform float textSigma;
  uniform float textDomeSigma;
  uniform float textDepth;
  uniform float textOpacity;

  varying vec2 vUv;

  float sdRoundRect(vec2 p, vec2 halfSize, float r) {
    vec2 q = abs(p) - halfSize + r;
    return length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - r;
  }

  // bridges the gap between merged panes + rounds the inside corners
  #define MERGE 44.0
  float smoothUnion(float a, float b) {
    float h = max(MERGE - abs(a - b), 0.0) / MERGE;
    return min(a, b) - h * h * MERGE * 0.25;
  }

  bool inGroup(int j, int lead, float group) {
    return j == lead || (group > 0.5 && abs(paneMerge[j] - group) < 0.5);
  }

  #define BEVEL_EDGE 11.0
  #define BEVEL_REACH 40.0

  float bottomCorners(vec2 p, vec2 halfSize, float r) {
    vec2 inner = halfSize - r;
    return smoothstep(inner.x - BEVEL_REACH, inner.x, abs(p.x))
      * smoothstep(inner.y - BEVEL_REACH, inner.y, p.y);
  }

  #define WAVE_PX 4.0
  #define JOIN 66.0

  float joinWeight(float a, float b) {
    return smoothstep(0.0, 1.0, clamp((JOIN - abs(a - b)) / JOIN, 0.0, 1.0));
  }

  // page + screen coords so separate canvases agree
  float ripple(vec2 px) {
    vec2 s = px + origin;
    float y = s.y + waveScroll;
    float r = 0.65 * sin(y * 0.045 + s.x * 0.03 - waveTime * 4.0)
      + 0.35 * sin(y * 0.02 - s.x * 0.05 + waveTime * 2.6);
    return r * waveAmount * WAVE_PX;
  }

  float joinAt(vec2 px, int lead, float group) {
    if (group < 0.5) return 0.0;
    float a = 1e5;
    float b = 1e5;
    for (int j = 0; j < MAX_PANES; j++) {
      if (j >= paneCount) break;
      if (!inGroup(j, lead, group)) continue;
      float dj = sdRoundRect(px - panes[j].xy, panes[j].zw, paneRadii[j]);
      if (dj < a) {
        b = a;
        a = dj;
      } else if (dj < b) {
        b = dj;
      }
    }
    return joinWeight(a, b);
  }

  float paneDistance(vec2 px, int lead, float group) {
    float d = 1e5;
    if (group < 0.5) {
      d = sdRoundRect(px - panes[lead].xy, panes[lead].zw, paneRadii[lead]);
    } else {
      float a = 1e5;
      float b = 1e5;
      for (int j = 0; j < MAX_PANES; j++) {
        if (j >= paneCount) break;
        if (!inGroup(j, lead, group)) continue;
        float dj = sdRoundRect(px - panes[j].xy, panes[j].zw, paneRadii[j]);
        d = smoothUnion(d, dj);
        if (dj < a) {
          b = a;
          a = dj;
        } else if (dj < b) {
          b = dj;
        }
      }
      if (waveAmount > 0.001) d += ripple(px) * joinWeight(a, b);
    }
    return d;
  }

  // lod 0 has to be the full scene, not a mip left over from a hover
  vec4 sampleAt(vec2 px, float lod) {
    vec2 uv = vec2(px.x / viewport.x, 1.0 - px.y / viewport.y);
    return textureLod(tScene, clamp(uv, 0.0, 1.0), lod);
  }

  // golden angle spiral, weighted to the centre so it looks frosted not smeared
  vec4 blurredAt(vec2 px, float radius, float lod) {
    vec4 sum = sampleAt(px, lod);
    float total = 1.0;
    for (int k = 1; k <= BLUR_TAPS; k++) {
      float f = float(k) / float(BLUR_TAPS);
      float angle = float(k) * 2.39996;
      vec2 tap = vec2(cos(angle), sin(angle)) * sqrt(f) * radius;
      float weight = 1.0 - 0.6 * f;
      sum += sampleAt(px + tap, lod) * weight;
      total += weight;
    }
    return sum / total;
  }

  float lensAmount(float strength) {
    return clamp((strength - 1.0) / 0.4, 0.0, 1.0);
  }

  vec4 throughGlass(vec2 px, vec2 offset, float strength, float splitScale, float radius, float lod) {
    vec2 split = normalize(vec2(1.0, -0.4)) * SPLIT * splitScale * (1.0 - lensAmount(strength));
    float dispersion = min(EDGE_DISPERSION * splitScale, 0.95);
    vec4 red = blurredAt(px + offset * (1.0 + dispersion) + split, radius, lod);
    vec4 green = blurredAt(px + offset, radius, lod);
    vec4 blue = blurredAt(px + offset * (1.0 - dispersion) - split, radius, lod);
    vec4 glass = vec4(red.r, green.g, blue.b, max(red.a, max(green.a, blue.a)));
    glass.rgb *= 1.06;
    return glass;
  }

  // matches the css it replaced: radial-gradient(circle, 0.12, 0.58 56%, 0.95 82%) of #08090c
  vec4 shade(vec4 color, vec2 px) {
    if (shadeScene < 0.5) return color;
    color *= sceneDim;
    float r = length(px - viewport * 0.5) / length(viewport * 0.5);
    float a = r < 0.56
      ? mix(0.12, 0.58, r / 0.56)
      : mix(0.58, 0.95, clamp((r - 0.56) / 0.26, 0.0, 1.0));
    return vec4(vec3(8.0, 9.0, 12.0) / 255.0 * a, a) + color * (1.0 - a);
  }

  // premultiplied over
  vec4 over(vec4 top, vec4 bottom) {
    return top + bottom * (1.0 - top.a);
  }

  void main() {
    vec2 px = vec2(vUv.x, 1.0 - vUv.y) * viewport;
    vec4 color = glassOnly > 0.5 ? vec4(0.0) : texture2D(tScene, vUv);

    bool inPanes = paneCount > 0 &&
      px.x >= panesBounds.x && px.y >= panesBounds.y &&
      px.x <= panesBounds.z && px.y <= panesBounds.w;

    for (int i = 0; i < MAX_PANES; i++) {
      if (!inPanes || i >= paneCount) break;

      // merged group is drawn once, by its first pane
      float group = paneMerge[i];
      if (group < 0.5) {
        vec2 dBox = abs(px - panes[i].xy) - panes[i].zw;
        if (dBox.x > 1.0 || dBox.y > 1.0) continue;
      } else {
        bool drawn = false;
        for (int j = 0; j < MAX_PANES; j++) {
          if (j >= i) break;
          if (abs(paneMerge[j] - group) < 0.5) drawn = true;
        }
        if (drawn) continue;
      }

      float r = paneRadii[i];
      float d = paneDistance(px, i, group);
      if (d > 1.0) continue;

      // flat middle, steep rim. thick panes act like a lens and pull in from past the edge instead
      float strength = paneStrength[i];
      float lens = lensAmount(strength);
      float swell = waveAmount > 0.001 ? 1.0 + waveAmount * 0.6 * joinAt(px, i, group) : 1.0;
      float corner = paneBevel[i] > 0.5 ? bottomCorners(px - panes[i].xy, panes[i].zw, r) : 0.0;
      swell *= 1.0 + corner * 1.2;
      float bezel = clamp(r * 1.15, 14.0, 34.0) * strength * paneGlass[i].y * swell;
      float rim = rimCap > 0.0 ? min(bezel, min(panes[i].z, panes[i].w) * rimCap) : bezel;
      float t = clamp(-d / rim, 0.0, 1.0);
      vec2 normal = vec2(0.0);
      vec2 offset = vec2(0.0);
      if (t < 1.0 || corner > 0.001 || group > 0.5) {
        vec2 e = vec2(0.5, 0.0);
        normal = normalize(vec2(
          paneDistance(px + e.xy, i, group) - paneDistance(px - e.xy, i, group),
          paneDistance(px + e.yx, i, group) - paneDistance(px - e.yx, i, group)
        ) + 1e-5);
        float bend = pow(1.0 - t, 2.4);
        float reach = mix(-0.7, 0.24, lens);
        offset = normal * reach * bend * bezel;
      }

      float hovered = paneHover[i];
      float widen = 1.0 + hoverFrost * hovered;
      float paneBlur = paneFrost[i] >= 0.0 ? paneFrost[i] : frost;
      vec4 glass = throughGlass(
        px, offset, strength, paneGlass[i].x * (1.0 + hoverSplit * hovered), paneBlur * widen, log2(widen) * 1.4
      );
      glass.rgb *= 1.0 - hoverDim * hovered;
      glass.rgb = mix(glass.rgb, vec3(8.0, 9.0, 12.0) / 255.0, paneTint[i]);
      if (adapt > 0.0) {
        vec3 around = (
          sampleAt(px, 0.0) +
          sampleAt(px + vec2(20.0, 0.0), 0.0) + sampleAt(px - vec2(20.0, 0.0), 0.0) +
          sampleAt(px + vec2(0.0, 20.0), 0.0) + sampleAt(px - vec2(0.0, 20.0), 0.0)
        ).rgb / 5.0;
        float light = dot(around, vec3(0.2126, 0.7152, 0.0722));
        glass.rgb *= 1.0 - adapt * smoothstep(0.3, 0.85, light);
      }
      glass.rgb = mix(glass.rgb, vec3(glass.a), paneHaze[i] >= 0.0 ? paneHaze[i] : haze);

      if (corner > 0.001) {
        float across = clamp(-d / BEVEL_EDGE, 0.0, 1.0);
        float below = max(dot(normal, vec2(0.0, 1.0)), 0.0);
        float light = (0.35 + 0.65 * below) * pow(1.0 - across, 1.6);
        float crease = exp(-abs(-d - BEVEL_EDGE) / 1.6);
        glass.rgb += vec3(light * 0.42 - crease * 0.07) * corner * glass.a;
      }

      // css borders can't follow a merged outline so draw the rim here
      if (group > 0.5) {
        float facing = dot(normal, normalize(vec2(-1.0, -1.0)));
        float light = 0.18 + 0.75 * max(facing, 0.0) + 0.4 * max(-facing, 0.0);
        float rim = exp(-abs(d + 1.0) / 1.0) * light;
        float glow = exp(d / 22.0) * 0.07;
        glass.rgb += vec3(rim + glow);
      }

      float coverage = (1.0 - smoothstep(-1.0, 1.0, d)) * paneOpacity[i];
      color = mix(color, glass, coverage);
    }

    color = shade(color, px);

    if (textOpacity > 0.0) {
      vec2 tuv = (px - textRect.xy) / textRect.zw;
      if (all(greaterThanEqual(tuv, vec2(0.0))) && all(lessThanEqual(tuv, vec2(1.0)))) {
        vec4 mask = texture2D(tText, tuv);
        float coverage = mask.r;
        float textScale = mask.a;

        if (coverage > 0.004) {
          vec2 grad = vec2(
            texture2D(tText, tuv + vec2(textTexel.x, 0.0)).g -
              texture2D(tText, tuv - vec2(textTexel.x, 0.0)).g,
            texture2D(tText, tuv + vec2(0.0, textTexel.y)).g -
              texture2D(tText, tuv - vec2(0.0, textTexel.y)).g
          );
          float slope = clamp(length(grad) * textSigma * textScale / 0.8, 0.0, 1.0);
          vec2 inward = grad / (length(grad) + 1e-5);

          vec2 offset = inward * slope * textDepth * textScale;
          if (textLens > 0.0) {
            vec2 rise = vec2(
              texture2D(tText, tuv + vec2(2.0 * textTexel.x, 0.0)).b -
                texture2D(tText, tuv - vec2(2.0 * textTexel.x, 0.0)).b,
              texture2D(tText, tuv + vec2(0.0, 2.0 * textTexel.y)).b -
                texture2D(tText, tuv - vec2(0.0, 2.0 * textTexel.y)).b
            ) * textDomeSigma * textScale / 1.6;
            offset -= rise * textLens * textScale;
          }
          vec4 glyph = shade(throughGlass(px, offset, 1.0, 1.0, textFrost, 0.0), px);
          glyph.rgb *= mix(vec3(1.0), textTint, smoothstep(0.4, 0.75, mask.b));
          glyph = over(vec4(TEXT_FROST), glyph);

          // lit from the top left
          float facing = dot(-inward, normalize(vec2(-1.0, -1.0)));
          float light = 0.15 + 0.85 * max(facing, 0.0) + 0.45 * max(-facing, 0.0);
          float specular = clamp(pow(slope, 2.5) * light * TEXT_SPECULAR, 0.0, 1.0);
          glyph = over(vec4(specular), glyph);

          color = mix(color, glyph, coverage * textOpacity);
        }
      }
    }

    gl_FragColor = color;
  }
`;
