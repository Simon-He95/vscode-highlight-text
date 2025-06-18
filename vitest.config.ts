import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    setupFiles: ['./test/setup.ts'],
    testTimeout: 30000, // 30 seconds for performance tests
    include: ['test/**/*.test.ts'],
    exclude: ['node_modules/', 'dist/'],
    reporters: ['verbose'],
    alias: {
      vscode: './test/mocks/vscode.ts',
    },
  },
  esbuild: {
    target: 'node16',
  },
})
