import { useFrame } from '@react-three/fiber';
import React, { useMemo } from 'react';
import * as THREE from 'three';

export default function Caustics({ lens }) {
  const uniforms = useMemo(
    () => ({
      time: { value: 0 },
      dpr: { value: 1 },
      viewport: { value: new THREE.Vector2(1, 1) },
      scroll: { value: 0 },
      intro: { value: 0 },
      tintA: { value: new THREE.Vector3(...(lens?.a || [0.8, 0.85, 1])) },
      tintB: { value: new THREE.Vector3(...(lens?.b || [0.8, 0.85, 1])) },
    }),
    [lens]
  );

  const reduceMotion = useMemo(
    () => window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false,
    []
  );

  useFrame(({ clock, size, viewport }) => {
    const t = clock.getElapsedTime();
    uniforms.time.value = reduceMotion ? 12 : t;
    uniforms.dpr.value = viewport.dpr;
    uniforms.viewport.value.set(size.width, size.height);
    uniforms.scroll.value = window.scrollY;
    uniforms.intro.value = Math.min(1, t / 1.2);
  });

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

const vertexShader = `
  void main() {
    gl_Position = vec4(position.xy, 0.0, 1.0);
  }
`;

const fragmentShader = `
  uniform float time;
  uniform float dpr;
  uniform vec2 viewport;
  uniform float scroll;
  uniform float intro;
  uniform vec3 tintA;
  uniform vec3 tintB;

  float causticLayer(vec2 p, float t) {
    vec2 q = p;
    for (int i = 0; i < 4; i++) {
      float fi = float(i);
      q += 0.32 * vec2(
        sin(q.y * 1.6 + t * 0.9 + fi * 1.7),
        cos(q.x * 1.4 - t * 0.7 + fi * 2.3)
      );
    }
    float v = sin(q.x * 2.0 + t * 0.3) * sin(q.y * 2.0 - t * 0.2);
    return pow(1.0 - abs(v), 14.0);
  }

  float caustics(vec2 p, float t) {
    return causticLayer(p, t) * 0.65 + causticLayer(p * 1.9 + 3.7, t * 1.3) * 0.35;
  }

  void main() {
    // scrolls at 30% of page speed
    vec2 px = vec2(gl_FragCoord.x, viewport.y * dpr - gl_FragCoord.y) / dpr;
    px.y += scroll * 0.3;

    vec2 p = px / 260.0;
    float t = time * 0.22;

    vec2 split = vec2(0.012, 0.004);
    vec3 light = vec3(
      caustics(p + split, t),
      caustics(p, t),
      caustics(p - split, t)
    );

    vec3 tint = mix(tintA, tintB, 0.5 + 0.5 * sin(p.x * 0.6 + p.y * 0.4 + t * 0.5));

    vec2 uv = gl_FragCoord.xy / (viewport * dpr);
    float falloff = smoothstep(1.15, 0.2, length((uv - 0.5) * vec2(1.2, 1.0)));

    vec3 color = vec3(0.031, 0.035, 0.047) + light * tint * 0.32 * falloff * intro;
    color += (fract(sin(dot(gl_FragCoord.xy, vec2(12.9898, 78.233))) * 43758.5453) - 0.5) / 255.0;

    gl_FragColor = vec4(color, 1.0);
  }
`;
