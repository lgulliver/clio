import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    // Better Auth introspects accessible schemas; concurrent migration DDL can invalidate that scan.
    fileParallelism: false,
    include: ['tests/*.integration.ts'],
    testTimeout: 15000,
    hookTimeout: 15000,
  },
});
