// Opens every file of a workspace in the real Electron editor, one after another, and reports any
// page error, renderer crash or blank window. Binary and large files included: they must be
// refused with a message, not break the app. Read-only: nothing is typed or saved.
// Usage: WORKSPACE=/path/to/a/copy node e2e/open-files.ts   (ONLY=part narrows the list)
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron } from '@playwright/test';
import { brand } from '@app/brand';

const here = path.dirname(fileURLToPath(import.meta.url));
const ws = process.env['WORKSPACE'];
if (!ws) throw new Error('set WORKSPACE to a folder (a copy: nothing is written, but be safe)');

async function walk(dir: string, rel = ''): Promise<string[]> {
  const out: string[] = [];
  for (const d of await readdir(dir, { withFileTypes: true })) {
    if (d.name.startsWith('.')) continue; // the file list hides them too
    const r = rel ? `${rel}/${d.name}` : d.name;
    if (d.isDirectory()) out.push(...(await walk(path.join(dir, d.name), r)));
    else if (d.isFile()) out.push(r);
  }
  return out;
}
const all = await walk(ws);
const files = process.env['ONLY'] ? all.filter((f) => f.includes(process.env['ONLY']!)) : all;

const data = await mkdtemp(path.join(tmpdir(), 'desktop-open-'));
const app = await electron.launch({
  args: [path.join(here, '..')],
  env: { ...process.env, [`${brand.envPrefix}_DATA_DIR`]: data, ...(process.env['VISIBLE'] ? {} : { [`${brand.envPrefix}_HIDDEN_WINDOW`]: '1' }) },
});
const problems: string[] = [];
let current = '(start)';
let closing = false;
app.process().on('exit', (code, signal) => !closing && problems.push(`${current}: the app exited (code ${code}, signal ${signal})`));
const started = Date.now();
try {
  const page = await app.firstWindow();
  // A hidden window is throttled like a background tab; the learner's window is not.
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.webContents.setBackgroundThrottling(false));
  // The GPU process draws the window: if it dies, the window can go blank with no page error.
  await app.evaluate(({ app: electronApp }) => {
    electronApp.on('child-process-gone', (_e, d) => console.log(`CHILD GONE ${JSON.stringify(d)}`));
  });
  app.process().stdout?.on('data', (b: Buffer) => {
    for (const line of b.toString().split('\n')) if (line.startsWith('CHILD GONE')) problems.push(`${current}: ${line}`);
  });
  page.on('pageerror', (e) => problems.push(`${current}: page error: ${e.message}`));
  page.on('crash', () => problems.push(`${current}: renderer crashed`));
  page.on('console', (m) => m.type() === 'error' && problems.push(`${current}: console: ${m.text()}`));

  await page.getByPlaceholder('Your name').fill('Open');
  await page.getByRole('button', { name: 'Create' }).click();
  await page.getByRole('button', { name: '+ Start a new project' }).click();
  await page.getByLabel(/What do you want/).fill('Engine');
  await page.getByLabel('Describe the goal').fill('Open every file');
  await page.getByLabel('Workspace folder').fill(ws);
  await page.getByRole('button', { name: 'Create project' }).click();
  await page.getByRole('button', { name: 'Editor' }).click();

  const exact = (label: string) => new RegExp(`^${label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`);
  const entry = (label: string) => page.locator('.editor-files button.entry').filter({ hasText: exact(label) });
  const shown = (dir: string) => page.locator('.editor-dir', dir ? { hasText: `/${dir}` } : { hasText: /^workspace$/ });
  let n = 0;
  const trace = (m: string) => process.env['TRACE'] && console.log(`${((Date.now() - started) / 1000).toFixed(1)} s ${m}`);
  for (const f of files) {
    current = f;
    trace(f);
    // From the top, folder by folder, as the learner does. Clicks are dispatched: a hidden window
    // paints about once a second, and a pointer click waits for paints.
    const up = page.locator('.editor-dir button', { hasText: '← up' });
    while ((await up.count()) > 0) await up.dispatchEvent('click');
    await shown('').waitFor();
    const parts = f.split('/');
    for (let i = 0; i < parts.length - 1; i++) {
      await entry(`${parts[i]}/`).dispatchEvent('click');
      await shown(parts.slice(0, i + 1).join('/')).waitFor();
    }
    await entry(parts.at(-1)!).dispatchEvent('click');
    // Opened, or refused with a message (binary, too large).
    await page.locator('.editor-path', { hasText: exact(f) }).waitFor({ timeout: 10_000 });
    await page.locator('.monaco-editor, .editor-main .error').first().waitFor({ timeout: 10_000 });
    if (await page.locator('#root').evaluate((r) => r.childElementCount === 0)) problems.push(`${f}: the window went blank`);
    if (problems.length > 0) break;
    if (++n % 50 === 0) console.log(`${n}/${files.length} files`);
  }
} catch (err) {
  problems.push(`${current}: step failed: ${(err as Error).message.split('\n').slice(0, 3).join(' / ')}`);
} finally {
  closing = true;
  await app.close().catch(() => undefined);
  await rm(data, { recursive: true, force: true });
}
if (problems.length) {
  console.error(`- ${problems.join('\n- ')}`);
  process.exit(1);
}
console.log(`open files: OK (${files.length} files in ${Math.round((Date.now() - started) / 1000)} s)`);
