// Desktop smoke test: launches the real Electron app headlessly against a temporary data dir.
// Usage: node e2e/smoke.ts [screenshot.png]   (run `node build.ts` and build the UI first)
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron } from '@playwright/test';
import { brand } from '@app/brand';

const here = path.dirname(fileURLToPath(import.meta.url));
const data = await mkdtemp(path.join(tmpdir(), 'desktop-smoke-'));
const app = await electron.launch({
  args: [path.join(here, '..')],
  env: { ...process.env, [`${brand.envPrefix}_DATA_DIR`]: data, [`${brand.envPrefix}_HIDDEN_WINDOW`]: '1' },
});
try {
  const page = await app.firstWindow();
  await page.getByText('Who is learning?').waitFor({ timeout: 15_000 });
  const connection = await page.evaluate(() => (window as unknown as { __APP_CONNECTION__?: { url: string } }).__APP_CONNECTION__);
  if (!connection?.url.startsWith('http://127.0.0.1:')) throw new Error('preload did not provide the connection');
  await page.getByPlaceholder('Your name').fill('Smoke');
  await page.getByRole('button', { name: 'Create' }).click();
  await page.getByText('Your projects').waitFor();
  await page.getByRole('button', { name: '+ Start a new project' }).click();
  await page.getByLabel(/What do you want/).fill('Smoke project');
  await page.getByLabel('Describe the goal').fill('Check the shell works');
  await page.getByRole('button', { name: 'Create project' }).click();
  await page.getByText('No lessons yet.').waitFor();
  const nodeIntegration = await page.evaluate(() => typeof (globalThis as { require?: unknown }).require);
  if (nodeIntegration !== 'undefined') throw new Error('renderer can reach Node');
  if (process.argv[2]) await page.screenshot({ path: process.argv[2] });
  console.log('desktop smoke: OK', connection.url);
} finally {
  await app.close();
  await rm(data, { recursive: true, force: true });
}
