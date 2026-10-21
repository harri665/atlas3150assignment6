import { useFrame, useThree } from '@react-three/fiber';
import { useEffect, useMemo, useRef, useState } from 'react';
import * as THREE from 'three';

import {
  createBackdropState,
  failRelight,
  releaseDevice,
  startRelight,
  stopRelight,
} from './relight/backdropEngine';
import { renderBackdropFrame } from './relight/backdropFrame';
import { reportRun, saveState } from './relight/backdropStatus';
import { ROOM_VERTEX } from './relight/presentation';
import { ROOM_FRAGMENT, RoomLayer } from './relight/roomLayer';
import { setRelightStatus } from './relight/status';
import { isCompact, webglRequested } from './relight/util';
import useCardLights from './useCardLights';

function matches(query, fallback) {
  return window.matchMedia?.(query).matches ?? fallback;
}

function createUniforms() {
  return {
    tRelight: { value: null },
    texSize: { value: new THREE.Vector2(1, 1) },
    dpr: { value: 1 },
    viewport: { value: new THREE.Vector2(1, 1) },
    box: { value: new THREE.Vector4(0, 0, 1, 0.1) },
    ready: { value: 0 },
    dim: { value: 1 },
    saturation: { value: 1 },
    hotKeep: { value: 1 },
    sharp: { value: 1 },
    glowAt: { value: new THREE.Vector3(0, 0, 0) },
    glowColor: { value: new THREE.Vector3(0, 0, 0) },
  };
}

export default function RelightBackdrop({ onProgress, onFail, onDpr, frameInfo }) {
  const renderer = useThree((state) => state.gl);
  const updateLights = useCardLights();
  const canHover = useMemo(() => matches('(hover: hover) and (pointer: fine)', true), []);
  const reduceMotion = useMemo(() => matches('(prefers-reduced-motion: reduce)', false), []);
  const compact = useMemo(isCompact, []);

  const [webgl, setWebgl] = useState(webglRequested);

  const callbacks = useRef(null);
  callbacks.current = { onFail, onDpr };

  const meshRef = useRef(null);
  const st = useRef(null);
  if (!st.current) {
    st.current = createBackdropState(renderer, compact, webgl);
  }

  const uniforms = useMemo(createUniforms, []);

  useEffect(() => {
    const state = st.current;
    callbacks.current.onDpr?.(state.quality.dpr);
    const save = () => {
      saveState(state);
      if (state.reported) {
        reportRun(state);
      }
    };
    window.addEventListener('pagehide', save);
    return () => {
      window.removeEventListener('pagehide', save);
      save();
    };
  }, []);

  useEffect(() => {
    const state = st.current;
    return () => {
      releaseDevice(state);
      setRelightStatus({ phase: 'idle' });
    };
  }, []);

  useEffect(() => {
    const state = st.current;
    const host = renderer.domElement.closest('[data-backdrop-layer]');
    if (!host) {
      return undefined;
    }
    state.host = host;
    try {
      state.layer = new RoomLayer(host);
    } catch (error) {
      console.warn('Relight backdrop has no fixed layer:', error);
      return undefined;
    }
    return () => {
      state.layer?.dispose();
      state.layer = null;
      state.host = null;
    };
  }, [renderer]);

  useEffect(() => {
    const state = st.current;
    const controller = new AbortController();
    const fail = (error) => failRelight(state, error, callbacks.current.onFail);
    setRelightStatus({ phase: 'loading' });
    if (webgl && !state.notGPU) {
      state.notGPU = 'the page was asked for WebGL (?relight=webgl)';
    }
    if (navigator.connection?.saveData) {
      fail(new Error('data saver is on'));
      return undefined;
    }
    const onDeviceLost = () => setWebgl(true);
    startRelight(state, uniforms, { webgl, signal: controller.signal, onDeviceLost }).catch(fail);
    return () => {
      controller.abort();
      stopRelight(state, uniforms);
    };
  }, [renderer, uniforms, webgl]);

  useEffect(() => {
    if (!canHover) {
      return undefined;
    }
    const state = st.current;
    const onMove = (event) => {
      if (event.pointerType === 'touch') {
        return;
      }
      const { left, top, size } = state.box;
      state.pointer = [(event.clientX - left) / size, (event.clientY - top) / size];
    };
    window.addEventListener('pointermove', onMove, { passive: true });
    return () => window.removeEventListener('pointermove', onMove);
  }, [canHover]);

  useFrame(({ clock, size, viewport }, delta) => {
    renderBackdropFrame({
      state: st.current,
      uniforms,
      mesh: meshRef.current,
      clock,
      size,
      viewport,
      delta,
      onProgress,
      onDpr,
      frameInfo,
      updateLights,
      canHover,
      reduceMotion,
    });
  });

  return (
    <mesh ref={meshRef} frustumCulled={false}>
      <planeGeometry args={[2, 2]} />
      <shaderMaterial
        uniforms={uniforms}
        vertexShader={ROOM_VERTEX}
        fragmentShader={ROOM_FRAGMENT}
        depthTest={false}
        depthWrite={false}
      />
    </mesh>
  );
}
