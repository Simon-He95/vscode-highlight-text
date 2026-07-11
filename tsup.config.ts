import { defineConfig } from 'tsup'

export default defineConfig({
  entry: [
    'src/index.ts',
  ],
  format: ['cjs'],
  target: 'node16',
  shims: false,
  dts: false,
  external: [
    'vscode',
  ],
})
