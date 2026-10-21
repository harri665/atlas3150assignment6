import { useFrame } from '@react-three/fiber';
import React, { useEffect, useMemo, useRef } from 'react';
import * as THREE from 'three';

import { apiUrl } from '../../utils/api';
import useCardLights from './useCardLights';

function FullScreenPlane({ uniforms, fragmentShader }) {
  return (
    <mesh frustumCulled={false}>
      <planeGeometry args={[2, 2]} />
      <shaderMaterial
        uniforms={uniforms}
        vertexShader={vertexShader}
        fragmentShader={fragmentShader}
        depthTest={false}
        depthWrite={false}
      />
    </mesh>
  );
}

// screen coords not canvas coords so the project page's two canvases line up
export function DraftingGrid() {
  const uniforms = useMemo(
    () => ({
      dpr: { value: 1 },
      viewport: { value: new THREE.Vector2(1, 1) },
      origin: { value: new THREE.Vector2(0, 0) },
      screen: { value: new THREE.Vector2(1, 1) },
      focusA: { value: new THREE.Vector4(0, 0, 0, 0) },
      focusAAmount: { value: 0 },
      focusB: { value: new THREE.Vector4(0, 0, 0, 0) },
      focusBAmount: { value: 0 },
    }),
    []
  );
  const updateLights = useCardLights();

  useFrame(({ gl, size, viewport }, delta) => {
    uniforms.dpr.value = viewport.dpr;
    uniforms.viewport.value.set(size.width, size.height);
    const rect = gl.domElement.getBoundingClientRect();
    uniforms.origin.value.set(rect.left, rect.top);
    uniforms.screen.value.set(window.innerWidth, window.innerHeight);

    const [lightA, lightB] = updateLights(document, size, delta);
    uniforms.focusAAmount.value = lightA ? lightA[4] : 0;
    uniforms.focusBAmount.value = lightB ? lightB[4] : 0;
    if (lightA) {
      uniforms.focusA.value.set(lightA[0], lightA[1], lightA[2], lightA[3]);
    }
    if (lightB) {
      uniforms.focusB.value.set(lightB[0], lightB[1], lightB[2], lightB[3]);
    }
  });

  return <FullScreenPlane uniforms={uniforms} fragmentShader={gridFragmentShader} />;
}

export function CoverBackdrop({ image }) {
  const texture = useRef(null);
  const loadedAt = useRef(null);
  const uniforms = useMemo(
    () => ({
      dpr: { value: 1 },
      viewport: { value: new THREE.Vector2(1, 1) },
      scroll: { value: 0 },
      tCover: { value: null },
      coverSize: { value: new THREE.Vector2(1, 1) },
      ready: { value: 0 },
    }),
    []
  );

  useEffect(() => {
    if (!image) {
      return undefined;
    }
    let cancelled = false;
    const loader = new THREE.TextureLoader();
    loader.setCrossOrigin('anonymous');
    // artstation's cdn has no CORS headers, goes through the api
    loader.load(
      apiUrl(`/proxy/image?url=${encodeURIComponent(image)}`),
      (loaded) => {
        if (cancelled) {
          loaded.dispose();
          return;
        }
        loaded.generateMipmaps = true;
        loaded.minFilter = THREE.LinearMipmapLinearFilter;
        loaded.needsUpdate = true;
        texture.current?.dispose();
        texture.current = loaded;
        uniforms.tCover.value = loaded;
        uniforms.coverSize.value.set(loaded.image.width || 1, loaded.image.height || 1);
        loadedAt.current = null;
      },
      undefined,
      () => {}
    );
    return () => {
      cancelled = true;
    };
  }, [image, uniforms]);

  useEffect(() => () => texture.current?.dispose(), []);

  useFrame(({ clock, size, viewport }) => {
    uniforms.dpr.value = viewport.dpr;
    uniforms.viewport.value.set(size.width, size.height);
    uniforms.scroll.value = window.scrollY;
    if (uniforms.tCover.value) {
      if (loadedAt.current === null) {
        loadedAt.current = clock.getElapsedTime();
      }
      uniforms.ready.value = Math.min(1, (clock.getElapsedTime() - loadedAt.current) / 0.8);
    }
  });

  return <FullScreenPlane uniforms={uniforms} fragmentShader={coverFragmentShader} />;
}

const vertexShader = `
  void main() {
    gl_Position = vec4(position.xy, 0.0, 1.0);
  }
`;

const gridFragmentShader = `
  #define SPACING 24.0

  uniform float dpr;
  uniform vec2 viewport;
  uniform vec2 origin;
  uniform vec2 screen;
  uniform vec4 focusA;
  uniform float focusAAmount;
  uniform vec4 focusB;
  uniform float focusBAmount;

  float sdRoundBox(vec2 p, vec2 halfSize, float r) {
    vec2 q = abs(p) - halfSize + r;
    return length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - r;
  }

  vec3 paneLight(vec2 p, vec4 rect, float amount) {
    vec2 center = 0.5 * (rect.xy + rect.zw);
    vec2 halfSize = 0.5 * (rect.zw - rect.xy);
    float df = sdRoundBox(p - center, halfSize, 24.0);
    vec2 fromCorner = abs(p - center) - (halfSize - 24.0);
    float corner = smoothstep(-90.0, 0.0, min(fromCorner.x, fromCorner.y));
    float band = exp(-abs(df) / 6.0) * mix(0.12, 1.0, corner);
    float spill = df > 0.0 ? exp(-df / 60.0) * 0.04 : 0.0;
    return vec3(1.0) * (band * 0.28 + spill) * amount;
  }

  void main() {
    vec2 px = vec2(gl_FragCoord.x, viewport.y * dpr - gl_FragCoord.y) / dpr + origin;
    vec2 g = px - vec2(screen.x * 0.5, 0.0);

    vec2 index = floor(g / SPACING + 0.5);
    vec2 cell = g - index * SPACING;
    vec2 every5 = abs(mod(index, 5.0));
    bool major = every5.x < 0.5 && every5.y < 0.5;

    float radius = major ? 1.3 : 0.95;
    float d = length(cell) - radius;
    float dotMask = 1.0 - smoothstep(-0.6, 0.6, d);

    vec3 base = vec3(0.031, 0.035, 0.047);
    float strength = major ? 0.2 : 0.1;

    vec2 uv = px / screen;
    float falloff = smoothstep(1.0, 0.35, length((uv - 0.5) * vec2(1.1, 1.3)));

    vec3 color = base + dotMask * strength * mix(0.45, 1.0, falloff);
    if (focusAAmount > 0.001) color += paneLight(px, focusA, focusAAmount);
    if (focusBAmount > 0.001) color += paneLight(px, focusB, focusBAmount);
    color += (fract(sin(dot(floor(px * dpr), vec2(12.9898, 78.233))) * 43758.5453) - 0.5) / 255.0;
    gl_FragColor = vec4(color, 1.0);
  }
`;

const coverFragmentShader = `
  uniform float dpr;
  uniform vec2 viewport;
  uniform float scroll;
  uniform sampler2D tCover;
  uniform vec2 coverSize;
  uniform float ready;

  void main() {
    vec2 uv = gl_FragCoord.xy / (viewport * dpr);
    vec3 base = vec3(0.031, 0.035, 0.047);
    vec3 color = base;

    if (ready > 0.0) {
      float screenAspect = viewport.x / viewport.y;
      float imageAspect = coverSize.x / coverSize.y;
      vec2 fit = screenAspect > imageAspect
        ? vec2(1.0, imageAspect / screenAspect)
        : vec2(screenAspect / imageAspect, 1.0);
      vec2 tuv = (uv - 0.5) * fit / 1.2 + 0.5;
      tuv.y += min(scroll / viewport.y, 3.0) * 0.03;

      // small mips + a ring of taps so the mip levels don't show as blocks
      vec3 image = texture2D(tCover, tuv, 6.0).rgb * 0.2;
      for (int i = 0; i < 8; i++) {
        float a = float(i) * 0.785398;
        image += texture2D(tCover, tuv + vec2(cos(a), sin(a)) * 0.035, 6.5).rgb * 0.1;
      }

      float luma = dot(image, vec3(0.2126, 0.7152, 0.0722));
      image = mix(vec3(luma), image, 0.8);
      float fromBottom = smoothstep(0.0, 0.9, uv.y);
      float vignette = smoothstep(1.2, 0.3, length((uv - 0.5) * vec2(1.2, 1.0)));
      color = mix(base, base + image * 0.5 * mix(0.45, 1.0, fromBottom) * vignette, ready);
    }

    color += (fract(sin(dot(gl_FragCoord.xy, vec2(12.9898, 78.233))) * 43758.5453) - 0.5) / 255.0;
    gl_FragColor = vec4(color, 1.0);
  }
`;
