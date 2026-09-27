import { defineConfig } from 'tsup';

export default defineConfig([
  // Main library — ESM + CJS + types, consumed via `import`/`require`.
  {
    entry: ['src/index.ts'],
    format: ['cjs', 'esm'],
    dts: true,
    clean: true,
    treeshake: true,
  },
  // Standalone <script> build for the behavioral widget — sets
  // `window.TouchQueBehavioral = { attach }`.
  {
    entry: { 'touchque-behavioral': 'src/behavioral/global.ts' },
    format: ['iife'],
    globalName: 'TouchQueBehavioral',
    dts: false,
    clean: false,
    minify: true,
    treeshake: true,
  },
]);
