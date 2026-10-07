// Desktop recovery check: the learner's place and unsaved text survive a crashed page, a reload
// (Ctrl+R) and a full restart of the app, and each incident is written to the app's log.
// Usage: node e2e/recover.ts   (build the UI and the shell first, as for smoke.ts)
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron, type ElectronApplication } from '@playwright/test';
import { brand } from '@app/brand';

const here = path.dirname(fileURLToPath(import.meta.url));
const data = await mkdtemp(path.join(tmpdir(), 'desktop-recover-'));
const ws = await mkdtemp(path.join(tmpdir(), 'desktop-recover-ws-'));
await mkdir(path.join(ws, 'physics'));
await writeFile(path.join(ws, 'physics', 'Joint.cpp'), 'void integratePosition() {\n}\n');
const UNSAVED = '// typed, never saved';

const problems: string[] = [];
const launch = () =>
  electron.launch({
    args: [path.join(here, '..')],
    env: { ...process.env, [`${brand.envPrefix}_DATA_DIR`]: data, ...(process.env['VISIBLE'] ? {} : { [`${brand.envPrefix}_HIDDEN_WINDOW`]: '1' }) },
  });

/** Run a check in the window's page through Electron (Playwright's page handle dies with a crashed renderer). */
async function inPage<T>(app: ElectronApplication, js: string): Promise<T> {
  return app.evaluate(({ BrowserWindow }, code) => BrowserWindow.getAllWindows()[0]!.webContents.executeJavaScript(code), js) as Promise<T>;
}

/** The project page with the editor on Joint.cpp, showing the unsaved text, and History open. */
async function expectPlace(app: ElectronApplication, when: string): Promise<void> {
  const check = `(() => {
    const text = (s) => [...document.querySelectorAll(s)].map((e) => e.textContent).join(' ');
    return {
      project: text('.crumb'),
      file: text('.editor-path'),
      kept: text('.editor-head .dirty'),
      code: text('.monaco-editor .view-lines'),
      history: document.querySelector('.margin-tabs button[aria-pressed="true"]')?.textContent ?? '',
    };
  })()`;
  let last: Record<string, string> = {};
  for (let i = 0; i < 60; i++) {
    last = await inPage<Record<string, string>>(app, check).catch((e: Error) => ({ error: e.message.split('\n')[0]! }));
    const ok = last['project'] === 'Engine' && last['file'] === 'physics/Joint.cpp' && last['kept']?.includes('kept from your last session') && last['code']?.includes(UNSAVED.replace(/ /g, '\u00a0')) || last['code']?.includes(UNSAVED);
    if (ok && last['history']?.startsWith('History')) return;
    await new Promise((r) => setTimeout(r, 250));
  }
  problems.push(`${when}: not back where the learner was: ${JSON.stringify(last)}`);
}

const mainOut: string[] = [];
let app = await launch();
const capture = (a: ElectronApplication) => {
  a.process().stdout?.on('data', (b: Buffer) => mainOut.push(b.toString()));
  a.process().stderr?.on('data', (b: Buffer) => mainOut.push(b.toString()));
  a.process().on('exit', (code, signal) => mainOut.push(`\n[main exited: ${code} ${signal}]\n`));
};
capture(app);
try {
  const page = await app.firstWindow();
  await page.getByPlaceholder('Your name').fill('Recover');
  await page.getByRole('button', { name: 'Create' }).click();
  await page.getByRole('button', { name: '+ Start a new project' }).click();
  await page.getByLabel(/What do you want/).fill('Engine');
  await page.getByLabel('Describe the goal').fill('Survive crashes');
  await page.getByLabel('Workspace folder').fill(ws);
  await page.getByRole('button', { name: 'Create project' }).click();
  await page.getByRole('button', { name: /^History/ }).click();
  await page.getByRole('button', { name: 'Editor' }).click();
  await page.locator('.editor-files button.entry', { hasText: 'physics/' }).dispatchEvent('click');
  await page.locator('.editor-files button.entry', { hasText: 'Joint.cpp' }).dispatchEvent('click');
  await page.locator('.monaco-editor .view-lines').waitFor({ timeout: 15_000 });
  await page.locator('.monaco-editor .view-lines').click();
  await page.keyboard.press('Control+End');
  await page.keyboard.type(UNSAVED);
  await page.waitForTimeout(1000); // the draft is kept 0.4 s after typing stops

  // 1. The page's process dies: the window reloads it, and the learner is back where they were.
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.webContents.forcefullyCrashRenderer());
  await new Promise((r) => setTimeout(r, 3000));
  await expectPlace(app, 'after the page crashed');

  // 2. Ctrl+R reloads the page (a way back from a blank window).
  await app.evaluate(({ BrowserWindow }) => {
    const c = BrowserWindow.getAllWindows()[0]!.webContents;
    c.sendInputEvent({ type: 'keyDown', keyCode: 'R', modifiers: ['control'] });
    c.sendInputEvent({ type: 'keyUp', keyCode: 'R', modifiers: ['control'] });
  });
  await new Promise((r) => setTimeout(r, 500));
  await expectPlace(app, 'after Ctrl+R');

  // 3. The whole app closes and starts again.
  await app.close();
  app = await launch();
  capture(app);
  await app.firstWindow();
  await expectPlace(app, 'after a restart');

  const disk = await readFile(path.join(ws, 'physics', 'Joint.cpp'), 'utf8');
  if (disk.includes(UNSAVED)) problems.push('unsaved text was written to the learner\'s file');
  const log = await readFile(path.join(data, 'logs', 'app.log'), 'utf8').catch(() => '');
  if (!/the page's process stopped \(\w+.*reloading the page/.test(log)) problems.push(`the crash is not in the log:\n${log}`);
  if (!log.includes('page reloaded by the learner')) problems.push('the reload is not in the log');
} catch (err) {
  problems.push(`step failed: ${(err as Error).message.split('\n').slice(0, 4).join(' / ')}`);
} finally {
  await app.close().catch(() => undefined);
  if (problems.length) console.error(`app log:\n${await readFile(path.join(data, 'logs', 'app.log'), 'utf8').catch(() => '(none)')}\nmain output:\n${mainOut.join('').slice(-3000)}`);
  await rm(data, { recursive: true, force: true });
  await rm(ws, { recursive: true, force: true });
}
if (problems.length) {
  console.error(`desktop recovery: FAILED\n- ${problems.join('\n- ')}`);
  process.exit(1);
}
console.log('desktop recovery: OK');
