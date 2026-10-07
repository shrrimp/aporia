import { createRequire } from 'node:module';
import path from 'node:path';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Monaco's package exports do not reach the modules the app picks one by one (src/editor/monaco.ts).
const monacoRoot = path.join(path.dirname(createRequire(import.meta.url).resolve('monaco-editor')), '..', '..', 'esm', 'vs');

export default defineConfig({
  plugins: [react()],
  base: './',
  resolve: { alias: [{ find: /^monaco-vs\//, replacement: `${monacoRoot}/` }] },
  worker: { format: 'es' },
  build: { outDir: 'dist', emptyOutDir: true, sourcemap: true, chunkSizeWarningLimit: 4000 },
  server: { port: 5173, strictPort: true },
});
