import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Vite dev server proxies /api to the Fastify backend on port 4317.
export default defineConfig({
  plugins: [react()],
  // Minify CSS with esbuild rather than the default Lightning CSS: the latter
  // (the version bundled with this Vite) doesn't recognize the CSS Custom
  // Highlight API `::highlight()` selector used by the finder and emits a noisy
  // (harmless) warning on every build. esbuild passes it through cleanly.
  build: { cssMinify: 'esbuild' },
  server: {
    port: 5317,
    proxy: {
      '/api': {
        target: 'http://localhost:4317',
        changeOrigin: true,
      },
    },
  },
});
