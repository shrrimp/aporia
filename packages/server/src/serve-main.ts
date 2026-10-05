// Headless entry point: `node packages/server/src/serve-main.ts` → prints the UI URL.
import { homedir } from 'node:os';
import { brand } from '@app/brand';
import { dataRoot } from '@app/core';
import { AppService } from './app.ts';
import { serve } from './ws.ts';

const root = dataRoot({ platform: process.platform, env: process.env, home: homedir() });
const app = new AppService({ dataRoot: root });
const staticDir = process.env[`${brand.envPrefix}_UI_DIR`];
const devOrigin = process.env[`${brand.envPrefix}_DEV_ORIGIN`];
const served = await serve({
  app,
  ...(staticDir ? { staticDir } : {}),
  ...(devOrigin ? { allowedOrigins: [devOrigin] } : {}),
  ...(process.env[`${brand.envPrefix}_PORT`] ? { port: Number(process.env[`${brand.envPrefix}_PORT`]) } : {}),
  ...(process.env[`${brand.envPrefix}_TOKEN`] ? { token: process.env[`${brand.envPrefix}_TOKEN`]! } : {}),
});
console.log(`${brand.displayName} data: ${root}`);
console.log(`${brand.displayName}: ${served.url}/#token=${served.token}`);
const stop = async () => {
  await served.close();
  await app.close();
  process.exit(0);
};
process.on('SIGINT', () => void stop());
process.on('SIGTERM', () => void stop());
