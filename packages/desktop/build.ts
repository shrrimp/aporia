// Bundles the Electron main process (ESM) and preload (CJS, required by the sandbox).
import { cp } from 'node:fs/promises';
import { build } from 'esbuild';

const common = { bundle: true, platform: 'node' as const, target: 'node22', sourcemap: true, logLevel: 'warning' as const };
await build({
  ...common,
  entryPoints: ['src/main.ts'],
  outfile: 'dist/main.js',
  format: 'esm',
  // The Claude adapter runs as its own process from node_modules; electron is provided at runtime.
  external: ['electron', '@agentclientprotocol/claude-agent-acp'],
  banner: { js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" },
});
await build({ ...common, entryPoints: ['src/preload.ts'], outfile: 'dist/preload.cjs', format: 'cjs', external: ['electron'] });
// The teaching rules are read relative to the module at runtime ('../rules/'): ship them beside dist/.
await cp('../teacher-mcp/rules', 'rules', { recursive: true });
console.log('desktop built');
