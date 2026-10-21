/** @type {import('tailwindcss').Config} */

// default opacity scale only has steps of 5 so border-white/12 etc silently did nothing
const opacity = Object.fromEntries(
  Array.from({ length: 101 }, (_, i) => [String(i), String(i / 100)])
);

const rgbToken = (name) => `rgb(var(--${name}) / <alpha-value>)`;

export default {
  content: [
    './src/**/*.{js,jsx,ts,tsx}',
  ],
  theme: {
    extend: {
      opacity,
      colors: {
        bg: rgbToken('bg'),
        surface: rgbToken('surface'),
        'surface-2': rgbToken('surface-2'),
        line: rgbToken('line'),
        ink: rgbToken('ink'),
        'ink-2': rgbToken('ink-2'),
        'ink-3': rgbToken('ink-3'),
        accent: 'oklch(var(--accent) / <alpha-value>)',
        'on-accent': rgbToken('on-accent'),
      },
      fontFamily: {
        sans: ['var(--font-sans)'],
        mono: ['var(--font-mono)'],
      },
      // named for what they round so they don't shadow tailwind's sizes
      borderRadius: {
        chip: 'var(--radius-sm)',
        field: 'var(--radius-md)',
        card: 'var(--radius-lg)',
      },
      transitionTimingFunction: {
        DEFAULT: 'var(--ease)',
      },
    },
  },
  plugins: [],
}
