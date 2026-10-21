import { clamp01 } from './util';

export const PANEL_SELECTOR = '[data-prism-panel]';
export const HERO_SELECTOR = '[data-prism-hero]';
export const NAV_CLEAR = 72;
export const START = 0.03;
export const END_TOP = 0.14;

const PHONE_WIDTH = 640;
const COVER_OVERSCAN = 1.04;

export function walkInProgress(panel, vh) {
  const rect = panel.getBoundingClientRect();
  const maxScroll = Math.max(0, document.documentElement.scrollHeight - vh);
  let start = START * vh;
  let end = Math.max(rect.top + window.scrollY - END_TOP * vh, start + 0.2 * vh);
  end = Math.min(end, maxScroll);
  if (end - start < 0.15 * vh) {
    start = 0;
    end = maxScroll;
  }
  return end > 0 ? clamp01((window.scrollY - start) / (end - start)) : 1;
}

function phoneHero(state, vw, vh) {
  if (!state.hero?.isConnected) {
    state.hero = document.querySelector(HERO_SELECTOR);
    state.heroCache.vw = 0;
  }
  if (!state.hero) {
    return [Math.min(vw * 1.12, vh * 0.6), vh * 0.44];
  }
  const cache = state.heroCache;
  if (cache.vw !== vw || cache.vh !== vh) {
    const bottom = state.hero.getBoundingClientRect().bottom + window.scrollY;
    const space = Math.max(bottom - NAV_CLEAR, vh * 0.4);
    cache.vw = vw;
    cache.vh = vh;
    cache.size = Math.min(vw * 1.2, space);
    cache.y = NAV_CLEAR + space / 2;
  }
  return [cache.size, cache.y];
}

export function heroPlacement(state, vw, vh) {
  return vw < PHONE_WIDTH ? phoneHero(state, vw, vh) : [Math.min(vw * 0.9, vh * 0.86), vh * 0.5];
}

export function coverSize(vw, vh) {
  return Math.max(vw, vh) * COVER_OVERSCAN;
}
