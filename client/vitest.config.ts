import { defineConfig } from 'vitest/config';

export default defineConfig({
  // `tsconfig.json` sets `jsx: preserve`, which is what Next.js compiles with
  // and what Vite refuses to parse. Without this a test may not so much as
  // import a module containing JSX — it fails in import analysis, before a
  // single test runs, with an error that names the tsconfig rather than this.
  oxc: { jsx: { runtime: 'automatic' } },
  test: {
    // 3.6 GB of RAM: one fork, no parallelism.
    pool: 'forks',
    fileParallelism: false,
    maxWorkers: 1,
    environment: 'jsdom',
  },
  resolve: { alias: { '@': new URL('./src/', import.meta.url).pathname } },
});
