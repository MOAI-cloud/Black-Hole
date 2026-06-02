import { defineConfig } from 'vite';

const apiTarget = `http://127.0.0.1:${process.env.RENDER_API_PORT ?? '8787'}`;

export default defineConfig({
  server: {
    port: 5173,
    strictPort: false,
    proxy: {
      '/api': apiTarget,
      '/renders': apiTarget
    }
  },
  preview: {
    port: 4173
  }
});
