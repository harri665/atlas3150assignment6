import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  // relative, so the same build works at harri665.github.io/atlas3150assignment6/
  // and at the root of atlas3150A6.harrison-martin.com (routes are in the hash,
  // so the page is always loaded from index.html's folder)
  base: './',
  // the portfolio's relight engine (src/relight/engine) finds its rooms under
  // Create React App's PUBLIC_URL
  define: {
    'process.env.PUBLIC_URL': JSON.stringify('.'),
  },
  plugins: [react()],
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
