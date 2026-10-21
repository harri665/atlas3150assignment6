import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useLocation } from 'react-router-dom';

import {
  REFRACTION_FILTER_ID,
  RefractionFilter,
  buildRefractionMap,
  supportsBackdropRefraction,
} from './glassRefraction';
import './prism.css';

const navItems = [
  { to: '/', label: 'Home' },
  { to: '/about', label: 'About' },
];

// no sheen on this one, it looked like glare on a bar this long
export default function SubdomainNav() {
  const { pathname } = useLocation();
  const barRef = useRef(null);
  const refract = useMemo(() => supportsBackdropRefraction(), []);
  const [map, setMap] = useState(null);

  useEffect(() => {
    const el = barRef.current;
    if (!refract || !el) {
      return undefined;
    }
    const observer = new ResizeObserver(() => {
      const { width, height } = el.getBoundingClientRect();
      if (width && height) {
        setMap(buildRefractionMap(width, height, height / 2));
      }
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [refract]);

  const bending = refract && map;

  return (
    <div className="fixed left-0 right-0 top-0 z-30 px-3 py-3 sm:px-6 sm:py-4">
      {bending && <RefractionFilter map={map} />}
      <nav
        ref={barRef}
        // otherwise it'd get bent twice
        data-liquid-glass={bending ? undefined : ''}
        style={bending ? { backdropFilter: `url(#${REFRACTION_FILTER_ID})` } : undefined}
        className={[
          'liquid-glass glass-bar relative mx-auto flex max-w-7xl items-center justify-between rounded-full px-3 py-2 sm:px-4',
          bending ? '' : 'glass-bar-frost',
        ].join(' ')}
      >
        <span aria-hidden="true" className="liquid-glass-rim" />
        <Link
          to="/"
          aria-label="Harrison Martin, home"
          className="relative z-10 shrink-0 px-2 text-sm font-semibold tracking-tight text-ink"
        >
          <span className="sm:hidden">HM</span>
          <span className="hidden sm:inline">Harrison Martin</span>
        </Link>

        <div className="relative z-10 flex items-center gap-1 sm:gap-1.5">
          {navItems.map((item) => {
            const isActive = item.to === pathname;

            return (
              <Link
                key={item.to}
                to={item.to}
                aria-current={isActive ? 'page' : undefined}
                className={[
                  'rounded-full px-3 py-1.5 text-sm font-medium transition-colors sm:px-3.5',
                  !isActive ? 'text-ink-2 hover:bg-line/6 hover:text-ink' : 'bg-accent text-white',
                ].join(' ')}
              >
                {item.label}
              </Link>
            );
          })}

        </div>
      </nav>
    </div>
  );
}
