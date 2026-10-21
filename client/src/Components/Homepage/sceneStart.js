import { useEffect, useState } from 'react';

// starting a scene (parsing three.js + compiling shaders) blocks the main thread for a few
// hundred ms, way longer on phones. so show the poster and wait for load + some input
const START_DELAY_MS = 3500;
const START_EVENTS = ['pointermove', 'pointerdown', 'wheel', 'touchstart', 'keydown', 'scroll'];
const LISTEN = { passive: true };

let started = false;
let loaded = false;
let interacted = false;
let timer = 0;
const listeners = new Set();

function start() {
  if (started) {
    return;
  }
  started = true;
  clearTimeout(timer);
  START_EVENTS.forEach((type) => window.removeEventListener(type, interact, LISTEN));
  listeners.forEach((listener) => listener());
  listeners.clear();
}

function interact() {
  interacted = true;
  if (loaded) {
    start();
  }
}

function arm() {
  START_EVENTS.forEach((type) => window.addEventListener(type, interact, LISTEN));
  afterLoad(() => {
    loaded = true;
    if (interacted) {
      start();
    } else {
      timer = setTimeout(start, START_DELAY_MS);
    }
  });
}

export function afterLoad(callback) {
  if (document.readyState === 'complete') {
    callback();
    return undefined;
  }
  window.addEventListener('load', callback, { once: true });
  return () => window.removeEventListener('load', callback);
}

// armed right away so a pointer move during load counts
if (typeof window !== 'undefined' && new URLSearchParams(window.location.search).get('relight') !== 'bench') {
  arm();
}

export default function useSceneStart(immediate = false) {
  const [ready, setReady] = useState(started || immediate);

  useEffect(() => {
    if (immediate) {
      start();
    }
    if (started) {
      setReady(true);
      return undefined;
    }
    const listener = () => setReady(true);
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  }, [immediate]);

  return ready;
}
