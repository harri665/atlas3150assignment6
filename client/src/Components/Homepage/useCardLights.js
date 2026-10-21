import { useEffect, useMemo, useRef } from 'react';
import * as THREE from 'three';

// touch screens don't hover, so the card nearest the middle gets the light (and data-focus)
export const CARD_SELECTOR = '[data-liquid-glass]';

// returns update(root, size, delta). gives the two brightest as [l, t, r, b, amount] in css px
export default function useCardLights() {
  const focus = useRef({ el: null, lights: new Map(), scrollY: -1, height: -1 });
  const canHover = useMemo(
    () => window.matchMedia?.('(hover: hover) and (pointer: fine)').matches ?? true,
    []
  );

  useEffect(() => {
    const focusState = focus.current;
    return () => focusState.el?.removeAttribute('data-focus');
  }, []);

  return function update(root, size, delta) {
    const f = focus.current;
    const rects = new Map();
    let next = f.el;
    if (canHover) {
      next = root.querySelector(`${CARD_SELECTOR}:hover`);
    } else if (window.scrollY !== f.scrollY || size.height !== f.height || !f.el?.isConnected) {
      f.scrollY = window.scrollY;
      f.height = size.height;
      next = null;
      const middle = size.height / 2;
      let best = Infinity;
      root.querySelectorAll(CARD_SELECTOR).forEach((card) => {
        const r = card.getBoundingClientRect();
        rects.set(card, r);
        if (r.bottom < 0 || r.top > size.height) {
          return;
        }
        const distance = Math.abs((r.top + r.bottom) / 2 - middle);
        if (distance < best) {
          best = distance;
          next = card;
        }
      });
    }

    if (next !== f.el) {
      if (!canHover) {
        f.el?.removeAttribute('data-focus');
        next?.setAttribute('data-focus', '');
      }
      f.el = next;
    }
    if (next && !f.lights.has(next)) {
      f.lights.set(next, 0);
    }
    f.lights.forEach((amount, card) => {
      const eased = THREE.MathUtils.damp(amount, card === next ? 1 : 0, 8, delta);
      if (card !== next && (eased < 0.002 || !card.isConnected)) {
        f.lights.delete(card);
      } else {
        f.lights.set(card, eased);
      }
    });

    return [...f.lights]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 2)
      .map(([card, amount]) => {
        const r = rects.get(card) || card.getBoundingClientRect();
        return [r.left, r.top, r.right, r.bottom, amount];
      });
  };
}
