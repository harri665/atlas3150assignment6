import { useFrame, useThree } from '@react-three/fiber';
import React, { useEffect, useMemo, useRef, useState } from 'react';
import * as THREE from 'three';

// paints the page's images and text into the glass scene so fixed glass can bend what
// scrolls under it. the DOM stays visible, the canvas only shows inside the glass
const SELECTOR = '[data-glass-paint]';
// --bg
const BACKGROUND = [8 / 255, 9 / 255, 12 / 255];

export default function PaintedPage() {
  const [items, setItems] = useState([]);

  useEffect(() => {
    let cancelled = false;
    let timer = 0;
    let built = [];

    const build = () => {
      const next = [...document.querySelectorAll(SELECTOR)]
        .map((el) => ({ el, texture: el.tagName === 'IMG' ? imageTexture(el) : textTexture(el) }))
        .filter((item) => item.texture);
      if (cancelled) {
        next.forEach((item) => item.texture.dispose());
        return;
      }
      built.forEach((item) => item.texture.dispose());
      built = next;
      setItems(next);
    };
    const schedule = () => {
      clearTimeout(timer);
      timer = setTimeout(build, 120);
    };

    document.fonts?.ready.then(schedule);
    const images = [...document.querySelectorAll(`img${SELECTOR}`)];
    images.forEach((img) => img.addEventListener('load', schedule));
    const resize = new ResizeObserver(schedule);
    resize.observe(document.body);
    schedule();

    return () => {
      cancelled = true;
      clearTimeout(timer);
      images.forEach((img) => img.removeEventListener('load', schedule));
      resize.disconnect();
      built.forEach((item) => item.texture.dispose());
    };
  }, []);

  return (
    <>
      <Background />
      {items.map((item, index) => (
        <Painted key={index} item={item} />
      ))}
    </>
  );
}

function Background() {
  const uniforms = useMemo(() => ({ color: { value: new THREE.Vector3(...BACKGROUND) } }), []);
  return (
    <mesh frustumCulled={false} renderOrder={-1}>
      <planeGeometry args={[2, 2]} />
      <shaderMaterial
        uniforms={uniforms}
        vertexShader={`void main() { gl_Position = vec4(position.xy, 0.0, 1.0); }`}
        fragmentShader={`uniform vec3 color; void main() { gl_FragColor = vec4(color, 1.0); }`}
        depthTest={false}
        depthWrite={false}
      />
    </mesh>
  );
}

function Painted({ item }) {
  const gl = useThree((state) => state.gl);
  const mesh = useRef(null);
  const uniforms = useMemo(
    () => ({
      tex: { value: item.texture },
      viewport: { value: new THREE.Vector2(1, 1) },
      rect: { value: new THREE.Vector4() },
      radius: { value: 0 },
      pad: { value: item.texture.userData.pad || 0 },
    }),
    [item]
  );

  useFrame(({ size }) => {
    const canvas = gl.domElement.getBoundingClientRect();
    const box = item.el.getBoundingClientRect();
    const visible = box.bottom > canvas.top && box.top < canvas.bottom && box.width > 0;
    mesh.current.visible = visible;
    if (!visible) return;
    uniforms.viewport.value.set(size.width, size.height);
    uniforms.rect.value.set(box.left - canvas.left, box.top - canvas.top, box.width, box.height);
    uniforms.radius.value = item.texture.userData.radius || 0;
  });

  return (
    <mesh ref={mesh} frustumCulled={false}>
      <planeGeometry args={[2, 2]} />
      <shaderMaterial
        uniforms={uniforms}
        vertexShader={vertexShader}
        fragmentShader={fragmentShader}
        transparent
        premultipliedAlpha
        depthTest={false}
        depthWrite={false}
      />
    </mesh>
  );
}

function imageTexture(img) {
  if (!img.complete || !img.naturalWidth) return null;
  const texture = new THREE.Texture(img);
  texture.needsUpdate = true;
  texture.userData.radius = parseFloat(getComputedStyle(img).borderTopLeftRadius) || 0;
  texture.userData.pad = 0;
  return texture;
}

function textTexture(el) {
  const box = el.getBoundingClientRect();
  if (!box.width || !box.height) return null;
  const pad = 6;
  const scale = Math.min(window.devicePixelRatio || 1, 2);
  const canvas = document.createElement('canvas');
  canvas.width = Math.ceil((box.width + pad * 2) * scale);
  canvas.height = Math.ceil((box.height + pad * 2) * scale);
  const ctx = canvas.getContext('2d');
  ctx.scale(scale, scale);
  ctx.textBaseline = 'alphabetic';

  const range = document.createRange();
  const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const style = getComputedStyle(node.parentElement);
    if (style.visibility === 'hidden') continue;
    ctx.font = `${style.fontStyle} ${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
    ctx.fillStyle = style.color;
    const fontSize = parseFloat(style.fontSize) || 16;
    const words = /\S+/g;
    let match;
    while ((match = words.exec(node.textContent))) {
      range.setStart(node, match.index);
      range.setEnd(node, match.index + match[0].length);
      // words broken across lines have a box per line, use the first
      const rect = range.getClientRects()[0] || range.getBoundingClientRect();
      const metrics = ctx.measureText(match[0]);
      const ascent = metrics.fontBoundingBoxAscent ?? fontSize * 0.92;
      const descent = metrics.fontBoundingBoxDescent ?? fontSize * 0.24;
      const baseline = rect.top - box.top + (rect.height - ascent - descent) / 2 + ascent;
      ctx.fillText(match[0], rect.left - box.left + pad, baseline + pad);
    }
  }

  const texture = new THREE.CanvasTexture(canvas);
  texture.premultiplyAlpha = true;
  texture.userData.pad = pad;
  texture.userData.radius = 0;
  return texture;
}

const vertexShader = `
  uniform vec2 viewport;
  uniform vec4 rect;
  uniform float pad;
  varying vec2 vUv;
  varying vec2 vPx;

  void main() {
    vUv = vec2(position.x * 0.5 + 0.5, 0.5 - position.y * 0.5);
    vec2 px = rect.xy - pad + vUv * (rect.zw + pad * 2.0);
    vPx = px - rect.xy;
    gl_Position = vec4(px.x / viewport.x * 2.0 - 1.0, 1.0 - px.y / viewport.y * 2.0, 0.0, 1.0);
  }
`;

const fragmentShader = `
  uniform sampler2D tex;
  uniform vec4 rect;
  uniform float radius;
  varying vec2 vUv;
  varying vec2 vPx;

  void main() {
    vec4 color = texture2D(tex, vec2(vUv.x, 1.0 - vUv.y));
    if (radius > 0.0) {
      vec2 half_ = rect.zw * 0.5;
      vec2 q = abs(vPx - half_) - half_ + radius;
      float d = length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - radius;
      color *= 1.0 - smoothstep(-0.75, 0.75, d);
    }
    gl_FragColor = color;
  }
`;
