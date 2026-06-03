import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Vite dev server proxies /api to the Fastify backend on port 4317.
export default defineConfig({
  plugins: [react()],
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
