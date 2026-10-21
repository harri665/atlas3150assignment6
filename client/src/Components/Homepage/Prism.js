import React, { Suspense, lazy, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { motion, useReducedMotion } from 'framer-motion';

import ErrorBoundary from '../ErrorBoundary';
import { useRelightStatus } from './relight/status';
import useSceneStart, { afterLoad } from './sceneStart';
import './prism.css';

// load the scene chunk right after page load at high priority. tried webpackPrefetch but
// that's idle priority (last on slow connections) and the import fetched it a second time
let sceneModule = null;
const loadScene = () => {
  sceneModule =
    sceneModule ||
    import(/* webpackChunkName: "scene", webpackFetchPriority: "high" */ './DistortedTorusScene');
  return sceneModule;
};
const DistortedTorusScene = lazy(loadScene);

const TONES = {
  hub: { scene: 'opacity-60 sm:opacity-70', veil: '' },
  page: { scene: 'opacity-90', veil: '' },
  quiet: { scene: 'opacity-35 sm:opacity-45', veil: 'bg-bg/55' },
  detail: { scene: 'opacity-60 sm:opacity-70', veil: 'bg-bg/20' },
};

const DETAIL_BACKDROPS = { cs: 'grid', art: 'cover' };

// phones/tablets keep the css frost, the pass is too heavy there
export const PANE_GLASS_QUERY = '(min-width: 1024px) and (pointer: fine)';

const SCENES = {
  hub: { variant: 'hub', camera: [0, 0, 4.1] },
  cs: { variant: 'cs', camera: [0, 0, 5] },
  art: { variant: 'art', camera: [0, 0, 5] },
};

// posters come from perf/posters.mjs, captured POSTER_TIME in so the live scene starts on the same frame
const POSTERS = { hub: 'hub', cs: 'cs', art: 'art' };
const POSTER_TIME = 2;
// don't ready the room straight away or lighthouse keeps recording and counts three.js
// against us (mobile went 48-61 vs 71-82)
const PREP_DELAY_MS = 2000;
const RELIGHT_BENCH =
  typeof window !== 'undefined' && new URLSearchParams(window.location.search).get('relight') === 'bench';

export function PrismBackdrop({ lens = 'hub', tone = 'page', image }) {
  const toneStyle = TONES[tone] || TONES.page;
  const scene = SCENES[lens] || SCENES.hub;
  const glass = lens === 'hub';
  const drip = tone === 'page' && lens !== 'hub';
  const pageBackdrop = drip && lens === 'cs' ? 'relight' : 'knot';
  const relight = pageBackdrop === 'relight';
  const detailBackdrop = tone === 'detail' ? DETAIL_BACKDROPS[lens] || 'torus' : 'torus';
  const flat = detailBackdrop !== 'torus';
  const paneGlass = useMemo(
    () => detailBackdrop === 'grid' && (window.matchMedia?.(PANE_GLASS_QUERY).matches ?? false),
    [detailBackdrop]
  );
  const artHome = drip && lens === 'art';
  const overlaysRef = useRef(null);
  const handleDrip = useCallback((progress) => {
    if (overlaysRef.current) {
      overlaysRef.current.style.opacity = String(1 - progress * 0.85);
    }
  }, []);

  // css layer instead of a canvas, a canvas trails fast scrolls
  if (flat && detailBackdrop === 'cover') {
    return (
      <>
        <div aria-hidden="true" className="pointer-events-none fixed inset-0 z-0 bg-bg" />
        {image && <CoverFill image={image} />}
      </>
    );
  }

  return (
    <>
      <div aria-hidden="true" className="pointer-events-none fixed inset-0 z-0 bg-bg" />
      <div
        aria-hidden="true"
        data-backdrop-layer
        className={`pointer-events-none absolute inset-0 z-0 overflow-hidden ${glass || flat || relight ? '' : toneStyle.scene}`}
      >
        <Scene
          poster={tone === 'hub' || tone === 'page' ? POSTERS[lens] : null}
          immediate={artHome}
          followScroll
          variant={scene.variant}
          lens={lens === 'hub' ? null : lens}
          drip={drip}
          onDrip={drip ? handleDrip : undefined}
          backdrop={flat ? detailBackdrop : pageBackdrop}
          image={image}
          glass={
            glass
              ? { selector: '[data-liquid-glass]', textSelector: '[data-liquid-glass-text]' }
              : drip
                ? {
                    selector: '[data-liquid-glass]',
                    imageSelector: '[data-glass-image]',
                    shade: false,
                    ...(lens === 'cs' ? CS_GLASS : null),
                  }
                : paneGlass
                  ? { ...PANE_GLASS, selector: '[data-liquid-glass]:not([data-glass-side])' }
                  : // no webgl glass on other project pages, the bevel bent their images and videos
                    undefined
          }
          // 100vh is the large viewport on phones so this doesn't resize when the toolbar collapses
          className="absolute inset-x-0 top-0 h-screen"
          cameraPosition={scene.camera}
        />
      </div>

      {paneGlass && <GlassStrip />}

      <div
        ref={overlaysRef}
        aria-hidden="true"
        className={`pointer-events-none fixed inset-0 z-0 ${flat ? 'hidden' : ''}`}
      >
        {!glass && !relight && (
          <div className="absolute inset-0 [background-image:radial-gradient(circle_at_center,rgba(8,9,12,0.12),rgba(8,9,12,0.58)_56%,rgba(8,9,12,0.95)_82%)]" />
        )}
        <div className="absolute inset-0 bg-gradient-to-b from-bg/0 via-transparent to-bg" />
        {toneStyle.veil && <div className={`absolute inset-0 ${toneStyle.veil}`} />}
      </div>
    </>
  );
}

function Scene({ poster, immediate = false, className, ...props }) {
  const started = useSceneStart(immediate);
  const [drawn, setDrawn] = useState(false);
  const [posterGone, setPosterGone] = useState(false);
  const handleFirstFrame = useCallback(() => setDrawn(true), []);
  const relight = useRelightStatus();
  const room = props.backdrop === 'relight';
  const shown = room ? relight.phase === 'running' || relight.phase === 'failed' : drawn;

  useEffect(
    () =>
      afterLoad(() => {
        loadScene().catch(() => {});
      }),
    []
  );

  useEffect(() => {
    if (!room) {
      return undefined;
    }
    if (RELIGHT_BENCH) {
      import(/* webpackChunkName: "relight-bench" */ './relight/bench').then((m) => m.installBench());
      return undefined;
    }
    let prepare = null;
    let timer = 0;
    const cancelLoad = afterLoad(() => {
      timer = setTimeout(() => {
        prepare = import(/* webpackChunkName: "relight" */ './relight/prepare');
        prepare.then((m) => m.prepareRelight()).catch(() => {});
      }, PREP_DELAY_MS);
    });
    return () => {
      clearTimeout(timer);
      cancelLoad?.();
      prepare?.then((m) => m.cancelPreparedRelight()).catch(() => {});
    };
  }, [room]);

  return (
    <>
      {poster && !posterGone && (room || !drawn) && (
        <picture>
          <source media="(max-width: 768px)" srcSet={posterUrl(poster, 'tall')} />
          <img
            src={posterUrl(poster, 'wide')}
            alt=""
            fetchpriority="high"
            decoding="async"
            className={`${className} h-screen w-full object-cover transition-opacity duration-700`}
            style={{ opacity: shown ? 0 : 1 }}
            onTransitionEnd={() => setPosterGone(true)}
          />
        </picture>
      )}
      {started && (
        <div
          className="absolute inset-0 transition-opacity duration-700"
          style={{ opacity: poster || shown ? 1 : 0 }}
        >
          <ErrorBoundary name="scene">
            <Suspense fallback={null}>
              <DistortedTorusScene
                {...props}
                className={className}
                onFirstFrame={handleFirstFrame}
                startAt={poster && !room ? POSTER_TIME : 0}
              />
            </Suspense>
          </ErrorBoundary>
        </div>
      )}
    </>
  );
}

const posterUrl = (name, shape) => `${process.env.PUBLIC_URL}/posters/${name}-${shape}.webp`;

const CS_GLASS = {
  textSelector: '[data-liquid-glass-text]',
  frost: 24,
  blurTaps: 24,
  haze: 0.06,
  textFrost: 5,
  textLens: 0.2,
  textTint: [0.82, 0.9, 1],
  hover: { frost: 2, split: 3, dim: 0.18 },
};

// 1x with a lighter blur, it covers most of the screen and you can't tell under that much frost
const PANE_GLASS = { shade: false, frost: 9, maxDpr: 1, blurTaps: 6 };

const STRIP_REACH = 40;

// the sticky sidebar card trailed the scroll on the main canvas, so it gets its own
// fixed strip canvas. browser keeps fixed + sticky in step
function GlassStrip() {
  const ref = useRef(null);

  useEffect(() => {
    const strip = ref.current;
    let frame = 0;

    const place = () => {
      frame = 0;
      const card = document.querySelector('[data-glass-side]');
      const sheet = document.querySelector('[data-glass-merge]:not([data-glass-side])');
      if (!card || !sheet) {
        strip.style.display = 'none';
        return;
      }
      const left = card.getBoundingClientRect().left - 8;
      const right = sheet.getBoundingClientRect().left + STRIP_REACH;
      strip.style.display = '';
      strip.style.left = `${left}px`;
      strip.style.width = `${right - left}px`;
    };
    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(place);
    };

    const mutations = new MutationObserver(schedule);
    mutations.observe(document.body, { childList: true, subtree: true });
    window.addEventListener('resize', schedule);
    place();
    return () => {
      mutations.disconnect();
      window.removeEventListener('resize', schedule);
      cancelAnimationFrame(frame);
    };
  }, []);

  return (
    <div
      ref={ref}
      aria-hidden="true"
      className="pointer-events-none fixed inset-y-0 z-0 overflow-hidden"
      style={{ display: 'none' }}
    >
      <Scene
        variant="cs"
        lens="cs"
        backdrop="grid"
        glass={{ ...PANE_GLASS, selector: '[data-glass-merge]' }}
        className="absolute -inset-8"
      />
    </div>
  );
}

// css not webgl so no CORS proxy needed, and the cover <img> already loaded it
function CoverFill({ image }) {
  const [loaded, setLoaded] = useState(null);

  useEffect(() => {
    let cancelled = false;
    const probe = new Image();
    probe.onload = () => {
      if (!cancelled) {
        setLoaded(image);
      }
    };
    probe.src = image;
    return () => {
      cancelled = true;
    };
  }, [image]);

  return (
    <div
      aria-hidden="true"
      className="pointer-events-none fixed inset-0 z-0 overflow-hidden transition-opacity duration-500"
      style={{ opacity: loaded === image ? 1 : 0 }}
    >
      <div
        className="absolute inset-0 bg-cover bg-center"
        style={{
          backgroundImage: `url("${image}")`,
          transform: 'scale(1.3)',
          filter: 'blur(56px) saturate(0.8) brightness(0.5)',
        }}
      />
      <div className="absolute inset-0 bg-gradient-to-b from-bg/0 via-bg/25 to-bg/55" />
      <div className="absolute inset-0 [background-image:radial-gradient(ellipse_at_center,transparent_35%,rgb(var(--bg)/0.6)_100%)]" />
    </div>
  );
}

export function PrismHero({
  title,
  subtitle,
  children,
  fullHeight = false,
  peek = false,
  glassTitle = false,
  glassSubtitle = false,
  align = 'center',
}) {
  const left = align === 'left';

  return (
    <div className="px-3 sm:px-6">
      <header
        data-prism-hero
        className={[
          'relative z-10 mx-auto flex w-full max-w-7xl flex-col justify-center px-5 sm:px-6',
          left ? 'items-start text-left' : 'items-center text-center',
          fullHeight
            ? [
                'pb-10 pt-24 sm:pb-16 sm:pt-28',
                peek ? 'min-h-[calc(100svh-3.5rem)] sm:min-h-[calc(100svh-7.5rem)]' : 'min-h-svh',
              ].join(' ')
            : 'min-h-[64vh] pb-12 pt-32',
        ].join(' ')}
      >
        <h1
          data-liquid-glass-text={glassTitle || undefined}
          className={[
            'hero-rise max-w-4xl leading-none tracking-tight text-ink',
            left ? 'text-6xl sm:text-8xl lg:text-9xl' : 'text-4xl sm:text-6xl lg:text-7xl',
            glassTitle ? 'prism-text font-bold' : 'font-semibold',
          ].join(' ')}
        >
          {title}
        </h1>

        {subtitle && (
          <p
            data-liquid-glass-text={glassSubtitle || undefined}
            className={[
              'hero-rise mt-5',
              glassSubtitle
                ? 'prism-text max-w-4xl text-2xl font-bold leading-snug tracking-tight text-ink sm:text-4xl'
                : 'max-w-2xl text-base leading-relaxed text-ink-2 sm:text-lg',
            ].join(' ')}
            style={{ animationDelay: '80ms' }}
          >
            {subtitle}
          </p>
        )}

        {children && (
          <div className="hero-rise w-full" style={{ animationDelay: '180ms' }}>
            {children}
          </div>
        )}
      </header>
    </div>
  );
}

const REVEAL_REACH = '0px 0px 96px 0px';

export function useScrollReveal(index = 0, amount = 0.15) {
  const reduceMotion = useReducedMotion();
  return {
    initial: { opacity: 0, y: reduceMotion ? 0 : 40 },
    whileInView: {
      opacity: 1,
      y: 0,
      transition: { duration: 0.7, ease: [0.22, 1, 0.36, 1], delay: (index % 3) * 0.08 },
    },
    viewport: { once: true, amount, margin: REVEAL_REACH },
  };
}

// tall panels (long readme on a phone) never get 15% on screen so reveal on appear
export function Reveal({ as = 'div', index = 0, ...props }) {
  const reveal = useScrollReveal(index, 'some');
  const Component = motion[as];
  return <Component {...reveal} {...props} />;
}

export const HOVER_LIFT = { y: -4, transition: { duration: 0.22, ease: 'easeOut' } };

export function trackPointer(event) {
  const el = event.currentTarget;
  const rect = el.getBoundingClientRect();
  el.style.setProperty('--mx', `${event.clientX - rect.left}px`);
  el.style.setProperty('--my', `${event.clientY - rect.top}px`);
}
