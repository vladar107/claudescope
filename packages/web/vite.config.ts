import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Vite dev server proxies /api to the Fastify backend on port 4317.
export default defineConfig({
  plugins: [react()],
  build: {
    // Minify CSS with esbuild rather than the default Lightning CSS: the latter
    // (the version bundled with this Vite) doesn't recognize the CSS Custom
    // Highlight API `::highlight()` selector used by the finder and emits a noisy
    // (harmless) warning on every build. esbuild passes it through cleanly.
    cssMinify: 'esbuild',
    // Shiki ships one large grammar per language, each emitted as its own
    // lazily-loaded chunk (fetched only when a transcript uses that language).
    // A few exceed the default 500 kB warning and can't be split further. This
    // is a localhost app served from disk, so chunk size isn't a real concern —
    // raise the threshold past the grammars while still flagging genuine
    // app-bundle bloat (the entry chunk) above 1 MB.
    chunkSizeWarningLimit: 1000,
  },
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
