import { Canvas, useFrame, useThree } from '@react-three/fiber';
import { cancelFrame, frame } from 'framer-motion';
import React, { useEffect, useMemo, useRef, useState } from 'react';
import * as THREE from 'three';

import ErrorBoundary from '../ErrorBoundary';
import Caustics from './Caustics';
import PaintedPage from '../Glass/PaintedPage';
import { CoverBackdrop, DraftingGrid } from './ProjectBackdrops';
import LiquidGlassPass from './LiquidGlassPass';
import RelightBackdrop from './RelightBackdrop';
import { MIN_FPS } from './relight/adaptiveQuality';
import { RelightFrameClock } from './relight/frameClock';
import useCardLights, { CARD_SELECTOR } from './useCardLights';

// type: 'torusKnot',
// args: [1, 0.4, 512, 64, 2, 3],

const SCENE_PRESETS = {
  art: {
    shape: {
      type: 'torusKnot',
      // needs this many segments or the shader's ripples show up as facets
      args: [0.5, 0.3, 1024, 128, 2],
      baseRotation: [0.2, 0, 0],
      tiltSpeed: 0.28,
      tiltAmplitude: 0.06,
    },
    ambientLightIntensity: 100,
    spotLight: { position: [5, 5, 5], color: '#ff8e8e', intensity: 1 },
    pointLights: [
      { position: [-10, 5, -5], intensity: 10000, color: '#ff00ff' },
      { position: [10, -5, 5], intensity: 10000, color: '#00ffff' },
    ],
    distortionFactor: 0.2,
    rotationWaveSpeed: 0.5,
    rotationWaveAmplitude: 0.2,
    spinSpeed: 0.02,
    mobileScale: 0.7,
    desktopScale: 1.2,
  },
  cs: {
    shape: {
      // type: 'cone',
      // args: [.2, .4, 128, 64],
      type: 'ring',
      args: [0.3, 0.3, 512, 96],
      baseRotation: [0.2, 0, 0],
      tiltSpeed: 0.28,
      tiltAmplitude: 0.06,
    },
    ambientLightIntensity: 100,
    spotLight: { position: [5, 5, 5], color: '#ff8e8e', intensity: 1 },
    pointLights: [
      { position: [-10, 5, -5], intensity: 10000, color: '#ff00ff' },
      { position: [10, -5, 5], intensity: 10000, color: '#00ffff' },
    ],
    distortionFactor: 0.2,
    rotationWaveSpeed: 0.5,
    rotationWaveAmplitude: 0.2,
    spinSpeed: 0.02,
    mobileScale: 0.7,
    desktopScale: 1.2,
  },
  hub: {
    shape: {
      type: 'box',
      args: [0.5, 0.3, 10, 32, 2],
      baseRotation: [0.2, 0, 0],
      tiltSpeed: 0.28,
      tiltAmplitude: 0.06,
    },
    ambientLightIntensity: 100,
    spotLight: { position: [5, 5, 5], color: '#ff8e8e', intensity: 1 },
    pointLights: [
      { position: [-10, 5, -5], intensity: 10000, color: '#ff00ff' },
      { position: [10, -5, 5], intensity: 10000, color: '#00ffff' },
    ],
    distortionFactor: 0.2,
    rotationWaveSpeed: 0.5,
    rotationWaveAmplitude: 0.2,
    spinSpeed: 0.02,
    mobileScale: 0.7,
    desktopScale: 1.2,
  },
};

const LENSES = {
  // anodised titanium look
  cs: {
    a: [0.902, 0.925, 0.949],
    b: [0.49, 0.541, 0.6],
    strength: 0.6,
    solidFocus: true,
    settledSaturation: 0.25,
  },
  art: {
    a: [1.0, 0.36, 0.44],
    b: [1.0, 0.68, 0.3],
    strength: 0.72,
    settledGlow: 0.24,
    slosh: 2.2,
    smoothFill: true,
  },
};

export default function DistortedTorusScene({
  className = 'h-screen w-full relative',
  variant = 'art',
  cameraPosition = [0, 0, 5],
  lens = null,
  drip = false,
  onDrip,
  backdrop = 'knot',
  image,
  glass,
  followScroll = false,
  onFirstFrame,
  startAt = 0,
}) {
  const layer = useRef(null);
  const preset = SCENE_PRESETS[variant] || SCENE_PRESETS.art;
  // hub keeps full res since its headline is drawn as glass in this canvas
  const compact = useMemo(
    () => window.matchMedia?.('(max-width: 768px), (pointer: coarse)').matches ?? false,
    []
  );
  const { maxDpr: glassDpr, blurTaps: glassTaps, glassOnly: onlyGlass, ...passProps } = glass || {};
  const maxDpr = glassDpr ?? (compact && !glass?.textSelector ? 1 : 1.5);
  const settles = backdrop === 'grid';
  const dripState = useRef(null);
  if (!dripState.current) {
    dripState.current = { progress: 0, rect: null };
  }
  const [relightFailed, setRelightFailed] = useState(false);
  const relight = backdrop === 'relight' && !relightFailed;
  // held here because Canvas re-applies its dpr prop every render
  const [relightDpr, setRelightDpr] = useState(null);
  const relightFrame = useRef(null);

  return (
    <div ref={layer} className={className}>
      <ErrorBoundary name="webgl">
        <Canvas
          camera={{ position: cameraPosition, fov: 60 }}
          dpr={relight && relightDpr ? relightDpr : [1, maxDpr]}
          gl={{ antialias: !glass }}
          resize={{ scroll: false }}
          frameloop="never"
          onCreated={({ clock }) => {
            clock.autoStart = false;
            clock.elapsedTime = startAt;
          }}
          style={{ width: '100%', height: '100%', pointerEvents: 'none' }}
        >
          <AfterMotion
            settle={settles}
            onFirstFrame={onFirstFrame}
            startAt={startAt}
            relightFrame={relight ? relightFrame : null}
          />
          {/* Has to be first so every frame callback sees the canvas over the viewport. */}
          {followScroll && <ScrollFollow layer={layer} />}
          <ambientLight intensity={preset.ambientLightIntensity} color="#ffffff" />
          <spotLight
            position={preset.spotLight.position}
            angle={0.2}
            penumbra={1}
            intensity={preset.spotLight.intensity}
            color={preset.spotLight.color}
            castShadow
          />
          {preset.pointLights.map((light) => (
            <pointLight
              key={`${light.position.join('-')}-${light.color}`}
              position={light.position}
              intensity={light.intensity}
              color={light.color}
            />
          ))}

          {drip && !relight && <DripDriver state={dripState.current} onProgress={onDrip} />}
          {relight ? (
            <RelightBackdrop
              frameInfo={relightFrame}
              onProgress={onDrip}
              onFail={() => setRelightFailed(true)}
              onDpr={setRelightDpr}
            />
          ) : backdrop === 'page' ? (
            <PaintedPage />
          ) : backdrop === 'caustics' ? (
            <Caustics lens={LENSES[lens]} />
          ) : backdrop === 'grid' ? (
            <DraftingGrid />
          ) : backdrop === 'cover' ? (
            <CoverBackdrop image={image} />
          ) : (
            <DistortedTorus
              preset={preset}
              lens={LENSES[lens]}
              dripState={drip ? dripState.current : null}
            />
          )}
          {drip && !relight && <LiquidDrip lens={LENSES[lens]} state={dripState.current} />}

          {glass && (
            <LiquidGlassPass
              {...passProps}
              glassOnly={relight || Boolean(onlyGlass)}
              blurTaps={compact ? Math.min(glassTaps ?? 6, 8) : glassTaps ?? 12}
            />
          )}
        </Canvas>
      </ErrorBoundary>
    </div>
  );
}

// drives frames after framer-motion moves the cards. on r3f's own loop the glass
// drew the cards where they were a frame ago
const SETTLE_MS = 900;
function AfterMotion({ settle = false, onFirstFrame, startAt = 0, relightFrame = null }) {
  const advance = useThree((state) => state.advance);
  const firstFrame = useRef(onFirstFrame);
  firstFrame.current = onFirstFrame;
  const drawn = useRef(false);

  useEffect(() => {
    const start = performance.now();
    let last = '';
    let busyUntil = start + SETTLE_MS;
    const clock = relightFrame ? new RelightFrameClock(MIN_FPS) : null;
    const tick = ({ timestamp }) => {
      if (clock) {
        if (document.hidden) {
          clock.suspend();
          return;
        }
        const sample = clock.step(timestamp);
        if (!sample) return;
        relightFrame.current = sample;
      }
      if (settle) {
        const now = sceneState();
        if (now !== last) {
          last = now;
          busyUntil = timestamp + SETTLE_MS;
        }
        if (timestamp > busyUntil) {
          return;
        }
      }
      const elapsed = window.__sceneStill ? 0 : Math.max(0, (timestamp - start) / 1000);
      advance(startAt + elapsed);
      if (!drawn.current) {
        drawn.current = true;
        firstFrame.current?.();
      }
    };
    frame.postRender(tick, true);
    return () => cancelFrame(tick);
  }, [advance, settle, startAt, relightFrame]);

  return null;
}

function sceneState() {
  let state = `${window.scrollY}|${window.innerWidth}x${window.innerHeight}`;
  document.querySelectorAll(CARD_SELECTOR).forEach((el) => {
    const r = el.getBoundingClientRect();
    state += `|${r.left},${r.top},${r.width},${r.height}${el.matches(':hover') ? 'h' : ''}`;
  });
  return state;
}

// a fixed canvas lags the page on phones (iOS especially) because the browser scrolls
// on its own thread. so the canvas scrolls with the page and gets moved back each frame
function ScrollFollow({ layer }) {
  const offset = useRef(0);

  useFrame(() => {
    const el = layer.current;
    if (!el) {
      return;
    }
    // clamp at 0 for iOS overscroll bounce
    const next = Math.max(0, offset.current - el.getBoundingClientRect().top);
    if (next !== offset.current) {
      offset.current = next;
      el.style.transform = `translate3d(0, ${next}px, 0)`;
    }
  }, -1);

  return null;
}

const PANEL_SELECTOR = '[data-prism-panel]';
const DRIP_START = 0.03;
const DRIP_END_TOP = 0.14;
const TIMELINE = {
  condenseEnd: 0.12,
  handoff: [0.07, 0.13],
  fall: [0.12, 0.3],
  splash: [0.3, 0.48],
  fill: [0.44, 1],
};
const SETTLE = [0.3, 0.44];

function DripDriver({ state, onProgress }) {
  const panelElement = useRef(null);
  const lastScroll = useRef(null);
  const updateLights = useCardLights();
  const reduceMotion = useMemo(
    () => window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false,
    []
  );

  useFrame(({ size }, delta) => {
    if (!panelElement.current?.isConnected) {
      panelElement.current = document.querySelector(PANEL_SELECTOR);
    }
    const el = panelElement.current;
    if (!el) {
      state.rect = null;
      return;
    }

    const y = window.scrollY;
    const speed = lastScroll.current === null || delta <= 0 ? 0 : (y - lastScroll.current) / delta;
    lastScroll.current = y;
    state.velocity = reduceMotion ? 0 : THREE.MathUtils.damp(state.velocity || 0, speed, 4, delta);

    state.focusLights = updateLights(el, size, delta);

    const rect = el.getBoundingClientRect();
    const vh = Math.max(size.height, 1);
    // short galleries might not scroll far enough to finish
    const maxScroll = Math.max(0, document.documentElement.scrollHeight - vh);
    let start = DRIP_START * vh;
    let end = Math.max(rect.top + window.scrollY - DRIP_END_TOP * vh, start + 0.2 * vh);
    end = Math.min(end, maxScroll);
    if (end - start < 0.15 * vh) {
      start = 0;
      end = maxScroll;
    }
    const target = end > 0 ? clamp01((window.scrollY - start) / (end - start)) : 1;

    const previous = state.progress;
    let progress = THREE.MathUtils.damp(previous, target, 5, delta);
    if (Math.abs(progress - target) < 0.0005) {
      progress = target;
    }
    state.progress = progress;
    state.rect = rect;
    if (onProgress && progress !== previous) {
      onProgress(progress);
    }
  });

  return null;
}

// everything is SDFs smooth-unioned together, that's what makes it bead and neck like liquid
function LiquidDrip({ lens, state }) {
  const uniforms = useMemo(
    () => ({
      time: { value: 0 },
      dpr: { value: 1 },
      viewport: { value: new THREE.Vector2(1, 1) },
      panel: { value: new THREE.Vector4(0, 0, 0, 0) }, // left, top, right, bottom (px)
      panelRadius: { value: 28 },
      drop: { value: new THREE.Vector4(0, 0, 0, 1) }, // x, y, radius, stretch
      puddle: { value: new THREE.Vector3(0, 0, 0) }, // x, half width, thickness
      mound: { value: new THREE.Vector3(0, 0, 0) }, // x, half width, height
      fillFront: { value: -1e4 },
      dripLength: { value: 0 },
      settle: { value: 0 },
      slosh: { value: 0 },
      focusA: { value: new THREE.Vector4(0, 0, 0, 0) },
      focusAAmount: { value: 0 },
      focusB: { value: new THREE.Vector4(0, 0, 0, 0) },
      focusBAmount: { value: 0 },
      focusSolid: { value: lens?.solidFocus ? 1 : 0 },
      settledSaturation: { value: lens?.settledSaturation ?? 1 },
      settledGlow: { value: lens?.settledGlow ?? 0 },
      tintA: { value: new THREE.Vector3(...(lens?.a || [1, 1, 1])) },
      tintB: { value: new THREE.Vector3(...(lens?.b || [1, 1, 1])) },
      lensStrength: { value: lens?.strength || 0 },
    }),
    [lens]
  );

  useFrame(({ clock, size, viewport }) => {
    uniforms.time.value = clock.getElapsedTime();
    uniforms.dpr.value = viewport.dpr;
    uniforms.viewport.value.set(size.width, size.height);

    const { rect, progress } = state;
    if (!rect || progress <= TIMELINE.handoff[0]) {
      uniforms.drop.value.z = 0;
      uniforms.puddle.value.y = 0;
      uniforms.mound.value.z = 0;
      uniforms.fillFront.value = -1e4;
      uniforms.dripLength.value = 0;
      return;
    }

    const small = size.width < 640;
    const pad = small ? 10 : 24;
    const left = rect.left - pad;
    const right = rect.right + pad;
    const top = rect.top - pad;
    const bottom = rect.bottom + pad;
    uniforms.panel.value.set(left, top, right, bottom);
    uniforms.panelRadius.value = small ? 20 : 28;

    const radius = small ? 26 : 38;
    const appear = easeOutBack(phase(progress, TIMELINE.handoff));
    const fall = phase(progress, TIMELINE.fall);
    const sink = phase(progress, [TIMELINE.fall[1], TIMELINE.fall[1] + 0.08]);
    const startX = size.width / 2;
    const startY = size.height / 2;
    const impactX = (left + right) / 2;
    const dropX = THREE.MathUtils.lerp(startX, impactX, easeInOutCubic(fall));
    const dropY = THREE.MathUtils.lerp(startY, top + radius * 0.4, fall * fall) + sink * radius;
    const stretch = 1 + 0.55 * Math.sin(Math.PI * Math.min(fall * 1.15, 1));
    uniforms.drop.value.set(dropX, dropY, radius * appear * (1 - sink), stretch);

    const splash = easeOutCubic(phase(progress, TIMELINE.splash));
    uniforms.puddle.value.set(
      impactX,
      splash > 0 ? THREE.MathUtils.lerp(radius, (right - left) / 2, splash) : 0,
      small ? 14 : 20
    );
    const heave = phase(progress, [TIMELINE.fall[1] - 0.02, TIMELINE.splash[1]]);
    uniforms.mound.value.set(
      impactX,
      THREE.MathUtils.lerp(radius * 1.2, radius * 4, easeOutCubic(heave)),
      heave > 0 ? radius * 1.1 * Math.sin(Math.PI * heave) * (1 - 0.35 * heave) : 0
    );

    const fill = phase(progress, TIMELINE.fill);
    uniforms.fillFront.value =
      progress >= 1
        ? bottom + 400
        : fill > 0
          ? THREE.MathUtils.lerp(top + 20, Math.max(size.height + 160, top + 20), easeInOutCubic(fill))
          : -1e4;
    uniforms.dripLength.value = lens?.smoothFill
      ? 0
      : (small ? 110 : 190) * Math.sin(Math.PI * Math.min(fill * 1.4, 1));

    uniforms.settle.value = easeInOutCubic(phase(progress, SETTLE));
    uniforms.slosh.value =
      THREE.MathUtils.clamp((state.velocity || 0) / 2200, -1, 1) * (small ? 7 : 11) * (lens?.slosh ?? 1);
    const [lightA, lightB] = state.focusLights || [];
    uniforms.focusAAmount.value = lightA ? lightA[4] : 0;
    uniforms.focusBAmount.value = lightB ? lightB[4] : 0;
    if (lightA) {
      uniforms.focusA.value.set(lightA[0], lightA[1], lightA[2], lightA[3]);
    }
    if (lightB) {
      uniforms.focusB.value.set(lightB[0], lightB[1], lightB[2], lightB[3]);
    }
  });

  return (
    <mesh frustumCulled={false} renderOrder={1}>
      <planeGeometry args={[2, 2]} />
      <shaderMaterial
        uniforms={uniforms}
        vertexShader={liquidVertexShader}
        fragmentShader={liquidFragmentShader}
        transparent
        depthTest={false}
        depthWrite={false}
      />
    </mesh>
  );
}

function phase(progress, [start, end]) {
  return clamp01((progress - start) / (end - start));
}

function DistortedTorus({ preset, lens, dripState }) {
  const meshRef = useRef();
  const shape = preset.shape || SCENE_PRESETS.art.shape;
  const windowWidth = typeof window !== 'undefined' ? window.innerWidth : 1280;
  const isMobile = windowWidth <= 768;
  const scale = isMobile ? preset.mobileScale : preset.desktopScale;
  const uniforms = useMemo(
    () => ({
      time: { value: 0 },
      distortionFactor: { value: preset.distortionFactor },
      introOpacity: { value: 0 },
      introGlow: { value: 1 },
      resolution: {
        value: new THREE.Vector2(
          typeof window !== 'undefined' ? window.innerWidth : 1920,
          typeof window !== 'undefined' ? window.innerHeight : 1080
        ),
      },
      colorTransition: { value: 0.5 },
      tintA: { value: new THREE.Vector3(...(lens?.a || [1, 1, 1])) },
      tintB: { value: new THREE.Vector3(...(lens?.b || [1, 1, 1])) },
      lensStrength: { value: lens?.strength || 0 },
      fade: { value: 0 },
    }),
    [preset.distortionFactor, lens]
  );

  useFrame(({ clock }) => {
    if (!meshRef.current) {
      return;
    }

    const elapsedTime = clock.getElapsedTime();
    const baseRotation = preset.shape?.baseRotation || [0, 0, 0];
    const tiltSpeed = preset.shape?.tiltSpeed ?? 0.3;
    const tiltAmplitude = preset.shape?.tiltAmplitude ?? 0.04;
    const introDuration = preset.introDuration ?? 1.8;
    const introDelay = preset.introDelay ?? 0.05;
    const introStartScale = preset.introStartScale ?? 0;
    const introStartZ = preset.introStartZ ?? -2.2;
    const introStartY = preset.introStartY ?? 0.35;
    const introSpinBoost = preset.introSpinBoost ?? 1.3;

    const introTime = clamp01((elapsedTime - introDelay) / introDuration);
    const introEase = easeOutCubic(introTime);
    const introScaleEase = easeOutBack(introTime);
    const introFadeEase = easeInOutCubic(introTime);

    const rotationAngle =
      Math.sin(elapsedTime * preset.rotationWaveSpeed) * preset.rotationWaveAmplitude;
    const introSpin = (1 - introEase) * (1 - introEase) * introSpinBoost;
    const introScaleMultiplier = THREE.MathUtils.lerp(
      introStartScale,
      1,
      introScaleEase
    );

    const progress = dripState?.progress ?? 0;
    const condense = easeInOutCubic(clamp01(progress / TIMELINE.condenseEnd));
    const fade = phase(progress, TIMELINE.handoff);

    meshRef.current.position.y =
      THREE.MathUtils.lerp(introStartY, 0, introEase) +
      Math.sin(elapsedTime * 1.2) * 0.02 * introFadeEase;
    meshRef.current.position.z = THREE.MathUtils.lerp(introStartZ, 0, introEase);

    meshRef.current.rotation.x =
      baseRotation[0] + Math.sin(elapsedTime * tiltSpeed) * tiltAmplitude;
    meshRef.current.rotation.y =
      baseRotation[1] + rotationAngle + introSpin + condense * Math.PI * 1.5;
    meshRef.current.rotation.z =
      baseRotation[2] + elapsedTime * preset.spinSpeed + (1 - introEase) * 0.4;

    meshRef.current.scale.setScalar(
      scale * introScaleMultiplier * THREE.MathUtils.lerp(1, 0.08, condense)
    );
    meshRef.current.visible = fade < 1;

    uniforms.distortionFactor.value =
      THREE.MathUtils.lerp(preset.distortionFactor * 2.25, preset.distortionFactor, introEase) *
      (1 + condense * 1.5);
    uniforms.introOpacity.value = introFadeEase;
    uniforms.introGlow.value = 1 - introEase;
    uniforms.time.value = elapsedTime;
    uniforms.fade.value = fade;
  });

  return (
    <mesh ref={meshRef} scale={scale}>
      <ShapeGeometry type={shape.type} args={shape.args} />
      <shaderMaterial
        uniforms={uniforms}
        vertexShader={vertexShader}
        fragmentShader={fragmentShader}
        transparent
      />
    </mesh>
  );
}

function ShapeGeometry({ type, args }) {
  switch (type) {
    case 'box':
      return <boxGeometry args={args} />;
    case 'icosahedron':
      return <icosahedronGeometry args={args} />;
    case 'torus':
      return <torusGeometry args={args} />;
    case 'sphere':
      return <sphereGeometry args={args} />;
    case 'torusKnot':
    default:
      return <torusKnotGeometry args={args} />;
  }
}

function clamp01(value) {
  return Math.max(0, Math.min(1, value));
}

function easeOutCubic(t) {
  return 1 - Math.pow(1 - t, 3);
}

function easeInOutCubic(t) {
  return t < 0.5
    ? 4 * t * t * t
    : 1 - Math.pow(-2 * t + 2, 3) / 2;
}

function easeOutBack(t) {
  const c1 = 1.70158;
  const c3 = c1 + 1;
  return 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2);
}

const vertexShader = `
  varying vec2 vUv;
  uniform float time;
  uniform float distortionFactor;

  void main() {
    vUv = uv;
    vec3 transformed = position;

    transformed.x += sin(transformed.y * 10.0 + time) * distortionFactor;
    transformed.y += cos(transformed.x * 10.0 + time) * distortionFactor;

    gl_Position = projectionMatrix * modelViewMatrix * vec4(transformed, 1.0);
  }
`;

const fragmentShader = `
  varying vec2 vUv;
  uniform float time;
  uniform vec2 resolution;
  uniform float colorTransition;
  uniform float introOpacity;
  uniform float introGlow;
  uniform vec3 tintA;
  uniform vec3 tintB;
  uniform float lensStrength;
  uniform float fade;

  float fresnel(vec3 viewDirection, vec3 normal) {
    return pow(1.0 - dot(viewDirection, normal), 3.0);
  }

  void main() {
    vec3 normal = normalize(vec3(vUv, 1.0));
    vec3 viewDirection = normalize(vec3(0.0, 0.0, 1.0));

    float r = 0.5 + 0.5 * sin(vUv.x * 2.0 + time * 0.5);
    float g = 0.5 + 0.5 * cos(vUv.y * 2.0 + time * 0.5);
    float b = 0.5 + 0.5 * sin((vUv.x + vUv.y) * 4.0 - time * 0.5);
    vec3 baseColor = vec3(r, g, b);

    float lum = dot(baseColor, vec3(0.333));
    vec3 lensColor = mix(tintA, tintB, smoothstep(0.2, 0.8, 0.5 * (r + b)));
    baseColor = mix(baseColor, lensColor * (0.55 + lum * 0.8), lensStrength);

    float fresnelFactor = fresnel(viewDirection, normal);
    vec3 fresnelColor = vec3(0.9, 0.9, 1.0) * fresnelFactor;

    vec3 finalColor = mix(baseColor, fresnelColor, fresnelFactor * 0.6);

    vec3 refractedColor = mix(finalColor, vec3(1.0), fresnelFactor);

    float alpha = (0.7 + fresnelFactor * 0.4) * (0.2 + 0.8 * introOpacity) * (1.0 - fade);
    vec3 reflectionColor = vec3(0.8, 0.9, 1.0);
    vec3 entryGlow = vec3(0.65, 0.85, 1.0) * introGlow * (0.5 + fresnelFactor);
    vec3 finalLitColor = mix(refractedColor, reflectionColor, fresnelFactor) + entryGlow;

    gl_FragColor = vec4(finalLitColor, alpha);
  }
`;

const liquidVertexShader = `
  void main() {
    gl_Position = vec4(position.xy, 0.0, 1.0);
  }
`;

const liquidFragmentShader = `
  uniform float time;
  uniform float dpr;
  uniform vec2 viewport;
  uniform vec4 panel;
  uniform float panelRadius;
  uniform vec4 drop;
  uniform vec3 puddle;
  uniform vec3 mound;
  uniform float fillFront;
  uniform float dripLength;
  uniform float settle;
  uniform float slosh;
  uniform vec4 focusA;
  uniform float focusAAmount;
  uniform vec4 focusB;
  uniform float focusBAmount;
  uniform float focusSolid;
  uniform float settledSaturation;
  uniform float settledGlow;
  uniform vec3 tintA;
  uniform vec3 tintB;
  uniform float lensStrength;

  float smin(float a, float b, float k) {
    float h = clamp(0.5 + 0.5 * (b - a) / k, 0.0, 1.0);
    return mix(b, a, h) - k * h * (1.0 - h);
  }

  float sdRoundBox(vec2 p, vec2 halfSize, float r) {
    vec2 q = abs(p) - halfSize + r;
    return length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - r;
  }

  float sdBox(vec2 p, vec2 halfSize) {
    vec2 q = abs(p) - halfSize;
    return length(max(q, 0.0)) + min(max(q.x, q.y), 0.0);
  }

  float sdCapsule(vec2 p, vec2 a, vec2 b, float r) {
    vec2 pa = p - a;
    vec2 ba = b - a;
    float h = clamp(dot(pa, ba) / dot(ba, ba), 0.0, 1.0);
    return length(pa - ba * h) - r;
  }

  vec3 cardLight(vec2 p, vec4 rect, float amount, vec3 baseColor) {
    vec2 center = 0.5 * (rect.xy + rect.zw);
    vec2 halfSize = 0.5 * (rect.zw - rect.xy);
    float df = sdRoundBox(p - center, halfSize, 24.0);
    if (focusSolid > 0.5) {
      vec2 fromCorner = abs(p - center) - (halfSize - 24.0);
      float corner = smoothstep(-90.0, 0.0, min(fromCorner.x, fromCorner.y));
      float band = exp(-abs(df) / 6.0) * mix(0.12, 1.0, corner);
      float spill = df > 0.0 ? exp(-df / 60.0) * 0.04 : 0.0;
      return vec3(1.0) * (band * 0.28 + spill) * amount;
    }
    float halo = exp(-max(df, 0.0) / 48.0);
    return baseColor * halo * 0.42 * amount;
  }

  float hash(float n) {
    return fract(sin(n * 127.1) * 43758.5453);
  }

  // css px, y down
  float liquid(vec2 p, out float dropField) {
    vec2 panelCenter = 0.5 * (panel.xy + panel.zw);
    vec2 panelHalf = 0.5 * (panel.zw - panel.xy);
    float inPanel = sdRoundBox(p - panelCenter, panelHalf, panelRadius);

    dropField = 1e5;
    if (drop.z > 0.5) {
      vec2 d = p - drop.xy;
      d.y /= drop.w;
      dropField = (length(d) - drop.z) * min(1.0, drop.w);
    }

    float pool = 1e5;
    if (puddle.y > 0.0) {
      pool = sdBox(p - vec2(puddle.x, panel.y + puddle.z * 0.5), vec2(puddle.y, puddle.z * 0.5));
    }

    float body = p.y - fillFront;

    float drips = 1e5;
    if (dripLength > 1.0) {
      float span = panel.z - panel.x;
      for (int i = 0; i < 9; i++) {
        float fi = float(i);
        float x = panel.x + span * (fi + 0.5) / 9.0 + (hash(fi) - 0.5) * span * 0.07
          + sin(time * 0.8 + fi * 1.7) * 3.0;
        float len = dripLength * mix(0.35, 1.0, hash(fi + 11.0));
        float w = mix(9.0, 18.0, hash(fi + 23.0));
        drips = min(drips, sdCapsule(p, vec2(x, fillFront - 20.0), vec2(x, fillFront + len), w));
        drips = min(drips, length(p - vec2(x, fillFront + len)) - w * 1.35);
      }
    }

    float spread = smin(pool, smin(body, drips, 22.0), 22.0);
    spread = max(spread, inPanel);

    float heave = 1e5;
    if (mound.z > 0.5) {
      vec2 m = (p - vec2(mound.x, panel.y)) / vec2(mound.y, mound.z);
      heave = (length(m) - 1.0) * min(mound.y, mound.z);
    }

    return smin(dropField, smin(heave, spread, 18.0), 26.0);
  }

  void main() {
    vec2 p = vec2(gl_FragCoord.x, viewport.y * dpr - gl_FragCoord.y) / dpr;

    vec2 q = p;
    q.x += sin(p.y * 0.011 + time * 2.4) * slosh;
    q.y += sin(p.x * 0.009 - time * 2.0) * slosh * 0.6;

    float dropField;
    float d = liquid(q, dropField);
    if (d > 2.0) discard;

    vec2 grad = vec2(dFdx(d), -dFdy(d));
    vec2 n = length(grad) > 1e-4 ? normalize(grad) : vec2(0.0, -1.0);
    float edge = smoothstep(-14.0, 0.0, d);
    float spec = pow(max(dot(n, normalize(vec2(-0.45, -1.0))), 0.0), 6.0) * edge;

    vec2 uv = p / viewport;
    float r = 0.5 + 0.5 * sin(uv.x * 2.0 + time * 0.5);
    float g = 0.5 + 0.5 * cos(uv.y * 2.0 + time * 0.5);
    float b = 0.5 + 0.5 * sin((uv.x + uv.y) * 4.0 - time * 0.5);
    vec3 baseColor = vec3(r, g, b);
    float lum = dot(baseColor, vec3(0.333));
    vec3 lensColor = mix(tintA, tintB, smoothstep(0.2, 0.8, 0.5 * (r + b)));
    baseColor = mix(baseColor, lensColor * (0.55 + lum * 0.8), lensStrength);

    float bead = smoothstep(30.0, -10.0, dropField);
    vec3 color = baseColor * mix(0.38, 0.95, bead);
    color += vec3(1.0) * spec * mix(0.28, 0.6, bead);
    color += baseColor * edge * 0.18;
    if (drop.z > 0.5) {
      vec2 glint = p - drop.xy - vec2(-0.32, -0.38 * drop.w) * drop.z;
      color += vec3(smoothstep(drop.z * 0.26, 0.0, length(glint)) * 0.55 * bead);
    }

    if (settle > 0.0) {
      float inside = max(-d, 0.0);
      vec3 lacquer = vec3(0.034, 0.037, 0.046);
      vec3 edgeColor = mix(vec3(dot(baseColor, vec3(0.333))), baseColor, settledSaturation);
      lacquer += edgeColor * exp(-inside / 22.0) * 0.12;
      lacquer += edgeColor * settledGlow;
      lacquer += mix(vec3(1.0), edgeColor, 0.5) * spec * 0.12;
      float rim = 1.0 - smoothstep(0.0, 1.5, abs(d + 1.0));
      lacquer += edgeColor * rim * 0.14;

      if (focusAAmount > 0.001) lacquer += cardLight(p, focusA, focusAAmount, baseColor);
      if (focusBAmount > 0.001) lacquer += cardLight(p, focusB, focusBAmount, baseColor);

      color = mix(color, lacquer, settle);
    }

    color += (fract(sin(dot(gl_FragCoord.xy, vec2(12.9898, 78.233))) * 43758.5453) - 0.5) / 255.0;

    float alpha = 1.0 - smoothstep(-1.0, 1.0, d);
    gl_FragColor = vec4(color, alpha);
  }
`;
