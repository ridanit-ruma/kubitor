import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // This workstation has 3.6 GB of RAM; parallel workers exhaust it.
    pool: 'forks',
    fileParallelism: false,
    maxWorkers: 1,
  },
});
