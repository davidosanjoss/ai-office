import { defineConfig } from 'vite';

const api = 'http://127.0.0.1:7420';

export default defineConfig({
  root: 'web',
  build: { outDir: '../dist', emptyOutDir: true },
  server: {
    proxy: {
      '/api': api,
      '/ws': { target: api, ws: true },
    },
  },
});
