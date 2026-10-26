import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig } from 'vite';

const api = process.env.API_URL ?? 'http://localhost:3000';

export default defineConfig({
  plugins: [sveltekit()],
  server: {
    proxy: {
      '/api': { target: api, changeOrigin: false },
      '/files': { target: api, changeOrigin: false },
      '/gateway': { target: api.replace(/^http/, 'ws'), ws: true, changeOrigin: false },
    },
  },
  build: { target: 'es2022', chunkSizeWarningLimit: 700 },
});
