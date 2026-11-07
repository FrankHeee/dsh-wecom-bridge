import { defineConfig } from 'tsdown'

export default defineConfig([
  {
    entry: { index: 'src/index.ts', 'wecom-watch': 'src/sources/wecom.ts' },
    outDir: 'lib',
    format: 'esm',
    fixedExtension: false,
    platform: 'node',
    target: 'es2024',
    dts: true,
    clean: true,
    deps: { neverBundle: [/^@deepseek-ai\//, 'zod', 'ws'] },
  },
])
