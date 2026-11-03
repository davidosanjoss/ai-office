import { defineConfig } from 'vite';

const api = 'http://127.0.0.1:7420';

export default defineConfig({
  root: 'web',
  // O Monaco (editor do explorador) passa de 2 MB, mas só carrega quando o explorador abre.
  build: { outDir: '../dist', emptyOutDir: true, chunkSizeWarningLimit: 4096 },
  server: {
    proxy: {
      '/api': api,
      '/ws': { target: api, ws: true },
    },
  },
});
