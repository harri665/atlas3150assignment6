// css version of the glass for the top bar, since page content scrolls under it and
// the webgl pass can only bend the canvas. svg backdrop-filter only works in chromium

export const REFRACTION_FILTER_ID = 'glass-bar-refraction';

// no fixed split like the webgl glass, shifting a channel here leaves a bare strip at the edge
const DISPERSION = 0.6;

export function supportsBackdropRefraction() {
  const brands = navigator.userAgentData?.brands;
  return Array.isArray(brands) && brands.some((b) => /Chromium/.test(b.brand));
}

function sdRoundRect(px, py, hx, hy, r) {
  const qx = Math.abs(px) - hx + r;
  const qy = Math.abs(py) - hy + r;
  const outside = Math.hypot(Math.max(qx, 0), Math.max(qy, 0));
  return outside + Math.min(Math.max(qx, qy), 0) - r;
}

// returns the map's data url + the largest offset (px), the filter's scale has to match it
export function buildRefractionMap(w, h, r) {
  const width = Math.max(1, Math.round(w));
  const height = Math.max(1, Math.round(h));
  const radius = Math.min(r, width / 2, height / 2);
  // same as LiquidGlassPass
  const bezel = Math.min(Math.max(radius * 1.15, 14), 34);
  const reach = 0.7 * bezel;

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  const image = ctx.createImageData(width, height);
  const hx = width / 2;
  const hy = height / 2;
  const e = 0.5;

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const px = x + 0.5 - hx;
      const py = y + 0.5 - hy;
      const d = sdRoundRect(px, py, hx, hy, radius);
      let dx = 0;
      let dy = 0;
      if (d <= 0) {
        const nx = sdRoundRect(px + e, py, hx, hy, radius) - sdRoundRect(px - e, py, hx, hy, radius);
        const ny = sdRoundRect(px, py + e, hx, hy, radius) - sdRoundRect(px, py - e, hx, hy, radius);
        const n = Math.hypot(nx, ny) || 1;
        const t = Math.min(-d / bezel, 1);
        const bend = Math.pow(1 - t, 2.4);
        dx = (-nx / n) * bend * reach;
        dy = (-ny / n) * bend * reach;
      }
      const i = (y * width + x) * 4;
      image.data[i] = Math.round(128 + (127 * dx) / reach);
      image.data[i + 1] = Math.round(128 + (127 * dy) / reach);
      image.data[i + 2] = 128;
      image.data[i + 3] = 255;
    }
  }
  ctx.putImageData(image, 0, 0);
  return { url: canvas.toDataURL('image/png'), width, height, reach };
}

export function RefractionFilter({ map, frost = 2.5 }) {
  const scale = map.reach * 2;
  const channel = (name, strength, matrix) => [
    <feDisplacementMap
      key={`${name}-d`}
      in="frost"
      in2="map"
      scale={scale * strength}
      xChannelSelector="R"
      yChannelSelector="G"
      result={`${name}-d`}
    />,
    <feColorMatrix key={`${name}-m`} in={`${name}-d`} type="matrix" values={matrix} result={name} />,
  ];

  return (
    <svg aria-hidden="true" width="0" height="0" style={{ position: 'absolute' }}>
      <filter
        id={REFRACTION_FILTER_ID}
        x="0"
        y="0"
        width={map.width}
        height={map.height}
        filterUnits="userSpaceOnUse"
        colorInterpolationFilters="sRGB"
      >
        <feImage
          href={map.url}
          x="0"
          y="0"
          width={map.width}
          height={map.height}
          preserveAspectRatio="none"
          result="map"
        />
        <feGaussianBlur in="SourceGraphic" stdDeviation={frost} edgeMode="duplicate" result="frost" />
        {channel('red', 1 + DISPERSION, '1 0 0 0 0  0 0 0 0 0  0 0 0 0 0  0 0 0 1 0')}
        {channel('green', 1, '0 0 0 0 0  0 1 0 0 0  0 0 0 0 0  0 0 0 1 0')}
        {channel('blue', 1 - DISPERSION, '0 0 0 0 0  0 0 0 0 0  0 0 1 0 0  0 0 0 1 0')}
        <feBlend in="red" in2="green" mode="screen" result="rg" />
        <feBlend in="rg" in2="blue" mode="screen" />
      </filter>
    </svg>
  );
}
