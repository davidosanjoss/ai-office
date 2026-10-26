import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    root: '.',
    include: ['test/**/*.test.ts'],
    setupFiles: ['test/setup.ts'],
    environment: 'node',
    // Os testes de integração abrem uma porta fixa e processos reais: um arquivo por vez.
    fileParallelism: false,
    testTimeout: 20_000,
    hookTimeout: 30_000,
  },
});
