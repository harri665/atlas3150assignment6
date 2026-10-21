import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  // relative, so the same build works at harri665.github.io/atlas3150assignment6/
  // and at the root of atlas3150A6.harrison-martin.com (routes are in the hash,
  // so the page is always loaded from index.html's folder)
  base: './',
  // src/Components, src/utils and src/theme are copied from portfolio2024, a Create
  // React App project: JSX lives in .js files and settings come from process.env
  define: {
    'process.env.PUBLIC_URL': JSON.stringify('.'),
    'process.env.REACT_APP_API_BASE_URL': JSON.stringify('https://harrison-martin.com/api'),
  },
  esbuild: {
    loader: 'jsx',
    include: /src\/.*\.jsx?$/,
    exclude: [],
  },
  optimizeDeps: {
    esbuildOptions: {
      loader: { '.js': 'jsx' },
    },
  },
  plugins: [react({ include: /\.(js|jsx)$/ })],
  server: {
    proxy: {
      '/api': {
        target: 'http://localhost:3001',
        changeOrigin: true,
        secure: false,
      },
    },
  },
})
