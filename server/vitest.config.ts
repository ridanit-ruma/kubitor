import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // 3.6 GB of RAM: one fork, no parallelism.
    pool: 'forks',
    fileParallelism: false,
    maxWorkers: 1,
    hookTimeout: 30_000,
  },
});
